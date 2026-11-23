import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub } from "../src/agentEvents";
import type { UsageLimit } from "../src/accountUsage";
import type { CodexView } from "../src/codexPoller";
import { ChatHub } from "../src/chatHub";
import {
  deleteSession, getSession, getSessionAttention, insertLease, insertSession, listNotifyLog, listSessions, openDb, upsertAccountUsage,
  getSeenAt, putSessionAttention, type SessionRow,
} from "../src/db";
import { EventBus } from "../src/eventBus";
import { AUTO_END_HOLDS, AUTO_END_PER_TICK, AUTO_SETTLE_IDLE_MS, AUTO_SETTLE_TICK_MS, AUTO_SETTLE_SEEN_IDLE_MS, autoSettleDue, hubShelfDeps, resetDeps, untilReset, type ResetDeps } from "../src/sessionAttention";
import { Inbox, RESUME_POLL_MS, RESUME_WAIT_MS, SETTLE_END_GRACE_MS } from "../src/sessionInbox";
import { ThreadStore } from "../src/threadStore";
import type { Attention, BackgroundWork, BridgeEvent, InboxItem } from "../../shared/thread";

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
function setup(opts: {
  snoozedThrows?: boolean; activityThrows?: boolean; quietMs?: number; endFails?: string;
  /** git status of a session's worktree (null: unreadable); clean when not given. */
  changes?: Record<string, string[] | null>;
  /** Runs while git status is being read (something happens during that await). */
  onChanges?: (id: string) => void;
  /** The end waits for this (an end takes minutes: the storage guard backs the container up first). */
  endGate?: Promise<void>;
} = {}) {
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
  /** The ends the inbox started ("id:reason"); a successful one deletes the session, as end() does. */
  const ends: string[] = [];
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
    now: () => now, coalesceMs: 0, timers: timers.timers, log: (m) => logs.push(m),
    end: async (id, reason) => {
      ends.push(`${id}:${reason}`);
      await opts.endGate;
      if (opts.endFails) throw new Error(opts.endFails);
      deleteSession(db, id);
    },
    worktreeChanges: async (s) => {
      opts.onChanges?.(s.id);
      return opts.changes && s.id in opts.changes ? opts.changes[s.id] : [];
    },
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
  return { db, hub, inbox, threads, feed, notified, published, section, timers, logs, ends, tick: (ms: number) => { now += ms; }, now: () => now };
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
  putSessionAttention(t.db, { session_id: TMUX.id, settled_at: null, settled_reason: null, snooze_until: until, snooze_kind: "time", updated_at: 1, end_at: null, end_error: null });
  putSessionAttention(t.db, { session_id: CHAT.id, settled_at: null, settled_reason: null, snooze_until: t.now() - 1, snooze_kind: "time", updated_at: 1, end_at: null, end_error: null });
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

const NEVER = { seenAt: null, stateKnown: true } as const;
const SEEN_AT_0 = { seenAt: 0, stateKnown: true } as const;

test("auto-settle: idle (seen, nothing to say) after 24 h; needs-you (unseen done, failed, CI) after 7 days", () => {
  const s: SessionRow = { ...TMUX, created_at: 0, last_active_at: 0 };
  const idle = { section: "idle", reason: null, since: 0 } as const;
  expect(AUTO_SETTLE_SEEN_IDLE_MS).toBe(DAY);
  expect(autoSettleDue(idle, s, null, SEEN_AT_0, DAY - 60_000)).toBe(false); // 23:59
  expect(autoSettleDue(idle, s, null, SEEN_AT_0, DAY)).toBe(true);
  for (const reason of ["completed", "failed", "ci-failed"] as const) {
    const needsYou = { section: "needs_you", reason, since: 0 } as const;
    expect(autoSettleDue(needsYou, s, null, SEEN_AT_0, DAY)).toBe(false);
    expect(autoSettleDue(needsYou, s, null, SEEN_AT_0, AUTO_SETTLE_IDLE_MS - 1)).toBe(false);
    expect(autoSettleDue(needsYou, s, null, SEEN_AT_0, AUTO_SETTLE_IDLE_MS)).toBe(true);
  }
});

test("auto-settle: idle that was never seen, or whose agent state devd does not know, keeps 7 days", () => {
  const s: SessionRow = { ...TMUX, created_at: 0, last_active_at: 0 };
  const idle = { section: "idle", reason: null, since: 0 } as const;
  for (const look of [NEVER, { seenAt: 0, stateKnown: false }]) {
    expect(autoSettleDue(idle, s, null, look, DAY)).toBe(false);
    expect(autoSettleDue(idle, s, null, look, AUTO_SETTLE_IDLE_MS - 1)).toBe(false);
    expect(autoSettleDue(idle, s, null, look, AUTO_SETTLE_IDLE_MS)).toBe(true);
  }
});

test("auto-settle: a tmux session seen once, whose finish devd missed while down (state unknown), is not settled after 24 h", async () => {
  const t = setup();
  const tmux = getSession(t.db, TMUX.id)!;
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  t.hub.sweep();
  t.inbox.seen(TMUX.id);
  t.hub.handle(tmux, "user_prompt_submit"); // working; the stop that follows is lost while devd is down
  const restarted = new AgentEventHub({ db: t.db, notify: () => {}, now: t.now });
  restarted.loadPersisted([tmux]); // working is not restored: unknown
  const inbox = new Inbox({
    db: t.db, sessions: () => [tmux], session: (id) => getSession(t.db, id), threads: t.threads,
    chatLink: () => null, tmuxLive: (id) => restarted.liveSnapshot(id), bus: new EventBus(), now: t.now, coalesceMs: 0,
    end: async () => {}, worktreeChanges: async () => [],
  });
  expect(restarted.liveSnapshot(TMUX.id)?.status).toBe("unknown");
  expect(inbox.item(tmux).attention.section).toBe("idle");
  t.tick(AUTO_SETTLE_SEEN_IDLE_MS + DAY);
  expect(await inbox.autoSettle()).toEqual([]);
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect(await inbox.autoSettle()).toEqual([TMUX.id]);
});

test("auto-settle: a seen quiet session after 24 h, an unseen completion after 7 days (reason idle), not before", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]); // unseen: needs-you
  const tmux = getSession(t.db, TMUX.id)!;
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  t.hub.sweep();
  t.inbox.seen(TMUX.id); // done and seen: idle
  t.tick(AUTO_SETTLE_SEEN_IDLE_MS - 1);
  expect((await t.inbox.autoSettle())).toEqual([]);
  t.tick(1);
  expect((await t.inbox.autoSettle())).toEqual([TMUX.id]);
  expect(getSessionAttention(t.db, TMUX.id)?.settled_reason).toBe("idle");
  t.tick(AUTO_SETTLE_IDLE_MS - AUTO_SETTLE_SEEN_IDLE_MS - 2000 - 1);
  expect((await t.inbox.autoSettle())).toEqual([]);
  t.tick(1);
  expect((await t.inbox.autoSettle())).toEqual([CHAT.id]);
  expect(t.section(CHAT.id)).toBe("settled");
  expect(getSessionAttention(t.db, CHAT.id)?.settled_reason).toBe("idle");
  expect((await t.inbox.autoSettle())).toEqual([]); // already settled
});

