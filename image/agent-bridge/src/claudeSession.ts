import { query, type CanUseTool, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTracker, WAKEUP_ID } from "./background.ts";
import { claudeQueryOptions, mapSdkMessage, resultError, sumModelUsage, type ClaudeSdkOptions, type QueryFn } from "./claude.ts";
import type { BridgeEvent, RunOrigin, TokenUsage } from "./events.ts";

export interface HarnessSession {
  startTurn(runId: string, text: string, origin: RunOrigin): Promise<void>; // resolves when the turn is accepted
  interrupt(): Promise<void>;
  answer(requestId: string, answer: string): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeSessionOptions {
  cwd: string;
  model: string | null;
  claudeExecutable: string;
  configDir: string;
  entrypoint?: string;
  resume: string | null;
  mcpServers: Record<string, unknown>;
  appendSystemPrompt: string;
  emit: (e: BridgeEvent) => void;
  now?: () => number;
}

// The answer to a plan request that approves it; any other text rejects the plan with that text as feedback.
export const PLAN_APPROVE = "Approve";

// Claude Code jitters a wakeup early, at most 60 s before the minute-rounded time it reports
// (T3 ClaudeAdapterV2.ts CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS); the rest is slack.
const WAKEUP_EARLY_FIRE_MARGIN_MS = 120_000;

const SESSION_ENDED = "Claude session ended";

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface ActiveRun {
  runId: string;
  interrupted: boolean;
}

interface Turn {
  runId: string;
  text: string;
  origin: RunOrigin;
}

interface QuestionInput {
  questions?: { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
}

function isRootFrame(msg: SDKMessage): boolean {
  if (msg.type === "system") return msg.subtype === "init";
  if (msg.type === "result") return true;
  if (msg.type === "stream_event" || msg.type === "assistant") return msg.parent_tool_use_id === null;
  if (msg.type === "user") {
    return msg.parent_tool_use_id === null && Array.isArray(msg.message.content) && msg.message.content.some((b) => b.type === "tool_result");
  }
  return false;
}

function subtractUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input - b.input, output: a.output - b.output, cacheCreation: a.cacheCreation - b.cacheCreation, cacheRead: a.cacheRead - b.cacheRead };
}

