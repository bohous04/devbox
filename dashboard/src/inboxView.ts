import type { Attention, InboxItem } from "../../shared/thread";

/** The inbox's three sections. Ordering mirrors `sortInbox` in devd/src/sessionInbox.ts: needs-you oldest first
 *  (the longest wait on top), working and idle newest first. */
export function groupInbox(items: InboxItem[]): { needsYou: InboxItem[]; working: InboxItem[]; idle: InboxItem[] } {
  const newestFirst = (a: InboxItem, b: InboxItem) => b.attention.since - a.attention.since;
  return {
    needsYou: items.filter((i) => i.attention.section === "needs_you").sort((a, b) => a.attention.since - b.attention.since),
    working: items.filter((i) => i.attention.section === "working").sort(newestFirst),
    idle: items.filter((i) => i.attention.section === "idle").sort(newestFirst),
  };
}

/** An SSE `inbox` event carries one session's current item: it replaces that session's row. */
export function upsertInbox(items: InboxItem[], next: InboxItem): InboxItem[] {
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
  completed: "finished",
  disconnected: "agent not connected",
  "bridge-behind": "bridge log behind — events may be missing",
  running: "running",
  background: "background work",
  queued: "queued",
};

export const reasonLabel = (r: Attention["reason"]): string => (r === null ? "" : REASON[r]);
