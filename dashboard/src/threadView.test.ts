import { expect, spyOn, test } from "bun:test";
import type { BridgeEvent, LoggedEvent, ThreadItem, ThreadSnapshot } from "../../shared/thread";
import fixture from "../../shared/fixtures/thread-events.json";
import { activeRun, applyNotice, applyThreadEvent, composerErrorText, criticRunIds, emptyThread, mergeSnapshot, queuedRunIds } from "./threadView";

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
