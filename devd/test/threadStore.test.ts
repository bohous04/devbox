import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let n = 0;
import { ThreadStore } from "../src/threadStore";
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
