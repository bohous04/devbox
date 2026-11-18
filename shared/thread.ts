import type { BackgroundWork, RequestKind, RunOrigin, TokenUsage } from "../image/agent-bridge/src/events";

export type { BackgroundWork, BridgeEvent, LoggedEvent, RequestKind, RunOrigin, TokenUsage } from "../image/agent-bridge/src/events";

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
}

/** devd's connection to a chat session's agent bridge socket. */
export type LinkStatus = "connecting" | "connected" | "disconnected";

export type InboxSection = "needs_you" | "working" | "idle";
/** Where a session belongs in the inbox and why; `since` is when that state began (0 = nothing happened yet). */
export interface Attention {
  section: InboxSection;
  reason: "request" | "failed" | "completed" | "disconnected" | "running" | "background" | "queued" | null;
  since: number;
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
  attention: Attention;
  lastText: string | null;
}
