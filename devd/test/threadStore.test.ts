import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let n = 0;
import { Database } from "bun:sqlite";
import { THREAD_STORE_SCHEMA, ThreadStore } from "../src/threadStore";
import type { BridgeEvent } from "../../shared/thread";

function store() { n = 0; return ThreadStore.open(mkdtempSync(join(tmpdir(), "threads-")), "dev-a-b-1"); }
const ev = (event: BridgeEvent, seq = ++n) => ({ seq, ts: 1000 + seq, event });

test("deltas then final produce one assistant item with the final text", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "message.delta", runId: "r1", itemId: "m1", text: "Hel" }));
  s.apply(ev({ type: "message.delta", runId: "r1", itemId: "m1", text: "lo" }));
  expect(s.snapshot().items[0]).toMatchObject({ text: "Hello", status: "streaming" });
  s.apply(ev({ type: "message.final", runId: "r1", itemId: "m1", role: "assistant", text: "Hello!" }));
  const items = s.snapshot().items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello!", status: "done" });
});

test("applying the same seq twice is a no-op", () => {
  const s = store(); n = 0;
  const e = ev({ type: "message.delta", runId: "r1", itemId: "m1", text: "x" });
  expect(s.apply(e)).toBe(true);
  expect(s.apply(e)).toBe(false);
  expect(s.snapshot().items[0].text).toBe("x");
});

test("seq gap is accepted (log was trimmed) but lastSeq is the max", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "1" }, 5));
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "b", text: "2" }, 9));
  expect(s.lastSeq()).toBe(9);
  expect(s.apply(ev({ type: "message.delta", runId: "r", itemId: "c", text: "3" }, 7))).toBe(false);
  expect(s.snapshot().items).toHaveLength(2);
});

test("run lifecycle queued→running→completed with usage; user text stored once", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "nt", account: null, model: "m" }));
  s.apply(ev({ type: "run.queued", runId: "r1", text: "do it", attachments: [] }));
  expect(s.snapshot().runs[0]).toMatchObject({ status: "queued", origin: "user", harness: "claude" });
  s.apply(ev({ type: "run.started", runId: "r1", origin: "user", nativeThreadId: "nt", model: "m" }));
  s.apply(ev({ type: "message.final", runId: "r1", itemId: "u", role: "user", text: "do it" }));
  expect(s.snapshot().runs[0]).toMatchObject({ status: "running", startedAt: 1000 + 3 });
  const usage = { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 };
  s.apply(ev({ type: "run.completed", runId: "r1", nativeThreadId: "nt", usage, costUsd: 0.1 }));
  const snap = s.snapshot();
  expect(snap.runs[0]).toMatchObject({ status: "completed", usage });
  expect(snap.items.filter((i) => i.kind === "user")).toHaveLength(1);
  expect(snap.items[0].text).toBe("do it");
});

test("null usage stays null and a later terminal event wins", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "run.started", runId: "r", origin: "agent", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "run.completed", runId: "r", nativeThreadId: "nt", usage: null, costUsd: null }));
  expect(s.snapshot().runs[0].usage).toBeNull();
  s.apply(ev({ type: "run.failed", runId: "r", error: "boom" }));
  expect(s.snapshot().runs[0]).toMatchObject({ status: "failed", error: "boom" });
});

test("tool items and request opened then resolved by expired", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "tool.started", runId: "r", itemId: "t", tool: "Bash", input: { cmd: "ls" } }));
  s.apply(ev({ type: "tool.finished", runId: "r", itemId: "t", isError: true, output: "nope" }));
  expect(s.snapshot().items[0]).toMatchObject({ tool: "Bash", input: { cmd: "ls" }, output: "nope", isError: true, status: "done" });
  s.apply(ev({ type: "request.opened", runId: "r", requestId: "q", kind: "question", prompt: "Which?", options: [{ label: "A" }] }));
  expect(s.snapshot().pending).toMatchObject([{ requestId: "q", prompt: "Which?", options: [{ label: "A" }] }]);
  s.apply(ev({ type: "request.resolved", requestId: "q", answer: null, by: "expired" }));
  const snap = s.snapshot();
  expect(snap.pending).toEqual([]);
  expect(snap.items.find((i) => i.kind === "request")).toMatchObject({ status: "expired" });
});

