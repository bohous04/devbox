import { expect, test } from "bun:test";
import { AGENT_IDS, AGENTS } from "../src/agents";
import {
  getAgentLiveState, insertMetrics, insertSession, listNotifyLog, listWorkIntervals, openDb, updateSession, type SessionRow,
} from "../src/db";
import { AgentEventHub, blockedText, doneText, sessionTitle, stuckText, type NotifyExtra } from "../src/agentEvents";

function fixture(quietMs = 20_000, coalesceMs = 30_000) {
  const db = openDb(":memory:");
  const row: SessionRow = {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  };
  insertSession(db, row);
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  let t = 100_000;
  const hub = new AgentEventHub({
    db, notify: (title, message, extra) => notified.push({ title, message, extra }),
    now: () => t, quietMs, coalesceMs,
  });
  return { db, row, hub, notified, tick: (ms: number) => { t += ms; }, now: () => t };
}

test('stop → silence → sweep sends "finished" with the session payload, no sound', () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop");
  hub.sweep();
  expect(notified).toHaveLength(0); // the window is still running
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  expect(notified[0].title).toBe("shop/cms");
  expect(notified[0].message).toBe("Claude finished working");
  expect(notified[0].extra?.sound).toBeUndefined();
  expect(notified[0].extra?.session).toEqual({ id: "dev-shop-cms", project: "shop", repo: "cms" });
  hub.sweep();
  expect(notified).toHaveLength(1); // one-shot
});

test("user_prompt_submit cancels a pending done and writes last_active_at", () => {
  const { db, row, hub, notified, tick, now } = fixture();
  hub.handle(row, "stop");
  tick(10_000);
  hub.handle(row, "user_prompt_submit");
  const at = now();
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);
  const r = db.query("SELECT last_active_at FROM sessions WHERE id=?").get(row.id) as { last_active_at: number };
  expect(r.last_active_at).toBe(at);
});

test("another stop moves the quiet window", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop");
  tick(15_000);
  hub.handle(row, "stop");
  tick(15_000);
  hub.sweep();
  expect(notified).toHaveLength(0); // only 15 s since the second stop
  tick(5_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
});

test("permission_request notifies right away, with sound and 30 s coalescing", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "permission_request");
  expect(notified).toHaveLength(1);
  expect(notified[0]).toMatchObject({ title: "shop/cms", message: "Claude is waiting for permission" });
  expect(notified[0].extra?.sound).toBe(true);
  tick(10_000);
  hub.handle(row, "permission_request");
  expect(notified).toHaveLength(1); // coalescing
  tick(30_000);
  hub.handle(row, "permission_request");
  expect(notified).toHaveLength(2);
});

test("notification: permission type → permission, blocking type → input", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "user_prompt_submit"); // turn is running
  tick(31_000);
  hub.handle(row, "notification", { notificationType: "agent_needs_input" });
  expect(notified).toHaveLength(1);
  expect(notified[0].message).toBe("Claude is waiting for input");
  tick(31_000);
  hub.handle(row, "notification", { notificationType: "permission_prompt" });
  expect(notified).toHaveLength(2);
  expect(notified[1].message).toBe("Claude is waiting for permission");
  // worker_permission_prompt is a permission too — a substring catches it, not an enumeration
  tick(31_000);
  hub.handle(row, "notification", { notificationType: "worker_permission_prompt" });
  expect(notified).toHaveLength(3);
  expect(notified[2].message).toBe("Claude is waiting for permission");
});

test("idle after a finished turn is suppressed (done already went out)", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "user_prompt_submit");
  tick(1_000);
  hub.handle(row, "stop");
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1); // done
  tick(60_000);
  hub.handle(row, "notification", { notificationType: "idle_prompt" });
  expect(notified).toHaveLength(1); // idle after the turn = no block
});

test("lastHookTs and forget", () => {
  const { row, hub, now } = fixture();
  expect(hub.lastHookTs(row.id)).toBeNull();
  hub.handle(row, "stop");
  expect(hub.lastHookTs(row.id)).toBe(now());
  hub.forget(row.id);
  expect(hub.lastHookTs(row.id)).toBeNull();
});

test("forget after stop: sweep after forget does not notify, a reopened session has no inherited lastStopAt", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop");
  hub.forget(row.id); // the session ended (status !== "running") before the quiet window elapsed
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(0); // forgotten state → no "finished" after the old stop
  expect(hub.lastHookTs(row.id)).toBeNull();
  // Re-open of the same (deterministic) session id: the old incarnation's lastStopAt must not leak
  // into the new one, otherwise api.ts would derive a made-up prompt wait time from it.
  expect(hub.lastStopTs(row.id)).toBeNull();
  hub.handle(row, "user_prompt_submit");
  expect(hub.lastStopTs(row.id)).toBeNull();
});

