import type { InboxItem, InboxRemoved, InboxSection } from "../../shared/thread";
import type { AgentLiveSnapshot } from "./agentEvents";
import { chatAttention, tmuxAttention, WORKING_GRACE_MS, type LinkState } from "./attention";
import type { SessionRow } from "./db";
import type { EventBus } from "./eventBus";
import { storedRuntime } from "./sessions";
import type { ThreadStore } from "./threadStore";

/** `lastText` is a preview line in the inbox, not the message: longer texts are clipped. */
export const LAST_TEXT_MAX = 200;
export const INBOX_COALESCE_MS = 250;

const SECTION_ORDER: Record<InboxSection, number> = { needs_you: 0, working: 1, idle: 2 };

/** needs_you oldest first (the longest wait on top), working and idle newest first. */
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
  private rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last logged store error per session, so a broken store is logged once per message, not per inbox read. */
  private brokenLogged = new Map<string, string>();
  private coalesceMs: number;
  private log: (msg: string) => void;

  constructor(private d: {
    /** Sessions the inbox lists (index.ts leaves out ending ones: their store is being archived). */
    sessions: () => SessionRow[];
    /** null for a session that is gone or ending. */
    session: (id: string) => SessionRow | null;
    threads: (id: string) => ThreadStore;
    chatLink: (id: string) => LinkState | null;
    tmuxLive: (id: string) => AgentLiveSnapshot | null;
    bus: EventBus;
    now?: () => number;
    coalesceMs?: number;
    log?: (msg: string) => void;
  }) {
    this.coalesceMs = d.coalesceMs ?? INBOX_COALESCE_MS;
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  private now() { return this.d.now?.() ?? Date.now(); }

  item(s: SessionRow): InboxItem { return this.build(s).item; }

  list(): InboxItem[] { return sortInbox(this.d.sessions().map((s) => this.item(s))); }

  /** `recheckAt`: a chat run that just ended counts as working for WORKING_GRACE_MS; no event marks the end
   *  of that window, so the item has to be rebuilt then. */
  private build(s: SessionRow): { item: InboxItem; recheckAt: number | null } {
    const runtime = storedRuntime(s);
    // `agent` is optional in SessionRow only for insert literals; the column is NOT NULL.
    const base = { sessionId: s.id, runtime, title: s.name || `${s.project}/${s.repo}`, project: s.project, repo: s.repo, agent: s.agent! };
    if (runtime === "tmux") {
      return { item: { ...base, attention: tmuxAttention(this.d.tmuxLive(s.id)), lastText: null }, recheckAt: null };
    }
    try { return this.buildChat(s, base); }
    catch (e) {
      // One broken store must not take the whole inbox down; the session shows up as needing the user.
      const msg = (e as Error).message;
      if (this.brokenLogged.get(s.id) !== msg) {
        this.brokenLogged.set(s.id, msg);
        this.log(`inbox: thread store of ${s.id} unreadable: ${msg}`);
      }
      return {
        item: { ...base, attention: { section: "needs_you", reason: "failed", since: this.now() }, lastText: `thread store unreadable: ${msg}` },
        recheckAt: null,
      };
    }
  }

  private buildChat(s: SessionRow, base: Omit<InboxItem, "attention" | "lastText">): { item: InboxItem; recheckAt: number | null } {
    const store = this.d.threads(s.id);
    const t = store.snapshot({ limit: 0 }); // attention reads runs, pending and background only
    const now = this.now();
    const attention = chatAttention(t, this.d.chatLink(s.id), now);
    const text = store.lastMessageText();
    const last = t.runs.at(-1);
    const graceEnd = last && last.endedAt !== null ? last.endedAt + WORKING_GRACE_MS : null;
    return {
      item: { ...base, attention, lastText: text === null ? null : clip(text) },
      recheckAt: graceEnd !== null && graceEnd > now ? graceEnd : null,
    };
  }

  changed(sessionId: string): void {
    const w = this.windows.get(sessionId);
    if (w) { w.dirty = true; return; }
    const win = { dirty: false };
    this.windows.set(sessionId, win);
    setTimeout(() => {
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
      const removed: InboxRemoved = { sessionId, removed: true };
      this.d.bus.publish("inbox", removed);
      return;
    }
    const { item, recheckAt } = this.build(s);
    const old = this.rechecks.get(sessionId);
    if (old) { clearTimeout(old); this.rechecks.delete(sessionId); }
    if (recheckAt !== null) {
      this.rechecks.set(sessionId, setTimeout(() => {
        this.rechecks.delete(sessionId);
        this.changedSafe(sessionId);
      }, recheckAt - this.now() + 1));
    }
    const json = JSON.stringify(item);
    if (this.lastPublished.get(sessionId) === json) return;
    this.lastPublished.set(sessionId, json);
    this.d.bus.publish("inbox", item);
  }
}