test("background.changed replaces the set", () => {
  const s = store(); n = 0;
  const w = (id: string) => ({ id, kind: "monitor" as const, label: id, holding: true });
  s.apply(ev({ type: "background.changed", work: [w("a"), w("b")] }));
  s.apply(ev({ type: "background.changed", work: [w("c")] }));
  expect(s.snapshot().background).toEqual([w("c")]);
  s.apply(ev({ type: "background.changed", work: [] }));
  expect(s.snapshot().background).toEqual([]);
});

test("markSeen never moves backwards", () => {
  const s = store();
  for (let i = 0; i < 5; i++) s.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "x" }));
  s.markSeen(5); s.markSeen(3);
  expect(s.snapshot().seenSeq).toBe(5);
});

test("snapshot afterSeq returns only newer items (including ones that kept streaming)", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "1" }));
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "b", text: "2" }));
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "+" }));
  expect(s.snapshot({ afterSeq: 2 }).items.map((i) => i.text)).toEqual(["1+"]);
  expect(s.snapshot({ limit: 1 }).items.map((i) => i.itemId)).toEqual(["b"]);
});

test("state survives reopening the store", () => {
  const root = mkdtempSync(join(tmpdir(), "threads-")); n = 0;
  const a = ThreadStore.open(root, "x");
  a.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "hi" }));
  a.close();
  const b = ThreadStore.open(root, "x");
  expect(b.lastSeq()).toBe(1);
  expect(b.snapshot().items[0].text).toBe("hi");
});

test("run.failed for an unknown run applies, advances lastSeq and shows notices", () => {
  const s = store();
  expect(s.apply(ev({ type: "run.failed", runId: "ghost", error: "boom" }))).toBe(true);
  expect(s.lastSeq()).toBe(1);
  expect(s.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "x" }))).toBe(true);
  const notices = s.snapshot().items.filter((i) => i.kind === "notice");
  expect(notices.map((i) => i.text)).toEqual(["failed event for unknown run ghost", "boom"]);
});

test("an unknown event type becomes a visible notice and is logged", () => {
  const s = store();
  const orig = console.error; const logged: string[] = [];
  console.error = (m: string) => { logged.push(m); };
  try { s.apply(ev({ type: "future.thing" } as unknown as BridgeEvent)); } finally { console.error = orig; }
  expect(logged[0]).toContain("future.thing");
  expect(s.snapshot().items[0]).toMatchObject({ kind: "notice", text: "unknown event future.thing" });
  expect(s.lastSeq()).toBe(1);
});

test("interrupted run closes its streaming items", () => {
  const s = store();
  s.apply(ev({ type: "run.started", runId: "r", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "m", text: "par" }));
  s.apply(ev({ type: "tool.started", runId: "r", itemId: "t", tool: "Bash", input: {} }));
  s.apply(ev({ type: "run.interrupted", runId: "r" }));
  expect(s.snapshot().items.map((i) => i.status)).toEqual(["done", "done"]);
  expect(s.snapshot({ afterSeq: 3 }).items).toHaveLength(2);
});

test("an interrupted or failed run keeps the usage recorded by completed", () => {
  const s = store();
  const usage = { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 };
  s.apply(ev({ type: "run.started", runId: "r", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "run.completed", runId: "r", nativeThreadId: "nt", usage, costUsd: null }));
  s.apply(ev({ type: "run.interrupted", runId: "r" }));
  expect(s.snapshot().runs[0]).toMatchObject({ status: "interrupted", usage });
});