test("retainRunning forgets ended sessions → sweep does not send a late done", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop"); // arms pendingDone + creates the state
  expect(hub.lastHookTs(row.id)).not.toBeNull();
  hub.retainRunning(new Set(["dev-other-session"])); // row.id no longer runs → forget
  expect(hub.lastHookTs(row.id)).toBeNull();
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(0); // no "finished" after an ended session
});

test("retainRunning keeps a running session → done goes out normally", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop");
  hub.retainRunning(new Set([row.id])); // still running → keep
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  expect(notified[0].message).toBe("Claude finished working");
});

test("important session: done carries extra.important=true", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle({ ...row, important: 1 }, "stop");
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  expect(notified[0].extra?.important).toBe(true);
});

test("important session: blocked carries extra.important=true", () => {
  const { row, hub, notified } = fixture();
  hub.handle({ ...row, important: 1 }, "permission_request");
  expect(notified[0].extra?.important).toBe(true);
});

test("non-important session: extra.important is false", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop"); // important: 0
  tick(20_000);
  hub.sweep();
  expect(notified[0].extra?.important).toBe(false);
});

test("turnInProgress: prompt without stop → true, after stop → false", () => {
  const { row, hub, tick } = fixture();
  expect(hub.turnInProgress(row.id)).toBe(false); // no state
  hub.handle(row, "user_prompt_submit");
  expect(hub.turnInProgress(row.id)).toBe(true);
  tick(1_000);
  hub.handle(row, "stop");
  expect(hub.turnInProgress(row.id)).toBe(false);
});

test("turnInProgress: a running subagent holds the turn even after the main loop's stop (the stuck detector must not go blind)", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN);
  hub.handle(row, "stop", MAIN); // the main loop stepped back, but the subagent is still running
  expect(hub.turnInProgress(row.id)).toBe(true); // busy-subagents deferral ≠ end of turn
  tick(1_000);
  hub.handle(row, "subagent_stop", MAIN);
  hub.handle(row, "stop", MAIN); // only now really done
  expect(hub.turnInProgress(row.id)).toBe(false);
});

test("agent_done and agent_blocked are logged to events", () => {
  const { db, row, hub, tick } = fixture();
  hub.handle(row, "permission_request");
  hub.handle(row, "tool_complete"); // the allowed tool actually finished
  hub.handle(row, "stop");
  tick(20_000);
  hub.sweep();
  const types = (db.query("SELECT type FROM events WHERE session_id=? ORDER BY id").all(row.id) as { type: string }[]).map((r) => r.type);
  expect(types).toEqual(["agent_blocked", "agent_done"]);
});

test("notification texts: Claude (no agent / agent claude)", () => {
  const s = { id: "dev-a-b", project: "a", repo: "b" };
  expect(doneText(s)).toEqual({ title: "a/b", message: "Claude finished working" });
  expect(blockedText(s, "permission")).toEqual({ title: "a/b", message: "Claude is waiting for permission" });
  expect(blockedText(s, "input")).toEqual({ title: "a/b", message: "Claude is waiting for input" });
  expect(doneText({ ...s, agent: "claude" })).toEqual({ title: "a/b", message: "Claude finished working" });
});

test("notification texts: a Codex session reports Codex, not Claude (comfort parity, spec §5b)", () => {
  const s = { id: "dev-a-b", project: "a", repo: "b", agent: "codex" as const };
  expect(doneText(s)).toEqual({ title: "a/b", message: "Codex finished working" });
  expect(blockedText(s, "permission")).toEqual({ title: "a/b", message: "Codex is waiting for permission" });
  expect(blockedText(s, "input")).toEqual({ title: "a/b", message: "Codex is waiting for input" });
});

// `s.agent` comes from the DB as a plain string (SessionRow.agent), not as a verified
// AgentName — a custom table indexed directly by that value (the former AGENT_DISPLAY)
// would return `undefined` on an unknown profile and send "undefined finished working"
// to Pushover and the macOS notification. `specFor` falls back to claude, so this must not happen.
test("notification texts: an unknown profile falls back to Claude, not 'undefined'", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = { id: "dev-a-b", project: "a", repo: "b", agent: "gpt" as any };
  expect(doneText(s)).toEqual({ title: "a/b", message: "Claude finished working" });
  expect(blockedText(s, "permission")).toEqual({ title: "a/b", message: "Claude is waiting for permission" });
  expect(blockedText(s, "input")).toEqual({ title: "a/b", message: "Claude is waiting for input" });
});

test("stuckText carries the agent name, not a hardcoded Claude", () => {
  const base = { id: "x", project: "a", repo: "b" };
  expect(stuckText({ ...base, agent: "claude" })).toEqual({ title: "a/b", message: "Claude may be stuck — 20 min of silence while working" });
  expect(stuckText({ ...base, agent: "antigravity" }).message).toBe("Antigravity may be stuck — 20 min of silence while working");
});

test("the notification names the profile by its short name", () => {
  for (const agent of AGENT_IDS) {
    const t = doneText({ id: "x", project: "p", repo: "r", agent });
    expect(t.message).toBe(`${AGENTS[agent].short} finished working`);
  }
});

