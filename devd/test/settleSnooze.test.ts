import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub } from "../src/agentEvents";
import type { UsageLimit } from "../src/accountUsage";
import type { CodexView } from "../src/codexPoller";
import { ChatHub } from "../src/chatHub";
import {
  deleteSession, getSession, getSessionAttention, insertLease, insertSession, listNotifyLog, listSessions, openDb, upsertAccountUsage,
  getTmuxSeenAt, putSessionAttention, type SessionRow,
} from "../src/db";
import { EventBus } from "../src/eventBus";
import { AUTO_SETTLE_IDLE_MS, hubShelfDeps, resetDeps, untilReset, type ResetDeps } from "../src/sessionAttention";
import { Inbox } from "../src/sessionInbox";
import { ThreadStore } from "../src/threadStore";
import type { BackgroundWork, BridgeEvent, InboxItem } from "../../shared/thread";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const DAY = 86_400_000;
const T0 = 100 * DAY;
const CHAT: SessionRow = {
  id: "dev-a-chat", folder: "acme", project: "a", repo: "chat", container: "dev-a-chat",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat",
};
const TMUX: SessionRow = { ...CHAT, id: "dev-a-tmux", container: "dev-a-tmux", repo: "tmux", port_base: 40200, runtime: "tmux" };

const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });
const failed = (runId: string): BridgeEvent => ({ type: "run.failed", runId, error: "boom" });
const asked = (runId: string, requestId: string): BridgeEvent => ({ type: "request.opened", runId, requestId, kind: "question", prompt: "Which one?" });
const wakeup: BackgroundWork = { id: "w1", kind: "wakeup", label: "check CI", holding: true };

/** Timers the test fires by hand: `due()` runs every timer whose time has come on the test clock. */
function fakeTimers(clock: () => number) {
  let next = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => { pending.set(++next, { at: clock() + ms, fn }); return next; },
      clear: (h: unknown) => { pending.delete(h as number); },
    },
    pending: () => [...pending.values()].map((p) => p.at),
    due: () => {
      for (const [h, p] of [...pending]) if (p.at <= clock()) { pending.delete(h); p.fn(); }
    },
  };
}

/** A hub, a chat hub and an inbox over one clock, wired like index.ts. Chat events are stamped with that clock. */
function setup(opts: { snoozedThrows?: boolean; activityThrows?: boolean; quietMs?: number } = {}) {
  let now = T0;
  const clock = () => now;
  const timers = fakeTimers(clock);
  const logs: string[] = [];
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "settle-"));
  const stores = new Map<string, ThreadStore>();
  cleanups.push(() => { for (const s of stores.values()) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const threads = (id: string) => {
    let s = stores.get(id);
    if (!s) { s = ThreadStore.open(dir, id); stores.set(id, s); }
    return s;
  };
  const notified: string[] = [];
  const bus = new EventBus();
  let inbox: Inbox; // assigned below: the hub and the inbox refer to each other, as in index.ts
  const shelf = hubShelfDeps({
    activity: (id, kind) => { if (opts.activityThrows) throw new Error("db locked"); inbox.activity(id, kind); },
    snoozed: (id) => { if (opts.snoozedThrows) throw new Error("db locked"); return inbox.snoozed(id); },
  }, (m) => logs.push(m));
  const hub = new AgentEventHub({
    db, notify: (title, message) => notified.push(`${title}: ${message}`), now: () => now, quietMs: opts.quietMs ?? 1000, ...shelf,
  });
  const chatHub = new ChatHub({ hub, session: (id) => getSession(db, id), now: () => now });
  inbox = new Inbox({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id), threads,
    chatLink: () => ({ status: "connected", since: 1 }), tmuxLive: (id) => hub.liveSnapshot(id), bus,
    now: () => now, coalesceMs: 0, timers: timers.timers,
  });
  const published: InboxItem[] = [];
  bus.subscribe(["inbox"], (_t, data) => published.push(data as InboxItem));
  const feed = (id: string, events: BridgeEvent[]) => {
    const s = threads(id);
    for (const event of events) {
      const e = { seq: s.lastSeq() + 1, ts: now, event };
      s.apply(e);
      chatHub.onEvent(id, e, () => s.snapshot({ limit: 0 }));
    }
  };
  insertSession(db, { ...CHAT, created_at: T0, last_active_at: T0 });
  insertSession(db, { ...TMUX, created_at: T0, last_active_at: T0 });
  const section = (id: string) => inbox.item(getSession(db, id)!).attention.section;
  return { db, hub, inbox, threads, feed, notified, published, section, timers, logs, tick: (ms: number) => { now += ms; }, now: () => now };
}