test("runs are listed in creation order and harness is null before thread.native", () => {
  const s = store();
  s.apply(ev({ type: "run.started", runId: "a", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "run.started", runId: "b", origin: "agent", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "run.completed", runId: "a", nativeThreadId: "nt", usage: null, costUsd: null }));
  const runs = s.snapshot().runs;
  expect(runs.map((r) => r.runId)).toEqual(["a", "b"]);
  expect(runs[0].harness).toBeNull();
});

test("markSeen above lastSeq throws", () => {
  const s = store();
  s.apply(ev({ type: "message.delta", runId: "r", itemId: "a", text: "x" }));
  expect(() => s.markSeen(2)).toThrow();
  s.markSeen(1);
  expect(s.snapshot().seenSeq).toBe(1);
});

test("re-announced request.opened and tool.started do not duplicate or reset", () => {
  const s = store();
  s.apply(ev({ type: "request.opened", runId: "r", requestId: "q", kind: "approval", prompt: "ok?" }));
  s.apply(ev({ type: "request.resolved", requestId: "q", answer: "yes", by: "user" }));
  s.apply(ev({ type: "request.opened", runId: "r", requestId: "q", kind: "approval", prompt: "ok?" }));
  s.apply(ev({ type: "tool.started", runId: "r", itemId: "t", tool: "Bash", input: {} }));
  s.apply(ev({ type: "tool.finished", runId: "r", itemId: "t", isError: false, output: "o" }));
  s.apply(ev({ type: "tool.started", runId: "r", itemId: "t", tool: "Bash", input: {} }));
  const snap = s.snapshot();
  expect(snap.pending).toEqual([]);
  expect(snap.items).toHaveLength(2);
  expect(snap.items[0]).toMatchObject({ status: "answered" });
  expect(snap.items[1]).toMatchObject({ status: "done", output: "o" });
});

test("run.started for an unknown run creates it; resumed bridge.started adds a notice; tool.finished without start", () => {
  const s = store();
  s.apply(ev({ type: "run.started", runId: "c", origin: "continuation", nativeThreadId: "nt", model: "m" }));
  expect(s.snapshot().runs[0]).toMatchObject({ runId: "c", origin: "continuation", status: "running", model: "m" });
  s.apply(ev({ type: "bridge.started", version: "1", resumed: false }));
  s.apply(ev({ type: "bridge.started", version: "2", resumed: true }));
  s.apply(ev({ type: "tool.finished", runId: "c", itemId: "x", isError: false, output: "out" }));
  const items = s.snapshot().items;
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ kind: "notice", text: "Agent bridge restarted (v2)" });
  expect(items[1]).toMatchObject({ kind: "tool", tool: "(unknown)", output: "out" });
});

test("a bridge.started notice (state.json rebuilt) is shown in the thread, also on a fresh start", () => {
  const s = store();
  s.apply(ev({ type: "bridge.started", version: "1.5.0", resumed: true, notice: "state.json was unusable" }));
  s.apply(ev({ type: "bridge.started", version: "1.5.0", resumed: false, notice: "no thread to resume" }));
  expect(s.snapshot().items.map((i) => [i.kind, i.text])).toEqual([
    ["notice", "Agent bridge restarted (v1.5.0)"],
    ["notice", "state.json was unusable"],
    ["notice", "no thread to resume"],
  ]);
});

test("a bridge.notice is shown in the thread", () => {
  const s = store();
  s.apply(ev({ type: "bridge.notice", text: "events 1-2 are no longer available" }));
  expect(s.snapshot().items.map((i) => [i.kind, i.text])).toEqual([["notice", "events 1-2 are no longer available"]]);
});