test("auto-settle counts a look as activity: idle at the look + 24 h, not before", () => {
  const s: SessionRow = { ...TMUX, created_at: 0, last_active_at: 0 };
  const idle = { section: "idle", reason: null, since: 0 } as const;
  const look = { seenAt: 3 * DAY, stateKnown: true };
  expect(autoSettleDue(idle, s, null, look, 3 * DAY + AUTO_SETTLE_SEEN_IDLE_MS - 1)).toBe(false);
  expect(autoSettleDue(idle, s, null, look, 3 * DAY + AUTO_SETTLE_SEEN_IDLE_MS)).toBe(true);
});

test("a chat Done last active 3 days ago and seen now settles at now + 24 h, not minutes after the look", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(3 * DAY);
  expect(t.section(CHAT.id)).toBe("needs_you");
  const store = t.threads(CHAT.id);
  store.markSeen(store.lastSeq()); // what POST /thread/seen does
  t.inbox.seen(CHAT.id);
  expect(t.section(CHAT.id)).toBe("idle");
  t.tick(AUTO_SETTLE_SEEN_IDLE_MS - 1);
  expect((await t.inbox.autoSettle())).not.toContain(CHAT.id);
  t.tick(1);
  expect((await t.inbox.autoSettle())).toContain(CHAT.id);
});

