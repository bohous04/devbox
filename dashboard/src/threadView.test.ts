import { expect, spyOn, test } from "bun:test";
import type { BridgeEvent, LoggedEvent, RunRow, ThreadItem, ThreadSnapshot } from "../../shared/thread";
import fixture from "../../shared/fixtures/thread-events.json";
import { activeRun, applyCommands, applyLive, emptyHeld, mergeLive, applyEffort, applyNotice, applyThreadEvent, composerErrorText, criticRunIds, emptyThread, hasOlderThan, mergeSnapshot, olderBeforeSeq, prependOlder, queuedRunIds, seenToPost, tailView, THREAD_PAGE } from "./threadView";

/** The shared cases (also run by ios/DevboxAppTests/ThreadStoreTests.swift): each starts from an empty thread. */
type Step = { event: LoggedEvent } | { snapshot: { afterSeq: number; snapshot: ThreadSnapshot } } | { notice: ThreadItem };
interface Case { name: string; steps: Step[]; expect: ThreadSnapshot; derived?: { activeRun: string | null; queued: string[]; critic: string[] } }

for (const c of fixture.cases as unknown as Case[]) {
  test(`shared fixture: ${c.name}`, () => {
    // An unknown event type is logged; that is checked below, not here.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    let t = emptyThread();
    for (const s of c.steps) {
      if ("event" in s) t = applyThreadEvent(t, s.event);
      else if ("snapshot" in s) t = mergeSnapshot(t, s.snapshot);
      else t = applyNotice(t, s.notice);
    }
    logged.mockRestore();
    expect(t).toEqual(c.expect);
    if (c.derived) {
      expect(activeRun(t)?.runId ?? null).toBe(c.derived.activeRun);
      expect([...queuedRunIds(t)]).toEqual(c.derived.queued);
      expect([...criticRunIds(t)]).toEqual(c.derived.critic);
    }
  });
}

let seq = 0;
const ev = (event: BridgeEvent, ts = 1000 + seq): LoggedEvent => ({ seq: ++seq, ts, event });
const run = (t: ThreadSnapshot, events: BridgeEvent[]) => events.reduce((acc, e) => applyThreadEvent(acc, ev(e)), t);

test("an event at or below lastSeq returns the same thread object", () => {
  seq = 0;
  const t = run(emptyThread(), [
    { type: "run.started", runId: "r1", origin: "agent", nativeThreadId: "n", model: "m" },
    { type: "message.delta", runId: "r1", itemId: "m1", text: "a" },
  ]);
  expect(applyThreadEvent(t, { seq: 2, ts: 5, event: { type: "message.delta", runId: "r1", itemId: "m1", text: "a" } })).toBe(t);
  expect(applyThreadEvent(t, { seq: 1, ts: 5, event: { type: "run.interrupted", runId: "r1" } })).toBe(t);
});

test("an unknown event type is logged once", () => {
  seq = 0;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  run(emptyThread(), [{ type: "something.new" } as unknown as BridgeEvent]);
  expect(logged).toHaveBeenCalledTimes(1);
  logged.mockRestore();
});

test("composerErrorText: the three command failures, the rest by message", () => {
  expect(composerErrorText(409, { error: "agent-disconnected" })).toBe("agent not connected — message not sent");
  expect(composerErrorText(504, { error: "agent-timeout" })).toBe("no reply from the agent — check the thread before resending");
  expect(composerErrorText(409, { error: "command-failed", message: "busy" })).toBe("busy");
  expect(composerErrorText(400, { error: "text must be a non-empty string" })).toBe("text must be a non-empty string");
  expect(composerErrorText(500, null)).toBe("HTTP 500");
});

test("composerErrorText shows a bridge-too-old refusal's message", () => {
  expect(composerErrorText(409, { error: "bridge-too-old", message: "recreate the container" })).toBe("recreate the container");
});

test("effort: a thread-effort replaces the thread's effort; an effort.state thread event changes nothing", () => {
  const effort = { model: "gpt-6.1-sol", supported: ["low", "medium", "high"], effective: "high", chosen: "high" };
  const t = applyEffort(emptyThread(), effort);
  expect(t.effort).toEqual(effort);
  const after = run(t, [{ type: "effort.state", model: "m", supported: [], effective: null, chosen: null }]);
  expect(after.effort).toEqual(effort);
  expect(after.items).toEqual([]);
  const merged = mergeSnapshot(emptyThread(), { afterSeq: 0, snapshot: { ...emptyThread(), effort } });
  expect(merged.effort).toEqual(effort);
});

test("commands: thread-commands replaces the list (null = none: no / menu); a replay snapshot carries its own or none", () => {
  const list = [{ name: "compact", hint: "<instructions>" }];
  const t = applyCommands(emptyThread(), list);
  expect(t.commands).toEqual(list);
  expect("commands" in applyCommands(t, null)).toBe(false);
  expect(run(t, [{ type: "commands.changed", commands: [] }]).commands).toEqual(list);
  expect(mergeSnapshot(emptyThread(), { afterSeq: 0, snapshot: { ...emptyThread(), commands: list } }).commands).toEqual(list);
  // A snapshot without commands (the harness sent none, e.g. after a switch to Codex) drops the old list.
  expect("commands" in mergeSnapshot(t, { afterSeq: 0, snapshot: emptyThread() })).toBe(false);
});