test("runs carry when they were queued and the seq that ended them", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "run.queued", runId: "r1", text: "hi", attachments: [] }));
  s.apply(ev({ type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "run.started", runId: "r2", origin: "agent", nativeThreadId: null, model: null }));
  expect(s.snapshot().runs.map((r) => [r.queuedAt, r.endedSeq])).toEqual([[1001, null], [null, null]]);
  s.apply(ev({ type: "run.completed", runId: "r1", nativeThreadId: "n", usage: null, costUsd: null }));
  s.apply(ev({ type: "run.failed", runId: "r2", error: "boom" }));
  expect(s.snapshot().runs.map((r) => r.endedSeq)).toEqual([4, 5]);
  // limit 0 (the hub's snapshot) skips items but keeps every run.
  const lean = s.snapshot({ limit: 0 });
  expect([lean.items.length, lean.runs.length]).toEqual([0, 2]);
});

test("a run that starts at once has its user item", () => {
  // What the bridge sends for a message on an idle session: no run.queued, the text comes as message.final.
  const s = store(); n = 0;
  s.apply(ev({ type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "message.final", runId: "r1", itemId: "user:r1", role: "user", text: "hello" }));
  s.apply(ev({ type: "message.final", runId: "r1", itemId: "m1", role: "assistant", text: "hi" }));
  s.apply(ev({ type: "run.completed", runId: "r1", nativeThreadId: "nt", usage: null, costUsd: null }));
  const snap = s.snapshot();
  expect(snap.items.map((i) => [i.kind, i.itemId, i.text])).toEqual([["user", "user:r1", "hello"], ["assistant", "m1", "hi"]]);
  expect(snap.runs).toEqual([expect.objectContaining({ runId: "r1", status: "completed", origin: "user" })]);
  expect(s.lastMessageText()).toBe("hi");
});

test("the user item keeps its attachments, from run.queued or from the start echo; none means no field", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "run.queued", runId: "r1", text: "look", attachments: ["/inbox/s/a.png"] }));
  s.apply(ev({ type: "run.started", runId: "r2", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "message.final", runId: "r2", itemId: "user:r2", role: "user", text: "and this", attachments: ["/inbox/s/b.gif"] }));
  s.apply(ev({ type: "run.queued", runId: "r3", text: "plain", attachments: [] }));
  const items = s.snapshot().items;
  expect(items.map((i) => [i.text, i.attachments])).toEqual([["look", ["/inbox/s/a.png"]], ["and this", ["/inbox/s/b.gif"]], ["plain", undefined]]);
  expect("attachments" in items[2]!).toBe(false);
});

test("a store from before attachments gains the column on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  mkdirSync(join(dir, "_threads"));
  const db = new Database(ThreadStore.path(dir, "dev-a-b-1"));
  db.run(`CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, run_id TEXT, item_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
    tool TEXT, input TEXT, output TEXT, is_error INTEGER, status TEXT, ts INTEGER NOT NULL, updated_seq INTEGER NOT NULL)`);
  db.run(`INSERT INTO items (seq, run_id, item_id, kind, text, ts, updated_seq) VALUES (1, 'r0', 'user:r0', 'user', 'old', 1, 1)`);
  db.close();
  const s = ThreadStore.open(dir, "dev-a-b-1");
  n = 1;
  s.apply(ev({ type: "run.queued", runId: "r1", text: "new", attachments: ["/inbox/s/a.png"] }));
  expect(s.snapshot().items.map((i) => [i.text, i.attachments])).toEqual([["old", undefined], ["new", ["/inbox/s/a.png"]]]);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("deltas after a run's terminal event are ignored: the item stays done", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null }));
  s.apply(ev({ type: "message.delta", runId: "r1", itemId: "m1", text: "Hel" }));
  s.apply(ev({ type: "run.interrupted", runId: "r1" }));
  expect(s.apply(ev({ type: "message.delta", runId: "r1", itemId: "m1", text: "lo" }))).toBe(true);
  s.apply(ev({ type: "message.delta", runId: "r1", itemId: "m2", text: "late" }));
  expect(s.snapshot().items.map((i) => [i.itemId, i.text, i.status])).toEqual([["m1", "Hel", "done"]]);
  expect(s.lastSeq()).toBe(5);
});

