// The Chat view of a tmux session: its `main` pane's Claude Code transcript, mapped onto the chat thread's item model,
// and a composer that types into the pane.
//
// Where the transcript is: a VPS session container mounts devd's `<root>/_claude-projects/<session id>` as
// `/home/dev/.claude/projects/-workspace` (sessions.ts), and every account profile's `projects` resolves into it, so
// devd reads `<sid>.jsonl` from that host directory. Which `<sid>`: Claude keeps `<config dir>/sessions/<pid>.json`
// with the conversation the process is on right now (it follows /resume and /clear — /clear verified on 2.1.325) and
// its own status (idle/busy/waiting); `procStart` rules out a file of another process with the same pid (the
// directory is shared by all containers). One `docker exec` per poll reads that, plus the pane's process tree.
//
// The mapped events go into a ThreadStore of its own (`_mirrors/<id>.sqlite`), so the snapshot, paging and SSE replay
// work exactly like a chat thread's. Polling runs only while a client watches (SSE) and on the session's hook events.
// Transcript content never goes to logs.
import { closeSync, constants as C, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MirrorInfo, MirrorSendError } from "../../shared/mirror";
import type { BridgeEvent, LoggedEvent } from "../../shared/thread";
import { AGENT_RUNTIMES, AGENTS } from "./agents";
import type { AgentLiveSnapshot } from "./agentEvents";
import { agentProcsUnder, type ExecResult, type Proc } from "./ccUpkeep";
import { getSession, type SessionRow } from "./db";
import type { EventBus } from "./eventBus";
import { withDir } from "./noFollowFs";
import { storedRuntime } from "./sessions";
import { ThreadStore } from "./threadStore";

/** The pane the Chat view mirrors: the one the session page's Terminal tab opens. */
export const MIRROR_PANE = "main";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const POLL_MS = 2_000;
/** A sent message that has not shown up in the transcript by then gets a warn notice. */
export const SEEN_TIMEOUT_MS = 15_000;
/** Bytes read per chunk; a backlog is read chunk by chunk within one poll. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** A transcript line longer than this is skipped unparsed (a huge tool result); its tool then stays open. */
export const LINE_CAP = 16 * 1024 * 1024;
const OUTPUT_CHARS = 16 * 1024;
const INPUT_STRING_CHARS = 4_000;
const HEAD_BYTES = 256;
export const MAX_MESSAGE_CHARS = 100_000;

// ── In-container probes ──────────────────────────────────────────────────────────────
// Only metadata leaves the container: the pane's pid, the process table (pid, ppid, comm) and, for each claude
// process whose session file verifies, its session id and status.
const PY_LOCATE_FN = String.raw`
import json, os, subprocess, sys

def locate(session):
    out = {"pane": None, "procs": [], "claude": {}}
    r = subprocess.run(["tmux", "display-message", "-p", "-t", "=" + session + ":", "#{pane_pid}\t#{pane_in_mode}"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    f = r.stdout.strip().split("\t")
    if r.returncode == 0 and len(f) == 2 and f[0].isdigit():
        out["pane"] = {"pid": int(f[0]), "inMode": f[1] == "1"}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open("/proc/" + d + "/stat") as h:
                st = h.read()
        except OSError:
            continue
        i = st.rindex(")")
        rest = st[i + 2:].split()
        comm = st[st.index("(") + 1:i]
        out["procs"].append([int(d), int(rest[1]), comm])
        if comm != "claude":
            continue
        try:
            with open("/proc/" + d + "/environ", "rb") as h:
                env = dict(e.split(b"=", 1) for e in h.read().split(b"\0") if b"=" in e)
            # Claude's own default when CLAUDE_CONFIG_DIR is unset is ~/.claude.
            config = env.get(b"CLAUDE_CONFIG_DIR", b"").decode() or env[b"HOME"].decode() + "/.claude"
            with open(config + "/sessions/" + d + ".json") as h:
                s = json.load(h)
            if s.get("pid") != int(d) or str(s.get("procStart")) != rest[19]:
                continue
            out["claude"][d] = {"sid": s.get("sessionId"), "status": s.get("status")}
        except (OSError, KeyError, IndexError, ValueError, UnicodeDecodeError):
            continue
    return out
`;

export const MIRROR_LOCATE = `# MIRROR_LOCATE${PY_LOCATE_FN}
import signal
# Below the docker exec timeout (10 s).
signal.alarm(8)
print(json.dumps(locate(sys.argv[1])))
`;

