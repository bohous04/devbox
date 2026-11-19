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
};

export const reasonLabel = (r: Attention["reason"]): string => (r === null ? "" : REASON[r]);
