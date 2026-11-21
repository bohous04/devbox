// The Codex half of the tmux mirror (transcriptMirror.ts): reading a Codex rollout and mapping it onto thread events.
//
// Where the rollout is: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` on the account's codex
// volume, which only the container mounts, so the read runs inside it (MIRROR_CODEX_READ). Which thread: Codex's hook
// events carry it (`notify_log.agent_session_id`, as codexHarvester attributes usage), and the pane's codex process
// keeps the rollouts of its conversations open (verified on 0.166.0, also the one left by `/new`): the newest hook-named
// thread whose rollout the pane's process has open is the conversation the pane is on (TranscriptMirror.codexThread
// adds the guards). That rules out another codex in the session (another window, `codex exec`) and a fresh codex before
// its first prompt, whose rollout does not exist yet. A `/new` conversation shows up with its first prompt's hook event.
// The running rollout stays plain `.jsonl`.
//
// Subagents (verified on 0.166.0): a spawned agent runs in the same process, with a rollout of its own that the process
// keeps open and whose session_meta has `source.subagent`. Whether it sends hook events of its own was not verified;
// the locate probe drops subagent rollouts from the open ones either way, so its thread can never be the choice.
//
// The rollout's shape (verified on codex-cli 0.166.0): `{timestamp, type, payload}` lines. A turn runs from
// `event_msg task_started` to `task_complete` (or `turn_aborted`); what the user typed is `event_msg item_completed`
// with a `UserMessage` item (older versions: `event_msg user_message`), a second one inside a running turn is a steer.
// `response_item` carries the model's side: `message` (role assistant; the user/developer ones are model input with
// injected context), `function_call`/`custom_tool_call` and their `*_output`, `reasoning` (dropped).
import type { BridgeEvent } from "../../shared/thread";
import { clipInput, clipOutput, type MapState, type Mapped } from "./transcriptMirror";

/** Lines read per exec: one exec returns at most about this many bytes of rollout (plus one line up to the cap). */
export const CODEX_CHUNK_BYTES = 1024 * 1024;
/** A rollout line longer than this is skipped unread (it all goes through docker exec within the script's alarm). */
export const CODEX_LINE_CAP = 4 * 1024 * 1024;

