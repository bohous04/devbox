import { expect, spyOn, test } from "bun:test";
import type { BridgeEvent, LoggedEvent, ThreadItem, ThreadSnapshot } from "../../shared/thread";
import fixture from "../../shared/fixtures/thread-events.json";
import { activeRun, applyCommands, applyEffort, applyNotice, applyThreadEvent, composerErrorText, criticRunIds, emptyThread, hasOlderThan, mergeSnapshot, olderBeforeSeq, prependOlder, queuedRunIds, seenToPost, tailView, THREAD_PAGE } from "./threadView";

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
  const n = prependOlder(t, older);
  expect(n.items.map((i) => `${i.seq}:${i.itemId}`)).toEqual(["3:i3", "5:i5", "5:notice:1", "6:i6"]);
  expect(n.lastSeq).toBe(9);
  expect(n.topic).toBe("Fix it");
});

test("mergeSnapshot keeps the topic the GET named (stream frames carry none)", () => {
  const t: ThreadSnapshot = { ...emptyThread(), topic: "Fix it" };
  expect(mergeSnapshot(t, { afterSeq: 0, snapshot: { ...emptyThread(), lastSeq: 2 } }).topic).toBe("Fix it");
  expect("topic" in mergeSnapshot(emptyThread(), { afterSeq: 0, snapshot: emptyThread() })).toBe(false);
});

test("tailView starts a cut thread at its first whole run; a run that fills the page stays, unfolded", () => {
  const items = [it_(1, "r1", "tool"), it_(2, null, "notice"), it_(3, "r1", "assistant"), it_(4, "r2", "user"), it_(5, "r2", "tool")];
  expect(tailView(items, true)).toEqual({ items: items.slice(3), partialRun: null });
  // All of it loaded: nothing is cut.
  expect(tailView(items, false)).toEqual({ items, partialRun: null });
  const one = [it_(1, "r1", "tool"), it_(2, "r1", "tool")];
  expect(tailView(one, true)).toEqual({ items: one, partialRun: "r1" });
  expect(tailView([it_(1, null, "notice")], true)).toEqual({ items: [it_(1, null, "notice")], partialRun: null });
});