test("seenToPost: a look always posts (it restarts the inbox's auto-settle clock); a run ending only when unseen", () => {
  const t = { ...emptyThread(), lastSeq: 5, seenSeq: 5 };
  expect(seenToPost(t, true)).toBe(5);
  expect(seenToPost(t, false)).toBeNull();
  expect(seenToPost({ ...t, seenSeq: 3 }, false)).toBe(5);
});

const it_ = (seq: number, runId: string | null, kind: ThreadItem["kind"], itemId: string | null = `i${seq}`): ThreadItem =>
  ({ seq, runId, itemId, kind, text: `t${seq}`, ts: seq });

test("paging back: a full page may have more, the next page is asked from one past the oldest seq", () => {
  const t: ThreadSnapshot = { ...emptyThread(), lastSeq: 9, items: [it_(5, "r1", "user"), it_(6, "r1", "tool")] };
  expect(olderBeforeSeq(t)).toBe(6);
  expect(olderBeforeSeq(emptyThread())).toBeNull();
  expect(hasOlderThan({ ...t, items: Array.from({ length: THREAD_PAGE }, (_, i) => it_(i + 1, "r", "tool")) })).toBe(true);
  expect(hasOlderThan(t)).toBe(false);
});

test("prependOlder puts the older page in front and drops the boundary items already here", () => {
  // A devd notice took the seq of the event before it: both sit at seq 5, the notice already loaded.
  const t: ThreadSnapshot = { ...emptyThread(), lastSeq: 9, topic: "Fix it", items: [it_(5, null, "notice", "notice:1"), it_(6, "r2", "user")] };
  const older = [it_(3, "r1", "user"), it_(5, "r1", "tool"), it_(5, null, "notice", "notice:1")];
  const n = prependOlder(t, older, emptyHeld(), true);
  expect(n.items.map((i) => `${i.seq}:${i.itemId}`)).toEqual(["3:i3", "5:i5", "5:notice:1", "6:i6"]);
  expect(n.lastSeq).toBe(9);
  expect(n.topic).toBe("Fix it");
});

test("mergeSnapshot keeps the topic the GET named (stream frames carry none)", () => {
  const t: ThreadSnapshot = { ...emptyThread(), topic: "Fix it" };
  expect(mergeSnapshot(t, { afterSeq: 0, snapshot: { ...emptyThread(), lastSeq: 2 } }).topic).toBe("Fix it");
  expect("topic" in mergeSnapshot(emptyThread(), { afterSeq: 0, snapshot: emptyThread() })).toBe(false);
});

const run_ = (runId: string, status: RunRow["status"]): RunRow =>
  ({ runId, origin: "user", status, harness: null, nativeThreadId: null, model: null, queuedAt: null, startedAt: 1, endedAt: null, endedSeq: null, usage: null, error: null });

test("tailView starts a cut thread at its first whole run; a run that fills the page stays, unfolded", () => {
  const items = [it_(1, "r1", "tool"), it_(2, null, "notice"), it_(3, "r1", "assistant"), it_(4, "r2", "user"), it_(5, "r2", "tool")];
  const runs = [run_("r1", "completed"), run_("r2", "completed")];
  expect(tailView(items, true, runs, [])).toEqual({ items: items.slice(3), partialRun: null });
  // All of it loaded: nothing is cut.
  expect(tailView(items, false, runs, [])).toEqual({ items, partialRun: null });
  const one = [it_(1, "r1", "tool"), it_(2, "r1", "tool")];
  expect(tailView(one, true, runs, [])).toEqual({ items: one, partialRun: "r1" });
  expect(tailView([it_(1, null, "notice")], true, runs, [])).toEqual({ items: [it_(1, null, "notice")], partialRun: null });
});

test("tailView keeps the oldest run when its prompt is loaded: it is whole", () => {
  const items = [it_(1, "r1", "user"), it_(2, "r1", "tool"), it_(3, "r2", "user")];
  expect(tailView(items, true, [run_("r1", "completed"), run_("r2", "completed")], [])).toEqual({ items, partialRun: null });
});

test("tailView never drops a running run, nor one with an open request, even when a queued prompt follows", () => {
  // r1 runs (started before the window); the user queued r2, whose prompt devd inserts at queue time, among r1's items.
  const items = [it_(1, "r1", "tool"), it_(2, "r1", "request", "q1"), it_(3, "r2", "user"), it_(4, "r1", "tool")];
  expect(tailView(items, true, [run_("r1", "running"), run_("r2", "queued")], [])).toEqual({ items, partialRun: "r1" });
  const pending = [{ requestId: "q1", runId: "r1", kind: "question" as const, prompt: "ok?", openedAt: 2 }];
  expect(tailView(items, true, [run_("r1", "completed"), run_("r2", "completed")], pending)).toEqual({ items, partialRun: "r1" });
  // r1 ended with nothing open: all its items go, also those after r2's prompt, so no part of it is left out of place.
  expect(tailView(items, true, [run_("r1", "completed"), run_("r2", "running")], [])).toEqual({ items: [it_(3, "r2", "user")], partialRun: null });
});

