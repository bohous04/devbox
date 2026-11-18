import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
const HOST_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"];

export function claudeEnv(base: Record<string, string | undefined>, o: ClaudeTurnOptions): Record<string, string> {
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

function capText(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_OUTPUT_BYTES ? text : bytes.subarray(0, MAX_OUTPUT_BYTES).toString();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
}

export async function* runClaudeTurn(o: ClaudeTurnOptions, queryFn: QueryFn = query): AsyncIterable<BridgeEvent> {
  let currentMessageId = "";
  try {
    const stream = queryFn({
      prompt: singleUserMessage(o.prompt),
      options: {
        pathToClaudeCodeExecutable: o.claudeExecutable,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        model: o.model,
        cwd: o.cwd,
        env: claudeEnv(process.env, o),
        includePartialMessages: true,
        ...(o.resume ? { resume: o.resume } : {}),
      },
    });
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && msg.subtype === "init") {
        yield { type: "run.started", runId: o.runId, nativeThreadId: msg.session_id, model: msg.model };
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "message_start") currentMessageId = ev.message.id;
        else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { type: "message.delta", runId: o.runId, itemId: currentMessageId, text: ev.delta.text };
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            yield { type: "message.final", runId: o.runId, itemId: msg.message.id, role: "assistant", text: block.text };
          } else if (block.type === "tool_use") {
            yield { type: "tool.started", runId: o.runId, itemId: block.id, tool: block.name, input: block.input };
          }
        }
      } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            yield {
              type: "tool.finished",
              runId: o.runId,
              itemId: block.tool_use_id,
              isError: block.is_error === true,
              output: capText(toolResultText(block.content)),
            };
          }
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) {
          // result.usage covers the main loop only; modelUsage includes subagents and compaction.
          // It is cumulative across turns, so with `resume` it may include earlier turns (step 2 owns multi-turn accounting).
          const usage: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
          for (const m of Object.values(msg.modelUsage)) {
            usage.input += m.inputTokens;
            usage.output += m.outputTokens;
            usage.cacheCreation += m.cacheCreationInputTokens;
            usage.cacheRead += m.cacheReadInputTokens;
          }
          yield { type: "run.completed", runId: o.runId, nativeThreadId: msg.session_id, usage, costUsd: msg.total_cost_usd };
        } else {
          const errors = "errors" in msg ? msg.errors : [];
          yield { type: "run.failed", runId: o.runId, error: errors.join("; ") || `run ended with ${msg.subtype}` };
        }
      }
    }
  } catch (e) {
    yield { type: "run.failed", runId: o.runId, error: e instanceof Error ? e.message : String(e) };
  }
}
