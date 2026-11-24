/** How `POST /api/ended/:id/continue` starts the new session: `resume` continues the ended session's own native
 *  conversation, `handoff` starts a new one whose first message carries a summary and the transcript's path. */
export type ContinueMode = "resume" | "handoff";

/** How much of the conversation the transcript holds: all of it; what the last read before the end got to (it stopped
 *  short, see devd's TranscriptMirror.finalRefresh); or nothing (a tmux session whose Chat view was never read). */
export type TranscriptState = "complete" | "truncated" | "missing";

/** A session that ended and left its transcript behind (`GET /api/ended`, SSE `inbox-ended`). It lives in the inbox's
 *  Settled section only, read-only, until it is hidden or purged (30 days after it ended). */
export interface EndedSession {
  /** The transcript's id: the session id and the time it ended (session ids are reused, this one is not). */
  id: string;
  sessionId: string;
  runtime: "tmux" | "chat";
  title: string;
  folder: string;
  project: string;
  repo: string;
  agent: string;
  branch: string | null;
  /** A short title from the first user message (shared/threadTitle.ts); null when there is none. */
  topic: string | null;
  lastText: string | null;
  endedAt: number;
  /** What continue will do, so the button can say it. */
  continueMode: ContinueMode;
  transcript: TranscriptState;
  /** Where the session's worktree stayed on disk because it held uncommitted changes (or could not be read) when the
   *  session ended; null when it was removed. Continue does not reuse it (a new session gets its own worktree), so
   *  the transcript view says where that work is. Optional: older devd does not send it. */
  keptWorktree?: string | null;
  /** The kept worktree is no longer on disk (someone removed it since): the view says it was kept, not where it is.
   *  Optional: older devd does not send it. */
  keptWorktreeRemoved?: boolean;
  /** Why the ended tmux Claude session has no conversation to resume: it held several and the one it ended on could
   *  not be confirmed, so none was picked (devd does not guess). null otherwise. Optional: older devd does not send it. */
  threadNote?: string | null;
}

/** SSE `inbox-ended` when a transcript was hidden or purged. */
export interface EndedRemoved {
  id: string;
  removed: true;
}

/** `POST /api/ended/:id/continue`: the new session and how it was started. */
export interface ContinueResult {
  mode: ContinueMode;
  sessionId: string;
  runtime: "tmux" | "chat";
  /** Why a conversation that should have resumed was handed off instead (no jsonl, an image that predates resume);
   *  null when it resumed, or when resume does not exist for its agent. The new session's first message says it too. */
  reason: string | null;
}
