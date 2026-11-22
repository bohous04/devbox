import { expect, test } from "bun:test";
import type { Attention, InboxItem } from "../../shared/thread";
import { asks, branchLabel, groupInbox, inboxHref, inboxList, rowMark, secondLine, mixedAgents, plainPreview, projectBadge, reasonLabel, reasonStatus, rowStatus, rowTitle, statusParts, shelfBlock, shortAgo, snoozeTimes, splitNeedsYou, threadHeading, upsertInbox } from "./inboxView";

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

test("splitNeedsYou: finished runs are their own group, newest first; everything else asks for action, order kept", () => {
  const req = item("req", { section: "needs_you", reason: "request", since: 1 });
  const fail = item("fail", { section: "needs_you", reason: "failed", since: 2 });
  const done = item("done", { section: "needs_you", reason: "completed", since: 3 });
  const doneNew = item("done-new", { section: "needs_you", reason: "completed", since: 9 });
  expect(splitNeedsYou([req, done, fail, doneNew])).toEqual({ action: [req, fail], finished: [doneNew, done] });
});

test("rowStatus: chips per reason; settled and idle rows have none; snoozed says so", () => {
  expect(rowStatus(item("a", { section: "needs_you", reason: "request", since: 1 }))).toEqual({ label: "Needs answer", tone: "action" });
  expect(rowStatus(item("a", { section: "needs_you", reason: "completed", since: 1 }))).toEqual({ label: "Done", tone: "done" });
  expect(rowStatus(item("a", { section: "needs_you", reason: "ci-failed", since: 1 }))?.tone).toBe("danger");
  expect(rowStatus(item("a", { section: "working", reason: "running", since: 1 }))).toEqual({ label: "Working", tone: "busy" });
  expect(rowStatus(item("a", { section: "idle", reason: null, since: 1 }))).toBeNull();
  expect(rowStatus(item("a", { section: "settled", reason: "completed", since: 1 }))).toBeNull();
  expect(rowStatus(item("a", { section: "snoozed", reason: "completed", since: 1, until: 9 }))).toEqual({ label: "Snoozed", tone: "quiet" });
});

test("shortAgo: now, minutes, hours, days", () => {
  expect(shortAgo(30_000)).toBe("now");
  expect(shortAgo(-5)).toBe("now");
  expect(shortAgo(7 * 60_000)).toBe("7m");
  expect(shortAgo(3 * 3_600_000 + 59 * 60_000)).toBe("3h");
  expect(shortAgo(50 * 3_600_000)).toBe("2d");
});

test("projectBadge: two initials from words, two letters from one word, a stable slot", () => {
  expect(projectBadge("games/harbor_api").letters).toBe("GH");
  expect(projectBadge("acme").letters).toBe("AC");
  expect(projectBadge("Údržba města").letters).toBe("ÚM");
  expect(projectBadge("").letters).toBe("?");
  expect(projectBadge("apps").slot).toBe(projectBadge("apps").slot);
  expect(projectBadge("apps").slot).toBeLessThan(6);
});

test("plainPreview drops markdown marks from a one-line preview", () => {
  expect(plainPreview("Ve `scratch/` jsem **hotovo**\n\n# Done")).toBe("Ve scratch/ jsem hotovo # Done");
  expect(plainPreview("## Summary: all `green`")).toBe("Summary: all green");
});

test("rowTitle: custom name, else the topic from the first message, else repo and session number; never the newest message", () => {
  const base = item("dev-p-r-14", { section: "idle", reason: null, since: 1 });
  expect(rowTitle({ ...base, title: "Boosting", topic: "Add a retry queue" })).toBe("Boosting");
  expect(rowTitle({ ...base, title: "p/r", topic: "Add a retry queue", lastText: "OK" })).toBe("Add a retry queue");
  // The newest message changes with every reply (often the agent's "OK"): it is the preview, never the title.
  expect(rowTitle({ ...base, title: "p/r", lastText: "Fixed the `test`" })).toBe("r #14");
  expect(rowTitle({ ...base, title: "p/r", topic: null })).toBe("r #14");
  expect(rowTitle({ ...base, sessionId: "dev-p-r", title: "p/r" })).toBe("r");
  expect(rowTitle({ ...base, sessionId: "dev-p-notes-13", repo: "notes-13", title: "p/notes-13" })).toBe("notes-13");
});

