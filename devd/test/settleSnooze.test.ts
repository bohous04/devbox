import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub } from "../src/agentEvents";
import type { UsageLimit } from "../src/accountUsage";
import type { CodexView } from "../src/codexPoller";
import { ChatHub } from "../src/chatHub";
import {
  deleteSession, getSession, getSessionAttention, insertSession, listNotifyLog, listSessions, openDb, type SessionRow,
} from "../src/db";
import { EventBus } from "../src/eventBus";
import { AUTO_SETTLE_IDLE_MS, untilReset, type ResetDeps } from "../src/sessionAttention";
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

/** A hub, a chat hub and an inbox over one clock, wired like index.ts. Chat events are stamped with that clock. */
function setup() {
  let now = T0;
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
  const hub = new AgentEventHub({
    db, notify: (title, message) => notified.push(`${title}: ${message}`), now: () => now, quietMs: 1000,
    onActivity: (id, kind) => inbox.activity(id, kind),
    snoozed: (id) => inbox.snoozed(id),
  });
  const chatHub = new ChatHub({ hub, session: (id) => getSession(db, id), now: () => now });
  inbox = new Inbox({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id), threads,
    chatLink: () => ({ status: "connected", since: 1 }), tmuxLive: (id) => hub.liveSnapshot(id), bus,
    now: () => now, coalesceMs: 0,
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
  return { db, hub, inbox, threads, feed, notified, published, section, tick: (ms: number) => { now += ms; }, now: () => now };
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

test("a snooze until a time hides the session until then, and it comes back on its own", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(10_000);
  t.inbox.snooze(CHAT.id, t.now() + 50, "time");
  const it = t.inbox.item(getSession(t.db, CHAT.id)!);
  expect(it.attention).toMatchObject({ section: "snoozed", until: t.now() + 50 });
  t.tick(60);
  await Bun.sleep(120); // the inbox re-publishes when the snooze ends
  expect(t.published.at(-1)).toMatchObject({ sessionId: CHAT.id, attention: { section: "needs_you", reason: "completed" } });
  expect(t.published.at(-1)!.attention.until).toBeUndefined();
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