// Finds the thread's rollout and reads complete lines from the cursor (from 0 for another thread, or when the file is
// not the one the cursor read: shorter, a changed head, or another inode in the same home; a thread moved to another
// account's home keeps its head, so it reads on). Prints one JSON object (`{"id": null}`: no single rollout of it);
// `lines` are the rollout's own lines, so this is the only output that carries conversation content.
//
// The walk opens every directory relative to its parent with O_NOFOLLOW: the agent owns the volume and could plant a
// symlink anywhere below the home (`sessions/2026 -> /`). `path` (the cursor's last find) is tried before a full scan.
export const MIRROR_CODEX_READ = String.raw`# MIRROR_CODEX_READ
import hashlib, json, os, re, signal, stat, sys
# Below the docker exec timeout (10 s).
signal.alarm(8)
home, thread, cur, budget, cap = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
HEAD = 256
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
NAME = re.compile(r"rollout-[^/]*-" + re.escape(thread) + r"\.jsonl")
CALL = re.compile(rb'"type":\s*"(?:function_call_output|custom_tool_call_output)".*?"call_id":\s*"([^"\\]{1,200})"|"call_id":\s*"([^"\\]{1,200})".*?"type":\s*"(?:function_call_output|custom_tool_call_output)"', re.S)

def emit(o):
    # Not ASCII-escaped: escaping would multiply the size of non-Latin text going through docker exec.
    sys.stdout.buffer.write(json.dumps(o, ensure_ascii=False).encode("utf-8"))

def opendir(parent, name):
    try:
        return os.open(name, DIR, dir_fd=parent)
    except OSError:
        return None

def subdirs(fd):
    return sorted(n for n in os.listdir(fd) if re.fullmatch(r"\d{2,4}", n))

def find(root):
    """[(year, month, day, name)] of the thread's rollouts below sessions/."""
    sessions = opendir(root, "sessions")
    if sessions is None:
        return []
    hint = cur.get("path") if cur.get("sid") == thread else None
    if isinstance(hint, list) and len(hint) == 4 and all(isinstance(x, str) for x in hint) and NAME.fullmatch(hint[3]):
        found = walk(sessions, [hint[0]], lambda y: [hint[1]], lambda m: [hint[2]], lambda d: [hint[3]] if hint[3] in os.listdir(d) else [])
        if found:
            return found
    return walk(sessions, subdirs(sessions), subdirs, subdirs, lambda d: [n for n in os.listdir(d) if NAME.fullmatch(n)])

def walk(sessions, years, months, days, names):
    found = []
    for y in years:
        yfd = opendir(sessions, y)
        if yfd is None:
            continue
        for m in months(yfd):
            mfd = opendir(yfd, m)
            if mfd is None:
                continue
            for d in days(mfd):
                dfd = opendir(mfd, d)
                if dfd is None:
                    continue
                found += [(y, m, d, n, dfd) for n in names(dfd)]
    return found

root = os.open(home, DIR)
hits = find(root)
if len(hits) != 1:
    emit({"id": None})
    sys.exit(0)
y, m, d, name, dfd = hits[0]
try:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
except FileNotFoundError:
    emit({"id": None})
    sys.exit(0)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode):
    emit({"error": "not-a-file"})
    sys.exit(0)
head = lambda n: hashlib.sha256(os.pread(fd, n, 0)).hexdigest()
offset, rewritten = 0, False
if cur.get("sid") == thread:
    offset = cur.get("offset", 0)
    moved = st.st_ino != cur.get("ino") and cur.get("home") == home
    if offset > 0 and (moved or st.st_size < offset or head(cur.get("headLen", 0)) != cur.get("headHash")):
        offset, rewritten = 0, True
f = os.fdopen(fd, "rb")
f.seek(offset)
lines, pos, skipped = [], offset, 0
while pos - offset < budget:
    line = f.readline(cap + 1)
    if not line.endswith(b"\n"):
        if len(line) <= cap:
            break  # still being written
        # Over the cap: skip it unread, once its end is written.
        end, ended = pos + len(line), False
        while not ended:
            rest = f.readline(1 << 20)
            if not rest:
                break
            end += len(rest)
            ended = rest.endswith(b"\n")
        if not ended:
            break
        pos, skipped = end, skipped + 1
        # A tool's output too large to read still ends its tool: a stub output in its place.
        call = CALL.search(line[:65536])
        if call:
            lines.append(json.dumps({"type": "response_item", "payload": {"type": "function_call_output", "call_id": (call.group(1) or call.group(2)).decode("utf-8", "replace"),
                                                                         "output": "(output too large to show)"}}))
        else:
            lines.append("{}")  # keeps the line count, which entry ids are built from
        continue
    pos += len(line)
    lines.append(line[:-1].decode("utf-8", "replace") if line.strip() else "{}")
n = min(HEAD, st.st_size)
emit({"id": thread, "path": [y, m, d, name], "ino": st.st_ino, "size": st.st_size, "headLen": n, "headHash": head(n), "next": pos,
      "skipped": skipped, "rewritten": rewritten, "lines": lines})
`;

export type CodexRead =
  | { id: null }
  | { id: string; path: [string, string, string, string]; ino: number; size: number; headLen: number; headHash: string; next: number; skipped: number; rewritten: boolean; lines: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** null when the output is not what MIRROR_CODEX_READ prints (or it refused the file). */
export function parseCodexRead(stdout: string): CodexRead | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(stdout); } catch { return null; }
  if (typeof o !== "object" || o === null) return null;
  if (o.id === null) return { id: null };
  const num = (k: string) => typeof o[k] === "number" && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0;
  if (typeof o.id !== "string" || !UUID.test(o.id) || !["ino", "size", "headLen", "next", "skipped"].every(num)
    || typeof o.headHash !== "string" || typeof o.rewritten !== "boolean" || !Array.isArray(o.lines) || !o.lines.every((l) => typeof l === "string")
    || !Array.isArray(o.path) || o.path.length !== 4 || !o.path.every((x) => typeof x === "string")) return null;
  return o as CodexRead;
}

export interface CodexMapState extends MapState {
  /** The turn `task_started` opened; null between turns. */
  turn: string | null;
  /** Lines mapped so far: the id of an entry that has none of its own. */
  line: number;
}

export const newCodexMapState = (): CodexMapState => ({ openRun: null, lastRun: null, turn: null, line: 0 });

type Part = { type?: unknown; text?: unknown };

/** A tool's output: a string, or content parts (`input_text`, `input_image`). */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  const parts = Array.isArray(output) ? output : (output as { content?: unknown } | null)?.content;
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return (parts as Part[]).map((p) => (typeof p?.text === "string" ? p.text : p?.type === "input_image" ? "[image]" : "")).filter(Boolean).join("\n");
}

/** What the user typed: its text parts, and how many images. */
function userInput(parts: unknown): { text: string; images: number } {
  if (!Array.isArray(parts)) return { text: "", images: 0 };
  const texts = (parts as Part[]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string);
  return { text: texts.join("\n"), images: (parts as Part[]).filter((p) => p?.type === "image" || p?.type === "local_image").length };
}