test("plainPreview keeps __ inside words", () => {
  expect(plainPreview("edit __init__.py and my__var")).toBe("edit __init__.py and my__var");
  expect(plainPreview("a __bold__ word")).toBe("a bold word");
});

test("reasonStatus: the chip of any reason regardless of shelf; none for no reason", () => {
  expect(reasonStatus("completed")).toEqual({ label: "Done", tone: "done" });
  expect(reasonStatus("failed")).toEqual({ label: "Failed", tone: "danger" });
  expect(reasonStatus(null)).toBeNull();
});

test("statusParts: nothing for an untouched idle row; snooze end; compact keeps only danger labels", () => {
  const now = 10 * 60_000;
  expect(statusParts(item("a", { section: "idle", reason: null, since: 0 }), now, true)).toBeNull();
  expect(statusParts(item("a", { section: "snoozed", reason: "completed", since: 0, until: 99 }), now, false))
    .toEqual({ mark: { label: "Snoozed", tone: "quiet" }, showLabel: true, until: 99, ago: "" });
  expect(statusParts(item("a", { section: "needs_you", reason: "completed", since: now - 3 * 60_000 }), now, true))
    .toEqual({ mark: { label: "Done", tone: "done" }, showLabel: false, until: null, ago: "3m" });
  expect(statusParts(item("a", { section: "settled", reason: "ci-failed", since: 1 }), now, true)?.showLabel).toBe(true);
  expect(statusParts(item("a", { section: "idle", reason: null, since: now - 120_000 }), now, true))
    .toEqual({ mark: null, showLabel: false, until: null, ago: "2m" });
});

test("rowTitle: a failed session's error stays in the preview, not the title", () => {
  const failed = { ...item("dev-p-r", { section: "needs_you", reason: "failed", since: 1 }), title: "p/r", lastText: "Error: **build** failed" };
  expect(rowTitle(failed)).toBe("r");
});

test("threadHeading: the thread page names the thread like its inbox row, the topic from the first message with text", () => {
  const session = { name: null, project: "p", repo: "r" };
  const user = (text: string, seq: number) => ({ seq, runId: `r${seq}`, itemId: `user:r${seq}`, kind: "user" as const, text, status: "done" as const, ts: seq });
  expect(threadHeading("dev-p-r-14", session, [user("", 1), user("Fix the login redirect. Then test it", 2)])).toBe("Fix the login redirect");
  expect(threadHeading("dev-p-r-14", session, [])).toBe("r #14");
  expect(threadHeading("dev-p-r-14", { ...session, name: " Boosting " }, undefined)).toBe("Boosting");
  // Loading, no name: the crumb stands in.
  expect(threadHeading("dev-p-r-14", session, undefined)).toBeNull();
  // Not a known session: its id.
  expect(threadHeading("dev-p-r-14", undefined, undefined)).toBe("dev-p-r-14");
});

test("mixedAgents: a row names its agent only while the visible rows use more than one", () => {
  const a = item("a", { section: "idle", reason: null, since: 1 });
  expect(mixedAgents([a, { ...a, sessionId: "b" }])).toBe(false);
  expect(mixedAgents([])).toBe(false);
  expect(mixedAgents([a, { ...a, sessionId: "b", agent: "codex" }])).toBe(true);
});