test("a devd notice is announced to the listener, keeps the bridge's seq and is in every replay that could miss it", () => {
  n = 0;
  const heard: unknown[] = [];
  const s = ThreadStore.open(mkdtempSync(join(tmpdir(), "threads-")), "dev-a-b-1", { onNotice: (i) => heard.push(i) });
  s.addNotice("before any event", 500);
  s.apply(ev({ type: "run.queued", runId: "r1", text: "hi", attachments: [] }));
  s.addNotice("switched", 1500);
  // devd never takes a seq: the bridge's next event is still seq 2.
  expect(s.lastSeq()).toBe(1);
  expect(s.apply(ev({ type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null }))).toBe(true);
  expect(heard).toEqual([
    { seq: 0, runId: null, itemId: "notice:1", kind: "notice", text: "before any event", status: "done", ts: 500 },
    { seq: 1, runId: null, itemId: "notice:2", kind: "notice", text: "switched", status: "done", ts: 1500 },
  ]);
  expect(s.snapshot().items.map((i) => i.text)).toEqual(["before any event", "hi", "switched"]);
  // A client at seq 1 that missed the live notice gets it on replay; one past it does not.
  expect(s.snapshot({ afterSeq: 1 }).items.map((i) => i.text)).toEqual(["switched"]);
  expect(s.snapshot({ afterSeq: 2 }).items.map((i) => i.text)).toEqual([]);
});

test("a thread.native without a model keeps the harness's known model; another harness's is not carried over", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: "a", model: "claude-opus-5-5" }));
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: "b", model: null }));
  expect(s.snapshot().native).toEqual({ harness: "claude", nativeThreadId: "t1", account: "b", model: "claude-opus-5-5" });
  s.apply(ev({ type: "thread.native", harness: "codex", nativeThreadId: "x1", account: "c", model: null }));
  expect(s.snapshot().native!.model).toBeNull();
});

test("a model is not carried from a proxy profile (no account) to a subscription account or back", () => {
  const s = store(); n = 0;
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: null, model: "gpt-6.1-sol" }));
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: "a", model: null }));
  expect(s.snapshot().native!.model).toBeNull();
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: "a", model: "claude-opus-5-5" }));
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: null, model: null }));
  expect(s.snapshot().native!.model).toBeNull();
});

test("resume-failed for a run id never announced adds no item: devd's own notice says it", () => {
  const s = store(); n = 0;
  expect(s.apply(ev({ type: "run.failed", runId: "never-started", error: "resume-failed" }))).toBe(true);
  expect(s.snapshot().items).toEqual([]);
  expect(s.lastSeq()).toBe(1);
});