// Checks right before typing, inside the container so the window to the paste is as short as it gets: the same claude
// process is still the pane's nearest agent, it is not waiting for an answer, the pane is not scrolled back, and the
// screen shows Claude's empty prompt (no dialog, nothing typed). The text goes in through a tmux buffer from stdin
// (never through a shell) as a bracketed paste, so its newlines do not submit; Enter submits it unless a dialog
// opened meanwhile.
//
// Multi-line text relies on Claude enabling bracketed paste (verified on 2.1.325: a pasted multi-line text stays one
// draft). tmux exposes no way to check that per pane, so without it each line would be submitted on its own; that is
// why send() refuses a command at the start of ANY line, not only the first.
//
// The screen: Claude's selection dialogs (trust, question, permission) end with a "Enter to confirm/select … Esc to
// cancel" footer; its prompt box is a `❯` line right below a rule, running to the next rule, and the placeholder in an
// empty prompt is dim (`\e[2m` up to a reset). Verified on Claude Code 2.1.325.
export const MIRROR_SEND = String.raw`# MIRROR_SEND${PY_LOCATE_FN}
import re, signal, time, uuid

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
DIM = re.compile(r"\x1b\[2m.*?(?:\x1b\[0?m|\x1b\[22m|$)")
RULE = re.compile(r"^\s*─{8,}\s*$")
PROMPT = re.compile(r"^\s*❯")
DIALOG = re.compile(r"Enter to (confirm|select)|Esc to cancel")

def screen(target):
    r = subprocess.run(["tmux", "capture-pane", "-e", "-p", "-t", target], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if r.returncode != 0:
        return "unknown"
    raw = r.stdout.decode("utf-8", "replace").split("\n")
    plain = [ANSI.sub("", l) for l in raw]
    if any(DIALOG.search(l) for l in plain[-25:]):
        return "dialog"
    for i in range(len(plain) - 1, 0, -1):
        if not PROMPT.match(plain[i]) or not RULE.match(plain[i - 1]):
            continue
        end = i + 1
        while end < len(plain) and not RULE.match(plain[end]):
            end += 1
        if end == len(plain):
            return "unknown"
        typed = [ANSI.sub("", DIM.sub("", l)).replace("\u00a0", " ") for l in raw[i:end]]
        typed[0] = PROMPT.sub("", typed[0])
        return "draft" if any(t.strip() for t in typed) else "ready"
    return "unknown"

def fail(code):
    print(json.dumps({"error": code}))
    sys.exit(0)

def check(session, expected, agents):
    """None when the pane still runs the expected claude, not waiting and not scrolled back; else the refusal."""
    now = locate(session)
    pane = now["pane"]
    if pane is None:
        return "pane-changed"
    children, comm = {}, {}
    for pid, ppid, c in now["procs"]:
        children.setdefault(ppid, []).append(pid)
        comm[pid] = c
    nearest, queue, seen = None, [pane["pid"]], set()
    while queue:
        p = queue.pop(0)
        if p in seen:
            continue
        seen.add(p)
        if comm.get(p) in agents:
            nearest = p
            break
        queue.extend(sorted(children.get(p, [])))
    if nearest != expected:
        return "pane-changed"
    if (now["claude"].get(str(expected)) or {}).get("status") == "waiting":
        return "agent-waiting-in-terminal"
    if pane["inMode"]:
        return "terminal-scrolled"
    return None

# Below the docker exec timeout (15 s), so a hung tmux never leaves this running to type later.
signal.alarm(12)
session, expected, agents = sys.argv[1], int(sys.argv[2]), set(sys.argv[3].split(","))
text = sys.stdin.buffer.read()
target = "=" + session + ":"
refused = check(session, expected, agents)
if refused:
    fail(refused)
state = screen(target)
if state != "ready":
    fail({"dialog": "agent-waiting-in-terminal", "draft": "terminal-has-draft"}.get(state, "terminal-not-ready"))
buf = "devd-mirror-" + uuid.uuid4().hex
subprocess.run(["tmux", "load-buffer", "-b", buf, "-"], input=text, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# The last check before the paste: the agent may have exited while the buffer loaded.
refused = check(session, expected, agents)
if refused:
    subprocess.run(["tmux", "delete-buffer", "-b", buf], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fail(refused)
subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", buf, "-t", target], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# Claude takes the paste asynchronously; an Enter right behind it can land before the pasted text.
time.sleep(0.3)
# Enter only into the same claude whose prompt now holds the paste. Otherwise nothing more is typed: the pasted text
# is not cleared either, since a key sent to whatever now has the pane (a shell, a dialog) is exactly what this avoids.
if check(session, expected, agents) or screen(target) != "draft":
    fail("not-submitted")
subprocess.run(["tmux", "send-keys", "-t", target, "Enter"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(json.dumps({"ok": True}))
`;

