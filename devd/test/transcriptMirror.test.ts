import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { MirrorResponse } from "../../shared/mirror";
import type { ThreadItem } from "../../shared/thread";
import type { ExecResult } from "../src/ccUpkeep";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { EventBus } from "../src/eventBus";
import { registerMirrorRoutes } from "../src/mirrorApi";
import { ThreadStore } from "../src/threadStore";
import {
  mapClaudeLines, MIRROR_LOCATE, MIRROR_SEND, MirrorSendRefused, parseLocate, readChunk, SEEN_TIMEOUT_MS,
  TranscriptMirror, type MapState,
} from "../src/transcriptMirror";

const FIXTURE = join(import.meta.dir, "../../shared/fixtures/mirror/claude-transcript.jsonl");
const fixtureLines = () => readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim() !== "");
const SID = "11111111-2222-4333-8444-555555555555";
const SID2 = "22222222-3333-4444-8555-666666666666";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

/** Maps `lines` (in chunks of `size` lines) into a fresh store; returns the shown items in a compact form. */
function render(lines: string[], size = lines.length) {
  const store = ThreadStore.open(tmp("mirror-map-"), "dev-x", { dir: "_mirrors" });
  cleanups.push(() => store.close());
  const st: MapState = { openRun: null, lastRun: null };
  let seq = 0;
  const seen: string[] = [];
  for (let i = 0; i < lines.length; i += size) {
    const m = mapClaudeLines(lines.slice(i, i + size), st, 0);
    seen.push(...m.seen);
    store.applyBatch(m.events.map((e) => ({ seq: ++seq, ts: e.ts, event: e.event })), JSON.stringify(st));
  }
  return { snapshot: store.snapshot(), seen, st };
}

const brief = (i: ThreadItem) =>
  i.kind === "tool" ? `tool ${i.tool} ${i.status}${i.isError ? " error" : ""}: ${i.output ?? ""}` : `${i.kind}: ${i.text}`;

test("the fixture maps onto user, assistant, tool and notice items; thinking, sidechain, meta and noise are dropped", () => {
  const { snapshot, seen } = render(fixtureLines());
  expect(snapshot.items.map(brief)).toEqual([
    "notice: Ran /model",
    "user: List the files in the repository",
    "assistant: I'll list them.",
    "tool Bash done: README.md\nsrc",
    "tool Read done error: File does not exist.",
    "assistant: There are two entries: README.md and src.",
    "user: Also count them",
    "assistant: Two.",
    "user: What is in this screenshot?\n[image]",
    "tool AskUserQuestion done error: The user doesn't want to proceed with this tool use.",
    "notice: Conversation compacted",
    "assistant: The background task finished.",
  ]);
  expect(snapshot.runs.map((r) => [r.origin, r.status])).toEqual([
    ["user", "completed"], ["user", "completed"], ["user", "interrupted"], ["agent", "completed"],
  ]);
  // Every run has its end seq, which the changes card anchors on.
  expect(snapshot.runs.every((r) => r.endedSeq !== null)).toBe(true);
  expect(snapshot.items.find((i) => i.tool === "Bash")!.input).toEqual({ command: "ls", description: "List files" });
  expect(seen).toEqual(["List the files in the repository", "Also count them", "Also count them", "What is in this screenshot?"]);
  expect(JSON.stringify(snapshot)).not.toContain("private reasoning");
  expect(JSON.stringify(snapshot)).not.toContain("subagent text");
  expect(JSON.stringify(snapshot)).not.toContain("Summary:");
});

test("reading the fixture line by line gives the same thread as reading it at once", () => {
  const whole = render(fixtureLines()).snapshot;
  const parts = render(fixtureLines(), 1).snapshot;
  expect(parts.items.map(brief)).toEqual(whole.items.map(brief));
  expect(parts.runs.map((r) => r.status)).toEqual(whole.runs.map((r) => r.status));
});

test("a long tool input is clipped and a long result is cut to its byte budget", () => {
  const big = "x".repeat(50_000);
  const lines = [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { content: "go" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { content: big } }] } }),
    JSON.stringify({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: big }] } }),
  ];
  const tool = render(lines).snapshot.items.find((i) => i.kind === "tool")!;
  expect(((tool.input as { content: string }).content).length).toBe(4_001);
  expect(tool.output!.endsWith("… (output clipped)")).toBe(true);
  expect(tool.output!.length).toBeLessThan(16 * 1024 + 30);
});