// --- manual settle ---

test("a settled session moves to the settled shelf and unsettle brings it back, chat and tmux alike", () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(10_000);
  expect(t.section(CHAT.id)).toBe("needs_you");
  t.inbox.settle(CHAT.id, "manual");
  t.inbox.settle(TMUX.id, "manual");
  expect(t.section(CHAT.id)).toBe("settled");
  expect(t.section(TMUX.id)).toBe("settled");
  expect(getSessionAttention(t.db, CHAT.id)).toMatchObject({ settled_at: T0 + 10_000, settled_reason: "manual", snooze_until: null });
  t.inbox.unsettle(CHAT.id);
  t.inbox.unsettle(TMUX.id);
  expect(t.section(CHAT.id)).toBe("needs_you");
  expect(t.section(TMUX.id)).toBe("idle");
});

test("settle publishes the session's new inbox item", () => {
  const t = setup();
  t.inbox.settle(TMUX.id, "manual");
  expect(t.published.at(-1)).toMatchObject({ sessionId: TMUX.id, attention: { section: "settled" } });
});

test("a new run, a request or a failure unsettles (chat)", () => {
  for (const events of [[started("r2")], [started("r2"), asked("r2", "q1")], [started("r2"), failed("r2")]]) {
    const t = setup();
    t.feed(CHAT.id, [started("r1"), completed("r1")]);
    t.inbox.settle(CHAT.id, "manual");
    t.tick(5000);
    t.feed(CHAT.id, events);
    expect(t.section(CHAT.id)).not.toBe("settled");
    expect(getSessionAttention(t.db, CHAT.id)?.settled_at ?? null).toBeNull();
  }
});

test("a new prompt, a permission request or a failure unsettles a tmux session", () => {
  for (const ev of ["user_prompt_submit", "permission_request", "stop_failure"] as const) {
    const t = setup();
    t.inbox.settle(TMUX.id, "manual");
    t.hub.handle(getSession(t.db, TMUX.id)!, ev);
    expect(t.section(TMUX.id)).not.toBe("settled");
  }
});

test("a completion does not unsettle", () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1")]);
  t.inbox.settle(CHAT.id, "manual");
  t.feed(CHAT.id, [completed("r1")]);
  t.tick(60_000);
  expect(t.section(CHAT.id)).toBe("settled");
});

// --- snooze ---

test("a snooze until a time hides the session until then, and it comes back on its own", () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(10_000);
  const until = t.now() + 3_600_000;
  t.inbox.snooze(CHAT.id, until, "time");
  expect(t.inbox.item(getSession(t.db, CHAT.id)!).attention).toMatchObject({ section: "snoozed", until });
  t.timers.due(); // the coalesce window (0 ms)
  expect(t.timers.pending()).toEqual([until + 1]);
  t.tick(3_600_000);
  t.timers.due();
  expect(t.published.at(-1)!.attention.section).toBe("snoozed"); // not yet
  t.tick(1);
  t.timers.due(); // the inbox re-publishes when the snooze ends
  expect(t.published.at(-1)).toMatchObject({ sessionId: CHAT.id, attention: { section: "needs_you", reason: "completed" } });
  expect(t.published.at(-1)!.attention.until).toBeUndefined();
});

test("after a devd restart every snooze still ending later gets its timer, stopped sessions too", () => {
  const t = setup();
  t.db.run("UPDATE sessions SET status='stopped' WHERE id=?", [TMUX.id]);
  const until = t.now() + DAY;
  // Rows a previous devd wrote: one still running, one already over.
  putSessionAttention(t.db, { session_id: TMUX.id, settled_at: null, settled_reason: null, snooze_until: until, snooze_kind: "time", updated_at: 1 });
  putSessionAttention(t.db, { session_id: CHAT.id, settled_at: null, settled_reason: null, snooze_until: t.now() - 1, snooze_kind: "time", updated_at: 1 });
  t.inbox.armSnoozes();
  t.timers.due(); // the coalesce window (0 ms)
  expect(t.timers.pending()).toEqual([until + 1]);
  t.tick(DAY + 1);
  t.timers.due();
  expect(t.published.at(-1)).toMatchObject({ sessionId: TMUX.id, attention: { section: "idle" } });
});

