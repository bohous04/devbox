// The Chat view of a tmux session: its `main` pane's Claude Code transcript or Codex rollout (codexMirror.ts), mapped
// onto the chat thread's item model, and a composer that types into the pane.
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
import { closeSync, constants as C, existsSync, fstatSync, lstatSync, openSync, read as readFd, readdirSync, readSync } from "node:fs";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MirrorInfo, MirrorSendError } from "../../shared/mirror";
import type { BridgeEvent, LoggedEvent } from "../../shared/thread";
import { AGENT_RUNTIMES, AGENTS } from "./agents";
import { CODEX_PROFILE_ROOT } from "./codexAccountProfiles";
import { CODEX_CHUNK_BYTES, CODEX_LINE_CAP, mapCodexLines, MIRROR_CODEX_READ, newCodexMapState, parseCodexRead, type CodexMapState } from "./codexMirror";
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
// Only metadata leaves the container: the pane's pid, the process table (pid, ppid, comm), for each claude process
// whose session file verifies its session id and status, and each codex process's CODEX_HOME and the thread ids of the
// rollouts it has open.
const PY_LOCATE_FN = String.raw`
import json, os, re, subprocess, sys

ROLLOUT = re.compile(r"/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")

def main_rollout(path):
    """A rollout whose session_meta says it is not a subagent's (a spawned agent's thread has a rollout of its own,
    possibly written by the same process); one whose first line cannot be read is not trusted to be a main one."""
    # Non-blocking: the fd could be a FIFO the agent named like a rollout.
    with open(path, "rb", opener=lambda p, flags: os.open(p, flags | os.O_NONBLOCK)) as h:
        first = h.readline(4 << 20)
    try:
        meta = json.loads(first)
    except (ValueError, RecursionError):
        return False
    payload = meta.get("payload") if isinstance(meta, dict) else None
    if not isinstance(meta, dict) or meta.get("type") != "session_meta" or not isinstance(payload, dict):
        return False
    source = payload.get("source")
    return not (isinstance(source, dict) and "subagent" in source)

def locate(session):
    out = {"pane": None, "procs": [], "claude": {}, "codex": {}}
    # The title last: whatever the agent set it to may hold a tab.
    r = subprocess.run(["tmux", "display-message", "-p", "-t", "=" + session + ":", "#{pane_pid}\t#{pane_in_mode}\t#{pane_title}"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
    f = r.stdout.rstrip("\n").split("\t", 2)
    if r.returncode == 0 and len(f) == 3 and f[0].isdigit():
        out["pane"] = {"pid": int(f[0]), "inMode": f[1] == "1", "title": f[2]}
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
        out["procs"].append([int(d), int(rest[1]), comm, rest[19]])
        if comm == "codex":
            try:
                with open("/proc/" + d + "/environ", "rb") as h:
                    env = dict(e.split(b"=", 1) for e in h.read().split(b"\0") if b"=" in e)
                home = env.get(b"CODEX_HOME", b"").decode() or env[b"HOME"].decode() + "/.codex"
                opened = []
                for fd in os.listdir("/proc/" + d + "/fd"):
                    try:
                        m = ROLLOUT.search(os.readlink("/proc/" + d + "/fd/" + fd))
                        if m and m.group(1) not in opened and main_rollout("/proc/" + d + "/fd/" + fd):
                            opened.append(m.group(1))
                    except OSError:
                        continue
                out["codex"][d] = {"home": home, "open": sorted(opened)}
            except (OSError, KeyError, ValueError, UnicodeDecodeError):
                pass
            continue
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
// (never through a shell) as a bracketed paste, so its newlines do not submit; Enter (Codex: Tab, below) submits it
// unless a dialog opened meanwhile. Then the prompt has to empty: one that still holds the text after SUBMIT_WAIT
// means something else took the key (an @-file suggestion, a popup), reported as not-submitted. A busy agent queues
// the message and empties its prompt too. Any other screen after the key (a dialog the new turn opened) is taken as
// submitted; devd's pending check then warns if the message never shows up in the conversation (SEEN_TIMEOUT_MS).
//
// Multi-line text relies on Claude enabling bracketed paste (verified on 2.1.325: a pasted multi-line text stays one
// draft). tmux exposes no way to check that per pane, so without it each line would be submitted on its own; that is
// why send() refuses a command at the start of ANY line, not only the first.
//
// The screen: Claude's selection dialogs (trust, question, permission) end with a "Enter to confirm/select … Esc to
// cancel" footer; its prompt box is a `❯` line right below a rule, running to the next rule, and the placeholder in an
// empty prompt is dim (`\e[2m` up to a reset). Verified on Claude Code 2.1.325.
//
// Codex (verified on 0.172.0 in tmux): its composer line starts with a bold `›` (`\e[1m›\e[0m `), followed by the dim
// placeholder when empty or the typed text. Past prompts in the history start with a dim bold `›` on a background and
// a popup's selected row with a reverse one, so neither passes for the composer. A popup ends with a hint: "enter
// select · esc back" (a picker over the composer), "to confirm", "to cancel" (approvals), "to submit answer"
// (questions); these replace the composer. While the composer holds an `@…` or `$…`, a mention or skill popup opens
// right above it, its last line "enter/tab insert · esc close · ↑/↓ select · ←/→ filter": Enter there inserts instead
// of submitting. Next to the composer a hint counts only with its key in bold (`\e[1menter`, `\e[0;1mesc`), as Codex
// draws hints: the status line below the composer names the thread after its first prompt ("… · write a form to
// submit orders") and chat text can read like a hint, neither is a dialog. With no composer on screen the last lines
// count as they read. A composer line without its placeholder could be the first, empty line of a longer draft: not
// ready.
//
// Codex submits with Tab, not Enter: idle, Tab sends like Enter; during a turn, Enter steers the running turn (the
// response in flight is dropped and the message joins that turn) while Tab queues the message as the next turn, as
// Claude does (verified on 0.172). Codex also takes a
// bracketed paste as one draft. Its title names the thread it is on (codexTitleThread), checked with the process.
export const MIRROR_SEND = String.raw`# MIRROR_SEND${PY_LOCATE_FN}
import re, signal, time, uuid

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
DIM = re.compile(r"\x1b\[2m.*?(?:\x1b\[0?m|\x1b\[22m|$)")
RULE = re.compile(r"^\s*─{8,}\s*$")
PROMPT = re.compile(r"^\s*❯")
DIALOG = re.compile(r"Enter to (confirm|select)|Esc to cancel")
CODEX_PROMPT = "\x1b[1m\u203a\x1b[0m"
CODEX_DIALOG = re.compile(r"\benter\b.{0,12}\b(select|confirm|submit|insert)|\btab\b.{0,6}\binsert\b|\besc\b.{0,12}\b(back|cancel|close)|\bto (confirm|cancel|submit)\b", re.I)
# Seconds the prompt has to empty after Enter.
SUBMIT_WAIT = 3
HINT_KEY = re.compile(r"\x1b\[(?:0;)?1m(?:enter|esc|tab)\b", re.I)
TITLE_THREAD = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}")

def capture(target):
    r = subprocess.run(["tmux", "capture-pane", "-e", "-p", "-t", target], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if r.returncode != 0:
        return None
    raw = r.stdout.decode("utf-8", "replace").split("\n")
    return raw, [ANSI.sub("", l) for l in raw]

def codex_screen(target):
    got = capture(target)
    if got is None:
        return "unknown"
    raw, plain = got
    at = next((i for i in range(len(raw) - 1, -1, -1) if raw[i].lstrip(" ").startswith(CODEX_PROMPT)), None)
    if at is None:
        hints = [l for l in plain if l.strip()][-4:]
    else:
        near = raw[at + 1:] + [next((l for l in reversed(raw[:at]) if ANSI.sub("", l).strip()), "")]
        hints = [ANSI.sub("", l) for l in near if HINT_KEY.search(l)]
    if any(CODEX_DIALOG.search(l) for l in hints):
        return "dialog"
    if at is None:
        return "unknown"
    rest = raw[at].lstrip(" ")[len(CODEX_PROMPT):]
    if ANSI.sub("", DIM.sub("", rest)).replace("\u00a0", " ").strip():
        return "draft"
    return "ready" if DIM.search(rest) and ANSI.sub("", rest).strip() else "unknown"

def screen(target):
    if kind == "codex":
        return codex_screen(target)
    got = capture(target)
    if got is None:
        return "unknown"
    raw, plain = got
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
    """None when the pane still runs the expected agent process (pid and start), not waiting and not scrolled back;
    else the refusal."""
    now = locate(session)
    pane = now["pane"]
    if pane is None:
        return "pane-changed"
    children, comm, starts = {}, {}, {}
    for pid, ppid, c, start in now["procs"]:
        children.setdefault(ppid, []).append(pid)
        comm[pid] = c
        starts[pid] = start
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
    if nearest != expected or starts.get(nearest) != expected_start:
        return "pane-changed"
    if kind == "codex":
        ids = TITLE_THREAD.findall(pane.get("title") or "")
        if len(ids) != 1 or len(ids[0]) < 24 or not thread.startswith(ids[0]):
            return "conversation-unknown"
    elif (now["claude"].get(str(expected)) or {}).get("status") == "waiting":
        return "agent-waiting-in-terminal"
    if pane["inMode"]:
        return "terminal-scrolled"
    return None

# Below the docker exec timeout (15 s), so a hung tmux never leaves this running to type later.
signal.alarm(12)
session, expected, agents, expected_start = sys.argv[1], int(sys.argv[2]), set(sys.argv[3].split(",")), sys.argv[4]
# "claude", or "codex" with the thread its title must name.
kind, thread = sys.argv[5], sys.argv[6]
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
# The agent takes the paste asynchronously; an Enter right behind it can land before the pasted text.
time.sleep(0.3)
# Enter only into the same agent whose prompt now holds the paste. Otherwise
# nothing more is typed: the pasted text is not cleared either, since a key sent to whatever now has the pane (a shell,
# a dialog) is exactly what this avoids.
if check(session, expected, agents) or screen(target) != "draft":
    fail("not-submitted")
subprocess.run(["tmux", "send-keys", "-t", target, "Tab" if kind == "codex" else "Enter"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
deadline = time.time() + SUBMIT_WAIT
while screen(target) == "draft":
    if time.time() >= deadline:
        fail("not-submitted")
    time.sleep(0.1)
print(json.dumps({"ok": True}))
`;

/** What the pane runs, from MIRROR_LOCATE's output. */
export type PaneAgent =
  | { kind: "no-pane" }
  | { kind: "no-agent"; inMode: boolean }
  | { kind: "other"; runtime: string; inMode: boolean }
  | { kind: "claude"; pid: number; start: string; inMode: boolean; sid: string | null; status: "idle" | "busy" | "waiting" | null }
  /** `open`: thread ids of the rollouts the process has open. `titleThread`: the thread id (a prefix of it) the pane's
   *  title shows (codexTitleThread), null when it shows none. */
  | { kind: "codex"; pid: number; start: string; inMode: boolean; home: string | null; open: string[]; titleThread: string | null };

// agent-launch has Codex put its thread id in the terminal title (image/co, `tui.terminal_title` item "thread-id"),
// truncated by Codex to 29 characters and "..." (verified on 0.172.0). Unlike its rollouts and hooks, the title
// changes the moment `/new` or `/resume` switches the conversation, so it tells whether a message typed in now lands in
// the conversation the chat shows. 24 characters (up to the fourth group) is the least taken as an id.
const TITLE_THREAD = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}/g;

/** The one thread id (or its truncated prefix) in a Codex pane's title; null for none, a short one, or several. */
export function codexTitleThread(title: string): string | null {
  const ids = title.match(TITLE_THREAD) ?? [];
  return ids.length === 1 && ids[0]!.length >= 24 ? ids[0]! : null;
}

/** null when the output is not what MIRROR_LOCATE prints. */
export function parseLocate(stdout: string): PaneAgent | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { pane?: unknown; procs?: unknown; claude?: unknown; codex?: unknown };
  if (o.pane === null) return { kind: "no-pane" };
  const pane = o.pane as { pid?: unknown; inMode?: unknown; title?: unknown } | undefined;
  if (typeof pane?.pid !== "number" || typeof pane.inMode !== "boolean" || !Array.isArray(o.procs) || typeof o.claude !== "object" || o.claude === null
    || typeof o.codex !== "object" || o.codex === null) return null;
  const procs: Proc[] = [];
  const starts = new Map<number, string>();
  for (const p of o.procs) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || typeof p[2] !== "string" || typeof p[3] !== "string") return null;
    procs.push({ pid: p[0], ppid: p[1], etimes: 0, comm: p[2] });
    starts.set(p[0], p[3]);
  }
  const nearest = agentProcsUnder(pane.pid, procs, AGENT_RUNTIMES)[0];
  if (!nearest) return { kind: "no-agent", inMode: pane.inMode };
  if (nearest.comm === "codex") {
    const info = (o.codex as Record<string, { home?: unknown; open?: unknown }>)[String(nearest.pid)];
    const home = typeof info?.home === "string" && codexHomeAllowed(info.home) ? info.home : null;
    const open = Array.isArray(info?.open) ? info.open.filter((t): t is string => typeof t === "string" && UUID.test(t)) : [];
    const titleThread = typeof pane.title === "string" ? codexTitleThread(pane.title) : null;
    return { kind: "codex", pid: nearest.pid, start: starts.get(nearest.pid)!, inMode: pane.inMode, home, open, titleThread };
  }
  if (nearest.comm !== "claude") return { kind: "other", runtime: nearest.comm, inMode: pane.inMode };
  const info = (o.claude as Record<string, { sid?: unknown; status?: unknown }>)[String(nearest.pid)];
  const sid = typeof info?.sid === "string" && UUID.test(info.sid) ? info.sid : null;
  const status = info?.status === "idle" || info?.status === "busy" || info?.status === "waiting" ? info.status : null;
  return { kind: "claude", pid: nearest.pid, start: starts.get(nearest.pid)!, inMode: pane.inMode, sid, status };
}

/** The Codex account (as `co` names it) whose home `home` is; `home` is one codexHomeAllowed accepts. */
function codexAccountOf(home: string): string {
  return home === "/home/dev/.codex" ? "default" : home.slice(CODEX_PROFILE_ROOT.length + 1);
}

/** The homes a session's codex may read from: the default one or an account profile's (the rule
 *  codexSessionAccounts' accountFromEnvironment applies). Any other CODEX_HOME is the agent's own choice and not read. */
export function codexHomeAllowed(home: string): boolean {
  if (home === "/home/dev/.codex") return true;
  return home.startsWith(`${CODEX_PROFILE_ROOT}/`) && UUID.test(home.slice(CODEX_PROFILE_ROOT.length + 1));
}

const runtimeLabel = (runtime: string): string => Object.values(AGENTS).find((a) => a.runtime === runtime)?.label ?? runtime;

// ── Reading the transcript ───────────────────────────────────────────────────────────

const readFdAsync = promisify(readFd);

export interface Chunk { lines: string[]; next: number; skipped: number }

/** Complete lines from `offset` (at most `budget` bytes, or one line up to `lineCap`); an unfinished last line is left
 *  for the next read. A line longer than `lineCap` is skipped unparsed (`skipped` counts them). */
export async function readChunk(fd: number, offset: number, size: number, budget = CHUNK_BYTES, lineCap = LINE_CAP): Promise<Chunk> {
  // Async (the thread pool reads it): a transcript never mirrored before is read whole before an end.
  const read = async (at: number, n: number): Promise<Buffer> => {
    const b = Buffer.alloc(n);
    const { bytesRead } = await readFdAsync(fd, b, 0, n, at);
    return b.subarray(0, bytesRead);
  };
  if (offset >= size) return { lines: [], next: offset, skipped: 0 };
  let buf = await read(offset, Math.min(size - offset, budget));
  let nl = buf.lastIndexOf(0x0a);
  if (nl === -1) {
    // One line longer than the budget: read it whole while it fits the cap.
    if (size - offset <= budget) return { lines: [], next: offset, skipped: 0 }; // still being written
    buf = await read(offset, Math.min(size - offset, lineCap + 1));
    nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length <= lineCap) return { lines: [], next: offset, skipped: 0 }; // still being written
      // Over the cap: find its end without keeping it.
      let at = offset + buf.length;
      while (at < size) {
        const part = await read(at, Math.min(size - at, 1024 * 1024));
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

export function clipInput(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > INPUT_STRING_CHARS ? `${v.slice(0, INPUT_STRING_CHARS)}…` : v;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => clipInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipInput(x, depth + 1)]));
}

export function clipOutput(text: string): string {
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
  /** Claude's session id, or the Codex thread id. */
  sid: string | null;
  ino: number;
  offset: number;
  headLen: number;
  headHash: string;
  map: MapState | CodexMapState;
  /** Codex: the process that read last (`pid:start`). A turn its predecessor left open (killed mid-turn) never ends
   *  otherwise. */
  proc?: string;
  /** Codex: the home read from (another home is another file of the same thread, so a new inode is no rewrite there). */
  home?: string;
  /** Codex: the account announced in thread.native (the home's), so a session ending holds where its thread is. */
  account?: string;
  /** Codex: codexThread's watch, kept so a devd restart does not take a process it saw before for a first look. */
  watch?: CodexWatch;
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
  "codex-send-unsupported": "This Codex doesn't show its conversation in the terminal title, so devd can't tell where a message would land. Restart it from devbox to send from chat, or reply in the terminal.",
  "unsupported-agent": "Chat view isn't supported for this agent yet.",
  "unsupported-host": "Chat view isn't supported on InstaBox sessions yet.",
  "pane-changed": "The terminal changed while the message was being sent; nothing was typed. Check the terminal.",
  // MIRROR_SEND pasted the text, then did not press Enter, or pressed it and the prompt still holds the text.
  "not-submitted": "The message was typed into the terminal but not submitted (the terminal changed, or a popup or suggestion took the Enter); it may still be in the terminal's prompt. Check the terminal.",
};

/** The lock while the title names another Codex thread than the one mirrored. */
const CODEX_MOVED = "The terminal is on another Codex conversation than this chat shows (after /new or /resume). Send its first prompt in the terminal and the chat follows, or use the terminal.";

export interface MirrorDeps {
  db: Parameters<typeof getSession>[0];
  root: string;
  bus: EventBus;
  isEnding: (id: string) => boolean;
  /** docker exec into the session's container; `stdin` is piped to the command. */
  exec: (container: string, cmd: string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
  /** docker's view of the container (docker.ts containerState): tells a stopped container from a failed exec. */
  containerState: (container: string) => Promise<"running" | "exited" | "missing">;
  /** The session's hook-derived state (AgentEventHub.liveSnapshot): the reason a waiting agent gives. */
  live: (id: string) => AgentLiveSnapshot | null;
  now?: () => number;
  log?: (msg: string) => void;
  /** How long the last read before an end may take (FINAL_READ_MS); tests shorten it. */
  finalReadMs?: number;
}

/** The last read before an end reads a Codex backlog to its end, not CODEX_TICK_CHUNKS of it, but for at most this
 *  long: end() waits for it with the session locked. */
export const FINAL_READ_MS = 60_000;

interface Pending { text: string; at: number }

/** The Codex conversation the pane is on (null: none known yet), and whether a turn of it runs (as far as the read has
 *  got: a backlog takes several refreshes). */
interface CodexState { thread: string | null; busy: boolean }

/** codexThread's view of the pane's codex process (`pid:start`): the rollouts seen open, and the newest hook row at the
 *  time one opened that was not the choice (null: no wait). */
interface CodexWatch { proc: string; known: string[]; waitAfter: number | null }

/** Chunks of a Codex backlog read per refresh. */
export const CODEX_TICK_CHUNKS = 4;

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
  /** What the last refresh found in the pane: what a send checks before typing (only into Claude). */
  private panes = new Map<string, PaneAgent | null>();
  /** Per session, for the pane's codex process (`pid:start`): the rollouts it was seen with open, and the newest hook
   *  row at the time an unchosen one newly opened (see codexThread). */
  private codexWatch = new Map<string, CodexWatch>();
  /** Sessions whose last read before the end runs now (finalRefresh): for it alone they are not ending yet. */
  private finalizing = new Set<string>();
  /** Sessions whose last read stopped short (the time cap, a read that failed): their transcript is not complete. */
  private cutShort = new Set<string>();
  /** Sessions whose final live read could not reach the pane (finalRefresh), for the read after the stop (finalTail). */
  private finalLocateFailed = new Set<string>();

  constructor(private d: MirrorDeps) {}

  private ending(id: string): boolean { return this.d.isEnding(id) && !this.finalizing.has(id); }

  private now() { return this.d.now?.() ?? Date.now(); }
  private log(msg: string) { (this.d.log ?? ((m) => console.error(m)))(msg); }

  /** The tmux session the mirror may serve, or why not. */
  session(id: string): { s: SessionRow } | { error: "unknown-session" | "not-a-tmux-session" | "session-ending" } {
    const s = getSession(this.d.db, id);
    if (!s) return { error: "unknown-session" };
    if (storedRuntime(s) !== "tmux") return { error: "not-a-tmux-session" };
    if (this.ending(id)) return { error: "session-ending" };
    return { s };
  }

  private gen(id: string): number { return this.generation.get(id) ?? 0; }

  store(id: string): ThreadStore {
    const open = this.stores.get(id);
    if (open) return open;
    if (this.ending(id)) throw new Error(`session ${id} is ending`);
    const store = ThreadStore.open(this.d.root, id, { dir: "_mirrors", onNotice: (item) => this.d.bus.publish(`mirror:${id}`, { notice: item }) });
    this.stores.set(id, store);
    return store;
  }

  info(id: string): MirrorInfo {
    return this.infos.get(id) ?? { state: "no-pane", agent: null, conversationId: null, activity: null, terminalPrompt: null, sendBlock: null };
  }

  /** A read of the pane got as far as its info since devd started (or since release): `info` is what it found. */
  hasRead(id: string): boolean { return this.infos.has(id); }

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

  /** The last read of an ending session, while its container still runs: end() (sessions.ts) archives the store as
   *  the ended session's transcript. Waits for a refresh in progress (it stops at its next step: the session is
   *  ending), then reads to the end of the transcript, within FINAL_READ_MS. `truncated`: it did not get there (the
   *  cap, a failed read), logged. Never throws. */
  async finalRefresh(id: string): Promise<{ truncated: boolean }> {
    await this.running.get(id);
    this.finalizing.add(id);
    this.cutShort.delete(id);
    this.finalLocateFailed.delete(id);
    const run = this.tick(id).catch((e) => {
      this.cutShort.add(id);
      this.log(`mirror ${id}: final refresh failed, the transcript ends where the last read got to: ${(e as Error).message}`);
    }).finally(() => { this.finalizing.delete(id); this.running.delete(id); });
    this.running.set(id, run);
    await run;
    const truncated = this.cutShort.delete(id);
    return { truncated };
  }

  /** The read after the backup stopped the container (end() calls it after finalRefresh): Claude kept writing until
   *  then, and the backup may wait many minutes for its turn. Reads the host copy of the conversation to its end,
   *  without a pane. Which conversation: the one the store's cursor holds, which the last live read pinned (also
   *  before a restart: the cursor is in the store). Without one, the session's own projects dir decides, but only
   *  when it holds exactly one conversation; with several none is picked and `threadNote` says so. `truncated`: the
   *  read failed, or the final live read could not reach the pane, so the agent may have moved to another
   *  conversation since the cursor's. null for an agent other than Claude: its live read was the last. Never throws. */
  async finalTail(id: string): Promise<{ truncated: boolean; threadNote?: string } | null> {
    const s = getSession(this.d.db, id);
    if (!s || (s.agent ?? "claude") !== "claude") { this.finalLocateFailed.delete(id); return null; }
    await this.running.get(id);
    this.finalizing.add(id);
    this.cutShort.delete(id);
    const unsure = this.finalLocateFailed.delete(id);
    let threadNote: string | undefined;
    let nothingToAdd = false;
    const run = (async () => {
      // A pinned conversation whose file is not in the projects dir (a Codex thread in a Claude session's pane):
      // nothing to add here, the live read's result stands.
      const pinned = this.pinned(id);
      if (pinned !== null && !this.conversations(id).some((c) => c.sid === pinned)) { nothingToAdd = true; return; }
      threadNote = await this.readPaneless(id, unsure);
    })().catch((e) => {
      this.cutShort.add(id);
      this.log(`mirror ${id}: the read after the stop failed, the transcript ends where the last read got to: ${(e as Error).message}`);
    }).finally(() => { this.finalizing.delete(id); this.running.delete(id); });
    this.running.set(id, run);
    await run;
    const truncated = this.cutShort.delete(id);
    if (nothingToAdd) return null;
    return threadNote === undefined ? { truncated } : { truncated, threadNote };
  }

  /** The conversation the store's cursor holds: the one the last live read named. */
  private pinned(id: string): string | null {
    const stored = this.stores.has(id) || existsSync(join(this.d.root, "_mirrors", `${id}.sqlite`));
    const saved = stored ? this.store(id).mirrorCursor() : null;
    return saved ? (JSON.parse(saved) as Cursor).sid : null;
  }

  /** The Claude conversations in the session's projects dir (regular files only), newest first. */
  private conversations(id: string): { sid: string; mtime: number }[] {
    try {
      return withDir(this.d.root, ["_claude-projects", id], false, (dir) => readdirSync(dir.path, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && UUID.test(e.name.slice(0, -6)))
        .map((e) => ({ sid: e.name.slice(0, -6), mtime: lstatSync(join(dir.path, e.name)).mtimeMs })))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async readPaneless(id: string, unsure: boolean): Promise<string | undefined> {
    const gen = this.gen(id);
    const current = () => gen === this.gen(id) && !this.ending(id);
    const pinned = this.pinned(id);
    const all = this.conversations(id);
    if (pinned !== null) {
      if (unsure) this.cutShort.add(id);
      await this.read(id, pinned, true, current);
      // A newer conversation than the pinned one (a /clear nobody watched): the session may have ended there.
      const newest = all[0];
      if (newest && newest.sid !== pinned && newest.mtime > (all.find((c) => c.sid === pinned)?.mtime ?? 0)) {
        this.cutShort.add(id);
        return `The session's newest Claude conversation (${newest.sid}) is not the one the last read of its terminal named (${pinned}); the transcript is that one.`;
      }
      return undefined;
    }
    if (all.length === 0) return undefined;
    if (all.length === 1) { await this.read(id, all[0]!.sid, true, current); return undefined; }
    return `The session holds ${all.length} Claude conversations and no read of its terminal named the one it ended on, so none was picked.`;
  }

  /** Session stopped or ended: closes the store. An ended session's store stays on disk for end() to archive. */
  release(id: string): void {
    this.generation.set(id, this.gen(id) + 1);
    const w = this.watchers.get(id);
    if (w) { clearInterval(w.timer); this.watchers.delete(id); }
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
    this.d.bus.publish(`mirror:${id}`, { released: true });
    this.stores.get(id)?.close();
    this.stores.delete(id);
    this.infos.delete(id);
    this.panes.delete(id);
    this.codexWatch.delete(id);
    this.pending.delete(id);
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

  /** `codex`: what reading the rollout found (null: it could not be read). */
  private infoFor(id: string, s: SessionRow, pane: PaneAgent | null, codex: CodexState | null = null): MirrorInfo {
    const base = { conversationId: null, activity: null, terminalPrompt: null } as const;
    const block = (code: MirrorSendError, message = SEND_MESSAGES[code]) => ({ code, message });
    if ((s.host ?? "vps") === "instabox") return { ...base, state: "unsupported", agent: null, sendBlock: block("unsupported-host") };
    if (pane === null || pane.kind === "no-pane") return { ...base, state: "no-pane", agent: null, sendBlock: block("agent-not-running", "The terminal is not running.") };
    if (pane.kind === "no-agent") return { ...base, state: "agent-exited", agent: null, sendBlock: block("agent-not-running") };
    if (pane.kind === "other") {
      const label = runtimeLabel(pane.runtime);
      return { ...base, state: "unsupported", agent: label, sendBlock: block("unsupported-agent", `Chat view isn't supported for ${label} yet.`) };
    }
    if (pane.kind === "codex") {
      const agent = AGENTS.codex.label;
      // Which conversation Codex's TUI is on changes with /new and /resume, which neither its rollouts nor its hooks
      // show until the next prompt: only its title does (codexTitleThread). Without the id there, a message typed in
      // from here could land in another conversation than the one shown.
      if (pane.titleThread === null) {
        const sendBlock = block("codex-send-unsupported");
        if (codex?.thread == null) return { ...base, state: "unresolved", agent, sendBlock };
        return { ...this.codexLive(id, codex.thread, codex.busy), agent, sendBlock };
      }
      if (codex?.thread == null) return { ...base, state: "unresolved", agent, sendBlock: block("conversation-unknown") };
      const info = this.codexLive(id, codex.thread, codex.busy);
      const sendBlock = !codex.thread.startsWith(pane.titleThread) ? block("conversation-unknown", CODEX_MOVED)
        : info.activity === "waiting" ? block("agent-waiting-in-terminal") : pane.inMode ? block("terminal-scrolled") : null;
      return { ...info, agent, sendBlock };
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

  /** A Codex pane's info apart from the agent and the send lock. Codex reports no status of its own: waiting comes
   *  from its hook events, a running turn from the rollout. */
  private codexLive(id: string, thread: string, busy: boolean): Omit<MirrorInfo, "agent" | "sendBlock"> {
    const live = this.d.live(id);
    const waiting = live?.status === "waiting";
    return {
      state: "live", conversationId: thread, activity: waiting ? "waiting" : busy ? "busy" : "idle",
      terminalPrompt: waiting ? { text: live.reason || "The agent is waiting for an answer in the terminal." } : null,
    };
  }

  private async tick(id: string): Promise<void> {
    const r = this.session(id);
    if ("error" in r) return;
    const { s } = r;
    const gen = this.gen(id);
    const current = () => gen === this.gen(id) && !this.ending(id);
    const reachable = (s.host ?? "vps") !== "instabox" && s.status === "running";
    const pane = reachable ? await this.locate(s) : null;
    if (!current()) return;
    // A final read that could not ask the pane (a failed or timed-out exec) is no proof the pane is gone: what it shows
    // is unknown, so the transcript is not complete and the read after the stop does not trust the cursor either.
    // A container docker reports exited (the backup stopped it; the row says running until the end is done) certainly
    // has no pane: nothing is unknown there.
    if (reachable && pane === null && this.finalizing.has(id) && await this.d.containerState(s.container) !== "exited") {
      this.cutShort.add(id);
      this.finalLocateFailed.add(id);
      this.log(`mirror ${id}: the final read could not reach the pane`);
    }
    // The pane is known to a send only together with the info from the same refresh: one that fails partway (a read
    // that throws) leaves neither, so a send never pairs a fresh pane with an older info.
    this.panes.delete(id);
    if (pane?.kind === "codex") {
      const codex = await this.readCodex(id, s, pane, current);
      if (!current()) return;
      this.setInfo(id, this.infoFor(id, s, pane, codex));
      this.panes.set(id, pane);
    } else {
      this.setInfo(id, this.infoFor(id, s, pane));
      if (pane?.kind === "claude" && pane.sid !== null) await this.read(id, pane.sid, pane.status === "idle", current);
      if (!current()) return;
      this.panes.set(id, pane);
    }
    if (!current()) return;
    this.checkPending(id);
  }

  /** The Codex threads this session's hook events named, newest first, with the id of each one's newest hook row and
   *  newest prompt row (codexHarvester attributes usage the same way); `last`: the newest hook row of any thread. The
   *  pane's thread falls out of the limit only after 100 other threads (Claude's included) had hooks in this session
   *  since its last one; hooks carry no pid to key by. notify_log keeps 14 days, so a thread with no hook for that long
   *  is unknown until its next prompt. */
  private codexHooks(id: string): { threads: { thread: string; hook: number; prompt: number }[]; last: number } {
    const rows = this.d.db.query(`SELECT agent_session_id AS thread, MAX(id) AS hook,
      COALESCE(MAX(CASE WHEN event = 'user_prompt_submit' THEN id END), 0) AS prompt
      FROM notify_log WHERE session_id = ? AND agent_session_id IS NOT NULL
      GROUP BY agent_session_id ORDER BY hook DESC LIMIT 100`).all(id) as { thread: string; hook: number; prompt: number }[];
    return { threads: rows.filter((r) => UUID.test(r.thread)), last: rows[0]?.hook ?? 0 };
  }

  /** The conversation the pane's codex is on: the newest hook-named thread whose rollout the process has open
   *  (codexMirror.ts), with two guards against showing another conversation as this one. A thread whose newest hook is
   *  older than the cursor's thread's is never fallen back to (the cursor's rollout missing from a flaky fd listing, a
   *  `codex resume` of an older thread before its first prompt). And while the process has a rollout open besides the
   *  choice that devd did not see open before (`/resume X`, `/new` at its first prompt), or on the first look at a
   *  process with several open (devd did not see which came last), the conversation is unknown until a prompt is
   *  submitted in the chosen thread after that: only a prompt starts a turn there, a late hook of an older turn (Stop
   *  runs up to 300 s) does not.
   *
   *  Not detectable: `/new` before its first prompt. No rollout exists yet, so the old conversation shows until then. */
  private codexThread(id: string, pane: Extract<PaneAgent, { kind: "codex" }>, cursor: Cursor): string | null {
    const { threads, last } = this.codexHooks(id);
    const proc = `${pane.pid}:${pane.start}`;
    let watch = this.codexWatch.get(id) ?? cursor.watch;
    const chosen = threads.find((t) => pane.open.includes(t.thread));
    if (watch?.proc !== proc) watch = { proc, known: [], waitAfter: null };
    else watch = { ...watch, known: [...watch.known] };
    this.codexWatch.set(id, watch);
    if (pane.open.some((t) => !watch.known.includes(t) && t !== chosen?.thread)) watch.waitAfter = Math.max(watch.waitAfter ?? 0, last);
    for (const t of pane.open) if (!watch.known.includes(t)) watch.known.push(t);
    if (!chosen) return null;
    const cursorHook = threads.find((t) => t.thread === cursor.sid)?.hook ?? 0;
    if (chosen.hook < cursorHook) return null;
    if (watch.waitAfter !== null) {
      if (chosen.prompt <= watch.waitAfter) return null;
      watch.waitAfter = null;
    }
    return chosen.thread;
  }

  /** Reads the pane's Codex rollout from where the cursor stopped, inside the container (the account volume is not
   *  devd's to read), at most CODEX_TICK_CHUNKS chunks per refresh. null when it could not be read. */
  private async readCodex(id: string, s: SessionRow, pane: Extract<PaneAgent, { kind: "codex" }>, current: () => boolean): Promise<CodexState | null> {
    const store = this.store(id);
    const saved = store.mirrorCursor();
    let cur: Cursor = saved ? JSON.parse(saved) as Cursor : { sid: null, ino: 0, offset: 0, headLen: 0, headHash: "", map: newCodexMapState() };
    const thread = pane.home === null ? null : this.codexThread(id, pane, cur);
    const watch = this.codexWatch.get(id);
    if (watch && JSON.stringify(watch) !== JSON.stringify(cur.watch)) {
      cur = { ...cur, watch };
      store.applyBatch([], JSON.stringify(cur));
    }
    if (pane.home === null || thread === null) return { thread: null, busy: false };
    const proc = `${pane.pid}:${pane.start}`;
    const final = this.finalizing.has(id);
    const deadline = Date.now() + (this.d.finalReadMs ?? FINAL_READ_MS);
    for (let chunk = 1; ; chunk++) {
      const r = await this.d.exec(s.container, ["python3", "-I", "-c", MIRROR_CODEX_READ, pane.home, thread,
        JSON.stringify({ sid: cur.sid, offset: cur.offset, ino: cur.ino, headLen: cur.headLen, headHash: cur.headHash, home: cur.home }),
        String(CODEX_CHUNK_BYTES), String(CODEX_LINE_CAP)], 10_000);
      if (!current()) return null;
      const out = r.code === 0 && !r.timedOut ? parseCodexRead(r.stdout) : null;
      if (out === null) {
        this.log(`mirror ${id}: the Codex rollout could not be read`);
        if (final) this.cutShort.add(id);
        return null;
      }
      if (out.id === null) return { thread: null, busy: false };
      const pre: BridgeEvent[] = [];
      const closeOpenRun = () => {
        if (cur.map.openRun !== null) pre.push({ type: "run.completed", runId: cur.map.openRun, nativeThreadId: cur.sid ?? "", usage: null, costUsd: null });
      };
      const from = cur.sid === out.id && !out.rewritten ? cur.offset : 0;
      const account = codexAccountOf(pane.home);
      if (cur.sid !== out.id) {
        if (cur.sid !== null) { closeOpenRun(); pre.push({ type: "bridge.notice", text: "New conversation" }); }
        pre.push({ type: "thread.native", harness: "codex", nativeThreadId: out.id, account, model: null });
        cur = { ...cur, sid: out.id, map: newCodexMapState(), account };
      } else {
        if (out.rewritten) {
          closeOpenRun();
          pre.push({ type: "bridge.notice", text: "The transcript was rewritten; it is read again from the start" });
          cur = { ...cur, map: newCodexMapState() };
        }
        // The same thread in another account's home (an account switch), or a mirror that announced it before the
        // account was recorded: the account is announced again, as continue copies the thread from there.
        if (cur.account !== account) {
          pre.push({ type: "thread.native", harness: "codex", nativeThreadId: out.id, account, model: null });
          cur = { ...cur, account };
        }
      }
      const map = cur.map as CodexMapState;
      // Another codex process now writes the thread (resumed after its predecessor died): that one's turn is over.
      if (cur.proc !== undefined && cur.proc !== proc && map.turn !== null) {
        if (map.openRun !== null) pre.push({ type: "run.interrupted", runId: map.openRun });
        map.openRun = null;
        map.turn = null;
      }
      if (out.skipped > 0) this.log(`mirror ${id}: skipped ${out.skipped} rollout line(s) over ${CODEX_LINE_CAP} bytes`);
      const mapped = mapCodexLines(out.lines, map, out.id, this.now());
      const advanced = out.next !== from;
      const moved = cur.proc !== proc || cur.home !== pane.home;
      cur = { ...cur, ino: out.ino, offset: out.next, headLen: out.headLen, headHash: out.headHash, home: pane.home, proc };
      if (advanced || pre.length || moved) this.commit(id, store, pre, mapped.events, cur);
      this.markSeen(id, mapped.seen);
      const done = !advanced || out.next >= out.size;
      if (done) return { thread: out.id, busy: map.turn !== null };
      // A long backlog continues on the next refresh, so one refresh stays a bounded read; the last one has no next.
      if (!final && chunk >= CODEX_TICK_CHUNKS) return { thread: out.id, busy: map.turn !== null };
      if (final && Date.now() >= deadline) {
        this.cutShort.add(id);
        this.log(`mirror ${id}: the last read stopped after ${chunk} chunks (${out.next} of ${out.size} bytes): the transcript is cut short`);
        return { thread: out.id, busy: map.turn !== null };
      }
      if (!current()) return null;
    }
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
        const chunk = await readChunk(fd, cur.offset, st.size);
        // Released or ended while it read: the store is closed.
        if (!current()) return;
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

  /** Types `text` into the pane's agent prompt and submits it, or refuses with the reason. Never types into anything
   *  but a verified, ready Claude prompt or Codex composer (and Codex only while its title names the mirrored thread). */
  async send(id: string, text: string): Promise<void> {
    // Leading blank lines would leave an agent's prompt looking empty after the paste, so Enter would not be pressed.
    text = text.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "");
    if (text.trim() === "") throw new MirrorSendRefused("bad-request", "text must be a non-empty string");
    if (text.length > MAX_MESSAGE_CHARS) throw new MirrorSendRefused("bad-request", `text is longer than ${MAX_MESSAGE_CHARS} characters`);
    // An escape could end the bracketed paste early and turn the rest into keystrokes (`\e[201~` then `!cmd`).
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) {
      throw new MirrorSendRefused("bad-request", "The message contains invisible control characters (from a paste?); remove them and send again.");
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
      // A fresh look at the pane and the conversation.
      await this.refresh(id);
      const pane = this.panes.get(id);
      if (pane === undefined) throw new MirrorSendRefused("terminal-not-ready", "devd could not check the terminal just now. Try again, or use the terminal.");
      const info = this.info(id);
      if ((pane?.kind !== "claude" && pane?.kind !== "codex") || info.sendBlock || (pane.kind === "codex" && info.conversationId === null)) {
        const b = info.sendBlock ?? { code: "agent-not-running" as const, message: SEND_MESSAGES["agent-not-running"] };
        throw new MirrorSendRefused(b.code, b.message);
      }
      const thread = pane.kind === "codex" ? info.conversationId! : "";
      const sent = await this.d.exec(s.container, ["python3", "-I", "-c", MIRROR_SEND, MIRROR_PANE, String(pane.pid), AGENT_RUNTIMES.join(","), pane.start, pane.kind, thread], 15_000, text);
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
