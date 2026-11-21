import type { ThreadSnapshot } from "./thread";

/** Why a message cannot go into the tmux pane right now (`POST /api/sessions/:id/mirror/messages` answers 409 with it,
 *  and `MirrorInfo.sendBlock` names it ahead of time when devd already knows). Clients show it as the composer's lock
 *  reason, next to Open terminal. */
export type MirrorSendError =
  | "agent-not-running" | "agent-waiting-in-terminal" | "terminal-has-draft" | "terminal-not-ready" | "terminal-scrolled"
  | "conversation-unknown" | "unsupported-agent" | "unsupported-host" | "pane-changed";

/** What the mirror of a tmux session's `main` pane knows (devd/src/transcriptMirror.ts).
 *  - `live`: the pane runs Claude Code and its transcript is being read;
 *  - `agent-exited`: the pane is there, but no agent runs in it (a shell);
 *  - `no-pane`: no `main` pane (stopped container, killed tmux session);
 *  - `unresolved`: Claude runs, but devd could not tell which conversation it is on;
 *  - `unsupported`: another agent (Codex, Grok, …) or an InstaBox session: no mirror yet. */
export interface MirrorInfo {
  state: "live" | "agent-exited" | "no-pane" | "unresolved" | "unsupported";
  /** The pane agent's label ("Claude Code", "Codex"); null when none runs. */
  agent: string | null;
  /** Claude's session id the mirror reads; null when none. */
  conversationId: string | null;
  /** What Claude reports in its session file; null when unknown. */
  activity: "idle" | "busy" | "waiting" | null;
  /** The agent waits for an answer only the terminal can give (a permission prompt, a question). */
  terminalPrompt: { text: string } | null;
  /** Why sending would be refused now; null = devd knows no reason (the send itself still checks the screen). */
  sendBlock: { code: MirrorSendError; message: string } | null;
}

/** `GET /api/sessions/:id/mirror`. The snapshot has the chat thread's shape, so clients render it unchanged. */
export interface MirrorResponse {
  snapshot: ThreadSnapshot;
  mirror: MirrorInfo;
}