test("readChunk returns complete lines only, reads a line longer than the budget whole, and skips one over the cap", () => {
  const dir = tmp("mirror-chunk-");
  const file = join(dir, "t.jsonl");
  writeFileSync(file, `{"a":1}\n${"y".repeat(30)}\n{"b":2}\n{"partial"`);
  const fd = openSync(file, "r");
  cleanups.push(() => closeSync(fd));
  const size = Buffer.byteLength(readFileSync(file));
  const first = readChunk(fd, 0, size, 10, 100);
  expect(first.lines).toEqual(['{"a":1}']);
  const second = readChunk(fd, first.next, size, 10, 100);
  expect(second.lines).toEqual(["y".repeat(30)]);
  const rest = readChunk(fd, second.next, size, 1000, 100);
  expect(rest.lines).toEqual(['{"b":2}']);
  expect(readChunk(fd, rest.next, size, 1000, 100)).toEqual({ lines: [], next: rest.next, skipped: 0 });
  const over = readChunk(fd, second.next - 31, size, 10, 20);
  expect(over).toEqual({ lines: [], next: second.next, skipped: 1 });
});

const locateOut = (o: { pane?: { pid: number; inMode: boolean } | null; procs?: [number, number, string][]; claude?: Record<string, { sid: unknown; status: unknown }> }) =>
  JSON.stringify({ pane: o.pane === undefined ? { pid: 10, inMode: false } : o.pane, procs: o.procs ?? [], claude: o.claude ?? {} });

test("parseLocate finds the pane's nearest agent and trusts only a well-formed session id", () => {
  const procs: [number, number, string][] = [[10, 1, "bash"], [20, 10, "claude"], [30, 20, "claude"], [40, 1, "claude"]];
  expect(parseLocate(locateOut({ procs, claude: { "20": { sid: SID, status: "busy" } } })))
    .toEqual({ kind: "claude", pid: 20, inMode: false, sid: SID, status: "busy" });
  expect(parseLocate(locateOut({ procs, claude: { "20": { sid: "../../etc/passwd", status: "weird" } } })))
    .toEqual({ kind: "claude", pid: 20, inMode: false, sid: null, status: null });
  expect(parseLocate(locateOut({ procs: [[10, 1, "bash"], [11, 10, "codex"]] }))).toEqual({ kind: "other", runtime: "codex", inMode: false });
  expect(parseLocate(locateOut({ procs: [[10, 1, "bash"]] }))).toEqual({ kind: "no-agent", inMode: false });
  expect(parseLocate(locateOut({ pane: null }))).toEqual({ kind: "no-pane" });
  expect(parseLocate("not json")).toBeNull();
});

const TMUX: SessionRow = {
  id: "dev-a-tmux", folder: "acme", project: "a", repo: "tmux", container: "dev-a-tmux",
  port_base: 40200, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "tmux",
};
const CHAT: SessionRow = { ...TMUX, id: "dev-a-chat", container: "dev-a-chat", repo: "chat", port_base: 40300, runtime: "chat" };

interface Pane { sid: string | null; status?: string; agent?: string; inMode?: boolean; sendResult?: string; noPane?: boolean }

