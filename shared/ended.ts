/** How `POST /api/ended/:id/continue` starts the new session: `resume` continues the ended session's own native
 *  conversation, `handoff` starts a new one whose first message carries a summary and the transcript's path. */
export type ContinueMode = "resume" | "handoff";

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
}