/** What the pane runs, from MIRROR_LOCATE's output. */
export type PaneAgent =
  | { kind: "no-pane" }
  | { kind: "no-agent"; inMode: boolean }
  | { kind: "other"; runtime: string; inMode: boolean }
  | { kind: "claude"; pid: number; inMode: boolean; sid: string | null; status: "idle" | "busy" | "waiting" | null };

/** null when the output is not what MIRROR_LOCATE prints. */
export function parseLocate(stdout: string): PaneAgent | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { pane?: unknown; procs?: unknown; claude?: unknown };
  if (o.pane === null) return { kind: "no-pane" };
  const pane = o.pane as { pid?: unknown; inMode?: unknown } | undefined;
  if (typeof pane?.pid !== "number" || typeof pane.inMode !== "boolean" || !Array.isArray(o.procs) || typeof o.claude !== "object" || o.claude === null) return null;
  const procs: Proc[] = [];
  for (const p of o.procs) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || typeof p[2] !== "string") return null;
    procs.push({ pid: p[0], ppid: p[1], etimes: 0, comm: p[2] });
  }
  const nearest = agentProcsUnder(pane.pid, procs, AGENT_RUNTIMES)[0];
  if (!nearest) return { kind: "no-agent", inMode: pane.inMode };
  if (nearest.comm !== "claude") return { kind: "other", runtime: nearest.comm, inMode: pane.inMode };
  const info = (o.claude as Record<string, { sid?: unknown; status?: unknown }>)[String(nearest.pid)];
  const sid = typeof info?.sid === "string" && UUID.test(info.sid) ? info.sid : null;
  const status = info?.status === "idle" || info?.status === "busy" || info?.status === "waiting" ? info.status : null;
  return { kind: "claude", pid: nearest.pid, inMode: pane.inMode, sid, status };
}

const runtimeLabel = (runtime: string): string => Object.values(AGENTS).find((a) => a.runtime === runtime)?.label ?? runtime;

// ── Reading the transcript ───────────────────────────────────────────────────────────

export interface Chunk { lines: string[]; next: number; skipped: number }

/** Complete lines from `offset` (at most `budget` bytes, or one line up to `lineCap`); an unfinished last line is left
 *  for the next read. A line longer than `lineCap` is skipped unparsed (`skipped` counts them). */
export function readChunk(fd: number, offset: number, size: number, budget = CHUNK_BYTES, lineCap = LINE_CAP): Chunk {
  const read = (at: number, n: number): Buffer => {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, at);
    return b.subarray(0, got);
  };
  if (offset >= size) return { lines: [], next: offset, skipped: 0 };
  let buf = read(offset, Math.min(size - offset, budget));
  let nl = buf.lastIndexOf(0x0a);
  if (nl === -1) {
    // One line longer than the budget: read it whole while it fits the cap.
    if (size - offset <= budget) return { lines: [], next: offset, skipped: 0 }; // still being written
    buf = read(offset, Math.min(size - offset, lineCap + 1));
    nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length <= lineCap) return { lines: [], next: offset, skipped: 0 }; // still being written
      // Over the cap: find its end without keeping it.
      let at = offset + buf.length;
      while (at < size) {
        const part = read(at, Math.min(size - at, 1024 * 1024));
        const i = part.indexOf(0x0a);
        if (i !== -1) return { lines: [], next: at + i + 1, skipped: 1 };
        at += part.length;
      }
      return { lines: [], next: offset, skipped: 0 }; // its end is not written yet
    }
  }
  const lines = buf.subarray(0, nl).toString("utf8").split("\n").filter((l) => l.trim() !== "");
  return { lines, next: offset + nl + 1, skipped: 0 };
}

// ── Mapping Claude's transcript onto thread events ───────────────────────────────────

export interface MapState {
  /** The run (one per prompt) still in progress; null between turns. */
  openRun: string | null;
  /** The newest run, for tool results arriving after their run was closed. */
  lastRun: string | null;
}

export interface Mapped {
  events: { ts: number; event: BridgeEvent }[];
  /** User prompts and queued messages this chunk recorded, for confirming sent messages. */
  seen: string[];
}

