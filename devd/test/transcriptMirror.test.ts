import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { MirrorResponse } from "../../shared/mirror";
import type { ThreadItem } from "../../shared/thread";
import type { ExecResult } from "../src/ccUpkeep";
import { insertNotifyLog, insertSession, openDb, type SessionRow } from "../src/db";
import { CODEX_CHUNK_BYTES, mapCodexLines, MIRROR_CODEX_READ, newCodexMapState } from "../src/codexMirror";
import { EventBus } from "../src/eventBus";
import { registerMirrorRoutes } from "../src/mirrorApi";
import { ThreadStore } from "../src/threadStore";
import {
  CODEX_TICK_CHUNKS, mapClaudeLines, MIRROR_LOCATE, MIRROR_SEND, MirrorSendRefused, parseLocate, readChunk, SEEN_TIMEOUT_MS,
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

/** Maps Codex rollout lines (in chunks of `size`) into a fresh store; returns its snapshot. */
function renderCodex(lines: string[], size = lines.length) {
  const store = ThreadStore.open(tmp("mirror-codex-map-"), "dev-x", { dir: "_mirrors" });
  cleanups.push(() => store.close());
  const st = newCodexMapState();
  let seq = 0;
  const seen: string[] = [];
  for (let i = 0; i < lines.length; i += size) {
    const m = mapCodexLines(lines.slice(i, i + size), st, "01aaaaaa-0000-7000-8000-000000000001", 0);
    seen.push(...m.seen);
    store.applyBatch(m.events.map((e) => ({ seq: ++seq, ts: e.ts, event: e.event })), JSON.stringify(st));
  }
  return Object.assign(store.snapshot(), { seen });
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

const locateOut = (o: { pane?: { pid: number; inMode: boolean } | null; procs?: ([number, number, string] | [number, number, string, string])[]; claude?: Record<string, { sid: unknown; status: unknown }>; codex?: Record<string, unknown> }) =>
  JSON.stringify({ pane: o.pane === undefined ? { pid: 10, inMode: false } : o.pane, procs: (o.procs ?? []).map((p) => p.length === 3 ? [...p, "777"] : p), claude: o.claude ?? {}, codex: o.codex ?? {} });

test("parseLocate finds the pane's nearest agent and trusts only a well-formed session id", () => {
  const procs: [number, number, string][] = [[10, 1, "bash"], [20, 10, "claude"], [30, 20, "claude"], [40, 1, "claude"]];
  expect(parseLocate(locateOut({ procs, claude: { "20": { sid: SID, status: "busy" } } })))
    .toEqual({ kind: "claude", pid: 20, start: "777", inMode: false, sid: SID, status: "busy" });
  expect(parseLocate(locateOut({ procs, claude: { "20": { sid: "../../etc/passwd", status: "weird" } } })))
    .toEqual({ kind: "claude", pid: 20, start: "777", inMode: false, sid: null, status: null });
  const codexAt = (home: string) => parseLocate(locateOut({ procs: [[10, 1, "bash"], [11, 10, "codex", "5"]], codex: { "11": { home, open: [SID, "../x"] } } }));
  expect(codexAt("/home/dev/.codex")).toEqual({ kind: "codex", pid: 11, start: "5", inMode: false, home: "/home/dev/.codex", open: [SID] });
  expect(codexAt(`/home/dev/.codex-accounts/${SID2}`)).toMatchObject({ home: `/home/dev/.codex-accounts/${SID2}` });
  // Only the default home or an account profile's: a CODEX_HOME the agent chose itself is not read.
  for (const foreign of ["/tmp/codex", "/home/dev/.codex-accounts/default", `/home/dev/.codex-accounts/${SID2}/..`, "/home/dev/.codex/", "relative"]) {
    expect(codexAt(foreign)).toMatchObject({ kind: "codex", home: null });
  }
  expect(parseLocate(locateOut({ procs: [[10, 1, "bash"], [11, 10, "grok"]] }))).toEqual({ kind: "other", runtime: "grok", inMode: false });
  expect(parseLocate(locateOut({ procs: [[10, 1, "bash"]] }))).toEqual({ kind: "no-agent", inMode: false });
  expect(parseLocate(locateOut({ pane: null }))).toEqual({ kind: "no-pane" });
  expect(parseLocate("not json")).toBeNull();
});

const TMUX: SessionRow = {
  id: "dev-a-tmux", folder: "acme", project: "a", repo: "tmux", container: "dev-a-tmux",
  port_base: 40200, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "tmux",
};
const CHAT: SessionRow = { ...TMUX, id: "dev-a-chat", container: "dev-a-chat", repo: "chat", port_base: 40300, runtime: "chat" };

/** Codex: `codexHome` is the local directory standing in for the reported CODEX_HOME (`home`, default /home/dev/.codex;
 *  the read script runs for real against it), `homes` maps further reported homes; `codexOpen`: the threads whose
 *  rollouts the codex process has open; `pid`/`start`: the agent process (20, "777"). */
interface Pane {
  sid: string | null; status?: string; agent?: string; inMode?: boolean; sendResult?: string; noPane?: boolean;
  codexHome?: string; home?: string; homes?: Record<string, string>; codexOpen?: string[]; pid?: number; start?: string;
}

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
      const pid = pane.pid ?? 20;
      return ok(locateOut({ pane: { pid: 10, inMode: pane.inMode ?? false }, procs: agent === "none" ? [[10, 1, "bash"]] : [[10, 1, "bash"], [pid, 10, agent, pane.start ?? "777"]],
        claude: agent === "claude" ? { [pid]: { sid: pane.sid, status: pane.status ?? "idle" } } : {},
        codex: agent === "codex" ? { [pid]: { home: pane.home ?? "/home/dev/.codex", open: pane.codexOpen ?? [] } } : {} }));
    }
    if (cmd[3] === MIRROR_CODEX_READ) {
      const homes: Record<string, string> = { "/home/dev/.codex": pane.codexHome ?? "/nonexistent", ...pane.homes };
      const r = Bun.spawnSync(["python3", ...cmd.slice(1, 4), homes[cmd[4]!] ?? cmd[4]!, ...cmd.slice(5)]);
      return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: false };
    }
    if (cmd[3] === MIRROR_SEND) return ok(pane.sendResult ?? '{"ok": true}');
    throw new Error(`unexpected exec ${cmd.join(" ")}`);
  };
  const bus = new EventBus();
  const mirror = new TranscriptMirror({ db, root, bus, exec, isEnding, live: () => null, now: () => now, log: (m) => logs.push(m) });
  cleanups.push(() => { mirror.release(TMUX.id); mirror.release(CHAT.id); });
  const write = (sid: string, lines: string[]) => appendFileSync(join(projects, `${sid}.jsonl`), lines.map((l) => `${l}\n`).join(""));
  /** A hook event of the session naming agent thread `thread` (what Codex's hooks record). */
  const hook = (thread: string, event = "user_prompt_submit") => insertNotifyLog(db, { ts: now, session_id: TMUX.id, event, decision: "sent", reason: null, inflight: 0, teammates: 0, agent_session_id: thread, detail: null });
  const t = { mirror, calls, logs, bus, projects, write, root, hook, advance: (ms: number) => { now += ms; },
    /** devd restarts: a new mirror over the same root and database. */
    restart: () => {
      t.mirror.release(TMUX.id);
      t.mirror = new TranscriptMirror({ db, root, bus, exec, isEnding, live: () => null, now: () => now, log: (m) => logs.push(m) });
      const next = t.mirror;
      cleanups.push(() => next.release(TMUX.id));
    } };
  return t;
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
  pane.agent = "grok";
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unsupported", agent: "Grok Build", sendBlock: { code: "unsupported-agent", message: "Chat view isn't supported for Grok Build yet." } });
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
    [{ sid: SID, agent: "grok" }, "hi", "unsupported-agent"],
    [{ sid: null, agent: "codex" }, "hi", "codex-send-unsupported"],
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
  expect(typed(t)[0]!.cmd.at(-1)).toBe("777");
  expect(await refusal(t.mirror.send(TMUX.id, "\n  \nafter blank lines"))).toBe("sent");
  expect(typed(t)[1]!.stdin).toBe("after blank lines");
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
real_readlink = os.readlink
os.readlink = lambda p: real_readlink(fix(p))
script = sys.argv[1]
sys.argv = ["-c"] + sys.argv[2:]
exec(compile(script, "<mirror>", "exec"), {"__name__": "__main__"})
`;

const RULE = "─".repeat(40);
const READY = `⏺ done\n${RULE}\n\x1b[39m❯\u00a0\x1b[2mTry "create a util"\x1b[0m\n${RULE}\n  Opus [high]\n`;

/** `onLoad`/`onPaste`: shell run by the fake tmux on load-buffer/paste-buffer (`$PROC` is the fake /proc). */
function fakeContainer(opts: { status: string; agent?: string; procStart?: string; inMode?: boolean; screen?: string; screenAfterPaste?: string; onLoad?: string; onPaste?: string }) {
  const dir = tmp("mirror-py-");
  const proc = join(dir, "proc");
  const home = join(dir, "home");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const stat = (pid: number, comm: string, ppid: number, start: string) => `${pid} (${comm}) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 0 0\n`;
  for (const [pid, comm, ppid] of [[10, "bash", 1], [20, opts.agent ?? "claude", 10], [30, "node", 20]] as [number, string, number][]) {
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
  expect(parseLocate(r.out)).toEqual({ kind: "claude", pid: 20, start: "777", inMode: false, sid: SID, status: "busy" });
  expect(c.tmuxLog()).toContain("display-message -p -t =main:");
  // A session file of another process with the same pid (another container) is not trusted.
  const other = fakeContainer({ status: "busy", procStart: "999" });
  expect(parseLocate(other.run(MIRROR_LOCATE, ["main"]).out)).toMatchObject({ kind: "claude", sid: null });
});

test.skipIf(!Bun.which("python3"))("MIRROR_SEND pastes stdin bracketed and presses Enter, or refuses after re-checking", () => {
  const c = fakeContainer({ status: "idle" });
  const r = c.run(MIRROR_SEND, ["main", "20", "claude,codex", "777"], "two\nlines $(nope) 'q'");
  expect([r.code, r.out.trim()]).toEqual([0, '{"ok": true}']);
  expect(c.pasted()).toBe("two\nlines $(nope) 'q'");
  const log = c.tmuxLog();
  expect(log).toMatch(/paste-buffer -p -d -b devd-mirror-[0-9a-f]+ -t =main:/);
  expect(log.trim().split("\n").at(-1)).toBe("send-keys -t =main: Enter");
  expect(c.run(MIRROR_SEND, ["main", "21", "claude", "777"], "x").out.trim()).toBe('{"error": "pane-changed"}');
  // The same pid, but another process (it started at another time): refused too.
  expect(c.run(MIRROR_SEND, ["main", "20", "claude", "778"], "x").out.trim()).toBe('{"error": "pane-changed"}');
  expect(fakeContainer({ status: "waiting" }).run(MIRROR_SEND, ["main", "20", "claude", "777"], "x").out.trim()).toBe('{"error": "agent-waiting-in-terminal"}');
  const scrolled = fakeContainer({ status: "idle", inMode: true });
  expect(scrolled.run(MIRROR_SEND, ["main", "20", "claude", "777"], "x").out.trim()).toBe('{"error": "terminal-scrolled"}');
  expect(scrolled.tmuxLog()).not.toContain("paste-buffer");
});

test.skipIf(!Bun.which("python3"))("MIRROR_SEND reads the screen: a draft, a dialog or an unknown screen is never typed into", () => {
  const send = (screen: string) => {
    const c = fakeContainer({ status: "idle", screen });
    return { out: c.run(MIRROR_SEND, ["main", "20", "claude", "777"], "x").out.trim(), log: c.tmuxLog() };
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
  expect(late.run(MIRROR_SEND, ["main", "20", "claude", "777"], "x").out.trim()).toBe('{"error": "not-submitted"}');
  expect(late.tmuxLog()).not.toContain("send-keys");
}, 15_000); // seven sends, each sleeping 0.3 s before Enter

test.skipIf(!Bun.which("python3"))("MIRROR_SEND: an agent that exits during the send gets no paste or no Enter, so nothing reaches the shell", () => {
  // Exits while the buffer loads: the check before the paste stops it, and the buffer is dropped.
  const atLoad = fakeContainer({ status: "idle", onLoad: 'rm -rf "$PROC/20" "$PROC/30"' });
  expect(atLoad.run(MIRROR_SEND, ["main", "20", "claude", "777"], "x").out.trim()).toBe('{"error": "pane-changed"}');
  expect(atLoad.tmuxLog()).not.toContain("paste-buffer");
  expect(atLoad.tmuxLog()).toContain("delete-buffer");
  // Exits while the paste lands (the shell got the bracketed paste, which it does not run): no Enter, no other key.
  const atPaste = fakeContainer({ status: "idle", onPaste: 'rm -rf "$PROC/20" "$PROC/30"', screenAfterPaste: "dev@box:/workspace$ x" });
  expect(atPaste.run(MIRROR_SEND, ["main", "20", "claude", "777"], "x").out.trim()).toBe('{"error": "not-submitted"}');
  expect(atPaste.tmuxLog()).not.toContain("send-keys");
});

// ── Codex ──────────────────────────────────────────────────────────────────────────

const CODEX_FIXTURE = join(import.meta.dir, "../../shared/fixtures/mirror/codex-rollout.jsonl");
const TID = "01aaaaaa-0000-7000-8000-000000000001";
const TID2 = "01aaaaaa-0000-7000-8000-000000000002";

/** A CODEX_HOME with `sessions/YYYY/MM/DD`, as Codex lays it out. */
function codexHome() {
  // Real path: the read script walks from / without following symlinks (macOS's tmpdir is below one).
  const home = realpathSync(tmp("mirror-codex-home-"));
  const day = join(home, "sessions", "2026", "01", "01");
  mkdirSync(day, { recursive: true });
  const file = (thread: string) => join(day, `rollout-2026-01-01T00-00-00-${thread}.jsonl`);
  const write = (thread: string, lines: string[]) => appendFileSync(file(thread), lines.map((l) => `${l}\n`).join(""));
  return { home, file, write };
}
const codexLines = () => readFileSync(CODEX_FIXTURE, "utf8").split("\n").filter((l) => l.trim() !== "");
const ev = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-01-01T00:01:00Z", type: "event_msg", payload });
const userMsg = (id: string, text: string) => ev({ type: "item_completed", item: { type: "UserMessage", id, content: [{ type: "text", text }] } });

const TID3 = "01aaaaaa-0000-7000-8000-000000000003";
const ACCOUNT_HOME = `/home/dev/.codex-accounts/${SID2}`;

test.skipIf(!Bun.which("python3"))("a Codex pane: the hook-named thread's rollout is mirrored, appended lines follow, and the chat never types into it", async () => {
  const c = codexHome();
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home };
  const t = setup(pane);
  const lines = codexLines();
  c.write(TID, lines.slice(0, 12));
  c.write(TID2, [userMsg("o1", "Another codex's conversation")]);
  t.hook(TID);
  t.hook(SID2); // a Claude id in the same session's log
  t.hook(TID2); // another codex of the session (another window): newest, but not this pane's
  await t.mirror.refresh(TMUX.id);
  // The pane's codex has no rollout open yet (a fresh Codex, before its first prompt): no older thread stands in.
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved", agent: "Codex", sendBlock: { code: "codex-send-unsupported" } });
  expect(await refusal(t.mirror.send(TMUX.id, "hi"))).toBe("codex-send-unsupported");
  // Its first prompt opens the rollout; that prompt's hook (TID's) is older than TID2's, which is not this pane's.
  pane.codexOpen = [TID];
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual(["user: List the files", "assistant: I'll list them.", "tool exec done: README.md\nsrc"]);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", agent: "Codex", conversationId: TID, activity: "busy", sendBlock: { code: "codex-send-unsupported" } });
  c.write(TID, lines.slice(12));
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual(renderCodex(lines).items.map(brief));
  // Idle and resolved: still locked, with the reason the composer shows next to Open terminal.
  const lock = { code: "codex-send-unsupported", message: "Sending from chat isn't available for Codex yet; reply in the terminal." };
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", activity: "idle", sendBlock: lock });
  expect(t.mirror.store(TMUX.id).snapshot().native).toMatchObject({ harness: "codex", nativeThreadId: TID });
  const res = await app(t).request(`/api/sessions/${TMUX.id}/mirror/messages`, { method: "POST", body: JSON.stringify({ text: "next" }), headers: { "content-type": "application/json" } });
  expect([res.status, await res.json()]).toEqual([409, { error: lock.code, message: lock.message }]);
  expect(typed(t)).toEqual([]);
});

test.skipIf(!Bun.which("python3"))("a Codex foreign CODEX_HOME or a symlinked sessions directory is never read", async () => {
  const c = codexHome();
  c.write(TID, [userMsg("u1", "Hidden")]);
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID], home: "/tmp/elsewhere" };
  const t = setup(pane);
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved" });
  expect(t.calls.filter((x) => x.cmd[3] === MIRROR_CODEX_READ)).toEqual([]);
  // The allowed home, but its sessions/2026 is a symlink to a directory holding the rollout.
  const other = codexHome();
  other.write(TID, [userMsg("u1", "Hidden")]);
  rmSync(join(c.home, "sessions", "2026"), { recursive: true });
  symlinkSync(join(other.home, "sessions", "2026"), join(c.home, "sessions", "2026"));
  pane.home = undefined;
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved" });
  expect(items(t.mirror)).toEqual([]);
});

test.skipIf(!Bun.which("python3"))("Codex /new: before its first prompt the old conversation stays; a rollout opened ahead of its hook is unknown until the hook", async () => {
  const c = codexHome();
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID] };
  const t = setup(pane);
  c.write(TID, [ev({ type: "task_started", turn_id: "a1" }), userMsg("u1", "First conversation")]);
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  // /new without a prompt yet: no new rollout exists, Codex keeps the old one open.
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: TID });
  // The first prompt: the new rollout opens before its hook event is logged.
  c.write(TID2, [ev({ type: "task_started", turn_id: "b1" }), userMsg("u2", "Second conversation"), ev({ type: "task_complete", turn_id: "b1" })]);
  pane.codexOpen = [TID, TID2];
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved", sendBlock: { code: "codex-send-unsupported" } });
  t.hook(TID2);
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual(["user: First conversation", "notice: New conversation", "user: Second conversation"]);
  // The first conversation's turn, left running, was closed.
  expect(t.mirror.store(TMUX.id).snapshot().runs.map((r) => r.status)).toEqual(["completed", "completed"]);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ conversationId: TID2, activity: "idle" });
});

test.skipIf(!Bun.which("python3"))("Codex /resume of an older thread while another has the newer hook is unknown until a hook names it", async () => {
  const c = codexHome();
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID2] };
  const t = setup(pane);
  c.write(TID, [userMsg("x1", "Resumed thread")]);
  c.write(TID2, [userMsg("y1", "Current thread")]);
  t.hook(TID);
  t.hook(TID2);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ conversationId: TID2 });
  // /resume X: its rollout opens, Y's stays open and still has the newest hook.
  pane.codexOpen = [TID, TID2];
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved" });
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: TID });
  expect(items(t.mirror)).toEqual(["user: Current thread", "notice: New conversation", "user: Resumed thread"]);
});

test.skipIf(!Bun.which("python3"))("a Codex fd listing that misses the current rollout never falls back to an older thread", async () => {
  const c = codexHome();
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID2] };
  const t = setup(pane);
  c.write(TID, [userMsg("x1", "Older thread")]);
  c.write(TID2, [userMsg("y1", "Current thread")]);
  t.hook(TID);
  t.hook(TID2);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ conversationId: TID2 });
  // The listing misses the current rollout: once nothing is left, once only an older thread's.
  for (const open of [[], [TID]]) {
    pane.codexOpen = open;
    await t.mirror.refresh(TMUX.id);
    expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved" });
  }
  // Back in the listing: known before, so it resolves at once.
  pane.codexOpen = [TID, TID2];
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: TID2 });
  expect(items(t.mirror)).toEqual(["user: Current thread"]);
  expect(typed(t)).toEqual([]);
});

test.skipIf(!Bun.which("python3"))("Codex: a first look at a process with several rollouts open, or a late hook of the old thread, never picks one", async () => {
  const c = codexHome();
  c.write(TID, [userMsg("x1", "Resumed thread")]);
  c.write(TID2, [userMsg("y1", "Previous thread")]);
  // `/resume X` happened while nobody watched: the first look sees X and Y open, Y with the newest hook.
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID, TID2] };
  const t = setup(pane);
  t.hook(TID);
  t.hook(TID2);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved" });
  // Y's Stop hook arrives late (it may take minutes): not a prompt, so still unknown.
  t.hook(TID2, "stop");
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "unresolved" });
  // The user prompts in X.
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: TID });
  expect(items(t.mirror)).toEqual(["user: Resumed thread"]);
  // devd restarts: the same process is no first look, so it stays resolved.
  t.restart();
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: TID });
});

test.skipIf(!Bun.which("python3"))("a rewritten Codex rollout is read again from the start; one moved to another account's home reads on", async () => {
  const c = codexHome();
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID] };
  const t = setup(pane);
  c.write(TID, [ev({ type: "task_started", turn_id: "a1" }), userMsg("u1", "Before"), ev({ type: "task_complete", turn_id: "a1" })]);
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  writeFileSync(c.file(TID), `${ev({ type: "task_started", turn_id: "z1" })}\n${userMsg("u9", "After")}\n`);
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual(["user: Before", "notice: The transcript was rewritten; it is read again from the start", "user: After"]);
  // An account switch: the thread's rollout copied to the account's home (another inode, the same head).
  const account = codexHome();
  account.write(TID, [readFileSync(c.file(TID), "utf8").trimEnd(), userMsg("u10", "On the other account")]);
  Object.assign(pane, { home: ACCOUNT_HOME, homes: { [ACCOUNT_HOME]: account.home }, pid: 30 });
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror)).toEqual(["user: Before", "notice: The transcript was rewritten; it is read again from the start", "user: After", "user: On the other account"]);
  // A rollout replaced by a symlink is not read; the cursor stays.
  const cursor = t.mirror.store(TMUX.id).mirrorCursor();
  rmSync(account.file(TID));
  symlinkSync("/etc/hosts", account.file(TID));
  await t.mirror.refresh(TMUX.id);
  expect(t.logs.some((l) => l.includes("could not be read"))).toBe(true);
  expect(t.mirror.store(TMUX.id).mirrorCursor()).toBe(cursor);
});

test.skipIf(!Bun.which("python3"))("a Codex turn left open by a process that died ends when another process (pid and start) takes the thread", async () => {
  const c = codexHome();
  const pane: Pane = { sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID] };
  const t = setup(pane);
  c.write(TID, [ev({ type: "task_started", turn_id: "a1" }), userMsg("u1", "Killed mid-turn")]);
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ activity: "busy" });
  pane.start = "888"; // `codex resume` of the same thread in a new process that got the same pid
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ activity: "idle" });
  expect(t.mirror.store(TMUX.id).snapshot().runs.map((r) => r.status)).toEqual(["interrupted"]);
});

test.skipIf(!Bun.which("python3"))("a long Codex backlog is read a few chunks per refresh", async () => {
  const c = codexHome();
  const t = setup({ sid: null, agent: "codex", codexHome: c.home, codexOpen: [TID] });
  const filler = JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "r".repeat(100_000) } });
  c.write(TID, [userMsg("u1", "Start"), ...Array(Math.ceil((CODEX_TICK_CHUNKS + 1) * CODEX_CHUNK_BYTES / filler.length)).fill(filler), userMsg("u2", "End")]);
  t.hook(TID);
  await t.mirror.refresh(TMUX.id);
  expect(t.calls.filter((x) => x.cmd[3] === MIRROR_CODEX_READ)).toHaveLength(CODEX_TICK_CHUNKS);
  expect(t.mirror.info(TMUX.id)).toMatchObject({ state: "live", conversationId: TID });
  expect(items(t.mirror).at(-1)).toBe("user: Start");
  await t.mirror.refresh(TMUX.id);
  expect(items(t.mirror).at(-1)).toBe("user: End");
}, 20_000);

test.skipIf(!Bun.which("python3"))("MIRROR_LOCATE reports a codex process's CODEX_HOME, start and the main rollouts it has open", () => {
  const c = fakeContainer({ status: "idle", agent: "codex" });
  const fds = join(c.dir, "proc", "20", "fd");
  mkdirSync(fds);
  const rollouts = join(c.dir, "rollouts");
  mkdirSync(rollouts);
  const meta = (source: unknown) => `${JSON.stringify({ type: "session_meta", payload: { id: "x", source } })}\n`;
  for (const [fd, thread, content] of [["7", TID, meta("cli")], ["8", TID2, meta({ subagent: { thread_spawn: { parent_thread_id: TID } } })], ["9", TID3, "not json\n"], ["11", "01aaaaaa-0000-7000-8000-000000000004", `${"[".repeat(100_000)}\n`]] as const) {
    const file = join(rollouts, `rollout-2026-01-01T00-00-00-${thread}.jsonl`);
    writeFileSync(file, content);
    symlinkSync(file, join(fds, fd));
  }
  symlinkSync("/dev/null", join(fds, "10"));
  const raw = JSON.parse(c.run(MIRROR_LOCATE, ["main"]).out) as { codex: Record<string, { home: string; open: string[] }> };
  // A subagent's rollout and one whose session_meta cannot be read (even one nested too deep to parse) are not candidates.
  expect(raw.codex["20"]).toEqual({ home: join(c.dir, "home", ".codex"), open: [TID] });
});

test("the Codex fixture maps onto user, assistant, tool and notice items, a steer into a run of its own; reasoning and model input are dropped", () => {
  const snap = renderCodex(codexLines());
  expect(snap.items.map(brief)).toEqual([
    "user: List the files",
    "assistant: I'll list them.",
    "tool exec done: README.md\nsrc",
    "user: Also count them",
    "tool view_image done: Viewed\n[image]",
    "assistant: Two entries.",
    "user: What is in this screenshot?\n[image]",
    "notice: Conversation compacted",
    "assistant: The background task finished.",
    "user: Use the other model",
    "notice: The model is not available.",
  ]);
  expect(snap.runs.map((r) => [r.origin, r.status])).toEqual([
    ["user", "completed"], ["user", "completed"], ["user", "interrupted"], ["agent", "completed"], ["user", "failed"],
  ]);
  expect(snap.items.find((i) => i.tool === "view_image")!.input).toEqual({ path: "a.png" });
  expect(snap.seen).toEqual(["List the files", "Also count them", "What is in this screenshot?", "Use the other model"]);
  const json = JSON.stringify(snap);
  for (const hidden of ["private reasoning", "developer instructions", "environment_context", "Summary: earlier work", "base instructions"]) expect(json).not.toContain(hidden);
  // Line by line gives the same thread.
  const parts = renderCodex(codexLines(), 1);
  expect(parts.items.map(brief)).toEqual(snap.items.map(brief));
  expect(parts.runs.map((r) => r.status)).toEqual(snap.runs.map((r) => r.status));
});

test("older Codex rollouts: a user_message event is the prompt, and a failed turn without a run is a notice", () => {
  const snap = renderCodex([
    ev({ type: "task_started", turn_id: "o1" }),
    ev({ type: "user_message", message: "Old style", images: ["data:x"] }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "not json" } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: { content: "out", success: false } } }),
    ev({ type: "task_complete", turn_id: "o1" }),
    ev({ type: "task_started", turn_id: "o2" }),
    ev({ type: "task_complete", turn_id: "o2", error: { message: "Quota exceeded." } }),
  ]);
  expect(snap.items.map(brief)).toEqual(["user: Old style\n[image]", "tool shell done error: out", "notice: Quota exceeded."]);
  expect(snap.items.find((i) => i.kind === "tool")!.input).toBe("not json");
  expect(snap.seen).toEqual(["Old style"]);
});

test.skipIf(!Bun.which("python3"))("MIRROR_CODEX_READ reads the thread's rollout in complete lines within its budget", () => {
  const c = codexHome();
  const read = (thread: string, cur: object, budget = 1000, cap = 100) => {
    const r = Bun.spawnSync(["python3", "-I", "-c", MIRROR_CODEX_READ, c.home, thread, JSON.stringify(cur), String(budget), String(cap)]);
    return JSON.parse(r.stdout.toString()) as { id: string | null; next: number; size: number; skipped: number; rewritten: boolean; lines: string[]; headLen: number; headHash: string; ino: number };
  };
  expect(read(TID, {}).id).toBeNull();
  const bigOutput = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call-9", output: "o".repeat(150) } });
  writeFileSync(c.file(TID2), `{"a":1}\n${"y".repeat(150)}\n${bigOutput}\n{"b":2}\n{"partial"`);
  const first = read(TID2, {}, 5);
  // A budget smaller than one line still returns that line.
  expect([first.id, first.lines, first.skipped]).toEqual([TID2, ['{"a":1}'], 0]);
  const cur = { sid: TID2, offset: first.next, ino: first.ino, headLen: first.headLen, headHash: first.headHash, home: c.home };
  const rest = read(TID2, cur);
  // Lines over the cap are skipped unread: in their place a placeholder, or a stub output ending the tool.
  expect([rest.skipped, rest.rewritten]).toEqual([2, false]);
  expect(rest.lines.map((l) => JSON.parse(l))).toEqual([
    {}, { type: "response_item", payload: { type: "function_call_output", call_id: "call-9", output: "(output too large to show)" } }, { b: 2 },
  ]);
  // The unfinished last line stays for the next read.
  expect(rest.next).toBe(rest.size - '{"partial"'.length);
  // Another thread starts from 0; a changed head is a rewrite; another inode in another home is not.
  expect(read(TID2, { ...cur, sid: TID }).lines[0]).toBe('{"a":1}');
  expect(read(TID2, { ...cur, ino: 1, home: "/elsewhere" }).rewritten).toBe(false);
  expect(read(TID2, { ...cur, ino: 1 }).rewritten).toBe(true);
  writeFileSync(c.file(TID2), `{"c":3}\n${"z".repeat(40)}\n`);
  const again = read(TID2, { ...cur, offset: 8 });
  expect([again.rewritten, again.lines[0]]).toEqual([true, '{"c":3}']);
  // Two rollouts of one thread: no thread.
  mkdirSync(join(c.home, "sessions", "2026", "01", "02"));
  writeFileSync(join(c.home, "sessions", "2026", "01", "02", `rollout-2026-01-02T00-00-00-${TID2}.jsonl`), "{}\n");
  expect(read(TID2, {}).id).toBeNull();
  // A home reached through a symlink is not read at all.
  const link = join(realpathSync(tmp("mirror-codex-link-")), "home");
  symlinkSync(c.home, link);
  const viaLink = Bun.spawnSync(["python3", "-I", "-c", MIRROR_CODEX_READ, link, TID2, "{}", "1000", "100"]);
  expect([viaLink.exitCode, viaLink.stdout.toString()]).toEqual([1, ""]);
});

test.skipIf(!Bun.which("python3"))("MIRROR_CODEX_READ stubs a tool call over the line cap, so its tool starts", () => {
  const c = codexHome();
  const call = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "call-7", name: "apply_patch", input: "p".repeat(300) } });
  writeFileSync(c.file(TID), `${call}\n`);
  const r = Bun.spawnSync(["python3", "-I", "-c", MIRROR_CODEX_READ, c.home, TID, "{}", "1000", "100"]);
  const lines = (JSON.parse(r.stdout.toString()) as { lines: string[] }).lines;
  const mapped = mapCodexLines(lines, newCodexMapState(), TID, 0).events.map((e) => e.event);
  expect(mapped).toContainEqual(expect.objectContaining({ type: "tool.started", itemId: "call-7", tool: "apply_patch", input: "(input too large to show)" }));
  // A function_call writes its call_id after the arguments; a nested item inside another line is no tool.
  const fn = JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "a".repeat(300), call_id: "call-8" } });
  const nested = JSON.stringify({ type: "compacted", payload: { replacement_history: [{ type: "response_item", payload: { type: "function_call", call_id: "call-x", name: "n" } }], pad: "q".repeat(300) } });
  writeFileSync(c.file(TID), `${fn}\n${nested}\n`);
  const r2 = Bun.spawnSync(["python3", "-I", "-c", MIRROR_CODEX_READ, c.home, TID, "{}", "1000", "100"]);
  const events = mapCodexLines((JSON.parse(r2.stdout.toString()) as { lines: string[] }).lines, newCodexMapState(), TID, 0).events.map((e) => e.event);
  expect(events.filter((e) => e.type === "tool.started")).toEqual([expect.objectContaining({ itemId: "call-8", tool: "shell" })]);
});

test("a Codex prompt carried by both user_message and UserMessage shows once; a repeated prompt in one type shows twice", () => {
  const snap = renderCodex([
    ev({ type: "task_started", turn_id: "d1" }),
    ev({ type: "user_message", message: "Same prompt" }),
    userMsg("u1", "Same prompt"),
    ev({ type: "task_complete", turn_id: "d1" }),
    ev({ type: "task_started", turn_id: "d2" }),
    userMsg("u2", "Again"),
    userMsg("u3", "Again"),
    ev({ type: "task_complete", turn_id: "d2" }),
  ]);
  expect(snap.items.map(brief)).toEqual(["user: Same prompt", "user: Again", "user: Again"]);
  expect(snap.seen).toEqual(["Same prompt", "Again", "Again"]);
});