function setup(pane: Pane, isEnding: (id: string) => boolean = () => false) {
  const root = tmp("mirror-root-");
  const projects = join(root, "_claude-projects", TMUX.id);
  mkdirSync(projects, { recursive: true });
  const db = openDb(":memory:");
  insertSession(db, TMUX);
  insertSession(db, CHAT);
  const calls: { cmd: string[]; stdin?: string }[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  const exec = async (_c: string, cmd: string[], _t: number, stdin?: string): Promise<ExecResult> => {
    calls.push({ cmd, stdin });
    const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    if (cmd[3] === MIRROR_LOCATE) {
      if (pane.noPane) return ok(locateOut({ pane: null }));
      const agent = pane.agent ?? "claude";
      return ok(locateOut({ pane: { pid: 10, inMode: pane.inMode ?? false }, procs: agent === "none" ? [[10, 1, "bash"]] : [[10, 1, "bash"], [20, 10, agent]],
        claude: agent === "claude" ? { "20": { sid: pane.sid, status: pane.status ?? "idle" } } : {} }));
    }
    if (cmd[3] === MIRROR_SEND) return ok(pane.sendResult ?? '{"ok": true}');
    throw new Error(`unexpected exec ${cmd.join(" ")}`);
  };
  const bus = new EventBus();
  const mirror = new TranscriptMirror({ db, root, bus, exec, isEnding, live: () => null, now: () => now, log: (m) => logs.push(m) });
  cleanups.push(() => { mirror.release(TMUX.id); mirror.release(CHAT.id); });
  const write = (sid: string, lines: string[]) => appendFileSync(join(projects, `${sid}.jsonl`), lines.map((l) => `${l}\n`).join(""));
  return { mirror, calls, logs, bus, projects, write, root, advance: (ms: number) => { now += ms; } };
}

const items = (m: TranscriptMirror) => m.store(TMUX.id).snapshot().items.map(brief);

test("the mirror backfills the transcript, then reads only what was appended", async () => {
  const t = setup({ sid: SID });
  const lines = fixtureLines();
  t.write(SID, lines.slice(0, 10));
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toContain("user: List the files in the repository");
  const before = t.mirror.store(TMUX.id).lastSeq();
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.store(TMUX.id).lastSeq()).toBe(before); // nothing new, nothing applied
  t.write(SID, lines.slice(10));
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual(render(lines).snapshot.items.map(brief));
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: SID, activity: "idle", sendBlock: null });
});

test("a new conversation (/clear) adds a notice and continues in the same mirror", async () => {
  const pane: Pane = { sid: SID, status: "busy" };
  const t = setup(pane);
  t.write(SID, fixtureLines().slice(0, 7));
  await t.mirror.refresh(TMUX.id);
  pane.sid = SID2;
  t.write(SID2, [JSON.stringify({ type: "user", uuid: "n1", origin: { kind: "human" }, message: { content: "Fresh start" } })]);
  await t.mirror.refresh(TMUX.id);
  const shown = items(t.mirror);
  expect(shown.slice(-2)).toEqual(["notice: New conversation", "user: Fresh start"]);
  // The old conversation's open run was closed, not left running.
  expect(t.mirror.store(TMUX.id).snapshot().runs.filter((r) => r.status === "running")).toHaveLength(1);
});

test("an idle agent closes a turn whose end entry never came; a busy one keeps it running", async () => {
  const pane: Pane = { sid: SID, status: "busy" };
  const t = setup(pane);
  t.write(SID, [JSON.stringify({ type: "user", uuid: "u1", origin: { kind: "human" }, message: { content: "Work" } })]);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.store(TMUX.id).snapshot().runs.map((r) => r.status)).toEqual(["running"]);
  pane.status = "idle";
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.store(TMUX.id).snapshot().runs.map((r) => r.status)).toEqual(["completed"]);
});

test("a refresh still running when the session is released does not reopen the store", async () => {
  const t = setup({ sid: SID });
  t.write(SID, fixtureLines());
  const pending = t.mirror.refresh(TMUX.id);
  t.mirror.release(TMUX.id, true);
  await pending;
  expect(existsSync(join(t.root, "_mirrors", `${TMUX.id}.sqlite`))).toBe(false);
});

test("a rewritten transcript is read again from the start with a notice", async () => {
  const t = setup({ sid: SID });
  t.write(SID, fixtureLines());
  await t.mirror.refresh(TMUX.id);
  writeFileSync(join(t.projects, `${SID}.jsonl`), `${JSON.stringify({ type: "user", uuid: "r1", message: { content: "Rewritten prompt here" } })}\n`);
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror).slice(-2)).toEqual(["notice: The transcript was rewritten; it is read again from the start", "user: Rewritten prompt here"]);
  // The new head is the reference from now on: the next read is not another rewrite.
  const seq = t.mirror.store(TMUX.id).lastSeq();
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.store(TMUX.id).lastSeq()).toBe(seq);
});