test("the notification carries the session nickname when it has one", () => {
  const s = { id: "dev-portal-web-2", project: "portal", repo: "web", agent: "claude" as const, name: "refactor" };
  expect(doneText(s).title).toBe("portal/web · refactor");
  expect(blockedText(s, "permission").title).toBe("portal/web · refactor");
  expect(blockedText(s, "input").title).toBe("portal/web · refactor");
});

// Without a nickname, neither an empty separator nor "undefined" may appear — two unnamed
// sessions then cannot be told apart, but that is only worse for whoever did not
// name them.
test("without a nickname the current shape stays unchanged", () => {
  const s = { id: "dev-portal-web", project: "portal", repo: "web", agent: "claude" as const };
  expect(doneText(s).title).toBe("portal/web");
  expect(blockedText(s, "permission").title).toBe("portal/web");
});

test("hub.handle: the agent from SessionRow is carried into the notification (Codex session)", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle({ ...row, agent: "codex" }, "stop");
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  expect(notified[0].message).toBe("Codex finished working");
});

// `st.session` is overwritten on EVERY hook event (just like `important`), so
// renaming a session while it runs must show in the notification title on the very next
// stop, not only after it is created anew.
test("hub.handle: renaming a running session shows in the title of the next notification", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "stop"); // no nickname
  tick(20_000);
  hub.sweep();
  expect(notified[0].title).toBe("shop/cms");

  hub.handle({ ...row, name: "refactor" }, "user_prompt_submit");
  hub.handle({ ...row, name: "refactor" }, "stop"); // renamed halfway through the session
  tick(20_000);
  hub.sweep();
  expect(notified[1].title).toBe("shop/cms · refactor");
});

const MAIN = { agentSessionId: "main-1" };

test("stop with a running subagent does not arm the notification and writes deferred", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", { ...MAIN, agentType: "Explore" });
  hub.handle(row, "stop", MAIN);
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.event).toBe("stop");
  expect(last.decision).toBe("deferred");
  expect(last.reason).toBe("busy-subagents");
  expect(last.inflight).toBe(1);
});

test("after the subagent finishes, only the NEXT stop notifies, not the counter drop", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN);
  hub.handle(row, "stop", MAIN);          // the main loop waits
  hub.handle(row, "subagent_stop", MAIN); // subagent finished — on its own it sends NOTHING
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);

  hub.handle(row, "stop", MAIN);          // the main agent finished
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  expect(notified[0].message).toBe("Claude finished working");
});

test("stop from a foreign agent session (teammate) is ignored, including lastStopAt", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { agentSessionId: "teammate-9" });
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.decision).toBe("deferred");
  expect(last.reason).toBe("foreign-session");
  expect(hub.turnInProgress(row.id)).toBe(true); // a foreign stop did not end the turn
});

test("an unknown main-loop identity decides only by the counter (unknown-main-id)", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "stop", { agentSessionId: "anything" }); // after a devd restart, no prompt
  const [armed] = listNotifyLog(db, { limit: 1 });
  expect(armed.decision).toBe("armed");
  expect(armed.reason).toBe("unknown-main-id");
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
});

test("user_prompt_submit resets the counters (drift after a lost hook ends with the turn)", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "subagent_start", MAIN);
  hub.handle(row, "subagent_start", MAIN);   // two starts, no stop = lost hooks
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", MAIN);
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  const armed = listNotifyLog(db).find((r) => r.decision === "armed");
  expect(armed?.inflight).toBe(0);
});

test("subagent_stop without a start does not undershoot the counter and logs counter-underflow", () => {
  const { row, hub, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_stop", MAIN);
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.reason).toBe("counter-underflow");
  expect(last.inflight).toBe(0);
});

// Round 3: the decision is the UNION of two incomplete signals (bg>0 OR inflight>0), not
// one taking precedence over the other — a teammate can stay "busy" only in the counter (background_tasks
// deliberately does not see it, see spec), a cloud session only in backgroundTasks. In the previous round
// this test was "backgroundTasks: 0 arms the notification even when inflight is stuck at 1" and
// verified signal PRECEDENCE — now it proves the exact opposite, because precedence was replaced
// by the union.
test("backgroundTasks: 0 with inflight stuck at 1 STILL defers the notification (union, not precedence)", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN); // inflight = 1 — typically a teammate that backgroundTasks does not see
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 }); // the signal says "done", the counter says "busy"
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(0); // busy = false || true = true → the notification must not go out
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.decision).toBe("deferred");
  expect(last.reason).toBe("busy-subagents");
});

test("backgroundTasks: 2 defers the notification even when inflight is 0", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 2 });
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.decision).toBe("deferred");
  expect(last.reason).toBe("busy-background-tasks");
});