/** Maps rollout lines (one JSON entry each) of thread `thread` to thread events. Pure: `st` is updated in place and
 *  saved with the cursor. Reasoning, model input and every entry type it does not know are dropped. */
export function mapCodexLines(lines: string[], st: CodexMapState, thread: string, now: number): Mapped {
  const events: Mapped["events"] = [];
  const seen: string[] = [];
  for (const line of lines) {
    const n = ++st.line;
    let j: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j !== "object" || j === null) continue;
    const parsed = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : now;
    const push = (event: BridgeEvent) => events.push({ ts, event });
    const p = typeof j.payload === "object" && j.payload !== null ? j.payload : {};
    const lineId = `${thread}:${n}`;
    const endRun = (end: "completed" | "interrupted" | { error: string } = "completed") => {
      if (st.openRun === null) return;
      if (end === "completed") push({ type: "run.completed", runId: st.openRun, nativeThreadId: thread, usage: null, costUsd: null });
      else if (end === "interrupted") push({ type: "run.interrupted", runId: st.openRun });
      else push({ type: "run.failed", runId: st.openRun, error: end.error });
      st.openRun = null;
    };
    /** The turn's run, started by whatever it shows first: the user's message or the agent's own. */
    const run = (origin: "user" | "agent", runId = `mirror:${st.turn ?? lineId}`): string => {
      if (st.openRun !== null) return st.openRun;
      push({ type: "run.started", runId, origin, nativeThreadId: null, model: null });
      st.openRun = runId;
      st.lastRun = runId;
      return runId;
    };

    if (j.type === "compacted") { push({ type: "bridge.notice", text: "Conversation compacted" }); continue; }
    if (j.type === "event_msg") {
      if (p.type === "task_started") {
        endRun();
        st.turn = typeof p.turn_id === "string" && p.turn_id !== "" ? p.turn_id : lineId;
      } else if (p.type === "task_complete") {
        const error = (p.error as { message?: unknown } | null | undefined)?.message;
        if (typeof error === "string") {
          // The store shows a failed run as its error; a turn that failed before showing anything has no run.
          if (st.openRun === null) push({ type: "bridge.notice", text: error });
          endRun({ error });
        } else endRun();
        st.turn = null;
      } else if (p.type === "turn_aborted") {
        endRun("interrupted");
        st.turn = null;
      } else {
        const item = p.type === "item_completed" ? p.item as { type?: unknown; id?: unknown; content?: unknown } | undefined : undefined;
        const legacy = p.type === "user_message" && typeof p.message === "string";
        if (item?.type !== "UserMessage" && !legacy) continue;
        const input = legacy ? { text: p.message as string, images: Array.isArray(p.images) ? p.images.length : 0 } : userInput(item!.content);
        if (input.text.trim() === "" && input.images === 0) continue;
        const text = [input.text, ...Array(input.images).fill("[image]")].filter(Boolean).join("\n");
        const key = typeof item?.id === "string" ? item.id : lineId;
        // A message sent into a running turn (a steer): a run holds one prompt, so what follows is a run of its own.
        const steer = st.openRun !== null;
        endRun();
        push({ type: "message.final", runId: run("user", steer ? `mirror:${st.turn ?? lineId}:${key}` : undefined), itemId: `user:${key}`, role: "user", text });
        seen.push(input.text);
      }
      continue;
    }
    if (j.type !== "response_item") continue;
    const id = typeof p.id === "string" && p.id !== "" ? p.id : lineId;
    if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      const text = (p.content as Part[]).filter((x) => x?.type === "output_text" && typeof x.text === "string").map((x) => x.text as string).join("\n");
      if (text.trim() !== "") push({ type: "message.final", runId: run("agent"), itemId: id, role: "assistant", text });
    } else if ((p.type === "function_call" || p.type === "custom_tool_call") && typeof p.call_id === "string" && typeof p.name === "string") {
      let input: unknown = p.type === "function_call" ? p.arguments : p.input;
      if (p.type === "function_call" && typeof input === "string") { try { input = JSON.parse(input); } catch { /* shown as the raw string */ } }
      push({ type: "tool.started", runId: run("agent"), itemId: p.call_id, tool: p.name, input: clipInput(input ?? null) });
    } else if (p.type === "local_shell_call" && typeof p.call_id === "string") {
      push({ type: "tool.started", runId: run("agent"), itemId: p.call_id, tool: "shell", input: clipInput(p.action ?? null) });
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && typeof p.call_id === "string") {
      const runId = st.openRun ?? st.lastRun;
      const failed = (p.output as { success?: unknown } | null)?.success === false;
      if (runId !== null) push({ type: "tool.finished", runId, itemId: p.call_id, isError: failed, output: clipOutput(outputText(p.output)) });
    }
  }
  return { events, seen };
}
