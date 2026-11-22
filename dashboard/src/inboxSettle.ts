import type { InboxItem } from "../../shared/thread";
import { asks, rowTitle, shelfBlock } from "./inboxView";

/** Settling from the inbox in one gesture (the row's ✓, ⌘⇧S), the "Settled · ⌘Z to undo" notice that follows it, and
 *  the tmux seen marker: the web's MacSettler (ios/DevboxMac/MacSettle.swift), same rules. Failures are kept in
 *  `problem` for the page to show until dismissed, never dropped. */

type Keys = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

/** The platform's command key alone among the modifiers named here: ⌘ on a Mac, Ctrl elsewhere. */
const commandOnly = (e: Keys, mac: boolean, shift: boolean) =>
  (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && e.shiftKey === shift && !e.altKey;

/** ⌘⇧S (Ctrl+Shift+S off a Mac): settle the focused row, as in T3 Code. */
export const settleShortcut = (e: Keys, mac: boolean): boolean => commandOnly(e, mac, true) && e.key.toLowerCase() === "s";

/** ⌘Z undoes the last settle while its notice shows, unless the focus has an undo of its own (a text field). */
export const claimsUndo = (e: Keys, mac: boolean, s: { noticeShown: boolean; focusOwnsUndo: boolean }): boolean =>
  s.noticeShown && !s.focusOwnsUndo && commandOnly(e, mac, false) && e.key.toLowerCase() === "z";

const NOT_TEXT = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"]);

/** Whether the focused element undoes typing itself on ⌘Z. */
export function focusOwnsUndo(el: { tagName: string; isContentEditable: boolean; type?: string } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NOT_TEXT.has((el.type ?? "text").toLowerCase());
}

/** A tmux session's finish or failure clears once the owner has looked at it (POST /seen). A chat session marks its
 *  thread seen itself (SessionPage), and waiting, working or idle sessions have nothing to clear. */
export const wantsSeen = (i: InboxItem | undefined): i is InboxItem =>
  i !== undefined && i.runtime === "tmux" && i.attention.section === "needs_you" && i.attention.reason !== "request";

/** Whether marking a row seen moves it in the list: a failure pinned on top drops into the newest-first part, while a
 *  finish keeps its time there (devd keeps `since`) and stays put. Such a row is marked when it is left instead. */
export const seenMoves = (i: InboxItem): boolean => asks(i);

export interface SettleState {
  /** The last settle, while it can be undone. `id` tells one settle's notice from the next. */
  notice: { sessionId: string; title: string; id: number } | null;
  /** The last settle, undo or seen that failed, with why. */
  problem: string | null;
}

interface SettleApi {
  settle: (id: string) => Promise<InboxItem>;
  unsettle: (id: string) => Promise<InboxItem>;
  seen: (id: string) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error && e.message) || "request failed";

export class Settler {
  state: SettleState = { notice: null, problem: null };
  private listeners = new Set<() => void>();
  private nextId = 1;
  /** Seen posts per finish ("id@since"): a failed one is tried once more, a done one never again. */
  private seenAttempts = new Map<string, number>();
  /** The finish whose failure `problem` shows, and the finishes whose failure the owner dismissed. */
  private problemSeenKey: string | null = null;
  private dismissedSeen = new Set<string>();
  /** Finishes with a post on its way: the window's focus and visibility events arrive together. */
  private seenInFlight = new Set<string>();

  constructor(private api: SettleApi) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private set(next: Partial<SettleState>, seenKey: string | null = null) {
    if ("problem" in next) this.problemSeenKey = seenKey;
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn();
  }

  /** Settles the row and shows the notice; the session's new item, or null when it was refused (the reason shown). */
  async settle(item: InboxItem): Promise<InboxItem | null> {
    const title = rowTitle(item);
    const block = shelfBlock(item);
    if (block) { this.set({ problem: `Couldn't settle “${title}”: ${block}` }); return null; }
    let next: InboxItem;
    try { next = await this.api.settle(item.sessionId); }
    catch (e) { this.set({ problem: `Couldn't settle “${title}”: ${message(e)}` }); return null; }
    this.set({ notice: { sessionId: item.sessionId, title, id: this.nextId++ } });
    return next;
  }

  /** Unsettles the notice's session; null when there is nothing to undo or the undo failed (shown). */
  async undo(): Promise<InboxItem | null> {
    const undone = this.state.notice;
    if (!undone) return null;
    this.set({ notice: null });
    try { return await this.api.unsettle(undone.sessionId); }
    catch (e) { this.set({ problem: `Couldn't undo the settle of “${undone.title}”: ${message(e)}` }); return null; }
  }

  /** The notice's time is up; a later settle's notice stays. */
  expire(id: number) {
    if (this.state.notice?.id === id) this.set({ notice: null });
  }

  /** A failure around the settle or seen flow that happened outside these methods (the inbox could not be read). */
  report(problem: string) {
    this.set({ problem });
  }

  dismiss() {
    if (this.problemSeenKey) this.dismissedSeen.add(this.problemSeenKey);
    this.set({ problem: null });
  }

  /** Marks a finished or failed tmux session seen: once per finish, a failed post tried once more (on the next
   *  look). A failure the owner dismissed is not raised again. */
  async seen(item: InboxItem | undefined): Promise<"posted" | "skipped" | "failed"> {
    if (!wantsSeen(item)) return "skipped";
    const key = `${item.sessionId}@${item.attention.since}`;
    const attempts = this.seenAttempts.get(key) ?? 0;
    if (attempts >= 2 || this.seenInFlight.has(key)) return "skipped";
    this.seenAttempts.set(key, attempts + 1);
    this.seenInFlight.add(key);
    try {
      await this.api.seen(item.sessionId);
    } catch (e) {
      if (!this.dismissedSeen.has(key)) this.set({ problem: `Couldn't mark “${rowTitle(item)}” seen: ${message(e)}` }, key);
      return "failed";
    } finally {
      this.seenInFlight.delete(key);
    }
    this.seenAttempts.set(key, 2);
    if (this.problemSeenKey === key) this.set({ problem: null });
    return "posted";
  }
}
