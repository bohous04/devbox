import type { Database } from "bun:sqlite";
import type { InboxItem, InboxRemoved, InboxSection } from "../../shared/thread";
import { threadTitle } from "../../shared/threadTitle";
import type { AgentLiveSnapshot } from "./agentEvents";
import { chatAttention, lastEndedRun, tmuxAttention, WORKING_GRACE_MS, type LinkState, type PrHold } from "./attention";
import { getSessionAttention, getSeenAt, putSessionAttention, setSeenAt, snoozedSessionIds, type SessionRow, type SettleReason, type SnoozeKind } from "./db";
import type { EventBus } from "./eventBus";
import { autoSettleDue, shelve, snoozeActive, type Activity } from "./sessionAttention";
import { storedRuntime } from "./sessions";
import type { ThreadStore } from "./threadStore";

/** `lastText` is a preview line in the inbox, not the message: longer texts are clipped. */
export const LAST_TEXT_MAX = 200;
export const INBOX_COALESCE_MS = 250;

const SECTION_ORDER: Record<InboxSection, number> = { needs_you: 0, working: 1, idle: 2, snoozed: 3, settled: 4 };
/** setTimeout's longest delay; a snooze that ends later is re-checked at this distance until it ends. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** needs_you oldest first (the longest wait on top), the other sections newest first. */
export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const s = SECTION_ORDER[a.attention.section] - SECTION_ORDER[b.attention.section];
    if (s !== 0) return s;
    return a.attention.section === "needs_you" ? a.attention.since - b.attention.since : b.attention.since - a.attention.since;
  });
}

const clip = (t: string) => (t.length > LAST_TEXT_MAX ? `${t.slice(0, LAST_TEXT_MAX)}…` : t);

/** The inbox over all sessions, and its live feed: `changed(id)` publishes the session's item on the bus
 *  topic "inbox" when it differs from the last one published (an `InboxRemoved` once the session is gone or ending), at most once per session per `coalesceMs`
 *  (the first change goes out at once, later ones in the window as one trailing item with the newest state). */
export class Inbox {
  private lastPublished = new Map<string, string>();
  private windows = new Map<string, { dirty: boolean }>();
  private rechecks = new Map<string, unknown>();
  private timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  /** Sessions whose store is unreadable: the logged message (logged once per message, not per inbox read) and since
   *  when it fails (the item's `since`, so an unchanged failure is not published again). Cleared once it reads again. */
  private broken = new Map<string, { msg: string; since: number }>();
  /** Each chat session's topic once known: it never changes, so the store is read only while it is still null. */
  private topics = new Map<string, string>();
  private coalesceMs: number;
  private log: (msg: string) => void;

