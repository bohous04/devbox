import type { ContinueMode, EndedRemoved, EndedSession } from "../../shared/ended";
import type { InboxItem } from "../../shared/thread";
import { sessionTitle } from "./inboxView";

/** An SSE `inbox-ended` event: a transcript that was just kept replaces its row, a hidden or purged one leaves. */
export function upsertEnded(list: EndedSession[], next: EndedSession | EndedRemoved): EndedSession[] {
  if ("removed" in next) return list.filter((e) => e.id !== next.id);
  const idx = list.findIndex((e) => e.id === next.id);
  if (idx < 0) return [...list, next];
  const out = [...list];
  out[idx] = next;
  return out;
}

export type SettledRow = { kind: "session"; item: InboxItem } | { kind: "ended"; ended: EndedSession };

/** The Settled shelf: settled sessions and ended transcripts together, newest first. */
export function settledShelf(settled: InboxItem[], ended: EndedSession[]): SettledRow[] {
  const at = (r: SettledRow) => (r.kind === "session" ? r.item.attention.since : r.ended.endedAt);
  return [...settled.map((item): SettledRow => ({ kind: "session", item })), ...ended.map((e): SettledRow => ({ kind: "ended", ended: e }))]
    .sort((a, b) => at(b) - at(a));
}

/** The transcript page's one button: it says what POST /api/ended/:id/continue will do. */
export function continueLabel(mode: ContinueMode): string {
  return mode === "resume" ? "Continue in a new session (resume)" : "Start a new session with this chat (handoff)";
}

export function endedTitle(e: EndedSession): string {
  return sessionTitle({ sessionId: e.sessionId, name: e.title === `${e.project}/${e.repo}` ? null : e.title, project: e.project, repo: e.repo, topic: e.topic });
}

export function endedSecondLine(e: EndedSession): string {
  return [`${e.project}/${e.repo}`, e.branch].filter(Boolean).join(" · ");
}

export const endedHref = (e: Pick<EndedSession, "id">) => `/ended/${encodeURIComponent(e.id)}`;

/** A transcript image (its `/inbox/<session>/<name>` path) from the ended session's archive. */
export function endedAttachmentUrl(endedId: string, path: string): string {
  return `/api/ended/${encodeURIComponent(endedId)}/attachments/${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
}