/** Content Claude wraps in these tags is its own bookkeeping, not something the user typed (older versions mark
 *  prompts only this way; newer ones also set `origin.kind`). */
const BOOKKEEPING = /^<(command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-prompt-submit-hook)>/;
const COMMAND = /^<command-name>\s*([^<\s]{1,80})\s*<\/command-name>/;
const INTERRUPTED = /^\[Request interrupted by user/;

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

function clipInput(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > INPUT_STRING_CHARS ? `${v.slice(0, INPUT_STRING_CHARS)}…` : v;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => clipInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipInput(x, depth + 1)]));
}

function clipOutput(text: string): string {
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (output clipped)` : text;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: Block) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

/** Maps transcript lines (one JSON entry each) to thread events. Pure: `st` is updated in place and saved with the
 *  cursor. Thinking, subagent (sidechain) and meta entries are dropped, as is every entry type it does not know. */
export function mapClaudeLines(lines: string[], st: MapState, now: number): Mapped {
  const events: Mapped["events"] = [];
  const seen: string[] = [];
  for (const line of lines) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j !== "object" || j === null || j.isSidechain === true) continue;
    const parsed = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : now;
    const uuid = typeof j.uuid === "string" ? j.uuid : null;
    const push = (event: BridgeEvent) => events.push({ ts, event });
    const endRun = () => {
      if (st.openRun === null) return;
      push({ type: "run.completed", runId: st.openRun, nativeThreadId: typeof j.sessionId === "string" ? j.sessionId : "", usage: null, costUsd: null });
      st.openRun = null;
    };
    const startRun = (runId: string, origin: "user" | "agent") => {
      endRun();
      push({ type: "run.started", runId, origin, nativeThreadId: null, model: null });
      st.openRun = runId;
      st.lastRun = runId;
    };
    const message = j.message as { content?: unknown } | undefined;

    if (j.type === "queue-operation") {
      if (j.operation === "enqueue" && typeof j.content === "string") seen.push(j.content);
      continue;
    }
    if (j.type === "system") {
      if (j.subtype === "compact_boundary") push({ type: "bridge.notice", text: "Conversation compacted" });
      else if (j.subtype === "stop_hook_summary" || j.subtype === "turn_duration") endRun();
      continue;
    }
    if (j.type === "user" && uuid !== null && message) {
      if (j.isMeta === true || j.isCompactSummary === true) continue;
      const content = message.content;
      const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      let hadResult = false;
      for (const b of blocks) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        hadResult = true;
        const runId = st.openRun ?? st.lastRun;
        if (runId !== null) push({ type: "tool.finished", runId, itemId: b.tool_use_id, isError: b.is_error === true, output: clipOutput(resultText(b.content)) });
      }
      if (hadResult) continue;
      const texts = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
      const images = blocks.filter((b) => b?.type === "image").length;
      const text = texts.join("\n");
      if (INTERRUPTED.test(text)) {
        if (st.openRun !== null) push({ type: "run.interrupted", runId: st.openRun });
        st.openRun = null;
        continue;
      }
      const origin = j.origin as { kind?: unknown } | undefined;
      if (origin !== undefined && origin?.kind !== "human") continue;
      const command = COMMAND.exec(text);
      if (command) { push({ type: "bridge.notice", text: `Ran ${command[1]}` }); continue; }
      if (BOOKKEEPING.test(text)) continue;
      if (text.trim() === "" && images === 0) continue;
      const shown = images > 0 ? [text, ...Array(images).fill("[image]")].filter(Boolean).join("\n") : text;
      const runId = `mirror:${uuid}`;
      startRun(runId, "user");
      push({ type: "message.final", runId, itemId: `user:${uuid}`, role: "user", text: shown });
      seen.push(text);
      continue;
    }
    if (j.type === "assistant" && uuid !== null && message && Array.isArray(message.content)) {
      (message.content as Block[]).forEach((b, i) => {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
          if (st.openRun === null) startRun(`mirror:${uuid}`, "agent");
          push({ type: "message.final", runId: st.openRun!, itemId: `${uuid}:${i}`, role: "assistant", text: b.text });
        } else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          if (st.openRun === null) startRun(`mirror:${uuid}`, "agent");
          push({ type: "tool.started", runId: st.openRun!, itemId: b.id, tool: b.name, input: clipInput(b.input ?? null) });
        }
      });
    }
  }
  return { events, seen };
}

// ── The mirror ───────────────────────────────────────────────────────────────────────

export interface Cursor {
  sid: string | null;
  ino: number;
  offset: number;
  headLen: number;
  headHash: string;
  map: MapState;
}

/** `status`: the HTTP status the route answers with (409 for a MirrorSendError). */
export class MirrorSendRefused extends Error {
  constructor(readonly code: MirrorSendError | "bad-request" | "unknown-session" | "not-a-tmux-session" | "session-ending", message: string,
    readonly status: 400 | 404 | 409 = code === "bad-request" ? 400 : code === "unknown-session" ? 404 : 409) { super(message); }
}

export const SEND_MESSAGES: Record<MirrorSendError, string> = {
  "agent-not-running": "No agent runs in the terminal; it may have exited. Open the terminal to start it again.",
  "agent-waiting-in-terminal": "The agent is waiting for an answer in the terminal. Answer it there.",
  "terminal-has-draft": "Text is already typed into the terminal's prompt. Send or clear it in the terminal first.",
  "terminal-not-ready": "The terminal is not showing the agent's prompt. Check the terminal.",
  "terminal-scrolled": "The terminal is scrolled back. Return it to the bottom first.",
  "conversation-unknown": "devd could not tell which conversation the agent is on. Use the terminal.",
  "unsupported-agent": "Chat view isn't supported for this agent yet.",
  "unsupported-host": "Chat view isn't supported on InstaBox sessions yet.",
  "pane-changed": "The terminal changed while the message was being sent; nothing was typed. Check the terminal.",
  // MIRROR_SEND pasted the text, then did not press Enter.
  "not-submitted": "The terminal changed while the message was being typed; it was not submitted and may still be in the terminal's prompt. Check the terminal.",
};

export interface MirrorDeps {
  db: Parameters<typeof getSession>[0];
  root: string;
  bus: EventBus;
  isEnding: (id: string) => boolean;
  /** docker exec into the session's container; `stdin` is piped to the command. */
  exec: (container: string, cmd: string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
  /** The session's hook-derived state (AgentEventHub.liveSnapshot): the reason a waiting agent gives. */
  live: (id: string) => AgentLiveSnapshot | null;
  now?: () => number;
  log?: (msg: string) => void;
}

interface Pending { text: string; at: number }

export class TranscriptMirror {
  private stores = new Map<string, ThreadStore>();
  private watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();
  private running = new Map<string, Promise<void>>();
  private infos = new Map<string, MirrorInfo>();
  private pending = new Map<string, Pending[]>();
  private sending = new Set<string>();
  /** Bumped by release: a refresh that started before it stops at its next step instead of reopening the store. */
  private generation = new Map<string, number>();
  private timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  constructor(private d: MirrorDeps) {}

  private now() { return this.d.now?.() ?? Date.now(); }
  private log(msg: string) { (this.d.log ?? ((m) => console.error(m)))(msg); }

  /** The tmux session the mirror may serve, or why not. */
  session(id: string): { s: SessionRow } | { error: "unknown-session" | "not-a-tmux-session" | "session-ending" } {
    const s = getSession(this.d.db, id);
    if (!s) return { error: "unknown-session" };
    if (storedRuntime(s) !== "tmux") return { error: "not-a-tmux-session" };
    if (this.d.isEnding(id)) return { error: "session-ending" };
    return { s };
  }

  private gen(id: string): number { return this.generation.get(id) ?? 0; }

  store(id: string): ThreadStore {
    const open = this.stores.get(id);
    if (open) return open;
    if (this.d.isEnding(id)) throw new Error(`session ${id} is ending`);
    const store = ThreadStore.open(this.d.root, id, { dir: "_mirrors", onNotice: (item) => this.d.bus.publish(`mirror:${id}`, { notice: item }) });
    this.stores.set(id, store);
    return store;
  }

  info(id: string): MirrorInfo {
    return this.infos.get(id) ?? { state: "no-pane", agent: null, conversationId: null, activity: null, terminalPrompt: null, sendBlock: null };
  }

  /** A client watches the mirror (its SSE stream): poll while anyone does. Returns the unwatch function. */
  watch(id: string): () => void {
    let w = this.watchers.get(id);
    if (w) w.count++;
    else { w = { count: 1, timer: setInterval(() => { void this.refresh(id); }, POLL_MS) }; this.watchers.set(id, w); }
    const mine = w;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // A release dropped this entry; a later watcher's entry is not ours to count down.
      if (this.watchers.get(id) !== mine) return;
      if (--mine.count === 0) { clearInterval(mine.timer); this.watchers.delete(id); }
    };
  }

  /** The mirror's live events: LoggedEvent, `{notice}` (a devd notice) and `{mirror}` (a changed MirrorInfo). */
  subscribe(id: string, cb: (data: unknown) => void): () => void {
    // `{released: true}` asks open streams to close (release), so their clients reconnect to a polled mirror.
    return this.d.bus.subscribe([`mirror:${id}`], (_topic, data) => cb(data));
  }

  /** A hook event of the session arrived: read now when someone watches. */
  poke(id: string): void {
    if (this.watchers.has(id)) void this.refresh(id);
  }

  /** Reads the pane and its transcript once; concurrent calls share the run in progress. Never throws. */
  refresh(id: string): Promise<void> {
    const cur = this.running.get(id);
    if (cur) return cur;
    const run = this.tick(id).catch((e) => this.log(`mirror ${id}: refresh failed: ${(e as Error).message}`))
      .finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  /** Session stopped (close the store) or ended (and delete it: the transcript itself stays). */
  release(id: string, ended = false): void {
    this.generation.set(id, this.gen(id) + 1);
    const w = this.watchers.get(id);
    if (w) { clearInterval(w.timer); this.watchers.delete(id); }
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
    this.d.bus.publish(`mirror:${id}`, { released: true });
    this.stores.get(id)?.close();
    this.stores.delete(id);
    this.infos.delete(id);
    this.pending.delete(id);
    if (ended) for (const x of ["", "-wal", "-shm"]) rmSync(join(this.d.root, "_mirrors", `${id}.sqlite${x}`), { force: true });
  }

  private async locate(s: SessionRow): Promise<PaneAgent | null> {
    const r = await this.d.exec(s.container, ["python3", "-I", "-c", MIRROR_LOCATE, MIRROR_PANE], 10_000);
    if (r.code !== 0 || r.timedOut) return null;
    return parseLocate(r.stdout);
  }

  private setInfo(id: string, info: MirrorInfo) {
    if (JSON.stringify(this.infos.get(id)) === JSON.stringify(info)) return;
    this.infos.set(id, info);
    this.d.bus.publish(`mirror:${id}`, { mirror: info });
  }

  private infoFor(id: string, s: SessionRow, pane: PaneAgent | null): MirrorInfo {
    const base = { conversationId: null, activity: null, terminalPrompt: null } as const;
    const block = (code: MirrorSendError, message = SEND_MESSAGES[code]) => ({ code, message });
    if ((s.host ?? "vps") === "instabox") return { ...base, state: "unsupported", agent: null, sendBlock: block("unsupported-host") };
    if (pane === null || pane.kind === "no-pane") return { ...base, state: "no-pane", agent: null, sendBlock: block("agent-not-running", "The terminal is not running.") };
    if (pane.kind === "no-agent") return { ...base, state: "agent-exited", agent: null, sendBlock: block("agent-not-running") };
    if (pane.kind === "other") {
      const label = runtimeLabel(pane.runtime);
      return { ...base, state: "unsupported", agent: label, sendBlock: block("unsupported-agent", `Chat view isn't supported for ${label} yet.`) };
    }
    const agent = AGENTS.claude.label;
    if (pane.sid === null) return { ...base, state: "unresolved", agent, sendBlock: block("conversation-unknown") };
    const waiting = pane.status === "waiting";
    const live = waiting ? this.d.live(id) : null;
    return {
      state: "live", agent, conversationId: pane.sid, activity: pane.status,
      terminalPrompt: waiting ? { text: live?.status === "waiting" && live.reason ? live.reason : "The agent is waiting for an answer in the terminal." } : null,
      sendBlock: waiting ? block("agent-waiting-in-terminal") : pane.inMode ? block("terminal-scrolled") : null,
    };
  }

  private async tick(id: string): Promise<void> {
    const r = this.session(id);
    if ("error" in r) return;
    const { s } = r;
    const gen = this.gen(id);
    const current = () => gen === this.gen(id) && !this.d.isEnding(id);
    const pane = (s.host ?? "vps") === "instabox" || s.status !== "running" ? null : await this.locate(s);
    if (!current()) return;
    this.setInfo(id, this.infoFor(id, s, pane));
    if (pane?.kind === "claude" && pane.sid !== null && (s.host ?? "vps") !== "instabox") await this.read(id, pane.sid, pane.status === "idle", current);
    if (!current()) return;
    this.checkPending(id);
  }

  /** Reads `<sid>.jsonl` from where the cursor stopped, never following a symlink the agent may have planted. */
  private async read(id: string, sid: string, idle: boolean, current: () => boolean): Promise<void> {
    const store = this.store(id);
    const saved = store.mirrorCursor();
    let cur: Cursor = saved ? JSON.parse(saved) as Cursor : { sid: null, ino: 0, offset: 0, headLen: 0, headHash: "", map: { openRun: null, lastRun: null } };
    const pre: BridgeEvent[] = [];
    /** Starting over (another conversation, a rewritten file): a run left open there is over. */
    const closeOpenRun = () => {
      if (cur.map.openRun !== null) pre.push({ type: "run.completed", runId: cur.map.openRun, nativeThreadId: cur.sid ?? "", usage: null, costUsd: null });
    };
    if (cur.sid !== sid) {
      if (cur.sid !== null) { closeOpenRun(); pre.push({ type: "bridge.notice", text: "New conversation" }); }
      pre.push({ type: "thread.native", harness: "claude", nativeThreadId: sid, account: null, model: null });
      cur = { sid, ino: 0, offset: 0, headLen: 0, headHash: "", map: { openRun: null, lastRun: null } };
    }
    let fd: number;
    try {
      fd = withDir(this.d.root, ["_claude-projects", id], false, (dir) => openSync(join(dir.path, `${sid}.jsonl`), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK));
    } catch (e) {
      // Claude writes the file with the first prompt: a new conversation has none yet.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { if (pre.length) this.commit(id, store, pre, [], cur); return; }
      throw e;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error("the transcript is not a regular file");
      const head = (n: number) => {
        const b = Buffer.alloc(n);
        readSync(fd, b, 0, n, 0);
        return createHash("sha256").update(b).digest("hex");
      };
      if (cur.offset > 0 && (st.ino !== cur.ino || st.size < cur.offset || head(cur.headLen) !== cur.headHash)) {
        closeOpenRun();
        pre.push({ type: "bridge.notice", text: "The transcript was rewritten; it is read again from the start" });
        cur = { ...cur, offset: 0, headLen: 0, headHash: "", map: { openRun: null, lastRun: null } };
      }
      cur.ino = st.ino;
      if (cur.headLen < HEAD_BYTES && st.size > cur.headLen) {
        cur.headLen = Math.min(HEAD_BYTES, st.size);
        cur.headHash = head(cur.headLen);
      }
      for (;;) {
        const chunk = readChunk(fd, cur.offset, st.size);
        if (chunk.skipped > 0) this.log(`mirror ${id}: skipped ${chunk.skipped} transcript line(s) over ${LINE_CAP} bytes`);
        const mapped = mapClaudeLines(chunk.lines, cur.map, this.now());
        const advanced = chunk.next !== cur.offset;
        cur.offset = chunk.next;
        if (advanced || pre.length) this.commit(id, store, pre.splice(0), mapped.events, cur);
        this.markSeen(id, mapped.seen);
        if (!advanced || cur.offset >= st.size) {
          // Claude says it is idle and everything written is read: a turn whose end entry never came is over.
          if (idle && cur.map.openRun !== null && cur.offset >= st.size) {
            pre.push({ type: "run.completed", runId: cur.map.openRun, nativeThreadId: sid, usage: null, costUsd: null });
            cur.map.openRun = null;
            this.commit(id, store, pre.splice(0), [], cur);
          }
          break;
        }
        // A backlog of several chunks: let the event loop breathe between them.
        await new Promise((res) => setImmediate(res));
        if (!current()) return;
      }
    } finally { closeSync(fd); }
  }

  private commit(id: string, store: ThreadStore, pre: BridgeEvent[], mapped: Mapped["events"], cur: Cursor) {
    let seq = store.lastSeq();
    const now = this.now();
    const logged: LoggedEvent[] = [
      ...pre.map((event): LoggedEvent => ({ seq: ++seq, ts: now, event })),
      // A re-read (rewritten transcript, a conversation resumed again) maps the same entries again: their items
      // and runs dedupe by id in the store, a notice has none, so it is matched by text and entry time.
      ...mapped.filter((e) => e.event.type !== "bridge.notice" || !store.hasNotice(e.event.text, e.ts))
        .map((e): LoggedEvent => ({ seq: ++seq, ts: e.ts, event: e.event })),
    ];
    store.applyBatch(logged, JSON.stringify(cur));
    for (const e of logged) this.d.bus.publish(`mirror:${id}`, e);
  }

  private markSeen(id: string, seen: string[]) {
    const list = this.pending.get(id);
    if (!list || seen.length === 0) return;
    const norm = (t: string) => t.replace(/\r\n?/g, "\n").trim();
    const got = new Set(seen.map(norm));
    const left = list.filter((p) => !got.has(norm(p.text)));
    if (left.length) this.pending.set(id, left); else this.pending.delete(id);
  }

  private checkPending(id: string) {
    const list = this.pending.get(id);
    if (!list) return;
    const now = this.now();
    const late = list.filter((p) => now - p.at >= SEEN_TIMEOUT_MS);
    if (late.length === 0) return;
    const left = list.filter((p) => now - p.at < SEEN_TIMEOUT_MS);
    if (left.length) this.pending.set(id, left); else this.pending.delete(id);
    const store = this.store(id);
    late.forEach(() => store.addNotice("A sent message has not shown up in the conversation yet. Check the terminal.", now, "warn"));
  }

  /** Types `text` into the pane's Claude prompt and submits it, or refuses with the reason. Never types into anything
   *  but a verified, ready Claude prompt. */
  async send(id: string, text: string): Promise<void> {
    text = text.replace(/\r\n/g, "\n");
    if (text.trim() === "") throw new MirrorSendRefused("bad-request", "text must be a non-empty string");
    if (text.length > MAX_MESSAGE_CHARS) throw new MirrorSendRefused("bad-request", `text is longer than ${MAX_MESSAGE_CHARS} characters`);
    // An escape could end the bracketed paste early and turn the rest into keystrokes (`\e[201~` then `!cmd`).
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) {
      throw new MirrorSendRefused("bad-request", "text must not contain control characters other than newlines and tabs");
    }
    if (text.split("\n").some((line) => /^[/!#]/.test(line.trimStart()))) {
      throw new MirrorSendRefused("bad-request", "Commands (a line starting with /, ! or #) can't be sent from the chat; type them in the terminal.");
    }
    const r = this.session(id);
    if ("error" in r) throw new MirrorSendRefused(r.error, r.error);
    const { s } = r;
    if ((s.host ?? "vps") === "instabox") throw new MirrorSendRefused("unsupported-host", SEND_MESSAGES["unsupported-host"]);
    if (s.status !== "running") throw new MirrorSendRefused("agent-not-running", "The session is not running.");
    if (this.sending.has(id)) throw new MirrorSendRefused("pane-changed", "Another message is being sent to this terminal.");
    this.sending.add(id);
    try {
      const pane = await this.locate(s);
      const info = this.infoFor(id, s, pane);
      this.setInfo(id, info);
      if (pane?.kind !== "claude" || info.sendBlock) {
        const b = info.sendBlock ?? { code: "agent-not-running" as const, message: SEND_MESSAGES["agent-not-running"] };
        throw new MirrorSendRefused(b.code, b.message);
      }
      const sent = await this.d.exec(s.container, ["python3", "-I", "-c", MIRROR_SEND, MIRROR_PANE, String(pane.pid), AGENT_RUNTIMES.join(",")], 15_000, text);
      let out: { ok?: unknown; error?: unknown } | null = null;
      try { out = JSON.parse(sent.stdout); } catch { out = null; }
      if (sent.code !== 0 || sent.timedOut || out === null) {
        // Unknown whether anything was typed: say so, never retry.
        throw new MirrorSendRefused("pane-changed", "devd could not confirm the message reached the terminal. Check the terminal before sending again.");
      }
      if (out.ok !== true) {
        const code = typeof out.error === "string" && out.error in SEND_MESSAGES ? out.error as MirrorSendError : "pane-changed";
        throw new MirrorSendRefused(code, SEND_MESSAGES[code]);
      }
      const list = this.pending.get(id) ?? [];
      list.push({ text, at: this.now() });
      this.pending.set(id, list);
    } finally {
      this.sending.delete(id);
    }
    void this.refresh(id);
    // The warn notice needs a poll after the timeout even when nobody watches any more.
    const timer = setTimeout(() => { this.timers.get(id)?.delete(timer); void this.refresh(id); }, SEEN_TIMEOUT_MS + 500);
    timer.unref?.();
    const set = this.timers.get(id) ?? new Set();
    set.add(timer);
    this.timers.set(id, set);
  }
}