test("re-reading a replaced transcript does not duplicate its notices", async () => {
  const t = setup({ sid: SID });
  t.write(SID, fixtureLines());
  await t.mirror.refresh(TMUX.id);
  // The replacement starts differently, so the head hash detects it on every filesystem: a Linux filesystem reuses
  // the freed inode number, so the same bytes at the same inode would be (rightly) no rewrite at all.
  rmSync(join(t.projects, `${SID}.jsonl`));
  t.write(SID, [JSON.stringify({ type: "file-history-snapshot", messageId: "m-replaced", snapshot: {} }), ...fixtureLines()]);
  await t.mirror.refresh(TMUX.id);
  const shown = items(t.mirror);
  expect(shown.filter((i) => i === "notice: Ran /model")).toHaveLength(1);
  expect(shown.filter((i) => i === "notice: Conversation compacted")).toHaveLength(1);
  expect(shown.filter((i) => i.startsWith("notice: The transcript was rewritten"))).toHaveLength(1);
  expect(shown.filter((i) => i === "user: List the files in the repository")).toHaveLength(1);
});

test("a transcript the agent replaced with a symlink is not followed", async () => {
  const t = setup({ sid: SID });
  const secret = join(t.root, "secret.txt");
  writeFileSync(secret, `${JSON.stringify({ type: "user", uuid: "s1", message: { content: "host secret" } })}\n`);
  symlinkSync(secret, join(t.projects, `${SID}.jsonl`));
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual([]);
  expect(t.logs.join("\n")).not.toContain("host secret");
});

test("the info names an exited agent, another agent and a waiting agent", async () => {
  const pane: Pane = { sid: SID, agent: "none" };
  const t = setup(pane);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "agent-exited", sendBlock: { code: "agent-not-running" } });
  pane.agent = "codex";
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unsupported", agent: "Codex", sendBlock: { code: "unsupported-agent", message: "Chat view isn't supported for Codex yet." } });
  pane.agent = "claude";
  pane.status = "waiting";
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", activity: "waiting", terminalPrompt: { text: expect.any(String) }, sendBlock: { code: "agent-waiting-in-terminal" } });
});

const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof MirrorSendRefused ? e.code : `other: ${(e as Error).message}`; } return "sent"; };
const typed = (t: ReturnType<typeof setup>) => t.calls.filter((c) => c.cmd[3] === MIRROR_SEND);

test("send refuses commands, control characters, an exited, waiting or unknown agent without typing", async () => {
  for (const [pane, text, want] of [
    [{ sid: SID }, "/exit", "bad-request"],
    [{ sid: SID }, "  !rm -rf x", "bad-request"],
    [{ sid: SID }, "# remember", "bad-request"],
    [{ sid: SID }, "fine first line\n/exit", "bad-request"],
    [{ sid: SID }, "notes\n   # heading", "bad-request"],
    [{ sid: SID }, "notes\n  !ls", "bad-request"],
    [{ sid: SID, agent: "none" }, "hi", "agent-not-running"],
    [{ sid: SID, noPane: true }, "hi", "agent-not-running"],
    [{ sid: SID, status: "waiting" }, "hi", "agent-waiting-in-terminal"],
    [{ sid: SID, inMode: true }, "hi", "terminal-scrolled"],
    [{ sid: null }, "hi", "conversation-unknown"],
    [{ sid: SID }, "hi\x1b[201~\r!rm -rf x\r", "bad-request"],
    [{ sid: SID, agent: "codex" }, "hi", "unsupported-agent"],
  ] as [Pane, string, string][]) {
    const t = setup(pane);
    expect(await refusal(t.mirror.send(TMUX.id, text))).toBe(want);
    expect(typed(t)).toEqual([]);
  }
});

test("send types the text through the send script's stdin and maps its refusals", async () => {
  const pane: Pane = { sid: SID };
  const t = setup(pane);
  expect(await refusal(t.mirror.send(TMUX.id, "line one\r\nline 'two' / not a command"))).toBe("sent");
  expect(typed(t)).toHaveLength(1);
  expect(typed(t)[0]!.stdin).toBe("line one\nline 'two' / not a command");
  expect(typed(t)[0]!.cmd.slice(0, 3)).toEqual(["python3", "-I", "-c"]);
  expect(typed(t)[0]!.cmd.slice(4, 6)).toEqual(["main", "20"]);
  pane.sendResult = '{"error": "pane-changed"}';
  expect(await refusal(t.mirror.send(TMUX.id, "again"))).toBe("pane-changed");
  pane.sendResult = '{"error": "terminal-has-draft"}';
  expect(await refusal(t.mirror.send(TMUX.id, "again"))).toBe("terminal-has-draft");
  pane.sendResult = '{"error": "not-submitted"}';
  expect(await refusal(t.mirror.send(TMUX.id, "again"))).toBe("not-submitted");
  pane.sendResult = "garbage";
  expect(await refusal(t.mirror.send(TMUX.id, "again"))).toBe("pane-changed");
});

