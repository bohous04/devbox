import { query, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BridgeEvent, TokenUsage } from "./events.ts";

export interface ClaudeTurnOptions {
  runId: string;
  prompt: string;
  cwd: string;
  model: string;
  claudeExecutable: string;
  configDir: string;
  entrypoint?: string;
  resume?: string;
}

export type QueryFn = typeof import("@anthropic-ai/claude-agent-sdk").query;

const MAX_OUTPUT_BYTES = 64 * 1024;

// The bridge may itself run inside a Claude Code session; these make the child CLI
// believe it is nested and change its behaviour.
export const HOST_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"];

export function claudeEnv(base: Record<string, string | undefined>, o: { configDir: string; entrypoint?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !HOST_SESSION_VARS.includes(k)) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = o.configDir;
  if (o.entrypoint) env.CLAUDE_CODE_ENTRYPOINT = o.entrypoint;
  return env;
}

async function* singleUserMessage(prompt: string): AsyncIterable<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
}

export function capText(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_OUTPUT_BYTES ? text : bytes.subarray(0, MAX_OUTPUT_BYTES).toString();
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
}

export type ClaudeSdkOptions = NonNullable<Parameters<QueryFn>[0]["options"]>;

// Options shared by the one-shot turn and the long-lived session.
// `baseEnv` is the environment the CLI starts from: the bridge's own unless a switch target names another.
export function claudeQueryOptions(o: { cwd: string; model: string | null; claudeExecutable: string; configDir: string; entrypoint?: string; resume?: string | null; baseEnv?: Record<string, string | undefined> }): ClaudeSdkOptions {
  return {
    pathToClaudeCodeExecutable: o.claudeExecutable,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(o.model !== null ? { model: o.model } : {}),
    cwd: o.cwd,
    env: claudeEnv(o.baseEnv ?? process.env, o),
    includePartialMessages: true,
    // Without it the SDK sends an empty system prompt, not the CLI's; the TUI always sends
    // Claude Code's, so the two paths would not cost or behave the same.
    systemPrompt: { type: "preset", preset: "claude_code" },
    // settingSources is left out on purpose: omitted means user, project and local, as in the CLI.
    ...(o.resume ? { resume: o.resume } : {}),
  };
}

// result.usage covers the main loop only; modelUsage includes subagents and compaction.
export function sumModelUsage(modelUsage: SDKResultMessage["modelUsage"]): TokenUsage {
  const usage: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const m of Object.values(modelUsage)) {
    usage.input += m.inputTokens;
    usage.output += m.outputTokens;
    usage.cacheCreation += m.cacheCreationInputTokens;
    usage.cacheRead += m.cacheReadInputTokens;
  }
  return usage;
}

// null for a successful result, else the error text for run.failed.
export function resultError(msg: SDKResultMessage): string | null {
  if (msg.subtype === "success" && !msg.is_error) return null;
  // An error reported as a "success" result (e.g. a usage limit) carries its message in `result`.
  if (msg.subtype === "success" && msg.result) return msg.result;
  const errors = "errors" in msg ? msg.errors : [];
  return errors.join("; ") || `run ended with ${msg.subtype}`;
}

// Content frames of a run (text deltas, final text, tool calls and results). Run boundaries
// (init, result) differ between the one-shot turn and the session and are handled by the callers.
export function mapSdkMessage(msg: SDKMessage, runId: string, cursor: { messageId: string }): BridgeEvent[] {
  const out: BridgeEvent[] = [];
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev.type === "message_start") cursor.messageId = ev.message.id;
    else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      out.push({ type: "message.delta", runId, itemId: cursor.messageId, text: ev.delta.text });
    }
  } else if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) {
        out.push({ type: "message.final", runId, itemId: msg.message.id, role: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        out.push({ type: "tool.started", runId, itemId: block.id, tool: block.name, input: block.input });
      }
    }
  } else if (msg.type === "system" && msg.subtype === "local_command_output") {
    // A local slash command (e.g. /voice) answers without the model; without this its run would end with nothing shown.
    out.push({ type: "message.final", runId, itemId: msg.uuid, role: "assistant", text: msg.content });
  } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        out.push({
          type: "tool.finished",
          runId,
          itemId: block.tool_use_id,
          isError: block.is_error === true,
          output: capText(toolResultText(block.content)),
        });
      }
    }
  }
  return out;
}

export async function* runClaudeTurn(o: ClaudeTurnOptions, queryFn: QueryFn = query): AsyncIterable<BridgeEvent> {
  const cursor = { messageId: "" };
  try {
    const stream = queryFn({ prompt: singleUserMessage(o.prompt), options: claudeQueryOptions(o) });
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && msg.subtype === "init") {
        yield { type: "run.started", runId: o.runId, origin: "user", nativeThreadId: msg.session_id, model: msg.model };
      } else if (msg.type === "result") {
        const error = resultError(msg);
        if (error === null) {
          // modelUsage is cumulative across turns, so with `resume` it may include earlier turns;
          // the long-lived session (claudeSession.ts) reports per-run deltas instead.
          yield { type: "run.completed", runId: o.runId, nativeThreadId: msg.session_id, usage: sumModelUsage(msg.modelUsage), costUsd: msg.total_cost_usd };
        } else {
          yield { type: "run.failed", runId: o.runId, error };
        }
      } else {
        yield* mapSdkMessage(msg, o.runId, cursor);
      }
    }
  } catch (e) {
    yield { type: "run.failed", runId: o.runId, error: e instanceof Error ? e.message : String(e) };
  }
}
