import type { Database } from "bun:sqlite";
import type { InboxItem, InboxRemoved, InboxSection } from "../../shared/thread";
import { threadTitle } from "../../shared/threadTitle";
import type { AgentLiveSnapshot } from "./agentEvents";
import { chatAttention, lastEndedRun, tmuxAttention, WORKING_GRACE_MS, type LinkState, type PrHold } from "./attention";
import { getSessionAttention, getSeenAt, pendingEnds, putSessionAttention, setSeenAt, snoozedSessionIds, type SessionAttentionRow, type SessionRow, type SettleReason, type SnoozeKind } from "./db";
import type { EventBus } from "./eventBus";
import { AUTO_END_HOLDS, AUTO_END_PER_TICK, autoSettleDue, shelve, snoozeActive, type Activity } from "./sessionAttention";
import { storedRuntime } from "./sessions";
import type { ThreadStore } from "./threadStore";

/** `lastText` is a preview line in the inbox, not the message: longer texts are clipped. */
export const LAST_TEXT_MAX = 200;
export const INBOX_COALESCE_MS = 250;
/** A settle ends the session this long after it, so an undo (unsettle) can still take it back. */
export const SETTLE_END_GRACE_MS = 8_000;

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

const endFields = (row: SessionAttentionRow | null): Pick<InboxItem, "endsAt" | "endError"> =>
  ({ endsAt: row?.end_at ?? null, endError: row?.end_error ?? null });

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
  /** The timers of the settles whose end is pending, per session. */
  private endTimers = new Map<string, unknown>();
  /** Sessions whose end runs now (minutes: the storage guard backs the container up first), with the item they show
   *  meanwhile: in Settled, `ending`. Kept here because devd's session list leaves ending sessions out. */
  private ending = new Map<string, InboxItem>();
  /** Why the auto rule leaves a due session alive (AUTO_END_HOLDS), shown on its row and logged once per change. */
  private holds = new Map<string, string>();
  /** Settles the owner confirmed (devd's 409 question answered yes): their end goes ahead even while the agent works.
   *  Kept in memory only: after a restart a busy session is not ended (runEnd). */
  private confirmed = new Set<string>();
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
    /** Ends a settled session once its grace has passed (index.ts: endSessionKeepingWork, so a dirty worktree stays).
     *  A rejection brings the session back out of Settled with the error. */
    end: (id: string, reason: SettleReason) => Promise<void>;
    /** The session worktree's uncommitted and untracked changes (git status), [] for none or no worktree of its own,
     *  null when they could not be read. The auto rule ends only a session with none: an end deletes them. */
    worktreeChanges: (s: SessionRow) => Promise<string[] | null>;
  }) {
    this.coalesceMs = d.coalesceMs ?? INBOX_COALESCE_MS;
    this.timers = d.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  now() { return this.d.now?.() ?? Date.now(); }

  /** A session whose end runs shows its `ending` item, whatever its own state says meanwhile. */
  item(s: SessionRow): InboxItem { return this.ending.get(s.id) ?? this.build(s).item; }

  /** Settle by hand (`manual`), by the idle rule (`idle`) or a merged PR (`merged`); ends a snooze. The session ends
   *  SETTLE_END_GRACE_MS later unless unsettled before. `confirmed`: the owner said yes to ending it even busy. */
  settle(sessionId: string, reason: SettleReason, o: { confirmed?: boolean } = {}): void {
    const now = this.now();
    this.holds.delete(sessionId);
    if (o.confirmed) this.confirmed.add(sessionId); else this.confirmed.delete(sessionId);
    putSessionAttention(this.d.db, { session_id: sessionId, settled_at: now, settled_reason: reason, snooze_until: null, snooze_kind: null, updated_at: now, end_at: now + SETTLE_END_GRACE_MS, end_error: null });
    this.armEnd(sessionId, now + SETTLE_END_GRACE_MS, reason);
    this.changedSafe(sessionId);
  }

  /** At startup: the settles whose end was pending when devd went down end when their time comes (at once if past). */
  armEnds(): void {
    for (const p of pendingEnds(this.d.db)) this.armEnd(p.session_id, p.end_at, p.settled_reason, p.end_started_at === null ? "resumed" : "started");
  }

  /** `resumed`: armed at startup, when hooks devd missed while down may have left the state unknown; `started`: its
   *  end had started running when devd went down, so it goes on (end() is safe to run again: a missing container,
   *  worktree or archive is skipped). */
  private armEnd(sessionId: string, at: number, reason: SettleReason, resumed: "no" | "resumed" | "started" = "no") {
    this.cancelEnd(sessionId);
    this.endTimers.set(sessionId, this.timers.set(() => {
      this.endTimers.delete(sessionId);
      void this.runEnd(sessionId, reason, resumed);
    }, Math.max(0, at - this.now())));
  }

  /** Sessions whose end is pending (grace) or runs: the auto rule's per-tick cap counts them. */
  private endsInFlight(): number { return this.endTimers.size + this.ending.size; }

  /** Whether the session's end runs now (it cannot be taken back). */
  isEnding(sessionId: string): boolean { return this.ending.has(sessionId); }

  /** The session's own attention, before the settled or snoozed shelf: what its agent does now. */
  liveAttention(s: SessionRow) { return this.base(s).item.attention; }

  private cancelEnd(sessionId: string) {
    const t = this.endTimers.get(sessionId);
    if (t !== undefined) { this.timers.clear(t); this.endTimers.delete(sessionId); }
  }

  private async runEnd(sessionId: string, reason: SettleReason, resumed: "no" | "resumed" | "started") {
    const s = this.d.session(sessionId);
    if (s && reason !== "manual" && resumed !== "started") {
      // An automatic settle (the idle rule checked before it, a merged PR did not) never ends a session with work
      // nobody committed: it stays alive, its row says why.
      const hold = await this.autoEndHold(s);
      if (hold !== null) {
        const row = getSessionAttention(this.d.db, sessionId);
        if (row) putSessionAttention(this.d.db, { ...row, settled_at: null, settled_reason: null, end_at: null, end_started_at: null, updated_at: this.now() });
        this.changedSafe(sessionId);
        return;
      }
    }
    // Re-read at the last moment: the awaits above let a run, an unsettle or a snooze in, and after a restart hooks
    // devd missed while down may mean the agent works now.
    if (s) {
      const row = getSessionAttention(this.d.db, sessionId);
      if (!row || row.end_at === null || row.settled_at === null) return; // taken back meanwhile
      const why = resumed === "started" ? null : this.endBlock(s, resumed === "resumed");
      if (why !== null) {
        this.log(`inbox: ${sessionId} was due to end but is not ended: ${why}; it is back in the inbox`);
        putSessionAttention(this.d.db, { ...row, settled_at: null, settled_reason: null, end_at: null, end_started_at: null, updated_at: this.now() });
        this.confirmed.delete(sessionId);
        this.changedSafe(sessionId);
        return;
      }
      if (reason !== "manual") this.log(`inbox: auto end of ${sessionId} (settled: ${reason})`);
      if (row.end_started_at == null) putSessionAttention(this.d.db, { ...row, end_started_at: this.now() });
    }
    this.confirmed.delete(sessionId);
    if (s) {
      const shown = this.build(s).item;
      this.ending.set(sessionId, { ...shown, attention: { ...shown.attention, section: "settled", reason: null }, endsAt: null, endError: null, ending: true, autoEndHold: null });
      this.changedSafe(sessionId);
    }
    try {
      await this.d.end(sessionId, reason);
      this.ending.delete(sessionId);
    } catch (e) {
      this.ending.delete(sessionId);
      const msg = (e as Error).message;
      this.log(`inbox: ending ${sessionId} after its settle failed, it is back in the inbox: ${msg}`);
      const row = getSessionAttention(this.d.db, sessionId);
      // The session is gone after all (ended meanwhile, its row deleted with it): nothing to bring back.
      if (row) putSessionAttention(this.d.db, { ...row, settled_at: null, settled_reason: null, end_at: null, end_started_at: null, end_error: msg, updated_at: this.now() });
    }
    this.changedSafe(sessionId);
  }

  /** Why a pending end must not go ahead now, or null: the agent works or waits (unless the owner confirmed that),
   *  or, `resumed` after a restart, a tmux session's state is unknown. */
  private endBlock(s: SessionRow, resumed: boolean): string | null {
    const a = this.base(s).item.attention;
    if ((a.section === "working" || a.reason === "request") && !this.confirmed.has(s.id)) {
      return a.reason === "request" ? "the agent waits for an answer" : "the agent works";
    }
    if (resumed && storedRuntime(s) === "tmux") {
      const live = this.d.tmuxLive(s.id);
      if (live === null || live.status === "unknown") return "its state is unknown after a devd restart";
    }
    return null;
  }

  /** Why the auto rule must not end `s` now (AUTO_END_HOLDS), or null. Logged when it changes, not every tick. */
  private async autoEndHold(s: SessionRow): Promise<string | null> {
    const changes = await this.d.worktreeChanges(s);
    const hold = changes === null ? AUTO_END_HOLDS.unknown : changes.length > 0 ? AUTO_END_HOLDS.dirty : null;
    this.setHold(s.id, hold, changes === null ? "its worktree state could not be read" : `${changes.length} uncommitted change(s) in ${s.worktree}`);
    return hold;
  }

  private setHold(sessionId: string, hold: string | null, why = "") {
    if ((this.holds.get(sessionId) ?? null) === hold) return;
    if (hold === null) this.holds.delete(sessionId); else this.holds.set(sessionId, hold);
    if (hold !== null) this.log(`inbox: ${sessionId} is due to settle and end, but stays: ${why}`);
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

  /** Back into the inbox: ends a settle and a snooze. False while the end runs: it cannot be taken back, and end_at
   *  stays so a restart resumes it. */
  unsettle(sessionId: string): boolean {
    if (this.ending.has(sessionId)) return false;
    const now = this.now();
    this.cancelEnd(sessionId);
    this.holds.delete(sessionId);
    this.confirmed.delete(sessionId);
    putSessionAttention(this.d.db, { session_id: sessionId, settled_at: null, settled_reason: null, snooze_until: null, snooze_kind: null, updated_at: now, end_at: null, end_error: null });
    this.changedSafe(sessionId);
    return true;
  }

  /** Snooze until `until` (epoch ms); ends a settle. False while the end runs (see unsettle). */
  snooze(sessionId: string, until: number, kind: SnoozeKind): boolean {
    if (this.ending.has(sessionId)) return false;
    this.cancelEnd(sessionId);
    this.confirmed.delete(sessionId);
    putSessionAttention(this.d.db, { session_id: sessionId, settled_at: null, settled_reason: null, snooze_until: until, snooze_kind: kind, updated_at: this.now(), end_at: null, end_error: null });
    this.changedSafe(sessionId);
    return true;
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
    if (this.ending.has(sessionId)) return; // the end runs: its row must keep end_at for a restart
    const row = getSessionAttention(this.d.db, sessionId);
    if (!row) return;
    const wake = kind !== "run" && row.snooze_until !== null;
    if (row.settled_at === null && !wake) return;
    if (row.settled_at !== null) this.cancelEnd(sessionId);
    this.holds.delete(sessionId);
    putSessionAttention(this.d.db, {
      ...row, settled_at: null, settled_reason: null, end_at: null, end_started_at: null,
      ...(wake ? { snooze_until: null, snooze_kind: null } : {}), updated_at: this.now(),
    });
    this.changedSafe(sessionId);
  }

  /** At startup: a snooze set before a devd restart still ends with an inbox update. Publishing arms its timer. */
  armSnoozes(): void {
    for (const id of snoozedSessionIds(this.d.db, this.now())) this.changedSafe(id);
  }

  /** The idle rule (index.ts runs it every AUTO_SETTLE_TICK_MS): settles, and so ends, the sessions that are due, at
   *  most AUTO_END_PER_TICK in flight (an end is heavy: a backup, a container removal). A due session with
   *  uncommitted changes, or whose worktree cannot be read, stays (autoEndHold). Returns the settled ids. */
  async autoSettle(): Promise<string[]> {
    const now = this.now();
    const settled: string[] = [];
    for (const s of this.d.sessions()) {
      const live = storedRuntime(s) === "tmux" ? this.d.tmuxLive(s.id) : null;
      const stateKnown = storedRuntime(s) === "chat" || (live !== null && live.status !== "unknown");
      const look = { seenAt: getSeenAt(this.d.db, s.id), stateKnown };
      if (!autoSettleDue(this.base(s).item.attention, s, getSessionAttention(this.d.db, s.id), look, now)) {
        // Its clock restarted (a look, a merged PR's settle taken back): a hold still says why while it is true.
        if (this.holds.has(s.id)) await this.autoEndHold(s);
        continue;
      }
      if (await this.autoEndHold(s) !== null) continue;
      // Ends still in their grace or running count too: each backs up and removes a container.
      if (this.endsInFlight() >= AUTO_END_PER_TICK) continue;
      // The session may have changed (a prompt, a settle by hand, an end) while git ran.
      const again = this.d.session(s.id);
      if (!again || !autoSettleDue(this.base(again).item.attention, again, getSessionAttention(this.d.db, s.id), look, this.now())) continue;
      this.settle(s.id, "idle");
      settled.push(s.id);
    }
    return settled;
  }

  list(): InboxItem[] {
    const live = this.d.sessions().filter((s) => !this.ending.has(s.id)).map((s) => this.item(s));
    return sortInbox([...live, ...this.ending.values()]);
  }

  /** `recheckAt`: when the item changes without an event: the end of a snooze, or of the WORKING_GRACE_MS a chat
   *  run that just ended still counts as working. */
  private build(s: SessionRow): { item: InboxItem; recheckAt: number | null } {
    const b = this.base(s);
    const row = getSessionAttention(this.d.db, s.id);
    const now = this.now();
    const attention = shelve(b.item.attention, row, now);
    const snoozeEnd = attention.until ?? null;
    const recheckAt = b.recheckAt === null ? snoozeEnd : snoozeEnd === null ? b.recheckAt : Math.min(b.recheckAt, snoozeEnd);
    return { item: { ...b.item, attention, ...endFields(row), ending: false, autoEndHold: this.holds.get(s.id) ?? null }, recheckAt };
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
    const ending = this.ending.get(sessionId);
    if (ending) {
      const json = JSON.stringify(ending);
      if (this.lastPublished.get(sessionId) === json) return;
      this.lastPublished.set(sessionId, json);
      this.d.bus.publish("inbox", ending);
      return;
    }
    if (!s) {
      this.holds.delete(sessionId);
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
