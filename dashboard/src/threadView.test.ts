import { expect, spyOn, test } from "bun:test";
import type { BridgeEvent, LoggedEvent, ThreadSnapshot } from "../../shared/thread";
import { activeRun, applyNotice, applyThreadEvent, composerErrorText, emptyThread, mergeSnapshot, queuedRunIds } from "./threadView";

let seq = 0;
const ev = (event: BridgeEvent, ts = 1000 + seq): LoggedEvent => ({ seq: ++seq, ts, event });
const run = (t: ThreadSnapshot, events: BridgeEvent[]) => events.reduce((acc, e) => applyThreadEvent(acc, ev(e)), t);

test("deltas then final: one assistant item, streaming until the final text replaces it", () => {
  seq = 0;
  let t = run(emptyThread(), [
    { type: "run.queued", runId: "r1", text: "hi", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "Hel" },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "lo" },
  ]);
  const a = t.items.filter((i) => i.kind === "assistant");
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ text: "Hello", status: "streaming", seq: 3 });
  t = run(t, [{ type: "message.final", runId: "r1", itemId: "m1", role: "assistant", text: "Hello!" }]);
  expect(t.items.filter((i) => i.kind === "assistant")).toEqual([
    { seq: 3, runId: "r1", itemId: "m1", kind: "assistant", text: "Hello!", status: "done", ts: 1002 },
  ]);
  expect(t.items[0]).toMatchObject({ kind: "user", itemId: "user:r1", text: "hi", status: "done" });
  expect(t.runs[0]).toMatchObject({ runId: "r1", status: "running", origin: "user", queuedAt: 1000, startedAt: 1001 });
  expect(t.lastSeq).toBe(5);
});

test("duplicate seq ignored: the same event twice changes nothing", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "agent", nativeThreadId: "n", model: "m" },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "a" },
  ]);
  const again = applyThreadEvent(t, { seq: 2, ts: 5, event: { type: "message.delta", runId: "r1", itemId: "m1", text: "a" } });
  expect(again).toBe(t);
  expect(applyThreadEvent(t, { seq: 1, ts: 5, event: { type: "run.interrupted", runId: "r1" } })).toBe(t);
});

test("request resolved updates the item and drops the pending request", () => {
  seq = 0;
  let t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "request.opened", runId: "r1", requestId: "q1", kind: "question", prompt: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
  ]);
  expect(t.pending).toEqual([{ requestId: "q1", runId: "r1", kind: "question", prompt: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true, openedAt: 1001 }]);
  expect(t.items.at(-1)).toMatchObject({ kind: "request", itemId: "q1", text: "Which?", status: "open" });
  // A re-announcement is a no-op (only lastSeq moves).
  const before = t.items.length;
  t = run(t, [{ type: "request.opened", runId: "r1", requestId: "q1", kind: "question", prompt: "Which?" }]);
  expect(t.items).toHaveLength(before);
  expect(t.pending).toHaveLength(1);
  t = run(t, [{ type: "request.resolved", requestId: "q1", answer: "A, B", by: "user" }]);
  expect(t.pending).toEqual([]);
  expect(t.items.at(-1)).toMatchObject({ kind: "request", itemId: "q1", status: "answered", output: "A, B" });
  t = run(t, [
    { type: "request.opened", runId: "r1", requestId: "q2", kind: "plan", prompt: "Plan", options: [{ label: "Approve" }] },
    { type: "request.resolved", requestId: "q2", answer: null, by: "expired" },
  ]);
  const q2 = t.items.find((i) => i.itemId === "q2")!;
  expect(q2.status).toBe("expired");
  expect("output" in q2).toBe(false);
});

test("tools: re-announced start is a no-op, finish fills output, a finish without start is an unknown tool", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "tool.started", runId: "r1", itemId: "t1", tool: "Bash", input: { command: "ls" } },
    { type: "tool.started", runId: "r1", itemId: "t1", tool: "Bash", input: { command: "other" } },
    { type: "tool.finished", runId: "r1", itemId: "t1", isError: false, output: "a\nb" },
    { type: "tool.finished", runId: "r1", itemId: "t2", isError: true, output: "boom" },
  ]);
  const tools = t.items.filter((i) => i.kind === "tool");
  expect(tools).toHaveLength(2);
  expect(tools[0]).toMatchObject({ tool: "Bash", input: { command: "ls" }, output: "a\nb", isError: false, status: "done" });
  expect(tools[1]).toMatchObject({ tool: "(unknown)", output: "boom", isError: true, status: "done" });
});