test("a tmux Done last active 3 days ago and seen now settles at now + 24 h, not minutes after the look", async () => {
  const t = setup();
  const tmux = getSession(t.db, TMUX.id)!;
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop");
  t.tick(2000);
  t.hub.sweep();
  t.tick(3 * DAY);
  expect(t.section(TMUX.id)).toBe("needs_you");
  t.inbox.seen(TMUX.id);
  expect(t.section(TMUX.id)).toBe("idle");
  t.tick(AUTO_SETTLE_SEEN_IDLE_MS - 1);
  expect((await t.inbox.autoSettle())).not.toContain(TMUX.id);
  t.tick(1);
  expect((await t.inbox.autoSettle())).toContain(TMUX.id);
});

test("auto-settle counts idle time from the last activity of the session, not from an old attention", async () => {
  const t = setup();
  t.db.run("UPDATE sessions SET last_active_at=? WHERE id=?", [T0 + 3 * DAY, TMUX.id]);
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect((await t.inbox.autoSettle())).toEqual([CHAT.id]); // idle since T0
  t.tick(3 * DAY - 1);
  expect((await t.inbox.autoSettle())).toEqual([]);
  t.tick(1);
  expect((await t.inbox.autoSettle())).toEqual([TMUX.id]);
});

test("a pending request, an active run, holding work or a snooze block auto-settle", async () => {
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
    expect((await t.inbox.autoSettle())).toEqual([]);
  }
});

test("a tmux session waiting for permission is not auto-settled", async () => {
  const t = setup();
  t.hub.handle(getSession(t.db, TMUX.id)!, "permission_request");
  t.db.run("UPDATE sessions SET last_active_at=? WHERE id=?", [T0 + 30 * DAY, CHAT.id]);
  t.tick(AUTO_SETTLE_IDLE_MS + DAY);
  expect((await t.inbox.autoSettle())).toEqual([]);
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
  expect(getSeenAt(t.db, TMUX.id)).toBe(t.now());
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
  expect(getSeenAt(t.db, TMUX.id)).toBeNull();
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

// --- settle ends the session (after SETTLE_END_GRACE_MS, unless undone) ---

/** Lets the end's promise and its handlers run. */
const settled = () => new Promise((r) => setTimeout(r, 0));

test("a settle ends the session once the grace has passed, and says when in the item", async () => {
  const t = setup();
  t.inbox.settle(TMUX.id, "manual");
  expect(t.published.at(-1)).toMatchObject({ sessionId: TMUX.id, attention: { section: "settled" }, endsAt: T0 + SETTLE_END_GRACE_MS, endError: null });
  t.tick(SETTLE_END_GRACE_MS - 1);
  t.timers.due();
  expect(t.ends).toEqual([]);
  t.tick(1);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([`${TMUX.id}:manual`]);
  expect(getSession(t.db, TMUX.id)).toBeNull();
});

test("unsettle within the grace keeps the session: no end", async () => {
  const t = setup();
  t.inbox.settle(CHAT.id, "manual");
  t.tick(SETTLE_END_GRACE_MS - 1);
  t.inbox.unsettle(CHAT.id);
  expect(getSessionAttention(t.db, CHAT.id)).toMatchObject({ settled_at: null, end_at: null });
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([]);
  expect(t.inbox.item(getSession(t.db, CHAT.id)!)).toMatchObject({ endsAt: null });
});

test("a new run within the grace unsettles and so keeps the session", async () => {
  const t = setup();
  t.inbox.settle(CHAT.id, "manual");
  t.feed(CHAT.id, [started("r1")]);
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([]);
});

test("a failed end brings the session back out of Settled with the error, logged", async () => {
  const t = setup({ endFails: "docker is stuck" });
  t.inbox.settle(TMUX.id, "manual");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  const item = t.inbox.item(getSession(t.db, TMUX.id)!);
  expect(item.attention.section).not.toBe("settled");
  expect(item).toMatchObject({ endsAt: null, endError: "docker is stuck" });
  t.timers.due(); // the ending item went out a moment ago: this one is coalesced behind it
  expect(t.published.at(-1)).toMatchObject({ sessionId: TMUX.id, endError: "docker is stuck" });
  expect(t.logs.some((l) => l.includes(TMUX.id) && l.includes("docker is stuck"))).toBe(true);
  // The next settle tries again and clears the error.
  t.inbox.settle(TMUX.id, "manual");
  expect(t.inbox.item(getSession(t.db, TMUX.id)!)).toMatchObject({ endError: null });
});

test("a settle pending over a devd restart ends when its time comes (armEnds)", async () => {
  const t = setup();
  const tmux = getSession(t.db, TMUX.id)!;
  t.hub.handle(tmux, "user_prompt_submit");
  t.hub.handle(tmux, "stop"); // its state is known after the restart: done, not working
  t.tick(2000);
  t.hub.sweep();
  t.inbox.settle(TMUX.id, "manual");
  const restarted = fakeTimers(t.now);
  const ends: string[] = [];
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id), threads: t.threads,
    chatLink: () => null, tmuxLive: (id) => t.hub.liveSnapshot(id), bus: new EventBus(), now: t.now, coalesceMs: 0, timers: restarted.timers,
    end: async (id, reason) => { ends.push(`${id}:${reason}`); }, worktreeChanges: async () => [],
  });
  t.tick(SETTLE_END_GRACE_MS + 60_000); // devd was down past the grace
  inbox.armEnds();
  restarted.due();
  await settled();
  expect(ends).toEqual([`${TMUX.id}:manual`]);
});