// The missing cell of the truth table: BOTH signals busy and they AGREE. Pins two things that
// nothing else verifies: (1) reason is busy-background-tasks, not busy-subagents — the order in
// `bgBusy ? … : …` in agentEvents.ts; if someone flipped it, no other test would catch it.
// (2) the counter-mismatch row is NOT WRITTEN, because the signals agree — the existing mismatch
// test covers only disagreement, so an overly sensitive condition (firing on any
// numeric difference, not only on differing busy/idle) would otherwise pass unnoticed here.
test("backgroundTasks: 2 and inflight: 1 (both busy, agree) — deferred with busy-background-tasks, no counter-mismatch row", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN); // inflight = 1
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 2 }); // both signals agree: busy
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);
  const rows = listNotifyLog(db);
  expect(rows.some((r) => r.reason === "counter-mismatch")).toBe(false);
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.decision).toBe("deferred");
  expect(last.reason).toBe("busy-background-tasks"); // bg>0 wins the label even though counterBusy is true too
});

test("backgroundTasks: 0 and inflight: 0 — both signals quiet, the notification goes through", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  const armed = listNotifyLog(db).find((r) => r.decision === "armed");
  expect(armed?.reason).toBeNull();
});

test("missing backgroundTasks and inflight: 0 — the notification goes through (nothing contributes to the union)", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", MAIN); // no backgroundTasks, no subagent
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);
  expect(listNotifyLog(db).some((r) => r.reason === "counter-mismatch")).toBe(false);
});

test("missing backgroundTasks and inflight: 1 — defers (fallback to the counter), no counter-mismatch row", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN);
  hub.handle(row, "stop", MAIN); // no backgroundTasks in meta
  tick(60_000);
  hub.sweep();
  expect(notified).toHaveLength(0);
  const rows = listNotifyLog(db);
  expect(rows.some((r) => r.reason === "counter-mismatch")).toBe(false);
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.reason).toBe("busy-subagents");
});

test("an armed stop writes the worked interval with the session's project", () => {
  const { row, hub, db, tick } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  tick(120_000);                                   // two minutes of work
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  const [iv] = listWorkIntervals(db, 0, 10_000_000);
  expect(iv.seconds).toBe(120);
  expect(iv.project).toBe("shop");
  expect(iv.repo).toBe("cms");
  expect(iv.capped).toBe(0);
});

test("a deferred stop does not write an interval (the turn is still running)", () => {
  const { row, hub, db, tick } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN);
  tick(60_000);
  hub.handle(row, "stop", MAIN);                   // deferred, a subagent is running
  expect(listWorkIntervals(db, 0, 10_000_000)).toHaveLength(0);
});

test("a stop without a preceding prompt is not written (we do not know the start)", () => {
  const { row, hub, db, tick } = fixture();
  tick(60_000);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  expect(listWorkIntervals(db, 0, 10_000_000)).toHaveLength(0);
});

test("an interval longer than 30 minutes is cut and flagged", () => {
  const { row, hub, db, tick } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  tick(90 * 60_000);                               // an hour and a half
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  const [iv] = listWorkIntervals(db, 0, 10_000_000);
  expect(iv.seconds).toBe(30 * 60);
  expect(iv.capped).toBe(1);
});

test("two turns = two intervals", () => {
  const { row, hub, db, tick } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  tick(60_000);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  tick(60_000);
  hub.handle(row, "user_prompt_submit", MAIN);
  tick(60_000);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  expect(listWorkIntervals(db, 0, 10_000_000)).toHaveLength(2);
});

test("signal disagreement writes a separate counter-mismatch row with both numbers, right before the decision row (and busy wins)", () => {
  const { row, hub, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN); // inflight = 1
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 }); // the signal says "done", the counter "busy"
  const rows = listNotifyLog(db, { limit: 2 }); // ORDER BY id DESC → [decision, mismatch]
  expect(rows[1].decision).toBe("none");
  expect(rows[1].reason).toBe("counter-mismatch");
  expect(JSON.parse(rows[1].detail ?? "{}")).toEqual({ backgroundTasks: 0, inflight: 1 });
  expect(rows[0].decision).toBe("deferred"); // union: busy = false || true = true
  expect(rows[0].reason).toBe("busy-subagents");
});

