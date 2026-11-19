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

/** What a harness adapter can do; reported with `thread.native` and stored by devd with the native thread. */
export interface Capabilities {
  resume: boolean;
  injectItems: boolean;
  liveModelSwitch: boolean;
  questions: boolean;
  images: boolean;
  backgroundVisibility: boolean;
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
  // harness: "claude", "codex" or an ACP agent's id (ACP_AGENTS).
  | { type: "thread.native"; harness: "claude" | "codex" | (string & {}); nativeThreadId: string; account: string | null; model: string | null; caps?: Capabilities }
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
  // reason: the harness was rate-limited (an ACP agent's rate-limit error code); absent for any other failure.
  | { type: "run.failed"; runId: string; error: string; reason?: "rate-limited" }
  // awaitingTarget: restarted after a switch whose secret env was not persisted; no harness until devd re-sends
  // switchTarget.
  | { type: "bridge.started"; version: string; resumed: boolean; awaitingTarget?: boolean };

export interface LoggedEvent {
  seq: number;
  ts: number;
  event: BridgeEvent;
}