test("terminal events close streaming items; usage only from run.completed; failed adds a notice", () => {
  seq = 0;
  let t = run(emptyThread(), [
    { type: "thread.native", harness: "claude", nativeThreadId: "n1", account: null, model: "m" },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "x" },
    { type: "tool.started", runId: "r1", itemId: "t1", tool: "Bash", input: {} },
    { type: "run.completed", runId: "r1", nativeThreadId: "n2", usage: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 }, costUsd: null },
  ]);
  expect(t.items.every((i) => i.status === "done")).toBe(true);
  expect(t.runs[0]).toMatchObject({ status: "completed", harness: "claude", nativeThreadId: "n2", endedSeq: 5, usage: { input: 1, output: 2 } });
  t = run(t, [{ type: "run.failed", runId: "r1", error: "late" }]);
  expect(t.runs[0]).toMatchObject({ status: "failed", error: "late", usage: { input: 1 }, nativeThreadId: "n2" });
  expect(t.items.at(-1)).toMatchObject({ kind: "notice", runId: "r1", itemId: null, text: "late" });
  expect(t.runs[0].failureReason).toBeUndefined();
  t = run(t, [{ type: "run.failed", runId: "r1", error: "rate-limited: x", reason: "rate-limited" }]);
  expect(t.runs[0]).toMatchObject({ status: "failed", failureReason: "rate-limited" });
  t = run(t, [{ type: "run.failed", runId: "r1", error: "later" }]);
  expect(t.runs[0].failureReason).toBeUndefined();
  t = run(t, [{ type: "run.interrupted", runId: "nope" }]);
  expect(t.items.at(-1)).toMatchObject({ kind: "notice", text: "interrupted event for unknown run nope" });
});

test("message.final from the user does not duplicate the queued text", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.queued", runId: "r1", text: "hi", attachments: [] },
    { type: "message.final", runId: "r1", itemId: "u1", role: "user", text: "hi" },
    { type: "message.final", runId: "r2", itemId: "u2", role: "user", text: "agent-started" },
  ]);
  expect(t.items.map((i) => i.text)).toEqual(["hi", "agent-started"]);
});

test("unknown event type becomes a visible notice (and is logged); bridge restart only when resumed", () => {
  seq = 0;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const t = run(emptyThread(), [
    { type: "bridge.started", version: "1", resumed: false },
    { type: "bridge.started", version: "2", resumed: true },
    { type: "something.new" } as unknown as BridgeEvent,
  ]);
  expect(t.items.map((i) => i.text)).toEqual(["Agent bridge restarted (v2)", "unknown event something.new"]);
  expect(logged).toHaveBeenCalledTimes(1);
  logged.mockRestore();
  expect(t.lastSeq).toBe(3);
});

test("background.changed replaces the list; activeRun and queuedRunIds", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "background.changed", work: [{ id: "w", kind: "monitor", label: "watch", holding: true }] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "run.queued", runId: "r2", text: "next", attachments: [] },
  ]);
  expect(t.background).toHaveLength(1);
  expect(activeRun(t)?.runId).toBe("r1");
  expect([...queuedRunIds(t)]).toEqual(["r2"]);
});

test("mergeSnapshot: changed rows replace the client's copies, new ones append, the rest is wholesale", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "par" },
    { type: "request.opened", runId: "r1", requestId: "q1", kind: "question", prompt: "?" },
  ]);
  const merged = mergeSnapshot(t, {
    afterSeq: 3,
    snapshot: {
      lastSeq: 6, seenSeq: 2,
      runs: [{ ...t.runs[0], status: "completed", endedAt: 9, endedSeq: 6 }],
      items: [
        { seq: 2, runId: "r1", itemId: "m1", kind: "assistant", text: "partial", status: "done", ts: 1001 },
        { seq: 6, runId: "r1", itemId: null, kind: "notice", text: "n", status: "done", ts: 9 },
      ],
      pending: [], background: [], native: null,
    },
  });
  expect(merged.lastSeq).toBe(6);
  expect(merged.seenSeq).toBe(2);
  expect(merged.items.map((i) => i.text)).toEqual(["partial", "?", "n"]);
  expect(merged.runs).toHaveLength(1);
  expect(merged.runs[0].status).toBe("completed");
  expect(merged.pending).toEqual([]);
});