export function openClaudeSession(o: ClaudeSessionOptions, queryFn: QueryFn = query): HarnessSession {
  const now = o.now ?? Date.now;
  const input = new InputQueue();
  const background = new BackgroundTracker();
  const waiting: Turn[] = [];
  const requests = new Map<string, (answer: string | null) => void>();
  const cursor = { messageId: "" };
  let active: ActiveRun | null = null;
  let nativeThreadId: string | null = o.resume;
  // modelUsage and total_cost_usd are running totals of the query (sdk.d.ts SDKResultMessage),
  // so a run's own usage is the difference to the previous result.
  let lastUsage: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let lastCost = 0;
  let ended = false;

  const emit = o.emit;

  function emitBackground(work: ReturnType<BackgroundTracker["list"]> | null): void {
    if (work) emit({ type: "background.changed", work });
  }

  function writeTurn(t: Turn): void {
    active = { runId: t.runId, interrupted: false };
    input.push({ type: "user", message: { role: "user", content: t.text }, parent_tool_use_id: null });
    emit({ type: "run.started", runId: t.runId, origin: t.origin, nativeThreadId, model: o.model });
  }

  function startAgentRun(model: string | null): void {
    active = { runId: crypto.randomUUID(), interrupted: false };
    emit({ type: "run.started", runId: active.runId, origin: "agent", nativeThreadId, model });
    const wakeup = background.list().find((w) => w.id === WAKEUP_ID);
    // The agent started a turn by itself at its wakeup time: that is the wakeup firing.
    if (wakeup?.until !== undefined && now() >= wakeup.until - WAKEUP_EARLY_FIRE_MARGIN_MS) emitBackground(background.clear(WAKEUP_ID));
  }

  function finishRun(msg: Extract<SDKMessage, { type: "result" }>): void {
    const run = active!;
    active = null;
    const total = sumModelUsage(msg.modelUsage);
    let usage = subtractUsage(total, lastUsage);
    let cost = msg.total_cost_usd - lastCost;
    // A /clear resets the running totals; the new total is then this run's own usage.
    if (Object.values(usage).some((v) => v < 0) || cost < 0) {
      usage = total;
      cost = msg.total_cost_usd;
    }
    lastUsage = total;
    lastCost = msg.total_cost_usd;
    if (!run.interrupted) {
      const error = resultError(msg);
      if (error === null) emit({ type: "run.completed", runId: run.runId, nativeThreadId: msg.session_id, usage, costUsd: cost });
      else emit({ type: "run.failed", runId: run.runId, error });
    }
    const next = waiting.shift();
    if (next) writeTurn(next);
  }

  function handle(msg: SDKMessage): void {
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id !== nativeThreadId) {
      nativeThreadId = msg.session_id;
      emit({ type: "thread.native", harness: "claude", nativeThreadId, account: null, model: msg.model });
    }
    if (active === null && isRootFrame(msg)) startAgentRun(msg.type === "system" && msg.subtype === "init" ? msg.model : o.model);
    if (active !== null) for (const e of mapSdkMessage(msg, active.runId, cursor)) emit(e);
    emitBackground(background.apply(msg));
    if (msg.type === "result") finishRun(msg);
  }

  function endSession(error: string): void {
    if (ended) return;
    ended = true;
    input.end();
    if (active && !active.interrupted) emit({ type: "run.failed", runId: active.runId, error });
    active = null;
    for (const t of waiting.splice(0)) emit({ type: "run.failed", runId: t.runId, error });
  }

  function openRequest(requestId: string): Promise<string | null> {
    return new Promise((resolve) => requests.set(requestId, resolve));
  }

  // Resolves to the user's answer, or null when the SDK withdrew the tool call (interrupt).
  async function ask(requestId: string, opened: Omit<Extract<BridgeEvent, { type: "request.opened" }>, "type" | "runId" | "requestId">, signal: AbortSignal): Promise<string | null> {
    const answer = openRequest(requestId);
    emit({ type: "request.opened", runId: active!.runId, requestId, ...opened });
    const onAbort = () => {
      const resolve = requests.get(requestId);
      if (!resolve) return;
      requests.delete(requestId);
      emit({ type: "request.resolved", requestId, answer: null, by: "expired" });
      resolve(null);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return answer;
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, { signal, toolUseID }): Promise<PermissionResult> => {
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") return { behavior: "allow", updatedInput: toolInput };
    if (active === null) return { behavior: "deny", message: `${toolName} arrived outside a run; the bridge cannot ask the user.` };
    if (toolName === "ExitPlanMode") {
      const plan = typeof toolInput.plan === "string" ? toolInput.plan : "";
      const answer = await ask(toolUseID, { kind: "plan", prompt: plan, options: [{ label: PLAN_APPROVE }] }, signal);
      if (answer === null) return { behavior: "deny", message: "The user did not answer the plan before the turn was stopped." };
      return answer === PLAN_APPROVE ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: answer };
    }
    const questions = (toolInput as QuestionInput).questions ?? [];
    const answers = await Promise.all(
      questions.map((q, i) =>
        ask(
          `${toolUseID}:${i}`,
          {
            kind: "question",
            prompt: q.question,
            ...(q.options ? { options: q.options.map((op) => ({ label: op.label, ...(op.description !== undefined ? { description: op.description } : {}) })) } : {}),
            ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
          },
          signal,
        ),
      ),
    );
    if (answers.some((a) => a === null)) return { behavior: "deny", message: "The user did not answer before the turn was stopped." };
    return {
      behavior: "allow",
      updatedInput: { ...toolInput, answers: Object.fromEntries(questions.map((q, i) => [q.question, answers[i]!])) },
    };
  };

  const stream: Query = queryFn({
    prompt: input,
    options: {
      ...claudeQueryOptions(o),
      systemPrompt: { type: "preset", preset: "claude_code", append: o.appendSystemPrompt },
      mcpServers: o.mcpServers as ClaudeSdkOptions["mcpServers"],
      canUseTool,
    },
  });

  void (async () => {
    try {
      for await (const msg of stream) handle(msg);
      endSession(SESSION_ENDED);
    } catch (e) {
      endSession(e instanceof Error ? e.message : String(e));
    }
  })();

  return {
    async startTurn(runId, text, origin) {
      if (ended) throw new Error(SESSION_ENDED);
      const turn = { runId, text, origin };
      // Writing during an active run would merge the message into that run; it starts the next one instead.
      if (active === null) writeTurn(turn);
      else waiting.push(turn);
    },
    async interrupt() {
      if (active === null) throw new Error("no active run");
      const run = active;
      // Set first: the run's own result may arrive before interrupt() returns, and it must not fail the run.
      run.interrupted = true;
      try {
        await stream.interrupt();
      } catch (e) {
        run.interrupted = false;
        throw e;
      }
      emit({ type: "run.interrupted", runId: run.runId });
    },
    async answer(requestId, answer) {
      const resolve = requests.get(requestId);
      if (!resolve) throw new Error(`no open request ${requestId}`);
      requests.delete(requestId);
      emit({ type: "request.resolved", requestId, answer, by: "user" });
      resolve(answer);
    },
    async close() {
      endSession(SESSION_ENDED);
      stream.close();
    },
  };
}
