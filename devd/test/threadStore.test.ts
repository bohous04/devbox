import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../src/threadStore";
import type { BridgeEvent } from "../../shared/thread";

function store() { return ThreadStore.open(mkdtempSync(join(tmpdir(), "threads-")), "dev-a-b-1"); }
let n = 0;
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
