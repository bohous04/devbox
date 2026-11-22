import type { InboxItem } from "../../shared/thread";
import { asks, rowTitle, shelfBlock } from "./inboxView";

/** Settling from the inbox in one gesture (the row's ✓, E, ⌘⇧S), the "Settled · ⌘Z to undo" notice that follows it, and
 *  the tmux seen marker: the web's MacSettler (ios/DevboxMac/MacSettle.swift), same rules. Failures are kept in
 *  `problem` for the page to show until dismissed, never dropped. */

type Keys = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

/** The platform's command key alone among the modifiers named here: ⌘ on a Mac, Ctrl elsewhere. */
const commandOnly = (e: Keys, mac: boolean, shift: boolean) =>
  (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && e.shiftKey === shift && !e.altKey;

/** ⌘⇧S (Ctrl+Shift+S off a Mac): settle the focused row, as in T3 Code. Some browsers keep that chord for themselves
 *  (Firefox's screenshot, Edge's web capture), so `settleKey` is the one that always reaches the page. */
export const settleShortcut = (e: Keys, mac: boolean): boolean => commandOnly(e, mac, true) && e.key.toLowerCase() === "s";

/** E on a focused row settles it, as Gmail's archive: no browser claims a bare letter. Not from a text field. */
export const settleKey = (e: Keys & { repeat?: boolean }, focusOwnsKeys: boolean): boolean =>
  !focusOwnsKeys && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e";

/** ⌘Z undoes the last settle while its notice shows, unless the focus has an undo of its own (a text field). */
export const claimsUndo = (e: Keys, mac: boolean, s: { noticeShown: boolean; focusOwnsUndo: boolean }): boolean =>
  s.noticeShown && !s.focusOwnsUndo && commandOnly(e, mac, false) && e.key.toLowerCase() === "z";

const NOT_TEXT = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"]);

/** Whether the focused element takes typing (and undoes it itself on ⌘Z). */
export function focusOwnsUndo(el: { tagName: string; isContentEditable: boolean; type?: string } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NOT_TEXT.has((el.type ?? "text").toLowerCase());
}

/** A tmux session's finish or failure clears once the owner has looked at it (POST /seen): devd clears `done` and
 *  `failed` only (attention.ts tmuxAttention). A chat session marks its thread seen itself (SessionPage); an open
 *  request, a PR's CI and everything else stay whatever seen says. */
export const wantsSeen = (i: InboxItem | undefined): i is InboxItem =>
  i !== undefined && i.runtime === "tmux" && i.attention.section === "needs_you"
  && (i.attention.reason === "completed" || i.attention.reason === "failed");

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

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** Why a request failed, with its HTTP status when the error carries one (api.ts ApiError) and its text does not
 *  already say it. */
export function failureText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const text = e.message || e.name;
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && !text.includes(String(status)) ? `${text} (HTTP ${status})` : text;
}

export class Settler {
  state: SettleState = { notice: null, problem: null };
  private listeners = new Set<() => void>();
  private nextId = 1;
  /** The notice's timer (MacSettler's lifetime): it runs whatever page is open, so a notice never outlives it and
   *  comes back stale. Held (no timer) while the pointer or the keyboard is on the notice. */
  private timer: unknown = null;
  private held = false;
  /** Seen posts per finish ("id@since"): a failed one is tried once more, a done one never again. */
  private seenAttempts = new Map<string, number>();
  /** The failure `problem` shows when it is about seen, and the ones the owner dismissed (not raised again). */
  private problemSeenKey: string | null = null;
  private dismissedSeen = new Set<string>();
  /** Finishes with a post on its way: the window's focus and visibility events arrive together. */
  private seenInFlight = new Set<string>();