test("auto-settle ends the session (reason idle), logged, and never one that works", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1")]); // working
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect((await t.inbox.autoSettle())).toEqual([TMUX.id]);
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([`${TMUX.id}:idle`]);
  expect(t.logs.some((l) => l.includes(TMUX.id) && l.includes("auto"))).toBe(true);
});

test("a session settled before settles ended (no end pending) is ended by the auto rule, counted from the migration", async () => {
  const t = setup();
  // What a settle before this change left: settled, no end; the migration stamped updated_at with its time.
  putSessionAttention(t.db, { session_id: TMUX.id, settled_at: T0, settled_reason: "manual", snooze_until: null, snooze_kind: null, updated_at: T0 + 10 * DAY, end_at: null, end_error: null });
  t.tick(10 * DAY + AUTO_SETTLE_IDLE_MS - 1);
  expect((await t.inbox.autoSettle())).not.toContain(TMUX.id);
  t.tick(1);
  expect((await t.inbox.autoSettle())).toContain(TMUX.id);
});

test("auto-settle starts at most AUTO_END_PER_TICK ends per tick, counting the ones still pending or running", async () => {
  let release!: () => void;
  const t = setup({ endGate: new Promise<void>((r) => { release = r; }) });
  for (const n of [1, 2, 3]) insertSession(t.db, { ...TMUX, id: `dev-a-more-${n}`, container: `dev-a-more-${n}`, port_base: 40300 + 100 * n, created_at: T0, last_active_at: T0 });
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect((await t.inbox.autoSettle())).toHaveLength(AUTO_END_PER_TICK);
  // Their grace runs: the next tick starts none.
  expect(await t.inbox.autoSettle()).toEqual([]);
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toHaveLength(AUTO_END_PER_TICK);
  // Their ends run (minutes): still none.
  expect(await t.inbox.autoSettle()).toEqual([]);
  release();
  await settled();
  expect((await t.inbox.autoSettle())).toHaveLength(AUTO_END_PER_TICK);
});

test("a due session past the per-tick cap still gets its hold rechecked: no stale Uncommitted changes chip", async () => {
  const changes: Record<string, string[] | null> = { "dev-a-more-3": ["M a.ts"] };
  const t = setup({ changes });
  for (const n of [1, 2, 3]) insertSession(t.db, { ...TMUX, id: `dev-a-more-${n}`, container: `dev-a-more-${n}`, port_base: 40300 + 100 * n, created_at: T0 - 10 + n, last_active_at: T0 });
  t.db.run("UPDATE sessions SET last_active_at=? WHERE id IN (?, ?)", [T0 + 30 * DAY, CHAT.id, TMUX.id]); // only the three are due
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect(await t.inbox.autoSettle()).toEqual(["dev-a-more-1", "dev-a-more-2"]);
  expect(t.inbox.item(getSession(t.db, "dev-a-more-3")!).autoEndHold).toBe(AUTO_END_HOLDS.dirty);
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  // A fourth due one ahead of it takes the cap; the owner committed in dev-a-more-3 meanwhile.
  insertSession(t.db, { ...TMUX, id: "dev-a-more-0", container: "dev-a-more-0", port_base: 40900, created_at: T0 - 20, last_active_at: T0 });
  insertSession(t.db, { ...TMUX, id: "dev-a-more-00", container: "dev-a-more-00", port_base: 41000, created_at: T0 - 20, last_active_at: T0 });
  changes["dev-a-more-3"] = [];
  await t.inbox.autoSettle();
  expect(t.inbox.item(getSession(t.db, "dev-a-more-3")!).autoEndHold).toBeNull();
});