test("snooze and settle replace each other; unsettle ends a snooze too", () => {
  const t = setup();
  t.inbox.settle(TMUX.id, "manual");
  t.inbox.snooze(TMUX.id, t.now() + DAY, "time");
  expect(t.section(TMUX.id)).toBe("snoozed");
  expect(getSessionAttention(t.db, TMUX.id)?.settled_at).toBeNull();
  t.inbox.settle(TMUX.id, "manual");
  expect(t.section(TMUX.id)).toBe("settled");
  expect(getSessionAttention(t.db, TMUX.id)?.snooze_until).toBeNull();
  t.inbox.snooze(TMUX.id, t.now() + DAY, "time");
  t.inbox.unsettle(TMUX.id);
  expect(t.section(TMUX.id)).toBe("idle");
});

test("only a request or a failure wakes a snooze early; a new run and a completion do not", () => {
  const t = setup();
  t.inbox.snooze(CHAT.id, t.now() + DAY, "time");
  t.feed(CHAT.id, [started("r1")]);
  expect(t.section(CHAT.id)).toBe("snoozed");
  t.feed(CHAT.id, [completed("r1")]);
  t.tick(60_000);
  expect(t.section(CHAT.id)).toBe("snoozed");
  t.feed(CHAT.id, [started("r2"), asked("r2", "q1")]);
  expect(t.section(CHAT.id)).toBe("needs_you");
  expect(getSessionAttention(t.db, CHAT.id)?.snooze_until ?? null).toBeNull();

  t.inbox.snooze(TMUX.id, t.now() + DAY, "time");
  t.hub.handle(getSession(t.db, TMUX.id)!, "user_prompt_submit");
  expect(t.section(TMUX.id)).toBe("snoozed");
  t.hub.handle(getSession(t.db, TMUX.id)!, "stop_failure");
  expect(t.section(TMUX.id)).toBe("needs_you");
});

test("a snoozed completion sends no notification; the sweep still reports it (autoEnd)", () => {
  const t = setup();
  t.inbox.snooze(CHAT.id, t.now() + DAY, "time");
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(2000);
  expect(t.hub.sweep()).toEqual([CHAT.id]);
  expect(t.notified).toEqual([]);
  const log = listNotifyLog(t.db, { session: CHAT.id }).find((r) => r.event === "sweep_done");
  expect(log).toMatchObject({ decision: "suppressed", reason: "snoozed" });
  // tmux too, and an ended snooze notifies again.
  const tmux = getSession(t.db, TMUX.id)!;
  t.inbox.snooze(TMUX.id, t.now() + 5000, "time");
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  expect(t.hub.sweep()).toEqual([TMUX.id]);
  expect(t.notified).toEqual([]);
  t.tick(10_000);
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  t.hub.sweep();
  expect(t.notified).toEqual(["a/tmux: Claude finished working"]);
});

test("an unreadable snooze state still sends the done notification, and is logged (S5-R14)", () => {
  const t = setup({ snoozedThrows: true });
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(2000);
  expect(t.hub.sweep()).toEqual([CHAT.id]);
  expect(t.notified).toEqual(["a/chat: Claude finished working"]);
  expect(t.logs.join("\n")).toContain("db locked");
});

test("a shelf that cannot be updated is logged; the hook is still handled", () => {
  const t = setup({ activityThrows: true });
  t.inbox.settle(TMUX.id, "manual");
  t.hub.handle(getSession(t.db, TMUX.id)!, "permission_request");
  expect(t.logs.join("\n")).toContain("db locked");
  expect(t.notified).toEqual(["a/tmux: Claude is waiting for permission"]);
  expect(t.section(TMUX.id)).toBe("settled"); // what the user sees: the session stays on the shelf until unsettled
});

// --- auto-settle ---

test("auto-settle: a session idle for 7 days is settled (reason idle), not before", () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(AUTO_SETTLE_IDLE_MS - 1);
  expect(t.inbox.autoSettle()).toEqual([]);
  t.tick(1);
  expect(t.inbox.autoSettle().sort()).toEqual([CHAT.id, TMUX.id]);
  expect(t.section(CHAT.id)).toBe("settled");
  expect(getSessionAttention(t.db, CHAT.id)?.settled_reason).toBe("idle");
  expect(t.inbox.autoSettle()).toEqual([]); // already settled
});

test("auto-settle counts idle time from the last activity of the session, not from an old attention", () => {
  const t = setup();
  t.db.run("UPDATE sessions SET last_active_at=? WHERE id=?", [T0 + 3 * DAY, TMUX.id]);
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect(t.inbox.autoSettle()).toEqual([CHAT.id]);
});