  constructor(private api: SettleApi, private lifetime = 5_000, private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private set(next: Partial<SettleState>, seenKey: string | null = null) {
    if ("problem" in next) this.problemSeenKey = seenKey;
    // A new notice (or none) starts unheld: the pointer that rested on the last one is not on this one.
    if ("notice" in next) { this.held = false; this.arm(next.notice?.id ?? null); }
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn();
  }

  private arm(id: number | null) {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (id === null || this.held) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.state.notice?.id === id) this.set({ notice: null });
    }, this.lifetime);
  }

  /** The pointer or the keyboard is on the notice (true) or left it (false: a full lifetime from now). */
  hold(on: boolean) {
    if (this.held === on) return;
    this.held = on;
    this.arm(this.state.notice?.id ?? null);
  }

  /** Settles the row and shows the notice; the session's new item, or null when it was refused (the reason shown). */
  async settle(item: InboxItem): Promise<InboxItem | null> {
    const title = rowTitle(item);
    const block = shelfBlock(item);
    if (block) { this.set({ problem: `Couldn't settle “${title}”: ${block}` }); return null; }
    let next: InboxItem;
    try { next = await this.api.settle(item.sessionId); }
    catch (e) { this.set({ problem: `Couldn't settle “${title}”: ${failureText(e)}` }); return null; }
    this.set({ notice: { sessionId: item.sessionId, title, id: this.nextId++ } });
    return next;
  }

  /** Unsettles the notice's session; null when there is nothing to undo or the undo failed (shown). */
  async undo(): Promise<InboxItem | null> {
    const undone = this.state.notice;
    if (!undone) return null;
    this.set({ notice: null });
    try { return await this.api.unsettle(undone.sessionId); }
    catch (e) { this.set({ problem: `Couldn't undo the settle of “${undone.title}”: ${failureText(e)}` }); return null; }
  }

  /** A seen failure outside `seen` (the inbox could not be read), under `key` so a dismissal holds for it too. */
  report(problem: string, key: string) {
    if (!this.dismissedSeen.has(key)) this.set({ problem }, key);
  }

  /** What `key` was about worked now: its failure goes, and a later one is shown again. */
  cleared(key: string) {
    this.dismissedSeen.delete(key);
    if (this.problemSeenKey === key) this.set({ problem: null });
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
      this.report(`Couldn't mark “${rowTitle(item)}” seen: ${failureText(e)}`, key);
      return "failed";
    } finally {
      this.seenInFlight.delete(key);
    }
    this.seenAttempts.set(key, 2);
    this.cleared(key);
    return "posted";
  }
}

/** How soon a focus or visibility change looks at the inbox again: the two arrive together, and a window switched
 *  back and forth should not refetch the whole inbox each time. Opening and leaving always look. */
export const FOCUS_LOOK_GAP_MS = 5_000;

interface WatchDeps {
  items: () => Promise<InboxItem[]>;
  settler: Pick<Settler, "seen" | "report" | "cleared">;
  visible: () => boolean;
  now: () => number;
  /** Runs `fn` after the current task; returns a cancel. */
  defer: (fn: () => void) => () => void;
}

/** When an open tmux session is looked at (useTmuxSeen): opening it, coming back to the window, leaving it; each only
 *  while the page is visible. A failure is marked on leaving only (seenMoves). Leaving waits a task, so React's
 *  StrictMode unmount-and-remount of the first mount is not a leave and does not mark a failure seen. */
export class SeenWatch {
  private pendingLeave = new Map<string, () => void>();
  private lastLook = new Map<string, number>();
  private focusLook = new Map<string, Promise<void>>();

  constructor(private d: WatchDeps) {}

  open(id: string): Promise<void> {
    const remount = this.pendingLeave.get(id);
    if (remount) { remount(); this.pendingLeave.delete(id); return Promise.resolve(); }
    return this.look(id, true);
  }

  focus(id: string): Promise<void> {
    const running = this.focusLook.get(id);
    if (running) return running;
    if (this.d.now() - (this.lastLook.get(id) ?? -Infinity) < FOCUS_LOOK_GAP_MS) return Promise.resolve();
    const p = this.look(id, true).finally(() => this.focusLook.delete(id));
    this.focusLook.set(id, p);
    return p;
  }

  leave(id: string) {
    this.pendingLeave.set(id, this.d.defer(() => { this.pendingLeave.delete(id); void this.look(id, false); }));
  }

  private async look(id: string, open: boolean): Promise<void> {
    if (!this.d.visible()) return;
    this.lastLook.set(id, this.d.now());
    const key = `${id}@inbox`;
    let items: InboxItem[];
    try { items = await this.d.items(); }
    catch (e) { this.d.settler.report(`Couldn't mark this session seen: could not read the inbox (${failureText(e)})`, key); return; }
    this.d.settler.cleared(key);
    const item = items.find((i) => i.sessionId === id);
    if (!wantsSeen(item) || (open && seenMoves(item))) return;
    await this.d.settler.seen(item);
  }
}