test("a held quiet session keeps its chip while it stays dirty, also after a merged PR's settle was taken back", async () => {
  const t = setup({ changes: { [TMUX.id]: ["M a.ts"] } });
  t.inbox.settle(TMUX.id, "merged");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).autoEndHold).toBe(AUTO_END_HOLDS.dirty);
  t.tick(AUTO_SETTLE_TICK_MS);
  await t.inbox.autoSettle();
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).autoEndHold).toBe(AUTO_END_HOLDS.dirty);
});

test("a run that starts while the auto end reads git status cancels the end", async () => {
  let t!: ReturnType<typeof setup>;
  t = setup({ onChanges: (id) => { if (id === CHAT.id) t.feed(CHAT.id, [started("r9")]); } });
  t.inbox.settle(CHAT.id, "idle");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([]);
  expect(t.inbox.item(getSession(t.db, CHAT.id)!).attention.section).toBe("working");
});

test("after a restart a pending end does not fire on a session that is busy or whose state stays unknown; it is back with why", async () => {
  for (const kind of ["working", "unknown"] as const) {
    const t = setup();
    const target = kind === "working" ? CHAT.id : TMUX.id;
    t.inbox.settle(target, "manual");
    if (kind === "working") t.threads(CHAT.id).apply({ seq: 1, ts: 0, event: started("r1") }); // the hook devd missed while down
    const restarted = fakeTimers(t.now);
    const ends: string[] = [];
    const logs: string[] = [];
    const inbox = new Inbox({
      db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id), threads: t.threads,
      chatLink: () => ({ status: "connected", since: 1 }), tmuxLive: () => null, bus: new EventBus(), now: t.now, coalesceMs: 0,
      timers: restarted.timers, log: (m) => logs.push(m),
      end: async (id, reason) => { ends.push(`${id}:${reason}`); }, worktreeChanges: async () => [],
    });
    t.tick(SETTLE_END_GRACE_MS + 60_000);
    inbox.armEnds();
    // An unknown tmux state gets RESUME_WAIT_MS for its first live read; a busy one is decided at once.
    for (let waited = 0; waited <= RESUME_WAIT_MS; waited += RESUME_POLL_MS) {
      restarted.due();
      await settled();
      t.tick(RESUME_POLL_MS);
    }
    expect(ends).toEqual([]);
    expect(getSessionAttention(t.db, target)).toMatchObject({ settled_at: null, end_at: null });
    // The owner sees why on the row, not only in the log.
    expect(getSessionAttention(t.db, target)!.end_error).toContain("restart");
    expect(logs.some((l) => l.includes(target) && l.includes("not ended"))).toBe(true);
  }
});

test("after a restart an end waits (bounded) for the tmux session's first live read, then goes ahead when it is known", async () => {
  const t = setup();
  t.inbox.settle(TMUX.id, "manual");
  const restarted = fakeTimers(t.now);
  const ends: string[] = [];
  let live: ReturnType<AgentEventHub["liveSnapshot"]> = null;
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id), threads: t.threads,
    chatLink: () => null, tmuxLive: () => live, bus: new EventBus(), now: t.now, coalesceMs: 0, timers: restarted.timers,
    end: async (id, reason) => { ends.push(`${id}:${reason}`); }, worktreeChanges: async () => [],
  });
  t.tick(SETTLE_END_GRACE_MS + 60_000);
  inbox.armEnds();
  restarted.due();
  await settled();
  expect(ends).toEqual([]);
  expect(getSessionAttention(t.db, TMUX.id)!.end_at).not.toBeNull(); // still pending, not refused
  live = { status: "done", body: "", reason: null, startedAt: 0, updatedAt: 0, statusSince: 0 } as never;
  t.tick(RESUME_POLL_MS);
  restarted.due();
  await settled();
  expect(ends).toEqual([`${TMUX.id}:manual`]);
});