test("inboxList: asks pinned on top oldest first, then finished and idle together newest first; no cap", () => {
  const rows = Array.from({ length: 12 }, (_, n) => item(`idle-${n}`, { section: "idle", reason: null, since: 100 + n }));
  const list = inboxList(groupInbox([
    ...rows,
    item("done-new", { section: "needs_you", reason: "completed", since: 500 }),
    item("fail", { section: "needs_you", reason: "failed", since: 30 }),
    item("ask-old", { section: "needs_you", reason: "request", since: 5 }),
    item("done-old", { section: "needs_you", reason: "completed", since: 50 }),
    item("limit", { section: "needs_you", reason: "rate-limited", since: 40 }),
    item("work", { section: "working", reason: "running", since: 999 }),
    item("snz", { section: "snoozed", reason: null, since: 998, until: 2_000 }),
    item("set", { section: "settled", reason: null, since: 997 }),
  ]));
  const ids = list.map((i) => i.sessionId);
  expect(ids.slice(0, 5)).toEqual(["ask-old", "fail", "limit", "done-new", "idle-11"]);
  expect(ids.at(-1)).toBe("done-old");
  expect(ids).toHaveLength(17);
  expect(ids).not.toContain("work");
  expect(ids).not.toContain("snz");
  expect(ids).not.toContain("set");
});

test("asks: a request or a failure in needs-you, not a finish", () => {
  expect(asks(item("a", { section: "needs_you", reason: "request", since: 1 }))).toBe(true);
  expect(asks(item("a", { section: "needs_you", reason: "ci-failed", since: 1 }))).toBe(true);
  expect(asks(item("a", { section: "needs_you", reason: "completed", since: 1 }))).toBe(false);
  expect(asks(item("a", { section: "snoozed", reason: "failed", since: 1 }))).toBe(false);
});

test("rowMark: a mark only when there is something to say", () => {
  const mark = (section: Attention["section"], reason: Attention["reason"]) => rowMark(item("x", { section, reason, since: 1 }));
  expect(mark("needs_you", "request")).toEqual({ label: "Answer", tone: "action" });
  expect(mark("needs_you", "failed")).toEqual({ label: "Failed", tone: "danger" });
  expect(mark("needs_you", "rate-limited")).toEqual({ label: "Limit", tone: "danger" });
  expect(mark("needs_you", "disconnected")).toEqual({ label: "Offline", tone: "danger" });
  expect(mark("needs_you", "bridge-behind")).toEqual({ label: "Behind", tone: "danger" });
  expect(mark("needs_you", "ci-failed")).toEqual({ label: "CI failed", tone: "danger" });
  expect(mark("needs_you", "completed")).toEqual({ label: "Done", tone: "done" });
  expect(mark("idle", null)).toBeNull();
  expect(mark("working", "running")).toBeNull();
  expect(mark("settled", "completed")).toBeNull();
  expect(mark("snoozed", "failed")).toBeNull();
});

test("branchLabel: a session's own numbered branch says only what the title does not", () => {
  const b = (branch: string | null | undefined, title = "Fix it") => branchLabel({ ...item("dev-r-3", { section: "idle", reason: null, since: 1 }), title, branch });
  expect(b(undefined)).toBeNull();
  expect(b("")).toBeNull();
  expect(b("feature/upload")).toBe("feature/upload");
  expect(b("session/r-3")).toBe("#3");
  expect(b("session/r-3", "p/r")).toBeNull();
  expect(b("session/r-x")).toBe("session/r-x");
});

test("secondLine: an ask says what it asks; any other row where it runs", () => {
  const ask = { ...item("a", { section: "needs_you", reason: "request", since: 1 }), lastText: "Run the **migration**?" };
  expect(secondLine(ask)).toBe("r · Run the migration?");
  expect(secondLine({ ...ask, lastText: null })).toBe("r · waiting for your answer");
  const idle = { ...item("i", { section: "idle", reason: null, since: 1 }), lastText: "All done" };
  expect(secondLine(idle)).toBe("p/r");
  expect(secondLine({ ...idle, branch: "feature/x" })).toBe("p/r · feature/x");
  const working = { ...item("w", { section: "working", reason: "running", since: 1 }), lastText: "Updating tokens" };
  expect(secondLine(working)).toBe("p/r · Updating tokens");
});