test("a queued critic run keeps its origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "threadstore-critic-"));
  const store = ThreadStore.open(dir, "dev-a-b-1");
  try {
    store.apply({ seq: 1, ts: 1, event: { type: "run.queued", runId: "r1", text: "fix it", attachments: [], origin: "critic" } });
    expect(store.snapshot().runs[0]).toMatchObject({ runId: "r1", origin: "critic", status: "queued" });
    expect(store.userText("r1")).toBe("fix it");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** The thread store schema as step 2 shipped it (main b7919d6): no provider_threads, failure_reason or attachments. */
function step2Store(dir: string): void {
  mkdirSync(join(dir, "_threads"));
  const db = new Database(ThreadStore.path(dir, "dev-a-b-1"));
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
  db.run(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, origin TEXT NOT NULL, status TEXT NOT NULL, harness TEXT,
    native_thread_id TEXT, model TEXT, queued_at INTEGER, started_at INTEGER, ended_at INTEGER, ended_seq INTEGER, usage TEXT, error TEXT,
    updated_seq INTEGER NOT NULL)`);
  db.run(`CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, run_id TEXT, item_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
    tool TEXT, input TEXT, output TEXT, is_error INTEGER, status TEXT, ts INTEGER NOT NULL,
    updated_seq INTEGER NOT NULL)`);
  db.run(`CREATE INDEX items_key ON items (run_id, item_id)`);
  db.run(`CREATE INDEX items_updated ON items (updated_seq)`);
  db.run(`CREATE TABLE requests (
    request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
    options TEXT, multi_select INTEGER, opened_at INTEGER NOT NULL, status TEXT NOT NULL)`);
  db.run(`CREATE TABLE background (id INTEGER PRIMARY KEY CHECK (id = 1), work TEXT NOT NULL)`);
  db.run(`CREATE TABLE native (
    id INTEGER PRIMARY KEY CHECK (id = 1), harness TEXT NOT NULL, native_thread_id TEXT NOT NULL,
    account TEXT, model TEXT)`);
  db.run(`INSERT INTO meta (key, value) VALUES ('last_seq', 3), ('seen_seq', 2)`);
  db.run(`INSERT INTO runs (run_id, origin, status, harness, native_thread_id, model, queued_at, started_at, ended_at, ended_seq, usage, error, updated_seq)
    VALUES ('r0', 'user', 'completed', 'claude', 'th-1', 'm', 1, 2, 3, 3, NULL, NULL, 3)`);
  db.run(`INSERT INTO items (seq, run_id, item_id, kind, text, status, ts, updated_seq) VALUES (1, 'r0', 'user:r0', 'user', 'hi', 'done', 1, 1)`);
  db.run(`INSERT INTO native (id, harness, native_thread_id, account, model) VALUES (1, 'claude', 'th-1', NULL, 'm')`);
  db.close();
}

const userVersion = (dir: string) => {
  const db = new Database(ThreadStore.path(dir, "dev-a-b-1"));
  try { return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version; } finally { db.close(); }
};

test("T8: a new store records its schema version", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  ThreadStore.open(dir, "dev-a-b-1").close();
  expect(userVersion(dir)).toBe(THREAD_STORE_SCHEMA);
  rmSync(dir, { recursive: true, force: true });
});

test("T8: a live store from step 2 (no schema version) opens with its data unchanged and is brought to the current schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  step2Store(dir);
  const s = ThreadStore.open(dir, "dev-a-b-1");
  const snap = s.snapshot();
  expect(snap).toMatchObject({ lastSeq: 3, seenSeq: 2, native: { harness: "claude", nativeThreadId: "th-1", account: null, model: "m" } });
  expect(snap.runs.map((r) => [r.runId, r.status, r.endedSeq])).toEqual([["r0", "completed", 3]]);
  expect(snap.items.map((i) => [i.kind, i.text])).toEqual([["user", "hi"]]);
  // What steps 3-5 added works on it.
  n = 3;
  s.apply(ev({ type: "thread.native", harness: "claude", nativeThreadId: "th-1", account: null, model: "m" }));
  s.apply(ev({ type: "run.queued", runId: "r1", text: "img", attachments: ["/inbox/s/a.png"] }));
  s.apply(ev({ type: "run.failed", runId: "r1", error: "limit", reason: "rate-limited" }));
  expect(s.providerThread("claude")).toMatchObject({ nativeThreadId: "th-1", resumeFailed: false });
  expect(s.snapshot().runs.at(-1)).toMatchObject({ runId: "r1", status: "failed", failureReason: "rate-limited" });
  s.close();
  expect(userVersion(dir)).toBe(THREAD_STORE_SCHEMA);
  // Reopening a current store changes nothing.
  const again = ThreadStore.open(dir, "dev-a-b-1");
  expect(again.snapshot().runs).toHaveLength(2);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test("T8: a store written by a newer devd (higher schema version) is refused with an explicit error", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  ThreadStore.open(dir, "dev-a-b-1").close();
  const db = new Database(ThreadStore.path(dir, "dev-a-b-1"));
  db.run(`PRAGMA user_version = ${THREAD_STORE_SCHEMA + 1}`);
  db.close();
  expect(() => ThreadStore.open(dir, "dev-a-b-1")).toThrow(`thread store schema ${THREAD_STORE_SCHEMA + 1} is newer than this devd's (${THREAD_STORE_SCHEMA})`);
  rmSync(dir, { recursive: true, force: true });
});