test("a sent message that never shows up gets a warn notice; one that shows up does not", async () => {
  const t = setup({ sid: SID });
  t.write(SID, ["{}"]);
  await t.mirror.send(TMUX.id, "Seen message");
  await t.mirror.send(TMUX.id, "Lost message");
  t.write(SID, [JSON.stringify({ type: "user", uuid: "q1", origin: { kind: "human" }, message: { content: "Seen message" } })]);
  t.advance(SEEN_TIMEOUT_MS);
  await t.mirror.refresh(TMUX.id);
  const warns = t.mirror.store(TMUX.id).snapshot().items.filter((i) => i.tone === "warn");
  expect(warns).toHaveLength(1);
});

function app(t: ReturnType<typeof setup>) {
  const a = new Hono();
  registerMirrorRoutes(a, t.mirror);
  return a;
}

test("routes: 404 unknown, 409 for a chat session, the snapshot with its info, 400 for a command, 409 with the lock reason", async () => {
  const t = setup({ sid: SID, agent: "none" });
  t.write(SID, fixtureLines());
  const a = app(t);
  expect((await a.request("/api/sessions/nope/mirror")).status).toBe(404);
  const chat = await a.request(`/api/sessions/${CHAT.id}/mirror`);
  expect([chat.status, await chat.json()]).toEqual([409, { error: "not-a-tmux-session" }]);
  const got = await a.request(`/api/sessions/${TMUX.id}/mirror`);
  expect(got.status).toBe(200);
  const body = await got.json() as MirrorResponse;
  expect(body.mirror.state).toBe("agent-exited");
  const post = (text: unknown) => a.request(`/api/sessions/${TMUX.id}/mirror/messages`, { method: "POST", body: JSON.stringify({ text }), headers: { "content-type": "application/json" } });
  const cmd = await post("/clear");
  expect(cmd.status).toBe(400);
  expect(((await cmd.json()) as { error: string }).error).toContain("type them in the terminal");
  const locked = await post("hi");
  expect([locked.status, ((await locked.json()) as { error: string }).error]).toEqual([409, "agent-not-running"]);
  expect((await post(5)).status).toBe(400);
});

test("routes: a session that starts ending between the check and opening the store answers 409, not 500", async () => {
  // The first isEnding (the route's check) says no, every later one yes: the store refuses to open.
  let calls = 0;
  const t = setup({ sid: SID }, () => calls++ > 0);
  const res = await app(t).request(`/api/sessions/${TMUX.id}/mirror/stream`);
  expect([res.status, await res.json()]).toEqual([409, { error: "session-ending" }]);
  expect(existsSync(join(t.root, "_mirrors", `${TMUX.id}.sqlite`))).toBe(false);
});

