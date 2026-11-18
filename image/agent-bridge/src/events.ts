export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** Claude's running usage totals at the last result; a resumed query continues from them. */
export interface UsageBaseline {
  usage: TokenUsage;
  costUsd: number;
}

export type RunOrigin = "user" | "agent" | "continuation";
export type RequestKind = "question" | "plan" | "approval";

export interface BackgroundWork {
  id: string;
  kind: "subagent" | "workflow" | "monitor" | "wakeup" | "declared-wait" | "command";
  label: string;
  holding: boolean;
  until?: number;
}

export type BridgeEvent =
  | { type: "thread.native"; harness: "claude" | "codex"; nativeThreadId: string; account: string | null; model: string | null }
  | { type: "run.queued"; runId: string; text: string; attachments: string[] }
  | { type: "run.started"; runId: string; origin: RunOrigin; nativeThreadId: string | null; model: string | null }
  | { type: "message.delta"; runId: string; itemId: string; text: string }
  | { type: "message.final"; runId: string; itemId: string; role: "assistant" | "user"; text: string }
  | { type: "tool.started"; runId: string; itemId: string; tool: string; input: unknown }
  | { type: "tool.finished"; runId: string; itemId: string; isError: boolean; output: string }
  | { type: "request.opened"; runId: string; requestId: string; kind: RequestKind; prompt: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }
  | { type: "request.resolved"; requestId: string; answer: string | null; by: "user" | "expired" }
  | { type: "background.changed"; work: BackgroundWork[] }
  // usage is null when the harness reported no usage for this run.
  | { type: "run.completed"; runId: string; nativeThreadId: string; usage: TokenUsage | null; costUsd: number | null }
  | { type: "run.interrupted"; runId: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "bridge.started"; version: string; resumed: boolean };

export interface LoggedEvent {
  seq: number;
  ts: number;
  event: BridgeEvent;
}
