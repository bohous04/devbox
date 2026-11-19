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

/** The snooze menu's fixed times: one hour from now, and tomorrow at 9:00 local time. */
export function snoozeTimes(now: Date): { hour: number; tomorrow: number } {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return { hour: now.getTime() + 3_600_000, tomorrow: tomorrow.getTime() };
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
