export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export type BridgeEvent =
  | { type: "run.started"; runId: string; nativeThreadId: string | null; model: string | null }
  | { type: "message.delta"; runId: string; itemId: string; text: string }
  | { type: "message.final"; runId: string; itemId: string; role: "assistant"; text: string }
  | { type: "tool.started"; runId: string; itemId: string; tool: string; input: unknown }
  | { type: "tool.finished"; runId: string; itemId: string; isError: boolean; output: string }
  | { type: "run.completed"; runId: string; nativeThreadId: string; usage: TokenUsage; costUsd: number | null }
  | { type: "run.failed"; runId: string; error: string };

export interface LoggedEvent {
  seq: number;
  ts: number;
  event: BridgeEvent;
}