test("T8: a schema-1 store from before the effort table (live since #91 shipped it in schema 1) gains it and reads/writes effort", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  try {
    const old = ThreadStore.open(dir, "dev-a-b-1");
    n = 0;
    old.apply(ev({ type: "run.queued", runId: "r1", text: "hi", attachments: [] }));
    old.close();
    // The live store's shape: version 1, no effort table.
    const db = new Database(ThreadStore.path(dir, "dev-a-b-1"));
    db.run("DROP TABLE effort");
    db.run("PRAGMA user_version = 1");
    db.close();
    const s = ThreadStore.open(dir, "dev-a-b-1");
    expect(s.snapshot().effort).toBeNull();
    expect(s.snapshot().runs.map((r) => r.runId)).toEqual(["r1"]);
    s.apply(ev({ type: "effort.state", model: "m", supported: ["low", "high"], effective: "high", chosen: null }));
    expect(s.snapshot().effort).toEqual({ model: "m", supported: ["low", "high"], effective: "high", chosen: null });
    s.close();
    expect(userVersion(dir)).toBe(THREAD_STORE_SCHEMA);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("effort.state: kept for the snapshot across a reopen; levels outside the known list are dropped, logged once", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const s = ThreadStore.open(dir, "dev-a-b-1");
    n = 0;
    const odd: BridgeEvent = { type: "effort.state", model: "m", supported: ["low", "turbo<b>", "high", "low"], effective: "turbo<b>", chosen: "high" };
    s.apply(ev(odd));
    s.apply(ev({ ...odd, chosen: null }));
    expect(s.snapshot().effort).toEqual({ model: "m", supported: ["low", "high"], effective: null, chosen: null });
    // Stored parsed, not only served parsed: the bridge's values never sit in the store.
    const row = new Database(ThreadStore.path(dir, "dev-a-b-1")).query("SELECT state FROM effort").get() as { state: string };
    expect(JSON.parse(row.state)).toEqual({ model: "m", supported: ["low", "high"], effective: null, chosen: null });
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("thread store: effort"))).toHaveLength(2);
    s.close();
    const again = ThreadStore.open(dir, "dev-a-b-1");
    expect(again.snapshot().effort).toEqual({ model: "m", supported: ["low", "high"], effective: null, chosen: null });
    again.close();
  } finally {
    errors.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effort: a stored state of another shape (written before the parser, or by hand) is served parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    ThreadStore.open(dir, "dev-a-b-1").close();
    const db = new Database(ThreadStore.path(dir, "dev-a-b-1"));
    db.query("INSERT INTO effort (id, state) VALUES (1, ?)").run(JSON.stringify({ model: "m", supported: "low", effective: ["x"], chosen: "low" }));
    db.close();
    const s = ThreadStore.open(dir, "dev-a-b-1");
    expect(s.snapshot().effort).toEqual({ model: "m", supported: null, effective: null, chosen: "low" });
    s.close();
  } finally {
    errors.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effort: dropped values are logged once per field per session, however many distinct ones a bridge sends", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const s = store();
    for (let i = 0; i < 50; i++) {
      s.apply(ev({ type: "effort.state", model: "m".repeat(200 + i), supported: [`bad${i}`], effective: `odd${i}`, chosen: `x${i}` }));
    }
    const logged = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("thread store: effort"));
    expect(logged.map((l) => l.split(" ")[3])).toEqual(["model", "supported", "effective", "chosen"]);
    s.close();
  } finally {
    errors.mockRestore();
  }
});