test("mergeSnapshot: a notice already applied from a live frame is not added twice; lastSeq never goes back", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "run.failed", runId: "r1", error: "boom" },
  ]);
  const merged = mergeSnapshot(t, {
    afterSeq: 1,
    snapshot: { ...t, lastSeq: 2, items: t.items.filter((i) => i.seq > 1) },
  });
  expect(merged.items.filter((i) => i.kind === "notice")).toHaveLength(1);
  expect(mergeSnapshot(t, { afterSeq: 0, snapshot: { ...emptyThread(), lastSeq: 1 } }).lastSeq).toBe(2);
});

test("composerErrorText: the three command failures, the rest by message", () => {
  expect(composerErrorText(409, { error: "agent-disconnected" })).toBe("agent not connected — message not sent");
  expect(composerErrorText(504, { error: "agent-timeout" })).toBe("no reply from the agent — check the thread before resending");
  expect(composerErrorText(409, { error: "command-failed", message: "busy" })).toBe("busy");
  expect(composerErrorText(400, { error: "text must be a non-empty string" })).toBe("text must be a non-empty string");
  expect(composerErrorText(500, null)).toBe("HTTP 500");
});

test("a run that starts at once has its user item", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "message.final", runId: "r1", itemId: "user:r1", role: "user", text: "hello" },
    { type: "message.final", runId: "r1", itemId: "m1", role: "assistant", text: "hi" },
    { type: "run.completed", runId: "r1", nativeThreadId: "nt", usage: null, costUsd: null },
  ]);
  expect(t.items.map((i) => [i.kind, i.itemId, i.text])).toEqual([["user", "user:r1", "hello"], ["assistant", "m1", "hi"]]);
  expect(t.runs).toEqual([expect.objectContaining({ runId: "r1", status: "completed", origin: "user" })]);
});

test("deltas after a run's terminal event are ignored: the item stays done", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "Hel" },
    { type: "run.interrupted", runId: "r1" },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "lo" },
    { type: "message.delta", runId: "r1", itemId: "m2", text: "late" },
  ]);
  expect(t.items.map((i) => [i.itemId, i.text, i.status])).toEqual([["m1", "Hel", "done"]]);
  expect(t.lastSeq).toBe(5);
});

test("a devd notice from the stream is added once, after what is there, and leaves lastSeq alone", () => {
  seq = 0;
  const t = run(emptyThread(), [{ type: "run.queued", runId: "r1", text: "hi", attachments: [] }]);
  const notice = { seq: 1, runId: null, itemId: "notice:1", kind: "notice" as const, text: "Switched to Codex", status: "done" as const, ts: 9 };
  const once = applyNotice(t, notice);
  expect(once.items.map((i) => i.text)).toEqual(["hi", "Switched to Codex"]);
  expect(once.lastSeq).toBe(1);
  // The same notice again (live frame and replay snapshot both carried it): still one.
  expect(applyNotice(once, notice).items).toHaveLength(2);
  expect(mergeSnapshot(once, { afterSeq: 1, snapshot: { ...emptyThread(), lastSeq: 1, items: [notice] } }).items).toHaveLength(2);
});

test("resume-failed or open-failed for a run id never announced adds no item (devd's notice says it), like the store", () => {
  const t = run(emptyThread(), [{ type: "run.failed", runId: "never-started", error: "resume-failed" }, { type: "run.failed", runId: "never-started-2", error: "open-failed" }]);
  expect(t.items).toEqual([]);
  expect(t.lastSeq).toBeGreaterThan(0);
});

test("a thread.native without a model keeps the harness's known model, like the store", () => {
  const t = run(emptyThread(), [
    { type: "thread.native", harness: "claude", nativeThreadId: "t1", account: "a", model: "claude-opus-5-5" },
    { type: "thread.native", harness: "claude", nativeThreadId: "t1", account: "b", model: null },
  ]);
  expect(t.native).toEqual({ harness: "claude", nativeThreadId: "t1", account: "b", model: "claude-opus-5-5" });
  expect(run(t, [{ type: "thread.native", harness: "codex", nativeThreadId: "x1", account: "c", model: null }]).native!.model).toBeNull();
});
