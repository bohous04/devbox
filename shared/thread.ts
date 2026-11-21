import type { BackgroundWork, RequestKind, RunOrigin, TokenUsage } from "../image/agent-bridge/src/events";

export type { BackgroundWork, BridgeEvent, Capabilities, LoggedEvent, RequestKind, RunOrigin, TokenUsage } from "../image/agent-bridge/src/events";

export interface ThreadItem {
  seq: number;
  runId: string | null;
  itemId: string | null;
  kind: "user" | "assistant" | "tool" | "request" | "notice";
  text: string;
  tool?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  status?: "streaming" | "done" | "open" | "answered" | "expired";
  /** A user message's images: container paths under `/inbox/<sessionId>/` (devd/src/threadImages.ts). */
  attachments?: string[];
  /** A notice the user has to act on, or data that may be missing (devd sets it): shown raised, not as a faint line.
   *  Absent = a plain notice. */
  tone?: "warn";
  ts: number;
}

export interface RunRow {
  runId: string;
  origin: RunOrigin;
  status: "queued" | "running" | "completed" | "interrupted" | "failed";
  /** null until the bridge has announced its native thread. */
  harness: string | null;
  nativeThreadId: string | null;
  model: string | null;
  /** When `run.queued` arrived; null for runs the bridge started without queueing (agent, continuation). */
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Seq of the terminal event; attention compares it with `seenSeq`. */
  endedSeq: number | null;
  usage: TokenUsage | null;
  error: string | null;
  /** Why a failed run failed, when the bridge says so (`run.failed.reason`); absent otherwise. */
  failureReason?: "rate-limited";
}

/** What `request.opened` carries, plus when it opened. */
export interface PendingRequest {
  requestId: string;
  runId: string;
  kind: RequestKind;
  prompt: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  openedAt: number;
}

export interface ThreadSnapshot {
  lastSeq: number;
  seenSeq: number;
  runs: RunRow[];
  items: ThreadItem[];
  pending: PendingRequest[];
  background: BackgroundWork[];
  native: { harness: string; nativeThreadId: string; account: string | null; model: string | null } | null;
  /** The agent's reasoning effort from the bridge's latest `effort.state` (bridge 1.7.0+); null before one. */
  effort: ThreadEffort | null;
}

/** `supported`: the levels the current model takes ([] = none, null = not known yet); `effective`: the level the agent
 *  runs at, null when it is not known (Claude's model default, before its first reply); `chosen`: the user's pick, null =
 *  the model default. `unchecked` (bridge 1.8.0, only while `supported` is null): levels the agent takes before it
 *  names its model, checked against that model's list on the next message (with `model` named, that list could not
 *  check them); absent = none. */
export interface ThreadEffort { model: string | null; supported: string[] | null; effective: string | null; chosen: string | null; unchecked?: string[] }

/** devd's connection to a chat session's agent bridge socket. */
export type LinkStatus = "connecting" | "connected" | "disconnected";

/** `settled` and `snoozed` are shelves the user (or the 7-day idle rule) put a session on; `reason` and `since` stay
 *  those of the state underneath (devd/src/sessionAttention.ts). */
export type InboxSection = "needs_you" | "working" | "idle" | "settled" | "snoozed";
/** Where a session belongs in the inbox and why; `since` is when that state began (0 = nothing happened yet). */
export interface Attention {
  section: InboxSection;
  /** `pr-checks`: the session's open PR waits for its CI checks; `ci-failed`: they failed (devd/src/prWatch.ts). */
  reason: "request" | "failed" | "rate-limited" | "completed" | "disconnected" | "bridge-behind" | "running" | "background" | "queued"
    | "pr-checks" | "ci-failed" | null;
  since: number;
  /** Snoozed only: when the snooze ends (epoch ms). */
  until?: number;
}

/** SSE `inbox` event for a session that left the inbox (ended, or ending). */
export interface InboxRemoved {
  sessionId: string;
  removed: true;
}

/** One session in the inbox (`GET /api/inbox`, SSE `inbox` events). `lastText` is the newest user or assistant
 *  message of a chat session, clipped for display; null for tmux sessions and empty threads. */
export interface InboxItem {
  sessionId: string;
  runtime: "tmux" | "chat";
  title: string;
  project: string;
  repo: string;
  agent: string;
  /** The branch the session's worktree was created on (devd's record, no git call); null when devd has none
   *  (shared workspace, or a row from before branches were recorded). Optional: older devd does not send it. */
  branch?: string | null;
  attention: Attention;
  lastText: string | null;
  /** A short title from the session's first user message (shared/threadTitle.ts): stable for the thread's life,
   *  unlike lastText. null for tmux sessions, an empty thread, or a first message with nothing that reads as words.
   *  Optional: older devd does not send it. */
  topic?: string | null;
}

/** Bridge housekeeping that once went into threads as notices: a restart (resumed, nothing to act on) and devd's
 *  "older bridge" line, which went stale once the bridge was updated (the target's `bridgeOutdated` says it while it
 *  is true). Stored rows stay; the apps leave them out of what they show (reversible). The Apple apps copy this
 *  rule (ThreadView.isHousekeeping); shared/fixtures/housekeeping-notices.json pins both. */
export function isHousekeepingNotice(i: Pick<ThreadItem, "kind" | "text">): boolean {
  return i.kind === "notice" && (/^Agent bridge restarted \(v[^)]*\)$/.test(i.text) || /^this session's agent bridge is .+, older than the current \S+: /.test(i.text));
}