  constructor(private d: {
    /** The main DB: the sessions' settled and snoozed shelves (session_attention). */
    db: Database;
    /** Sessions the inbox lists (index.ts leaves out ending ones: their store is being archived). */
    sessions: () => SessionRow[];
    /** null for a session that is gone or ending. */
    session: (id: string) => SessionRow | null;
    threads: (id: string) => ThreadStore;
    chatLink: (id: string) => LinkState | null;
    tmuxLive: (id: string) => AgentLiveSnapshot | null;
    /** The CI checks of the session's open PR (PrWatch.hold); absent = devd watches no PRs. */
    prHold?: (id: string) => PrHold | null;
    bus: EventBus;
    now?: () => number;
    coalesceMs?: number;
    log?: (msg: string) => void;
    /** The coalesce and re-check timers (tests drive them by hand). */
    timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  }) {
    this.coalesceMs = d.coalesceMs ?? INBOX_COALESCE_MS;
    this.timers = d.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  now() { return this.d.now?.() ?? Date.now(); }

  item(s: SessionRow): InboxItem { return this.build(s).item; }

  /** Settle by hand (`manual`) or by the idle rule (`idle`); ends a snooze. */
  settle(sessionId: string, reason: SettleReason): void {
    const now = this.now();
    putSessionAttention(this.d.db, { session_id: sessionId, settled_at: now, settled_reason: reason, snooze_until: null, snooze_kind: null, updated_at: now });
    this.changedSafe(sessionId);
  }

  /** Settles unless the session is busy (an active run, holding work, a pending request): the merged-PR rule settles
   *  at the session's next idle moment, so the caller retries. Returns whether it settled. */
  settleWhenIdle(sessionId: string, reason: SettleReason): boolean {
    const s = this.d.session(sessionId);
    if (!s) return false;
    const a = this.base(s).item.attention;
    if (a.section === "working" || a.reason === "request") return false;
    this.settle(sessionId, reason);
    return true;
  }

  /** Back into the inbox: ends a settle and a snooze. */
  unsettle(sessionId: string): void {
    const now = this.now();
    putSessionAttention(this.d.db, { session_id: sessionId, settled_at: null, settled_reason: null, snooze_until: null, snooze_kind: null, updated_at: now });
    this.changedSafe(sessionId);
  }

  /** Snooze until `until` (epoch ms); ends a settle. */
  snooze(sessionId: string, until: number, kind: SnoozeKind): void {
    putSessionAttention(this.d.db, { session_id: sessionId, settled_at: null, settled_reason: null, snooze_until: until, snooze_kind: kind, updated_at: this.now() });
    this.changedSafe(sessionId);
  }

  /** The owner looked at the session: the auto-settle clock restarts, and a tmux session's current done or failed
   *  state is seen (chat's is the thread store's seenSeq, which the caller advances). */
  seen(sessionId: string): void {
    setSeenAt(this.d.db, sessionId, this.now());
    this.changedSafe(sessionId);
  }

  snoozed(sessionId: string): boolean {
    return snoozeActive(getSessionAttention(this.d.db, sessionId), this.now());
  }

  /** A new run unsettles; a request or a failure unsettles and wakes a snooze. */
  activity(sessionId: string, kind: Activity): void {
    const row = getSessionAttention(this.d.db, sessionId);
    if (!row) return;
    const wake = kind !== "run" && row.snooze_until !== null;
    if (row.settled_at === null && !wake) return;
    putSessionAttention(this.d.db, {
      ...row, settled_at: null, settled_reason: null,
      ...(wake ? { snooze_until: null, snooze_kind: null } : {}), updated_at: this.now(),
    });
    this.changedSafe(sessionId);
  }

  /** At startup: a snooze set before a devd restart still ends with an inbox update. Publishing arms its timer. */
  armSnoozes(): void {
    for (const id of snoozedSessionIds(this.d.db, this.now())) this.changedSafe(id);
  }

  /** The idle rule (index.ts runs it every AUTO_SETTLE_TICK_MS): settles every session that is due. Returns their ids. */
  autoSettle(): string[] {
    const now = this.now();
    const settled: string[] = [];
    for (const s of this.d.sessions()) {
      const live = storedRuntime(s) === "tmux" ? this.d.tmuxLive(s.id) : null;
      const stateKnown = storedRuntime(s) === "chat" || (live !== null && live.status !== "unknown");
      const look = { seenAt: getSeenAt(this.d.db, s.id), stateKnown };
      if (!autoSettleDue(this.base(s).item.attention, s, getSessionAttention(this.d.db, s.id), look, now)) continue;
      this.settle(s.id, "idle");
      settled.push(s.id);
    }
    return settled;
  }

  list(): InboxItem[] { return sortInbox(this.d.sessions().map((s) => this.item(s))); }

  /** `recheckAt`: when the item changes without an event: the end of a snooze, or of the WORKING_GRACE_MS a chat
   *  run that just ended still counts as working. */
  private build(s: SessionRow): { item: InboxItem; recheckAt: number | null } {
    const b = this.base(s);
    const row = getSessionAttention(this.d.db, s.id);
    const now = this.now();
    const attention = shelve(b.item.attention, row, now);
    const snoozeEnd = attention.until ?? null;
    const recheckAt = b.recheckAt === null ? snoozeEnd : snoozeEnd === null ? b.recheckAt : Math.min(b.recheckAt, snoozeEnd);
    return { item: { ...b.item, attention }, recheckAt };
  }

  /** The session's item without its shelf. */
  private base(s: SessionRow): { item: InboxItem; recheckAt: number | null } {
    const runtime = storedRuntime(s);
    // `agent` is optional in SessionRow only for insert literals; the column is NOT NULL.
    const base = { sessionId: s.id, runtime, title: s.name || `${s.project}/${s.repo}`, project: s.project, repo: s.repo, agent: s.agent!, branch: s.branch ?? null };
    // Read outside the store's try: a failing DB read is not an unreadable thread store.
    const pr = this.d.prHold?.(s.id) ?? null;
    if (runtime === "tmux") {
      return { item: { ...base, attention: tmuxAttention(this.d.tmuxLive(s.id), pr, Math.max(s.last_active_at, s.created_at), getSeenAt(this.d.db, s.id)), lastText: null, topic: null }, recheckAt: null };
    }
    let built: { item: InboxItem; recheckAt: number | null };
    try { built = this.buildChat(s, base, pr); }
    catch (e) {
      // One broken store must not take the whole inbox down; the session shows up as needing the user.
      const msg = (e as Error).message;
      let b = this.broken.get(s.id);
      if (b?.msg !== msg) {
        b = { msg, since: b?.since ?? this.now() };
        this.broken.set(s.id, b);
        this.log(`inbox: thread store of ${s.id} unreadable: ${msg}`);
      }
      return {
        item: { ...base, attention: { section: "needs_you", reason: "failed", since: b.since }, lastText: `thread store unreadable: ${msg}`, topic: null },
        recheckAt: null,
      };
    }
    if (this.broken.delete(s.id)) this.log(`inbox: thread store of ${s.id} readable again`);
    return built;
  }

  private buildChat(s: SessionRow, base: Omit<InboxItem, "attention" | "lastText" | "topic">, pr: PrHold | null): { item: InboxItem; recheckAt: number | null } {
    const store = this.d.threads(s.id);
    const t = store.snapshot({ limit: 0 }); // attention reads runs, pending and background only
    const now = this.now();
    const attention = chatAttention(t, this.d.chatLink(s.id), now, pr);
    const text = store.lastMessageText();
    const topic = this.topic(s.id, store);
    const last = lastEndedRun(t);
    const graceEnd = last && last.endedAt !== null ? last.endedAt + WORKING_GRACE_MS : null;
    return {
      item: { ...base, attention, lastText: text === null ? null : clip(text), topic },
      recheckAt: graceEnd !== null && graceEnd > now ? graceEnd : null,
    };
  }

  private topic(sessionId: string, store: ThreadStore): string | null {
    const known = this.topics.get(sessionId);
    if (known !== undefined) return known;
    const first = store.firstUserText();
    const topic = first === null ? null : threadTitle(first);
    if (topic !== null) this.topics.set(sessionId, topic);
    return topic;
  }

  changed(sessionId: string): void {
    const w = this.windows.get(sessionId);
    if (w) { w.dirty = true; return; }
    const win = { dirty: false };
    this.windows.set(sessionId, win);
    this.timers.set(() => {
      this.windows.delete(sessionId);
      if (win.dirty) this.changedSafe(sessionId);
    }, this.coalesceMs);
    this.publish(sessionId);
  }

  /** `changed` for callers whose own work is done (a handled request, a timer, the sweep): a throw is logged,
   *  it must not fail them. */
  changedSafe(sessionId: string): void {
    try { this.changed(sessionId); }
    catch (e) { this.log(`inbox: cannot publish ${sessionId}: ${(e as Error).message}`); }
  }

  private publish(sessionId: string) {
    const s = this.d.session(sessionId);
    if (!s) {
      this.lastPublished.delete(sessionId);
      this.broken.delete(sessionId);
      this.topics.delete(sessionId);
      const recheck = this.rechecks.get(sessionId);
      if (recheck !== undefined) { this.timers.clear(recheck); this.rechecks.delete(sessionId); }
      const removed: InboxRemoved = { sessionId, removed: true };
      this.d.bus.publish("inbox", removed);
      return;
    }
    const { item, recheckAt } = this.build(s);
    const old = this.rechecks.get(sessionId);
    if (old !== undefined) { this.timers.clear(old); this.rechecks.delete(sessionId); }
    if (recheckAt !== null) {
      this.rechecks.set(sessionId, this.timers.set(() => {
        this.rechecks.delete(sessionId);
        this.changedSafe(sessionId);
      }, Math.min(recheckAt - this.now() + 1, MAX_TIMER_MS)));
    }
    const json = JSON.stringify(item);
    if (this.lastPublished.get(sessionId) === json) return;
    this.lastPublished.set(sessionId, json);
    this.d.bus.publish("inbox", item);
  }
}