test("the decision row carries backgroundTasks in the detail next to the inflight column, so they can be compared by eye", () => {
  const { row, hub, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  const [armed] = listNotifyLog(db, { limit: 1 });
  expect(armed.decision).toBe("armed");
  expect(JSON.parse(armed.detail ?? "{}")).toMatchObject({ backgroundTasks: 0 });
});

test("task_created/completed counts only team tasks, does not enter the decision", () => {
  const { row, hub, notified, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "task_created", MAIN);                              // todo list, no team
  hub.handle(row, "task_created", { ...MAIN, teammateName: "bob" });  // team task
  hub.handle(row, "stop", MAIN);
  tick(20_000);
  hub.sweep();
  expect(notified).toHaveLength(1);                                   // the teammates counter blocks nothing
  const armed = listNotifyLog(db).find((r) => r.decision === "armed");
  expect(armed?.teammates).toBe(1);
});

test("sweep writes the sent row as sweep_done", () => {
  const { row, hub, tick, db } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", MAIN);
  tick(20_000);
  hub.sweep();
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(last.event).toBe("sweep_done");
  expect(last.decision).toBe("sent");
});

test("detail carries agentType and the teammate name", () => {
  const { row, hub, db } = fixture();
  hub.handle(row, "subagent_start", { ...MAIN, agentType: "Explore" });
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(JSON.parse(last.detail ?? "{}")).toMatchObject({ agentType: "Explore" });
  expect(last.agent_session_id).toBe("main-1");
});

test("the prompt in the detail is clipped to 200 characters on user_prompt_submit", () => {
  const { row, hub, db } = fixture();
  const long = "a".repeat(250);
  hub.handle(row, "user_prompt_submit", { ...MAIN, prompt: long });
  const [last] = listNotifyLog(db, { limit: 1 });
  const detail = JSON.parse(last.detail ?? "{}") as { prompt?: string };
  expect(detail.prompt).toBe(long.slice(0, 200));
  expect(detail.prompt?.length).toBe(200);
});

test("the prompt does not get into the detail of other events, even if it is in meta", () => {
  const { row, hub, db } = fixture();
  hub.handle(row, "subagent_start", { ...MAIN, prompt: "this should not be in the subagent_start detail" });
  const [last] = listNotifyLog(db, { limit: 1 });
  expect(JSON.parse(last.detail ?? "{}")).not.toHaveProperty("prompt");
});

test("turnInProgress: a running cloud session holds the turn even when inflight is 0", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 1 }); // deferred, the counter knows nothing
  expect(hub.turnInProgress(row.id)).toBe(true);
});

test("turnInProgress: after a stop with zero in both signals the turn is over", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  expect(hub.turnInProgress(row.id)).toBe(false);
});

test("a new prompt forgets backgroundTasks from the previous turn", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 2 });
  expect(hub.turnInProgress(row.id)).toBe(true);
  hub.handle(row, "user_prompt_submit", MAIN);   // new turn = clean slate
  hub.handle(row, "stop", { ...MAIN, backgroundTasks: 0 });
  expect(hub.turnInProgress(row.id)).toBe(false);
});

test("missing backgroundTasks lets the counter decide (older Claude Code)", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", MAIN);
  hub.handle(row, "subagent_start", MAIN);
  hub.handle(row, "stop", MAIN);                 // no backgroundTasks
  expect(hub.turnInProgress(row.id)).toBe(true);
});

// I1 from the review: the "Claude may be stuck" alert comes with the project/repo title and goes as
// Pushover EMERGENCY. With two sessions on one repo, two indistinguishable messages
// arrive — exactly why the nickname in the title was introduced (doneText/blockedText
// already carry it). `sessionTitle` is therefore exported and that alert uses it too.
test("sessionTitle: the nickname distinguishes sessions of the same repo", () => {
  const s = { id: "dev-a-b", project: "a", repo: "b" };
  expect(sessionTitle(s)).toBe("a/b");
  expect(sessionTitle({ ...s, name: "refactor" })).toBe("a/b · refactor");
  expect(sessionTitle({ ...s, name: null })).toBe("a/b");
});

// The auto-end of scheduled runs (index.ts) hooks onto exactly this moment. sweep()
// therefore returns the ids of sessions for which "finished" just went out — whoever wants to react
// to the end of a run does not have to handle the quiet window, foreign loops or running subagents again.
test("sweep returns the ids of sessions for which \"finished\" just went out", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "stop");
  expect(hub.sweep()).toEqual([]);        // the quiet window is still running
  tick(20_000);
  expect(hub.sweep()).toEqual([row.id]);
  expect(hub.sweep()).toEqual([]);        // one-shot, just like the notification
});

test("sweep does not return a session whose stop was deferred because of running subagents", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main-1" });
  hub.handle(row, "subagent_start", { agentSessionId: "main-1" });
  hub.handle(row, "stop", { agentSessionId: "main-1" });
  tick(60_000);
  expect(hub.sweep()).toEqual([]);
});

// Regression for a flagged row from /notifications (21 Aug 2026, apps/directions):
// idle_prompt went out as "is waiting for input" while the session was just parked over a running
// background agent. Claude Code sends idle_prompt SOLELY based on REPL inactivity,
// and only when NO dialog is open — so it never means being blocked on a human.
test("idle_prompt in the middle of a turn (parked over a background agent) does NOT notify", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main-1" });
  tick(120_000); // the agent sent a subagent to the background, the main loop is silent
  hub.handle(row, "notification", { notificationType: "idle_prompt", agentSessionId: "main-1" });
  expect(notified).toHaveLength(0);
});

test("idle_prompt without any state (after a devd restart) does NOT notify", () => {
  const { row, hub, notified } = fixture();
  hub.handle(row, "notification", { notificationType: "idle_prompt" });
  expect(notified).toHaveLength(0);
});