test("a pending request, an active run, holding work or a snooze block auto-settle", () => {
  const cases: ((t: ReturnType<typeof setup>) => void)[] = [
    (t) => t.feed(CHAT.id, [started("r1"), asked("r1", "q1")]),
    (t) => t.feed(CHAT.id, [started("r1")]),
    (t) => t.feed(CHAT.id, [started("r1"), { type: "background.changed", work: [wakeup] }, completed("r1")]),
    (t) => t.inbox.snooze(CHAT.id, t.now() + 30 * DAY, "time"),
  ];
  for (const arrange of cases) {
    const t = setup();
    t.db.run("UPDATE sessions SET last_active_at=? WHERE id=?", [T0 + 30 * DAY, TMUX.id]); // only CHAT is old
    arrange(t);
    t.tick(AUTO_SETTLE_IDLE_MS + DAY);
    expect(t.inbox.autoSettle()).toEqual([]);
  }
});

test("a tmux session waiting for permission is not auto-settled", () => {
  const t = setup();
  t.hub.handle(getSession(t.db, TMUX.id)!, "permission_request");
  t.db.run("UPDATE sessions SET last_active_at=? WHERE id=?", [T0 + 30 * DAY, CHAT.id]);
  t.tick(AUTO_SETTLE_IDLE_MS + DAY);
  expect(t.inbox.autoSettle()).toEqual([]);
});

test("an ended session's settle state is deleted with it", () => {
  const t = setup();
  t.inbox.settle(TMUX.id, "manual");
  deleteSession(t.db, TMUX.id);
  expect(getSessionAttention(t.db, TMUX.id)).toBeNull();
});

// --- tmux seen marker ---

test("a finished tmux session is Done until seen; the next finish is Done again", () => {
  const t = setup();
  const tmux = getSession(t.db, TMUX.id)!;
  t.hub.handle(tmux, "user_prompt_submit");
  t.tick(1000);
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  t.hub.sweep();
  expect(t.inbox.item(tmux).attention).toMatchObject({ section: "needs_you", reason: "completed" });
  t.tick(1000);
  t.inbox.seen(TMUX.id);
  expect(t.published.at(-1)).toMatchObject({ sessionId: TMUX.id, attention: { section: "idle", reason: null } });
  expect(getTmuxSeenAt(t.db, TMUX.id)).toBe(t.now());
  t.tick(1000);
  t.hub.handle(tmux, "user_prompt_submit");
  t.tick(1000);
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  t.hub.sweep();
  expect(t.section(TMUX.id)).toBe("needs_you");
});

test("a tmux failure stays needs-you until seen", () => {
  const t = setup();
  const tmux = getSession(t.db, TMUX.id)!;
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop_failure");
  t.tick(60_000);
  expect(t.inbox.item(tmux).attention).toMatchObject({ section: "needs_you", reason: "failed" });
  t.inbox.seen(TMUX.id);
  expect(t.section(TMUX.id)).toBe("idle");
});

test("a reused session id does not inherit the seen marker: the new session's done is needs-you", () => {
  // No quiet window and a frozen clock: the new session's done begins at the very ms of the old look, so an
  // inherited marker would cover it (seen_at >= statusSince).
  const t = setup({ quietMs: 0 });
  const finish = () => {
    const tmux = getSession(t.db, TMUX.id)!;
    t.hub.handle(tmux, "user_prompt_submit");
    t.hub.handle(tmux, "stop");
    t.hub.sweep();
  };
  finish();
  t.inbox.seen(TMUX.id);
  expect(t.section(TMUX.id)).toBe("idle");
  deleteSession(t.db, TMUX.id);
  expect(getTmuxSeenAt(t.db, TMUX.id)).toBeNull();
  insertSession(t.db, { ...TMUX, created_at: t.now(), last_active_at: t.now() });
  finish();
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).attention).toMatchObject({ section: "needs_you", reason: "completed", since: t.now() });
});

// --- until reset ---

const limit = (over: Partial<UsageLimit>): UsageLimit =>
  ({ kind: "session", percent: 100, severity: null, resetsAt: null, modelName: null, isActive: false, ...over });
const codexView = (windows: CodexView["windows"]): CodexView =>
  ({ state: "ok", planType: "pro", windows, credits: null, limitReached: null, fetchedAt: 1, error: null });
function deps(over: Partial<ResetDeps> = {}): ResetDeps {
  return {
    claudeAccount: () => "acct-1", claudeLimits: () => [], codexAccount: () => "cx-1", codexUsage: () => codexView([]),
    ...over,
  };
}
const NOW = 1_000_000;

