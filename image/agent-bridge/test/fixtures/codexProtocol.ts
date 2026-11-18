// Hand-written app-server messages typed against the generated protocol (codex-protocol/), so tsc checks every
// shape. Live recordings replace or extend these once they exist.
import type { ThreadResumeResponse } from "../../src/codex-protocol/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "../../src/codex-protocol/v2/ThreadStartResponse";
import type { Thread } from "../../src/codex-protocol/v2/Thread";
import type { ThreadItem } from "../../src/codex-protocol/v2/ThreadItem";
import type { Turn } from "../../src/codex-protocol/v2/Turn";
import type { TurnStartResponse } from "../../src/codex-protocol/v2/TurnStartResponse";
import type { TokenUsageBreakdown } from "../../src/codex-protocol/v2/TokenUsageBreakdown";
import type { CodexNotification } from "../../src/codexSession.ts";
import type { ToolRequestUserInputParams } from "../../src/codex-protocol/v2/ToolRequestUserInputParams";
import type { CommandExecutionRequestApprovalParams } from "../../src/codex-protocol/v2/CommandExecutionRequestApprovalParams";

export const THREAD_ID = "019a0000-0000-7000-8000-000000000001";

export function thread(id = THREAD_ID): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    model: "gpt-5.5-codex",
    reasoningEffort: null,
    createdAt: 1763452800,
    updatedAt: 1763452800,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "0.169.0",
    originator: null,
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

const threadResponseBase = {
  model: "gpt-5.5-codex",
  modelProvider: "openai",
  serviceTier: null,
  disabledPluginIds: [],
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
  reasoningEffort: null,
} satisfies Omit<ThreadStartResponse, "thread">;

export function threadStartResponse(id = THREAD_ID): ThreadStartResponse {
  return { thread: thread(id), ...threadResponseBase };
}

export function threadResumeResponse(id: string): ThreadResumeResponse {
  return { thread: thread(id), ...threadResponseBase, collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
}

export function turn(id: string, status: Turn["status"], error: string | null = null): Turn {
  return {
    id,
    rootTurnId: id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: error === null ? null : { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null },
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

export function turnStartResponse(id: string): TurnStartResponse {
  return { turn: turn(id, "inProgress") };
}

export function usage(input: number, cached: number, output: number): TokenUsageBreakdown {
  return { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 };
}

export function commandItem(id: string, status: "inProgress" | "completed" | "failed", output: string | null, exitCode: number | null): ThreadItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: "ls -la",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: output,
    exitCode,
    durationMs: null,
  };
}

export function agentMessage(id: string, text: string): ThreadItem {
  return { type: "agentMessage", moderation: null, id, text, phase: null, memoryCitation: null, delivery: null, questions: null };
}

// One turn: a streamed message, one command, a final message, token usage, completion.
export function simpleTurn(turnId: string, threadId = THREAD_ID): CodexNotification[] {
  return [
    { method: "turn/started", params: { threadId, turn: turn(turnId, "inProgress") } },
    { method: "item/started", params: { threadId, turnId, item: agentMessage("msg_1", ""), startedAtMs: 1 } },
    { method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg_1", delta: "Lis" } },
    { method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg_1", delta: "ting" } },
    { method: "item/completed", params: { threadId, turnId, item: agentMessage("msg_1", "Listing"), completedAtMs: 2 } },
    { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: usage(1100, 100, 60), last: usage(100, 0, 10), modelContextWindow: null } } },
    { method: "item/started", params: { threadId, turnId, item: commandItem("call_1", "inProgress", null, null), startedAtMs: 3 } },
    { method: "item/completed", params: { threadId, turnId, item: commandItem("call_1", "completed", "a\nb\n", 0), completedAtMs: 4 } },
    { method: "item/completed", params: { threadId, turnId, item: agentMessage("msg_2", "Two files."), completedAtMs: 5 } },
    { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: usage(1400, 250, 90), last: usage(300, 150, 30), modelContextWindow: null } } },
    { method: "turn/completed", params: { threadId, turn: turn(turnId, "completed") } },
  ];
}

export function userInputRequest(turnId: string, threadId = THREAD_ID): ToolRequestUserInputParams {
  return {
    threadId,
    turnId,
    itemId: "call_ask",
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: "db",
        header: "Database",
        question: "Which database?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Postgres", description: "server" },
          { label: "SQLite", description: "file" },
        ],
      },
    ],
  };
}

export function commandApprovalRequest(turnId: string, threadId = THREAD_ID): CommandExecutionRequestApprovalParams {
  return {
    kind: "command",
    threadId,
    turnId,
    itemId: "call_rm",
    startedAtMs: 1,
    environmentId: null,
    reason: "needs to delete build output",
    command: "rm -rf dist",
    cwd: "/workspace",
  };
}