test("a started end is ending from the moment armEnds runs: no hook or unsettle can take it back before its timer", async () => {
  let release!: () => void;
  const t = setup({ endGate: new Promise<void>((r) => { release = r; }) });
  t.inbox.settle(TMUX.id, "manual");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  const restarted = fakeTimers(t.now);
  const ends: string[] = [];
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id), threads: t.threads,
    chatLink: () => null, tmuxLive: () => null, bus: new EventBus(), now: t.now, coalesceMs: 0, timers: restarted.timers,
    end: async (id, reason) => { ends.push(`${id}:${reason}`); }, worktreeChanges: async () => [],
  });
  inbox.armEnds();
  expect(inbox.unsettle(TMUX.id)).toBe(false);
  inbox.activity(TMUX.id, "failure");
  expect(getSessionAttention(t.db, TMUX.id)).toMatchObject({ end_at: expect.any(Number), end_started_at: expect.any(Number) });
  expect(inbox.item(getSession(t.db, TMUX.id)!).ending).toBe(true);
  restarted.due();
  await settled();
  expect(ends).toEqual([`${TMUX.id}:manual`]);
  release();
});

test("an end that had started when devd went down resumes after the restart, whatever the state says now", async () => {
  let release!: () => void;
  const t = setup({ endGate: new Promise<void>((r) => { release = r; }) });
  t.inbox.settle(TMUX.id, "manual");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled(); // the end runs (its container may be gone already) when devd goes down
  expect(getSessionAttention(t.db, TMUX.id)!.end_started_at).not.toBeNull();
  const restarted = fakeTimers(t.now);
  const ends: string[] = [];
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id), threads: t.threads,
    chatLink: () => null, tmuxLive: () => null, bus: new EventBus(), now: t.now, coalesceMs: 0, timers: restarted.timers,
    end: async (id, reason) => { ends.push(`${id}:${reason}`); }, worktreeChanges: async () => [],
  });
  inbox.armEnds();
  restarted.due();
  await settled();
  expect(ends).toEqual([`${TMUX.id}:manual`]);
  release();
});

test("a settle the owner confirmed for a working agent still ends it", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1")]);
  t.inbox.settle(CHAT.id, "manual", { confirmed: true });
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([`${CHAT.id}:manual`]);
});

test("the auto clock of a snoozed session counts from when the snooze ended", () => {
  const s = { ...TMUX, created_at: T0, last_active_at: T0 };
  const idle: Attention = { section: "idle", reason: null, since: T0 };
  const wake = T0 + 2 * DAY;
  const row = { session_id: TMUX.id, settled_at: null, settled_reason: null, snooze_until: wake, snooze_kind: "time" as const, updated_at: T0, end_at: null, end_error: null };
  const look = { seenAt: T0, stateKnown: true };
  expect(autoSettleDue(idle, s, row, look, wake + 10 * 60_000)).toBe(false);
  expect(autoSettleDue(idle, s, row, look, wake + AUTO_SETTLE_SEEN_IDLE_MS)).toBe(true);
});

test("while the end runs it cannot be taken back: unsettle and snooze refuse and leave end_at for a restart", async () => {
  let release!: () => void;
  const t = setup({ endGate: new Promise<void>((r) => { release = r; }) });
  t.inbox.settle(TMUX.id, "manual");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.inbox.unsettle(TMUX.id)).toBe(false);
  expect(t.inbox.snooze(TMUX.id, t.now() + DAY, "time")).toBe(false);
  t.inbox.activity(TMUX.id, "run");
  expect(getSessionAttention(t.db, TMUX.id)!.end_at).not.toBeNull();
  release();
  await settled();
  expect(t.inbox.unsettle(CHAT.id)).toBe(true);
});

test("the auto rule leaves a due session with uncommitted changes alive: its row says why, logged once, not every tick", async () => {
  const t = setup({ changes: { [TMUX.id]: ["M a.ts", "?? b.ts"] } });
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect(await t.inbox.autoSettle()).toEqual([CHAT.id]);
  expect(t.inbox.item(getSession(t.db, TMUX.id)!)).toMatchObject({ autoEndHold: AUTO_END_HOLDS.dirty, attention: { section: "idle" } });
  expect(await t.inbox.autoSettle()).toEqual([]);
  t.tick(AUTO_SETTLE_TICK_MS);
  expect(await t.inbox.autoSettle()).toEqual([]);
  expect(t.logs.filter((l) => l.includes(TMUX.id) && l.includes("stays"))).toHaveLength(1);
  expect(t.published.some((i) => i.sessionId === TMUX.id && i.autoEndHold === AUTO_END_HOLDS.dirty)).toBe(true);
  // Activity clears the hold: the session is not due any more.
  t.inbox.settle(TMUX.id, "manual");
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).autoEndHold).toBeNull();
});