test("informational notification types are not blocks", () => {
  const { row, hub, notified, tick } = fixture();
  for (const nt of ["auth_success", "agent_completed", "computer_use_exit", "quota_auto_resume_fired", "push_notification"]) {
    hub.handle(row, "notification", { notificationType: nt });
    tick(60_000); // outside the coalescing window, so the silence cannot be explained by coalescing
  }
  expect(notified).toHaveLength(0);
});

test("real blocks notify even after a finished turn", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "user_prompt_submit");
  tick(1_000);
  hub.handle(row, "stop"); // turn ended → lastStopAt > lastPromptAt
  tick(60_000);
  hub.handle(row, "notification", { notificationType: "elicitation_dialog" });
  expect(notified).toHaveLength(1);
  expect(notified[0].message).toBe("Claude is waiting for input");
  tick(60_000);
  hub.handle(row, "notification", { notificationType: "agent_needs_input" });
  expect(notified).toHaveLength(2);
  tick(60_000);
  hub.handle(row, "notification", { notificationType: "quota_auto_resume_stale" });
  expect(notified).toHaveLength(3);
});

test("an unknown notification type is suppressed and stays traceable in the log", () => {
  const { db, row, hub, notified } = fixture();
  hub.handle(row, "notification", { notificationType: "brand_new_type" });
  expect(notified).toHaveLength(0);
  const rows = listNotifyLog(db, { session: row.id });
  expect(rows[0].decision).toBe("suppressed");
  expect(rows[0].reason).toBe("non-blocking-type");
  expect(rows[0].detail).toContain("brand_new_type");
});

for (const toolName of ["request_user_input_async", "functions.request_user_input_async"]) {
  test(`Codex async question stays waiting after immediate completion: ${toolName}`, () => {
    const { row, hub, notified, tick } = fixture();
    row.agent = "codex";
    const meta = { agentSessionId: "main", toolName, toolCallId: "question" };
    hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
    hub.handle(row, "tool_start", meta);
    expect(notified).toHaveLength(1);
    expect(notified[0].message).toBe("Codex is waiting for input");
    expect(notified[0].extra?.sound).toBe(true);
    hub.handle(row, "tool_complete", meta);
    // Without another call it keeps waiting despite the stop and the elapsed quiet window.
    hub.handle(row, "stop", { agentSessionId: "main" });
    tick(60_000);
    hub.sweep();
    expect(hub.liveSnapshot(row.id)?.status).toBe("waiting");
    expect(notified).toHaveLength(1);
    hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
    expect(hub.liveSnapshot(row.id)?.status).toBe("working");
    hub.handle(row, "stop", { agentSessionId: "main" });
    tick(20_000);
    hub.sweep();
    expect(notified).toHaveLength(2);
    expect(notified[1].message).toBe("Codex finished working");
  });
}

// --- Live Activity v2: reliable state transitions ---

test("(a) waiting on AskUserQuestion A ends as soon as the agent starts another call B", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "AskUserQuestion", toolCallId: "A", question: "Which option?" });
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "waiting", reason: "Which option?" });
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "Bash", toolCallId: "B" });
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "working", reason: null });
});

test("(a') tool_complete of another call ends the wait, a concurrent call older than the question does not", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "Read", toolCallId: "parallel" });
  hub.handle(row, "permission_request", { agentSessionId: "main", toolName: "Bash", toolCallId: "perm" });
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "waiting", reason: "Allow: Bash" });
  hub.handle(row, "tool_complete", { agentSessionId: "main", toolName: "Read", toolCallId: "parallel" });
  expect(hub.liveSnapshot(row.id)?.status).toBe("waiting");
  hub.handle(row, "tool_complete", { agentSessionId: "main", toolName: "Grep", toolCallId: "later" });
  expect(hub.liveSnapshot(row.id)?.status).toBe("working");
});

test("(b) an async question ends on tool_start of the next call", () => {
  const { row, hub } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "functions.request_user_input_async", toolCallId: "q" });
  hub.handle(row, "tool_complete", { agentSessionId: "main", toolName: "functions.request_user_input_async", toolCallId: "q" });
  expect(hub.liveSnapshot(row.id)?.status).toBe("waiting");
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "exec_command", toolCallId: "next" });
  expect(hub.liveSnapshot(row.id)?.status).toBe("working");
});

test("(c) work without hooks or metrics for 181 s → stalled; a fresh metric keeps it in working", () => {
  const { db, row, hub, tick, now } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  const since = now();
  tick(180_000);
  expect(hub.liveSnapshot(row.id)?.status).toBe("working");
  tick(1_000);
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "stalled", body: "May be stuck", statusSince: since + 180_000 });
  insertMetrics(db, [{ ts: now(), session_id: row.id, name: "claude_code.token.usage", value: 1, attrs: "{}" }]);
  // Recovery from stalled is a transition: statusSince = the moment of recovery, not the time before the silence.
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "working", statusSince: now() });
  expect(hub.silentMs(row.id)).toBe(0);
});

