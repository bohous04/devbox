import type { ThreadSnapshot } from "./thread";

/** Why a message cannot go into the tmux pane right now (`POST /api/sessions/:id/mirror/messages` answers 409 with it,
 *  and `MirrorInfo.sendBlock` names it ahead of time when devd already knows). Clients show it as the composer's lock
 *  reason, next to Open terminal. */
export type MirrorSendError =
  | "agent-not-running" | "agent-waiting-in-terminal" | "codex-send-unsupported" | "terminal-has-draft" | "terminal-not-ready" | "terminal-scrolled"
  | "conversation-unknown" | "unsupported-agent" | "unsupported-host" | "pane-changed" | "not-submitted";

/** What the mirror of a tmux session's `main` pane knows (devd/src/transcriptMirror.ts).
 *  - `live`: the pane runs Claude Code or Codex and its transcript (Codex: rollout) is being read;
 *  - `agent-exited`: the pane is there, but no agent runs in it (a shell);
 *  - `no-pane`: no `main` pane (stopped container, killed tmux session);
 *  - `unresolved`: Claude or Codex runs, but devd could not tell which conversation it is on (Codex: until a hook
 *    event of it names one);
 *  - `unsupported`: another agent (Grok, Antigravity, …) or an InstaBox session: no mirror yet. */
export interface MirrorInfo {
  state: "live" | "agent-exited" | "no-pane" | "unresolved" | "unsupported";
  /** The pane agent's label ("Claude Code", "Codex"); null when none runs. */
  agent: string | null;
  /** Claude's session id or the Codex thread id the mirror reads; null when none. */
  conversationId: string | null;
  /** Claude: what it reports in its session file. Codex: `waiting` from its hook events, else `busy` while the
   *  rollout's turn runs. null when unknown. */
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