test("the auto rule does not end a session whose worktree state is unknown (unknown is not clean)", async () => {
  const t = setup({ changes: { [TMUX.id]: null, [CHAT.id]: null } });
  t.tick(AUTO_SETTLE_IDLE_MS);
  expect(await t.inbox.autoSettle()).toEqual([]);
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).autoEndHold).toBe(AUTO_END_HOLDS.unknown);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([]);
});

test("a merged PR's settle (not checked by the idle rule) still keeps a session with uncommitted changes alive", async () => {
  const t = setup({ changes: { [TMUX.id]: ["M a.ts"] } });
  t.inbox.settle(TMUX.id, "merged");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([]);
  expect(t.inbox.item(getSession(t.db, TMUX.id)!)).toMatchObject({ autoEndHold: AUTO_END_HOLDS.dirty, endsAt: null });
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).attention.section).not.toBe("settled");
});

test("a manual settle ends a dirty session too (the owner confirmed; the end keeps the worktree)", async () => {
  const t = setup({ changes: { [TMUX.id]: ["M a.ts"] } });
  t.inbox.settle(TMUX.id, "manual");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([`${TMUX.id}:manual`]);
});

test("while the end runs the row sits in Settled as ending (not undoable), then it goes; a failed end comes back with its error", async () => {
  let release!: () => void;
  const t = setup({ endGate: new Promise<void>((r) => { release = r; }) });
  t.inbox.settle(TMUX.id, "manual");
  t.tick(SETTLE_END_GRACE_MS);
  t.timers.due();
  await settled();
  expect(t.ends).toEqual([`${TMUX.id}:manual`]);
  const during = t.inbox.list().find((i) => i.sessionId === TMUX.id)!;
  expect(during).toMatchObject({ ending: true, endsAt: null, attention: { section: "settled" } });
  expect(t.published.at(-1)).toMatchObject({ sessionId: TMUX.id, ending: true });
  // devd's session lookup leaves an ending session out (mgr.isEnding): the inbox still shows it.
  expect(t.inbox.item(getSession(t.db, TMUX.id)!).ending).toBe(true);
  release();
  await settled();
  expect(t.inbox.list().some((i) => i.sessionId === TMUX.id)).toBe(false);
  t.timers.due();
  expect(t.published.at(-1) as unknown).toEqual({ sessionId: TMUX.id, removed: true });

  const f = setup({ endFails: "docker rm failed" });
  f.inbox.settle(CHAT.id, "manual");
  f.tick(SETTLE_END_GRACE_MS);
  f.timers.due();
  await settled();
  expect(f.inbox.item(getSession(f.db, CHAT.id)!)).toMatchObject({ ending: false, endError: "docker rm failed" });
});

test("the migration adds the end columns and restarts the auto clock of sessions already settled, not of others", () => {
  const dir = mkdtempSync(join(tmpdir(), "settle-mig-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "devd.db");
  const old = new Database(path);
  old.run(`CREATE TABLE session_attention (session_id TEXT PRIMARY KEY, settled_at INTEGER, settled_reason TEXT,
    snooze_until INTEGER, snooze_kind TEXT, updated_at INTEGER NOT NULL)`);
  old.run(`INSERT INTO session_attention VALUES ('dev-settled', 5, 'manual', NULL, NULL, 5), ('dev-snoozed', NULL, NULL, 99, 'time', 5)`);
  old.close();
  const before = Date.now();
  const db = openDb(path);
  cleanups.push(() => db.close());
  expect(getSessionAttention(db, "dev-settled")).toMatchObject({ settled_at: 5, end_at: null, end_error: null });
  expect(getSessionAttention(db, "dev-settled")!.updated_at).toBeGreaterThanOrEqual(before);
  expect(getSessionAttention(db, "dev-snoozed")!.updated_at).toBe(5);
});
