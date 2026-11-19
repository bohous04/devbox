import { expect, test } from "bun:test";
import type { Attention, InboxItem } from "../../shared/thread";
import { groupInbox, inboxHref, reasonLabel, shelfBlock, snoozeTimes, upsertInbox } from "./inboxView";

const item = (sessionId: string, attention: Attention, runtime: InboxItem["runtime"] = "chat"): InboxItem => ({
  sessionId, runtime, title: sessionId, project: "p", repo: "r", agent: "claude", attention, lastText: null,
});

test("groupInbox: three sections; needs-you oldest first, working and idle newest first", () => {
  const g = groupInbox([
    item("idle-old", { section: "idle", reason: null, since: 1 }),
    item("need-new", { section: "needs_you", reason: "completed", since: 50 }),
    item("work-old", { section: "working", reason: "running", since: 10 }),
    item("need-old", { section: "needs_you", reason: "request", since: 5 }),
    item("idle-new", { section: "idle", reason: null, since: 9 }),
    item("work-new", { section: "working", reason: "queued", since: 20 }),
  ]);
  expect(g.needsYou.map((i) => i.sessionId)).toEqual(["need-old", "need-new"]);
  expect(g.working.map((i) => i.sessionId)).toEqual(["work-new", "work-old"]);
  expect(g.idle.map((i) => i.sessionId)).toEqual(["idle-new", "idle-old"]);
});

test("upsertInbox replaces a session's item or appends a new one", () => {
  const a = item("a", { section: "idle", reason: null, since: 1 });
  const b = item("b", { section: "idle", reason: null, since: 2 });
  const a2 = item("a", { section: "needs_you", reason: "request", since: 3 });
  expect(upsertInbox([a, b], a2)).toEqual([a2, b]);
  const c = item("c", { section: "working", reason: "running", since: 4 });
  expect(upsertInbox([a, b], c)).toEqual([a, b, c]);
});

test("inboxHref: chat rows open the session page, tmux rows the terminal", () => {
  expect(inboxHref(item("dev x", { section: "idle", reason: null, since: 0 }))).toBe("/s/dev%20x");
  expect(inboxHref(item("dev-t", { section: "idle", reason: null, since: 0 }, "tmux"))).toBe("/terminal/dev-t");
});

test("reasonLabel names every reason", () => {
  expect(reasonLabel(null)).toBe("");
  expect(reasonLabel("request")).toBe("waiting for your answer");
  expect(reasonLabel("disconnected")).toBe("agent not connected");
  expect(reasonLabel("rate-limited")).toBe("rate limit reached — wait or switch model");
});

test("upsertInbox drops a removed session", () => {
  const a = item("a", { section: "idle", reason: null, since: 1 });
  const b = item("b", { section: "idle", reason: null, since: 2 });
  expect(upsertInbox([a, b], { sessionId: "a", removed: true })).toEqual([b]);
  expect(upsertInbox([b], { sessionId: "a", removed: true })).toEqual([b]);
});

test("groupInbox: settled and snoozed shelves, newest first", () => {
  const g = groupInbox([
    item("set-old", { section: "settled", reason: null, since: 1 }),
    item("snz", { section: "snoozed", reason: "completed", since: 3, until: 99 }),
    item("set-new", { section: "settled", reason: "completed", since: 7 }),
    item("idle", { section: "idle", reason: null, since: 2 }),
  ]);
  expect(g.settled.map((i) => i.sessionId)).toEqual(["set-new", "set-old"]);
  expect(g.snoozed.map((i) => i.sessionId)).toEqual(["snz"]);
  expect(g.idle.map((i) => i.sessionId)).toEqual(["idle"]);
});

test("snoozeTimes: one hour from now, and the next 9:00 local time (today before 9:00, else tomorrow)", () => {
  const late = new Date(2026, 10, 19, 23, 30);
  expect(snoozeTimes(late)).toEqual({ hour: late.getTime() + 3_600_000, morning: { at: new Date(2026, 10, 20, 9, 0).getTime(), label: "Tomorrow 9:00" } });
  expect(snoozeTimes(new Date(2026, 10, 30, 9, 0)).morning).toEqual({ at: new Date(2026, 11, 1, 9, 0).getTime(), label: "Tomorrow 9:00" });
  expect(snoozeTimes(new Date(2026, 10, 19, 6, 15)).morning).toEqual({ at: new Date(2026, 10, 19, 9, 0).getTime(), label: "9:00" });
});

test("shelfBlock: a session with an open request cannot be settled or snoozed", () => {
  expect(shelfBlock(item("a", { section: "needs_you", reason: "request", since: 1 }))).toBe("Answer the open request first");
  expect(shelfBlock(item("a", { section: "needs_you", reason: "completed", since: 1 }))).toBeNull();
});