test("routes: the stream replays the snapshot, then sends live events and the info; watching stops with the stream", async () => {
  const t = setup({ sid: SID });
  t.write(SID, fixtureLines().slice(0, 7));
  await t.mirror.refresh(TMUX.id);
  const ctrl = new AbortController();
  const res = await app(t).request(`/api/sessions/${TMUX.id}/mirror/stream?afterSeq=0`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const until = async (needle: string) => {
    while (!text.includes(needle)) text += dec.decode((await reader.read()).value);
  };
  await until("event: mirror");
  expect(text).toContain("event: thread-snapshot");
  t.write(SID, fixtureLines().slice(7));
  await t.mirror.refresh(TMUX.id);
  await until("There are two entries");
  expect(text).toContain("event: thread\n");
  // Releasing the session (stop/end) closes the stream, so the client reconnects.
  t.mirror.release(TMUX.id);
  for (;;) { if ((await reader.read()).done) break; }
  ctrl.abort();
});

test("applyBatch saves the cursor with the events", () => {
  const store = ThreadStore.open(tmp("mirror-batch-"), "dev-x", { dir: "_mirrors" });
  cleanups.push(() => store.close());
  expect(store.mirrorCursor()).toBeNull();
  store.applyBatch([{ seq: 1, ts: 1, event: { type: "bridge.notice", text: "n" } }], '{"offset":5}');
  expect(store.mirrorCursor()).toBe('{"offset":5}');
  expect(store.lastSeq()).toBe(1);
});

// The in-container scripts run against a fake /proc and a fake tmux: the harness redirects "/proc" paths and puts a
// tmux stub first on PATH that records its arguments and the pasted bytes.
const HARNESS = String.raw`
import builtins, os, sys
fake = os.environ["FAKE_PROC"]
real_open, real_listdir = builtins.open, os.listdir
fix = lambda p: fake + p[5:] if isinstance(p, str) and p.startswith("/proc") else p
builtins.open = lambda p, *a, **k: real_open(fix(p), *a, **k)
os.listdir = lambda p=".": real_listdir(fix(p))
script = sys.argv[1]
sys.argv = ["-c"] + sys.argv[2:]
exec(compile(script, "<mirror>", "exec"), {"__name__": "__main__"})
`;

const RULE = "─".repeat(40);
const READY = `⏺ done\n${RULE}\n\x1b[39m❯\u00a0\x1b[2mTry "create a util"\x1b[0m\n${RULE}\n  Opus [high]\n`;

/** `onLoad`/`onPaste`: shell run by the fake tmux on load-buffer/paste-buffer (`$PROC` is the fake /proc). */
function fakeContainer(opts: { status: string; procStart?: string; inMode?: boolean; screen?: string; screenAfterPaste?: string; onLoad?: string; onPaste?: string }) {
  const dir = tmp("mirror-py-");
  const proc = join(dir, "proc");
  const home = join(dir, "home");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const stat = (pid: number, comm: string, ppid: number, start: string) => `${pid} (${comm}) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 0 0\n`;
  for (const [pid, comm, ppid] of [[10, "bash", 1], [20, "claude", 10], [30, "node", 20]] as [number, string, number][]) {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), stat(pid, comm, ppid, "777"));
    writeFileSync(join(proc, String(pid), "environ"), `HOME=${home}\0PATH=/usr/bin\0`);
  }
  writeFileSync(join(home, ".claude", "sessions", "20.json"), JSON.stringify({ pid: 20, procStart: opts.procStart ?? "777", sessionId: SID, status: opts.status }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "tmux.log");
  writeFileSync(join(dir, "screen"), opts.screen ?? READY);
  writeFileSync(join(dir, "screen-after"), opts.screenAfterPaste ?? `${RULE}\n❯ pasted\n${RULE}\n`);
  // capture-pane shows `screen` until a paste, then `screen-after`.
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1" in\n  display-message) printf '10\\t${opts.inMode ? 1 : 0}\\n' ;;\n  load-buffer) cat > '${join(dir, "pasted")}'; PROC='${proc}'; ${opts.onLoad ?? ":"} ;;\n  paste-buffer) cp '${join(dir, "screen-after")}' '${join(dir, "screen")}'; PROC='${proc}'; ${opts.onPaste ?? ":"} ;;\n  capture-pane) cat '${join(dir, "screen")}' ;;\nesac\n`, { mode: 0o755 });
  const run = (script: string, args: string[], stdin = "") => {
    const r = Bun.spawnSync(["python3", "-I", "-c", HARNESS, script, ...args], {
      stdin: Buffer.from(stdin), env: { FAKE_PROC: proc, PATH: `${bin}:/usr/bin:/bin` },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { run, tmuxLog: () => (readFileSync(log, "utf8")), pasted: () => readFileSync(join(dir, "pasted"), "utf8"), dir };
}

test.skipIf(!Bun.which("python3"))("MIRROR_LOCATE reports the pane, the process table and the verified claude session", () => {
  const c = fakeContainer({ status: "busy" });
  const r = c.run(MIRROR_LOCATE, ["main"]);
  expect(r.code).toBe(0);
  expect(parseLocate(r.out)).toEqual({ kind: "claude", pid: 20, inMode: false, sid: SID, status: "busy" });
  expect(c.tmuxLog()).toContain("display-message -p -t =main:");
  // A session file of another process with the same pid (another container) is not trusted.
  const other = fakeContainer({ status: "busy", procStart: "999" });
  expect(parseLocate(other.run(MIRROR_LOCATE, ["main"]).out)).toMatchObject({ kind: "claude", sid: null });
});

test.skipIf(!Bun.which("python3"))("MIRROR_SEND pastes stdin bracketed and presses Enter, or refuses after re-checking", () => {
  const c = fakeContainer({ status: "idle" });
  const r = c.run(MIRROR_SEND, ["main", "20", "claude,codex"], "two\nlines $(nope) 'q'");
  expect([r.code, r.out.trim()]).toEqual([0, '{"ok": true}']);
  expect(c.pasted()).toBe("two\nlines $(nope) 'q'");
  const log = c.tmuxLog();
  expect(log).toMatch(/paste-buffer -p -d -b devd-mirror-[0-9a-f]+ -t =main:/);
  expect(log.trim().split("\n").at(-1)).toBe("send-keys -t =main: Enter");
  expect(c.run(MIRROR_SEND, ["main", "21", "claude"], "x").out.trim()).toBe('{"error": "pane-changed"}');
  expect(fakeContainer({ status: "waiting" }).run(MIRROR_SEND, ["main", "20", "claude"], "x").out.trim()).toBe('{"error": "agent-waiting-in-terminal"}');
  const scrolled = fakeContainer({ status: "idle", inMode: true });
  expect(scrolled.run(MIRROR_SEND, ["main", "20", "claude"], "x").out.trim()).toBe('{"error": "terminal-scrolled"}');
  expect(scrolled.tmuxLog()).not.toContain("paste-buffer");
});

test.skipIf(!Bun.which("python3"))("MIRROR_SEND reads the screen: a draft, a dialog or an unknown screen is never typed into", () => {
  const send = (screen: string) => {
    const c = fakeContainer({ status: "idle", screen });
    return { out: c.run(MIRROR_SEND, ["main", "20", "claude"], "x").out.trim(), log: c.tmuxLog() };
  };
  for (const [screen, want] of [
    [`${RULE}\n\x1b[39m❯ \n${RULE}\n`, '{"ok": true}'],
    [`${RULE}\n❯ hello draft\n${RULE}\n`, '{"error": "terminal-has-draft"}'],
    [`${RULE}\n❯ \n  second line\n${RULE}\n`, '{"error": "terminal-has-draft"}'],
    [`${RULE}\n Which file?\n❯ 1. A\n  2. B\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`, '{"error": "agent-waiting-in-terminal"}'],
    ["dev@box:/workspace$ ", '{"error": "terminal-not-ready"}'],
    [`${RULE}\n❯ unterminated box`, '{"error": "terminal-not-ready"}'],
  ] as [string, string][]) {
    const r = send(screen);
    expect(r.out).toBe(want);
    if (want !== '{"ok": true}') expect(r.log).not.toContain("paste-buffer");
  }
  // A dialog that opens while the paste lands: Enter is not pressed.
  const late = fakeContainer({ status: "idle", screenAfterPaste: "Enter to confirm · Esc to cancel\n" });
  expect(late.run(MIRROR_SEND, ["main", "20", "claude"], "x").out.trim()).toBe('{"error": "not-submitted"}');
  expect(late.tmuxLog()).not.toContain("send-keys");
});

test.skipIf(!Bun.which("python3"))("MIRROR_SEND: an agent that exits during the send gets no paste or no Enter, so nothing reaches the shell", () => {
  // Exits while the buffer loads: the check before the paste stops it, and the buffer is dropped.
  const atLoad = fakeContainer({ status: "idle", onLoad: 'rm -rf "$PROC/20" "$PROC/30"' });
  expect(atLoad.run(MIRROR_SEND, ["main", "20", "claude"], "x").out.trim()).toBe('{"error": "pane-changed"}');
  expect(atLoad.tmuxLog()).not.toContain("paste-buffer");
  expect(atLoad.tmuxLog()).toContain("delete-buffer");
  // Exits while the paste lands (the shell got the bracketed paste, which it does not run): no Enter, no other key.
  const atPaste = fakeContainer({ status: "idle", onPaste: 'rm -rf "$PROC/20" "$PROC/30"', screenAfterPaste: "dev@box:/workspace$ x" });
  expect(atPaste.run(MIRROR_SEND, ["main", "20", "claude"], "x").out.trim()).toBe('{"error": "not-submitted"}');
  expect(atPaste.tmuxLog()).not.toContain("send-keys");
});
