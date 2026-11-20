import type { Attention, InboxItem, InboxRemoved } from "../../shared/thread";

/** The inbox's sections and its two shelves. Ordering mirrors `sortInbox` in devd/src/sessionInbox.ts: needs-you
 *  oldest first (the longest wait on top), the rest newest first. */
export function groupInbox(items: InboxItem[]): {
  needsYou: InboxItem[]; working: InboxItem[]; idle: InboxItem[]; snoozed: InboxItem[]; settled: InboxItem[];
} {
  const newestFirst = (a: InboxItem, b: InboxItem) => b.attention.since - a.attention.since;
  const of = (section: InboxItem["attention"]["section"]) => items.filter((i) => i.attention.section === section);
  return {
    needsYou: of("needs_you").sort((a, b) => a.attention.since - b.attention.since),
    working: of("working").sort(newestFirst),
    idle: of("idle").sort(newestFirst),
    snoozed: of("snoozed").sort(newestFirst),
    settled: of("settled").sort(newestFirst),
  };
}

/** The snooze menu's fixed times: one hour from now, and the next 9:00 local time (today before 9:00, else tomorrow). */
export function snoozeTimes(now: Date): { hour: number; morning: { at: number; label: string } } {
  const today = now.getHours() < 9;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (today ? 0 : 1), 9, 0).getTime();
  return { hour: now.getTime() + 3_600_000, morning: { at, label: today ? "9:00" : "Tomorrow 9:00" } };
}

/** Why a row cannot be settled or snoozed (devd refuses it with 409 request-open), or null. */
export function shelfBlock(i: InboxItem): string | null {
  return i.attention.reason === "request" ? "Answer the open request first" : null;
}

/** An SSE `inbox` event carries one session's current item: it replaces that session's row. A removal drops it. */
export function upsertInbox(items: InboxItem[], next: InboxItem | InboxRemoved): InboxItem[] {
  if ("removed" in next) return items.filter((i) => i.sessionId !== next.sessionId);
  const idx = items.findIndex((i) => i.sessionId === next.sessionId);
  if (idx < 0) return [...items, next];
  const out = [...items];
  out[idx] = next;
  return out;
}

/** Router path a row opens: chat sessions their session page, tmux sessions the terminal. */
export function inboxHref(i: InboxItem): string {
  const id = encodeURIComponent(i.sessionId);
  return i.runtime === "chat" ? `/s/${id}` : `/terminal/${id}`;
}

const REASON: Record<NonNullable<Attention["reason"]>, string> = {
  request: "waiting for your answer",
  failed: "run failed",
  "rate-limited": "rate limit reached — wait or switch model",
  completed: "finished",
  disconnected: "agent not connected",
  "bridge-behind": "bridge log behind — events may be missing",
  running: "running",
  background: "background work",
  queued: "queued",
  "pr-checks": "waiting for CI checks",
  "ci-failed": "CI failed",
};

export const reasonLabel = (r: Attention["reason"]): string => (r === null ? "" : REASON[r]);

/** "Needs you" holds two different asks: something to act on (an open request, a failure, a lost agent) and a run
 *  that merely finished and has not been seen. The page shows them as separate groups; `completed` is the only
 *  reason that means "finished". */
export function splitNeedsYou(needsYou: InboxItem[]): { action: InboxItem[]; finished: InboxItem[] } {
  return {
    action: needsYou.filter((i) => i.attention.reason !== "completed"),
    // devd sends needs-you oldest first (the longest wait on top); a list of finished runs reads newest first.
    // Re-sorted here only, so devd's order for other clients stays as it is.
    finished: needsYou.filter((i) => i.attention.reason === "completed").sort((a, b) => b.attention.since - a.attention.since),
  };
}

export type StatusTone = "action" | "danger" | "done" | "busy" | "quiet";

const CHIP: Record<NonNullable<Attention["reason"]>, { label: string; tone: StatusTone }> = {
  request: { label: "Needs answer", tone: "action" },
  failed: { label: "Failed", tone: "danger" },
  "rate-limited": { label: "Rate limited", tone: "danger" },
  disconnected: { label: "Disconnected", tone: "danger" },
  "bridge-behind": { label: "Bridge behind", tone: "danger" },
  "ci-failed": { label: "CI failed", tone: "danger" },
  completed: { label: "Done", tone: "done" },
  running: { label: "Working", tone: "busy" },
  background: { label: "Background", tone: "busy" },
  queued: { label: "Queued", tone: "busy" },
  "pr-checks": { label: "CI running", tone: "busy" },
};

/** The short status chip a row shows, or null for a row whose time alone says enough (idle, settled). Snoozed rows
 *  say so; the page adds the time the snooze ends. */
export function rowStatus(i: InboxItem): { label: string; tone: StatusTone } | null {
  const { section, reason } = i.attention;
  if (section === "snoozed") return { label: "Snoozed", tone: "quiet" };
  if (section === "settled" || reason === null) return null;
  return CHIP[reason];
}

/** The chip for a reason whatever shelf the row is on: the outcome mark of a finished or settled run. */
export const reasonStatus = (r: Attention["reason"]): { label: string; tone: StatusTone } | null => (r === null ? null : CHIP[r]);

/** What a row's meta line says about its state, or null when there is nothing to say (no mark, no time).
 *  `compact` rows (groups whose heading names the state) show only the mark, except a danger mark keeps its label:
 *  a tooltip is the only other place it would be, and touch has none. */
export function statusParts(i: InboxItem, now: number, compact: boolean):
  { mark: { label: string; tone: StatusTone } | null; showLabel: boolean; until: number | null; ago: string } | null {
  const a = i.attention;
  const mark = compact ? reasonStatus(a.reason) : rowStatus(i);
  const ago = a.since > 0 ? shortAgo(now - a.since) : "";
  const until = a.until ?? null;
  if (mark === null && ago === "" && until === null) return null;
  return { mark, showLabel: mark !== null && (!compact || mark.tone === "danger"), until, ago };
}

/** Compact elapsed time for a row: "now", "7m", "3h", "2d". */
export function shortAgo(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** A project's badge: up to two letters from its name's words, and a stable colour slot (0-5) from its name. */
export function projectBadge(project: string): { letters: string; slot: number } {
  const words = project.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of project) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return { letters, slot: h % 6 };
}

/** A message preview as plain text: markdown's code ticks, emphasis and heading marks would show raw in one line.
 *  `__x__` only between spaces or line edges, so names like `__init__.py` stay whole. */
export const plainPreview = (t: string): string => t.replace(/`+/g, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/(?<=^|\s)__(\S(?:.*?\S)?)__(?=$|\s|[,;:!?)])/g, "$1").replace(/^#+\s+/, "").replace(/\s+/g, " ").trim();

/** What a row names the session by. A custom name wins. A session still named after its repo path says nothing its
 *  meta line does not, so it takes its newest message instead, or, with none (tmux), the repo and the session's
 *  number from its id ("harbor_api #14") so sibling sessions of one repo stay apart. `fromMessage` tells the row
 *  not to repeat that message as a preview. */
export function rowTitle(i: InboxItem): { text: string; fromMessage: boolean } {
  if (i.title !== `${i.project}/${i.repo}`) return { text: i.title, fromMessage: false };
  if (i.lastText) return { text: plainPreview(i.lastText), fromMessage: true };
  const n = new RegExp(`-${i.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`).exec(i.sessionId)?.[1];
  return { text: n ? `${i.repo} #${n}` : i.repo, fromMessage: false };
}