test("until-reset uses the active limit (Claude): the latest reset among active limits", () => {
  const limits = [
    limit({ kind: "session", isActive: true, resetsAt: NOW + 3_600_000 }),
    limit({ kind: "weekly_all", isActive: true, resetsAt: NOW + 7_200_000 }),
    limit({ kind: "weekly_scoped", isActive: false, resetsAt: NOW + 9_000_000 }),
  ];
  expect(untilReset(CHAT, deps({ claudeLimits: () => limits }), NOW)).toEqual({ resetsAt: NOW + 7_200_000 });
  expect(untilReset(TMUX, deps({ claudeLimits: () => [limits[2]] }), NOW)).toEqual({ reason: "No usage limit is active on this account" });
  expect(untilReset(CHAT, deps({ claudeLimits: () => [limit({ isActive: true, resetsAt: NOW - 1 })] }), NOW))
    .toEqual({ reason: "No usage limit is active on this account" });
  expect(untilReset(CHAT, deps({ claudeAccount: () => null }), NOW)).toEqual({ reason: "The account of this session is not known" });
  expect(untilReset(CHAT, deps({ claudeLimits: () => null }), NOW)).toEqual({ reason: "The usage of this account has not been measured yet" });
});

test("until-reset for Codex: the latest reset among windows at their limit", () => {
  const codex = { ...CHAT, agent: "codex" as const };
  const windows: CodexView["windows"] = [
    { kind: "primary", usedPct: 100, windowMinutes: 300, resetsAt: NOW + 1000 },
    { kind: "secondary", usedPct: 40, windowMinutes: 10080, resetsAt: NOW + 5000 },
  ];
  expect(untilReset(codex, deps({ codexUsage: () => codexView(windows) }), NOW)).toEqual({ resetsAt: NOW + 1000 });
  expect(untilReset(codex, deps({ codexUsage: () => codexView([windows[1]]) }), NOW)).toEqual({ reason: "No usage limit is active on this account" });
  expect(untilReset(codex, deps({ codexAccount: () => null }), NOW)).toEqual({ reason: "The account of this session is not known" });
  expect(untilReset(codex, deps({ codexUsage: () => null }), NOW)).toEqual({ reason: "The usage of this account has not been measured yet" });
});

test("until-reset is unavailable for ACP agents and proxy profiles, with a reason", () => {
  expect(untilReset({ ...CHAT, agent: "vibe" }, deps(), NOW)).toEqual({ reason: "Mistral Vibe has no usage limit devbox can read" });
  expect(untilReset({ ...CHAT, agent: "claude-gemini" }, deps(), NOW)).toEqual({ reason: "Claude Code + Gemini has no usage limit devbox can read" });
});

test("until-reset finds a chat Claude session's account: the lease its bridge launch took (account-lease)", () => {
  const t = setup();
  // agent-bridge-launch.sh runs account-lease, which leases as client=devbox with the session id.
  insertLease(t.db, { account_id: "acct-1", client: "devbox", session_id: CHAT.id, label: "a/chat", created_at: 1, released_at: null });
  upsertAccountUsage(t.db, {
    account_id: "acct-1", five_hour_pct: 100, five_hour_resets_at: NOW + 5000, seven_day_pct: 10, seven_day_resets_at: NOW + 9000,
    limits_json: JSON.stringify([limit({ isActive: true, resetsAt: NOW + 5000 })]), fetched_at: 1, error: null, error_count: 0, org_id: null,
  });
  const d = resetDeps({ db: t.db, threads: t.threads, codexAccounts: { list: () => ({ accounts: [] }) } });
  expect(untilReset(getSession(t.db, CHAT.id)!, d, NOW)).toEqual({ resetsAt: NOW + 5000 });
});

test("until-reset finds a chat Codex session's account in its thread", () => {
  const t = setup();
  const codex = { ...CHAT, id: "dev-a-codex", container: "dev-a-codex", port_base: 40300, agent: "codex" as const };
  insertSession(t.db, codex);
  t.feed(codex.id, [{ type: "thread.native", harness: "codex", nativeThreadId: "n1", account: "cx-1", model: null } as BridgeEvent]);
  const view = codexView([{ kind: "primary", usedPct: 100, windowMinutes: 300, resetsAt: NOW + 1000 }]);
  const d = resetDeps({ db: t.db, threads: t.threads, codexAccounts: { list: () => ({ accounts: [{ id: "cx-1", usage: view }] }) } });
  expect(untilReset(codex, d, NOW)).toEqual({ resetsAt: NOW + 1000 });
  expect(untilReset({ ...codex, runtime: "tmux" }, d, NOW)).toEqual({ reason: "The account of this session is not known" });
});
