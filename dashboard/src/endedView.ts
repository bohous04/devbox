import type { ContinueMode, ContinueResult, EndedRemoved, EndedSession } from "../../shared/ended";
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

/** The transcript page's one button: it says what POST /api/ended/:id/continue will do. A mode this dashboard does not
 *  know (a later devd) gets a label that promises neither. */
export function continueLabel(mode: ContinueMode | (string & {})): string {
  if (mode === "resume") return "Continue in a new session (resume)";
  if (mode === "handoff") return "Start a new session with this chat (handoff)";
  return "Start a new session";
}

/** A request the conversation still had open: in a live thread it waits, in an ended session's transcript it never
 *  will be answered. */
export function openRequestLabel(inTranscript: boolean): string {
  return inTranscript ? "No answer, session ended" : "waiting for an answer";
}

/** What the transcript page says about a transcript that is not whole (EndedSession.transcript); null when it is. */
export function transcriptNote(t: EndedSession["transcript"]): string | null {
  if (t === "truncated") return "The end of this conversation may be missing: the last read before the session ended stopped short.";
  if (t === "missing") return "This session ended without a transcript.";
  return null;
}

/** Continue on the transcript page: a handoff needs the transcript; a resume does not. */
export function canContinue(e: Pick<EndedSession, "transcript" | "continueMode">): boolean {
  return e.transcript !== "missing" || e.continueMode === "resume";
}

const continuing = new Map<string, Promise<ContinueResult>>();
/** One continue per transcript at a time, across page visits: a second press (or the page opened again) joins the
 *  one in flight instead of starting another session. devd refuses a second one too (409). */
export function continueOnce(id: string, start: (id: string) => Promise<ContinueResult>): Promise<ContinueResult> {
  const cur = continuing.get(id);
  if (cur) return cur;
  const p = start(id).finally(() => continuing.delete(id));
  continuing.set(id, p);
  return p;
}
export const continueInFlight = (id: string) => continuing.has(id);

export function endedTitle(e: EndedSession): string {
  return sessionTitle({ sessionId: e.sessionId, name: e.title === `${e.project}/${e.repo}` ? null : e.title, project: e.project, repo: e.repo, topic: e.topic });
}

/** After the project badge, as a session row's (inboxView.ts secondLine): the repo and the branch. */
export function endedSecondLine(e: EndedSession): string {
  return [e.repo, e.branch].filter(Boolean).join(" · ");
}

export const endedHref = (e: Pick<EndedSession, "id">) => `/ended/${encodeURIComponent(e.id)}`;

/** A transcript image (its `/inbox/<session>/<name>` path) from the ended session's archive. */
export function endedAttachmentUrl(endedId: string, path: string): string {
  return `/api/ended/${encodeURIComponent(endedId)}/attachments/${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
}
