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
  startedAt: number | null;
  endedAt: number | null;
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