test("(d) inflight stuck for 601 s without a Subagent event is reset and done goes through", () => {
  const { row, hub, notified, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "subagent_start", { agentSessionId: "main" });
  tick(601_000);
  hub.handle(row, "stop", { agentSessionId: "main" });
  expect(hub.counters(row.id).inflight).toBe(0);
  tick(20_000);
  expect(hub.sweep()).toEqual([row.id]);
  expect(hub.liveSnapshot(row.id)?.status).toBe("done");
  expect(notified.at(-1)?.message).toBe("Claude finished working");
});

test("(d') a stop deferred because of a stuck inflight completes in the sweep after 10 min", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "subagent_start", { agentSessionId: "main" });
  tick(60_000);
  hub.handle(row, "stop", { agentSessionId: "main" });
  tick(60_000);
  expect(hub.sweep()).toEqual([]);
  tick(480_000); // 10 min since subagent_start
  hub.sweep();
  expect(hub.counters(row.id).inflight).toBe(0);
  tick(20_000);
  expect(hub.sweep()).toEqual([row.id]);
  expect(hub.liveSnapshot(row.id)?.status).toBe("done");
});

test("(e) SSH approval: waiting with a reason, null restores the previous state", () => {
  const { row, hub, tick, now } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  const workingSince = now();
  tick(5_000);
  hub.setSshWaiting(row.id, "infra-root · root@1.2.3.4:22");
  expect(hub.liveSnapshot(row.id)).toMatchObject({
    status: "waiting", reason: "Approve SSH key: infra-root · root@1.2.3.4:22", statusSince: now(),
  });
  tick(5_000);
  hub.setSshWaiting(row.id, "infra-root · root@1.2.3.4:22"); // a periodic tick must not move statusSince
  expect(hub.liveSnapshot(row.id)?.statusSince).toBe(now() - 5_000);
  hub.setSshWaiting(row.id, null);
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "working", reason: null, statusSince: workingSince });
});

test("(e') SSH approval for a session without a single hook", () => {
  const { row, hub } = fixture();
  hub.setSshWaiting(row.id, "infra-root");
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "waiting", reason: "Approve SSH key: infra-root" });
  hub.setSshWaiting(row.id, null);
  expect(hub.liveSnapshot(row.id)).toBeNull();
});

test("(f) the question text is clipped to 140 characters in reason", () => {
  const { row, hub } = fixture();
  hub.handle(row, "tool_start", { toolName: "AskUserQuestion", toolCallId: "A", question: "x".repeat(500) });
  const reason = hub.liveSnapshot(row.id)!.reason!;
  expect(reason.length).toBe(140);
  expect(reason.endsWith("…")).toBe(true);
});

test("(f') a question without text gives the generic reason", () => {
  const { row, hub } = fixture();
  hub.handle(row, "tool_start", { toolName: "request_user_input", toolCallId: "A" });
  expect(hub.liveSnapshot(row.id)?.reason).toBe("Waiting for a reply");
});

test("(g) statusSince does not change on a heartbeat hook in the same state", () => {
  const { row, hub, tick, now } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  const since = now();
  tick(30_000);
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "Bash" });
  tick(30_000);
  hub.handle(row, "tool_complete", { agentSessionId: "main", toolName: "Bash" });
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "working", statusSince: since, updatedAt: now() });
  hub.handle(row, "permission_request", { agentSessionId: "main", toolName: "Bash" });
  expect(hub.liveSnapshot(row.id)?.statusSince).toBe(now());
});

test("the question text is not written to notify_log", () => {
  const { db, row, hub } = fixture();
  hub.handle(row, "tool_start", { toolName: "AskUserQuestion", toolCallId: "A", question: "secret question" });
  expect(JSON.stringify(listNotifyLog(db, { session: row.id }))).not.toContain("secret question");
});

test("(c2) an open call (long Bash) holds working for 5 min, stalled only after 20 min", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "Bash", toolCallId: "build" });
  tick(5 * 60_000);
  expect(hub.liveSnapshot(row.id)?.status).toBe("working");
  tick(16 * 60_000);
  expect(hub.liveSnapshot(row.id)?.status).toBe("stalled");
});

test("(c3) stop with backgroundTasks > 0 (monitor) holds working for 5 min", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "stop", { agentSessionId: "main", backgroundTasks: 1 });
  tick(5 * 60_000);
  expect(hub.liveSnapshot(row.id)?.status).toBe("working");
});

test("(c4) recovery from stalled via a hook moves statusSince to the moment of the hook", () => {
  const { row, hub, tick, now } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  tick(200_000);
  expect(hub.liveSnapshot(row.id)?.status).toBe("stalled");
  tick(10_000);
  hub.handle(row, "tool_start", { agentSessionId: "main", toolName: "Bash" });
  expect(hub.liveSnapshot(row.id)).toMatchObject({ status: "working", statusSince: now() });
});