const finished = (seq: number, itemId: string, output: string): LoggedEvent =>
  ({ seq, ts: seq, event: { type: "tool.finished", runId: "r1", itemId, isError: false, output } });

test("a live finish of a tool whose start is not loaded is held, then lands on that tool when its page loads: one tool, finished", () => {
  // Loaded window: seq 10 on; tool t1 started at seq 4, before it.
  let t: ThreadSnapshot = { ...emptyThread(), lastSeq: 10, items: [it_(10, "r1", "tool")] };
  let held = emptyHeld();
  ({ thread: t, held } = applyLive(t, finished(11, "t1", "ok"), true, held));
  expect(t.lastSeq).toBe(11);
  expect(t.items.map((i) => i.itemId)).toEqual(["i10"]);
  expect(t.items.some((i) => i.tool === "(unknown)")).toBe(false);
  // The page was answered before the finish: its copy of t1 is still running.
  const page = [{ ...it_(4, "r1", "tool", "t1"), tool: "Bash", status: "streaming" as const }, it_(10, "r1", "tool")];
  t = prependOlder(t, page, held, true);
  expect(t.items.map((i) => `${i.itemId}:${i.tool ?? ""}:${i.status ?? ""}:${i.output ?? ""}`)).toEqual(["t1:Bash:done:ok", "i10:::"]);
  // Applying the held finish again (an updater run twice, a later page) changes nothing.
  expect(prependOlder(t, [], held, false)).toEqual(t);
  // Not loaded but the thread is whole: applies as before.
  expect(applyLive({ ...emptyThread(), lastSeq: 1 }, finished(2, "t9", "x"), false, emptyHeld()).thread.items[0]!.tool).toBe("(unknown)");
});

test("a replayed item from before the window is held, not appended at the end; the page brings it to its place once", () => {
  const t: ThreadSnapshot = { ...emptyThread(), lastSeq: 10, items: [it_(10, "r1", "tool")] };
  const t1 = { ...it_(4, "r1", "tool", "t1"), tool: "Bash", status: "done" as const, output: "ok" };
  const r = mergeLive(t, { afterSeq: 10, snapshot: { ...emptyThread(), lastSeq: 12, items: [t1, it_(12, "r1", "assistant")] } }, true, emptyHeld());
  expect(r.thread.items.map((i) => i.seq)).toEqual([10, 12]);
  const n = prependOlder(r.thread, [{ ...t1, status: "streaming", output: undefined }], r.held, false);
  expect(n.items.map((i) => `${i.seq}:${i.status ?? ""}:${i.output ?? ""}`)).toEqual(["4:done:ok", "10::", "12::"]);
});

test("a finish whose start never comes (trimmed log) shows as an unknown tool once nothing older is left", () => {
  const t: ThreadSnapshot = { ...emptyThread(), lastSeq: 10, items: [it_(10, "r1", "tool")] };
  const { thread, held } = applyLive(t, finished(11, "gone", "x"), true, emptyHeld());
  expect(prependOlder(thread, [it_(2, "r1", "user")], held, true).items.some((i) => i.tool === "(unknown)")).toBe(false);
  const done = prependOlder(thread, [it_(2, "r1", "user")], held, false);
  expect(done.items.map((i) => i.tool ?? i.kind)).toEqual(["user", "tool", "(unknown)"]);
});

test("prependOlder never doubles an item the page repeats: the loaded copy keeps its place and state", () => {
  const live = { ...it_(9, "r1", "tool", "t1"), status: "done" as const, output: "new" };
  const t: ThreadSnapshot = { ...emptyThread(), lastSeq: 12, items: [live, it_(12, "r1", "assistant")] };
  const n = prependOlder(t, [it_(3, "r1", "user"), { ...live, status: "streaming", output: undefined }], emptyHeld(), false);
  expect(n.items.map((i) => `${i.itemId}:${i.output ?? ""}`)).toEqual(["i3:", "t1:new", "i12:"]);
});

test("prependOlder keeps two notices without item id at the same seq apart (by their text)", () => {
  const restarted = { ...it_(5, null, "notice", null), text: "Agent bridge restarted (v2)" };
  const own = { ...it_(5, null, "notice", null), text: "Resumed the conversation" };
  const t: ThreadSnapshot = { ...emptyThread(), lastSeq: 9, items: [own, it_(6, "r2", "user")] };
  expect(prependOlder(t, [it_(4, "r1", "user"), restarted, own], emptyHeld(), false).items.map((i) => i.text))
    .toEqual(["t4", "Agent bridge restarted (v2)", "Resumed the conversation", "t6"]);
});