test("(d3) a teammate sending hooks keeps inflight alive even after 12 min, the stop stays deferred", () => {
  const { row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit", { agentSessionId: "main" });
  hub.handle(row, "subagent_start", { agentSessionId: "main" });
  for (let i = 0; i < 12; i++) {
    tick(60_000);
    hub.handle(row, "tool_start", { agentSessionId: "mate", toolName: "Bash" });
  }
  hub.handle(row, "stop", { agentSessionId: "main" });
  expect(hub.counters(row.id).inflight).toBe(1);
  tick(20_000);
  expect(hub.sweep()).toEqual([]);
  expect(hub.liveSnapshot(row.id)?.status).not.toBe("done");
});

test("(h) a generic reason from a later Notification does not override a specific one", () => {
  const { row, hub } = fixture();
  hub.handle(row, "permission_request", { toolName: "Bash", toolCallId: "p" });
  hub.handle(row, "notification", { notificationType: "permission_prompt" });
  expect(hub.liveSnapshot(row.id)?.reason).toBe("Allow: Bash");
  hub.handle(row, "notification", { notificationType: "elicitation_dialog" });
  expect(hub.liveSnapshot(row.id)?.reason).toBe("Allow: Bash");
});

test("(h2) the question stays the reason even after an elicitation notification", () => {
  const { row, hub } = fixture();
  hub.handle(row, "tool_start", { toolName: "AskUserQuestion", toolCallId: "q", question: "Which one?" });
  hub.handle(row, "notification", { notificationType: "elicitation_dialog" });
  expect(hub.liveSnapshot(row.id)?.reason).toBe("Which one?");
});

// --- persisting hub state across restarts (Task 2) ---------------------------------

test("a state transition writes a row to agent_live_state; the same state again overwrites nothing extra", () => {
  const { db, row, hub } = fixture();
  expect(getAgentLiveState(db, row.id)).toBeNull(); // until a hook arrives, nothing is written
  hub.handle(row, "user_prompt_submit"); // unknown → working
  const r1 = getAgentLiveState(db, row.id);
  expect(r1).toMatchObject({ session_id: row.id, status: "working", body: "Agent is working", reason: null });
  hub.handle(row, "tool_start", { toolName: "Bash" }); // working → working, no transition
  expect(getAgentLiveState(db, row.id)).toEqual(r1); // unchanged
  hub.handle(row, "permission_request", { toolName: "Bash" }); // working → waiting, a new transition
  expect(getAgentLiveState(db, row.id)).toMatchObject({ status: "waiting", reason: "Allow: Bash" });
});

test("a new hub instance over the same DB: working comes back as unknown after restart, done stays done", () => {
  const { db, row, hub, tick, now } = fixture();
  hub.handle(row, "user_prompt_submit"); // working, persisted transition

  const row2: SessionRow = { ...row, id: "dev-shop-web", repo: "web", port_base: 40200 };
  insertSession(db, row2);
  // Shares the clock with the fixture (`now`) so `tick` also advances the second hub instance.
  const hub2 = new AgentEventHub({ db, notify: () => {}, now });
  hub2.handle(row2, "stop");
  tick(20_000);
  hub2.sweep(); // done, persisted transition

  // A new hub instance over the same DB (simulating a devd restart).
  const fresh = new AgentEventHub({ db, notify: () => {}, now });
  fresh.loadPersisted([row, row2]);
  expect(fresh.liveSnapshot(row.id)).toMatchObject({ status: "unknown", reason: null });
  expect(fresh.liveSnapshot(row2.id)).toMatchObject({ status: "done", body: "Work finished" });
});

test("loadPersisted ignores the row of an ended session (status !== running)", () => {
  const { db, row, hub } = fixture();
  hub.handle(row, "user_prompt_submit");
  updateSession(db, row.id, { status: "stopped" }); // the session ended in the meantime

  const fresh = new AgentEventHub({ db, notify: () => {} });
  fresh.loadPersisted([{ ...row, status: "stopped" }]);
  expect(fresh.liveSnapshot(row.id)).toBeNull();
});

test("the first hook after a restart overwrites the restored unknown state normally", () => {
  const { db, row, hub, tick } = fixture();
  hub.handle(row, "user_prompt_submit");

  const fresh = new AgentEventHub({ db, notify: () => {}, now: () => 500_000 });
  fresh.loadPersisted([row]);
  expect(fresh.liveSnapshot(row.id)?.status).toBe("unknown");
  fresh.handle(row, "permission_request", { toolName: "Bash" });
  expect(fresh.liveSnapshot(row.id)).toMatchObject({ status: "waiting", reason: "Allow: Bash" });
});

test("forget and retainRunning delete the persisted row of an ended session", () => {
  const { db, row, hub } = fixture();
  hub.handle(row, "user_prompt_submit");
  expect(getAgentLiveState(db, row.id)).not.toBeNull();
  hub.forget(row.id);
  expect(getAgentLiveState(db, row.id)).toBeNull();

  hub.handle(row, "user_prompt_submit");
  expect(getAgentLiveState(db, row.id)).not.toBeNull();
  hub.retainRunning(new Set()); // row.id no longer runs
  expect(getAgentLiveState(db, row.id)).toBeNull();
});
