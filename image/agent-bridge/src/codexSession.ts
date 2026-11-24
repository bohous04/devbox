import { capText, HOST_SESSION_VARS, toolResultText } from "./claude.ts";
import { ResumeFailedError, type HarnessSession } from "./claudeSession.ts";
import { EffortState } from "./effort.ts";
import type { BridgeEvent, Capabilities, RunOrigin, TokenUsage } from "./events.ts";
import { JsonRpcPeer } from "./jsonRpc.ts";
import type { InitializeParams } from "./codex-protocol/InitializeParams";
import type { RequestId } from "./codex-protocol/RequestId";
import type { AgentMessageDeltaNotification } from "./codex-protocol/v2/AgentMessageDeltaNotification";
import type { CommandExecutionRequestApprovalParams } from "./codex-protocol/v2/CommandExecutionRequestApprovalParams";
import type { CommandExecutionRequestApprovalResponse } from "./codex-protocol/v2/CommandExecutionRequestApprovalResponse";
import type { ErrorNotification } from "./codex-protocol/v2/ErrorNotification";
import type { FileChangeRequestApprovalParams } from "./codex-protocol/v2/FileChangeRequestApprovalParams";
import type { FileChangeRequestApprovalResponse } from "./codex-protocol/v2/FileChangeRequestApprovalResponse";
import type { ItemCompletedNotification } from "./codex-protocol/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./codex-protocol/v2/ItemStartedNotification";
import type { PermissionsRequestApprovalParams } from "./codex-protocol/v2/PermissionsRequestApprovalParams";
import type { PermissionsRequestApprovalResponse } from "./codex-protocol/v2/PermissionsRequestApprovalResponse";
import type { ServerRequestResolvedNotification } from "./codex-protocol/v2/ServerRequestResolvedNotification";
import type { ThreadInjectItemsParams } from "./codex-protocol/v2/ThreadInjectItemsParams";
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { ThreadResumeParams } from "./codex-protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./codex-protocol/v2/ThreadResumeResponse";
import type { ThreadStartParams } from "./codex-protocol/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./codex-protocol/v2/ThreadStartResponse";
import type { ThreadTokenUsageUpdatedNotification } from "./codex-protocol/v2/ThreadTokenUsageUpdatedNotification";
import type { TokenUsageBreakdown } from "./codex-protocol/v2/TokenUsageBreakdown";
import type { ToolRequestUserInputParams } from "./codex-protocol/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputResponse } from "./codex-protocol/v2/ToolRequestUserInputResponse";
import type { TurnCompletedNotification } from "./codex-protocol/v2/TurnCompletedNotification";
import type { TurnInterruptParams } from "./codex-protocol/v2/TurnInterruptParams";
import type { TurnStartedNotification } from "./codex-protocol/v2/TurnStartedNotification";
import type { TurnStartParams } from "./codex-protocol/v2/TurnStartParams";
import type { TurnStartResponse } from "./codex-protocol/v2/TurnStartResponse";
import type { TurnPlanUpdatedNotification } from "./codex-protocol/v2/TurnPlanUpdatedNotification";

export interface CodexProcess {
  stdin: { write(s: string): void };
  lines: AsyncIterable<string>;
  exited: Promise<number>;
  kill(): void;
}

export type CodexSpawn = (argv: string[], env: Record<string, string>) => CodexProcess;

export interface CodexSessionOptions {
  cwd: string;
  model: string | null;
  codexHome: string;
  /** Environment app-server starts from; the bridge's own when omitted. */
  baseEnv?: Record<string, string | undefined>;
  resume: string | null;
  mcpConfigArgs: string[];
  developerInstructions: string;
  emit: (e: BridgeEvent) => void;
  logError?: (msg: string) => void;
  /** The user's reasoning effort; null or absent = Codex's configured default. */
  effort?: string | null;
}

/** The part of app-server's `model/list` (v2 Model) the adapter reads: the levels each model offers and its default. */
interface ModelListPage {
  data: { id: string; model: string; supportedReasoningEfforts: { reasoningEffort: string }[]; defaultReasoningEffort: string }[];
  nextCursor: string | null;
}

// The app-server notifications the adapter consumes; everything else it receives is ignored.
export type CodexNotification =
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "item/agentMessage/delta"; params: AgentMessageDeltaNotification }
  | { method: "thread/tokenUsage/updated"; params: ThreadTokenUsageUpdatedNotification }
  | { method: "serverRequest/resolved"; params: ServerRequestResolvedNotification }
  | { method: "turn/plan/updated"; params: TurnPlanUpdatedNotification }
  | { method: "error"; params: ErrorNotification };

// The answer to an approval request that grants it; any other text declines it.
export const APPROVAL_ACCEPT = "Accept";
const APPROVAL_OPTIONS = [{ label: APPROVAL_ACCEPT }, { label: "Decline" }];

const SESSION_ENDED = "Codex session ended";

// injectItems: the generated protocol has `thread/inject_items`. liveModelSwitch: the model is a turn/start
// parameter, so a switch applies from the next turn. No background work is reported.
/** model/list pages read at most (100 models each): a cursor that never ends must not page forever. */
const MODEL_LIST_MAX_PAGES = 20;

export const CODEX_CAPABILITIES: Capabilities = { resume: true, injectItems: true, liveModelSwitch: true, questions: true, images: true, backgroundVisibility: false };

// Full access, matching today's tmux Codex sessions (global constraints).
const ACCESS = { approvalPolicy: "never", sandbox: "danger-full-access" } as const;

const CLIENT_INFO: InitializeParams["clientInfo"] = { name: "devbox-agent-bridge", title: null, version: "1.0.0" };

export function spawnCodex(argv: string[], env: Record<string, string>, cwd?: string): CodexProcess {
  const proc = Bun.spawn(argv, { env, ...(cwd !== undefined ? { cwd } : {}), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  async function* lines(): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const line of parts) if (line !== "") yield line;
    }
    buffer += decoder.decode();
    if (buffer !== "") yield buffer;
  }
  return {
    stdin: {
      write(s) {
        proc.stdin.write(s);
        proc.stdin.flush();
      },
    },
    lines: lines(),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

interface ActiveRun {
  runId: string;
  turnId: string | null;
  turnIdKnown: Promise<string>;
  setTurnId: (id: string) => void;
  failTurnId: (e: Error) => void;
  interrupted: boolean;
  interruptReported: boolean;
  // Thread token totals before this turn's first model response, and the latest totals within it.
  usageBase: TokenUsageBreakdown | null;
  usageTotal: TokenUsageBreakdown | null;
  startedItems: Set<string>;
  /** Plan updates of this turn so far: each is its own item. */
  planUpdates: number;
}

interface Turn {
  runId: string;
  text: string;
  origin: RunOrigin;
  images: string[];
}

interface OpenRequest {
  rpcId: RequestId;
  runId: string;
  resolve: (answer: string | null) => void;
}

type Opened = Omit<Extract<BridgeEvent, { type: "request.opened" }>, "type" | "runId" | "requestId">;

function newRun(runId: string, turnId: string | null): ActiveRun {
  let setTurnId: (id: string) => void = () => {};
  let failTurnId: (e: Error) => void = () => {};
  const turnIdKnown = new Promise<string>((resolve, reject) => {
    setTurnId = resolve;
    failTurnId = reject;
  });
  // A failed turn/start is reported as run.failed; only interrupt() awaits this promise.
  turnIdKnown.catch(() => {});
  const run: ActiveRun = { runId, turnId, turnIdKnown, setTurnId, failTurnId, interrupted: false, interruptReported: false, usageBase: null, usageTotal: null, startedItems: new Set(), planUpdates: 0 };
  if (turnId !== null) setTurnId(turnId);
  return run;
}

function minus(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: a.totalTokens - b.totalTokens,
    inputTokens: a.inputTokens - b.inputTokens,
    cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
  };
}

// Codex input tokens include cached and cache-written ones (same split as codexHarvester.ts).
function toTokenUsage(u: TokenUsageBreakdown): TokenUsage {
  return {
    input: u.inputTokens - u.cachedInputTokens - u.cacheWriteInputTokens,
    output: u.outputTokens,
    cacheCreation: u.cacheWriteInputTokens,
    cacheRead: u.cachedInputTokens,
  };
}

function toolName(item: ThreadItem): string | null {
  if (item.type === "commandExecution") return "command";
  if (item.type === "fileChange") return "fileChange";
  if (item.type === "mcpToolCall") return `mcp__${item.server}__${item.tool}`;
  return null;
}

function toolInput(item: ThreadItem): unknown {
  if (item.type === "commandExecution") return item.command;
  if (item.type === "fileChange") return item.changes.map((c) => ({ ...c, diff: capText(c.diff) }));
  if (item.type === "mcpToolCall") return item.arguments;
  return null;
}

function toolOutput(item: ThreadItem): { isError: boolean; output: string } {
  if (item.type === "commandExecution") return { isError: item.status !== "completed", output: capText(item.aggregatedOutput ?? "") };
  if (item.type === "fileChange") return { isError: item.status !== "completed", output: capText(item.changes.map((c) => `${c.kind.type} ${c.path}`).join("\n")) };
  if (item.type === "mcpToolCall") {
    return { isError: item.status !== "completed", output: capText(item.error ? item.error.message : toolResultText(item.result?.content)) };
  }
  throw new Error(`not a tool item: ${item.type}`);
}

export function openCodexSession(o: CodexSessionOptions, spawn: CodexSpawn = spawnCodex): HarnessSession {
  const emit = o.emit;
  const logError = o.logError ?? ((msg: string) => console.error(msg));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.baseEnv ?? process.env)) if (v !== undefined && !HOST_SESSION_VARS.includes(k)) env[k] = v;
  env.CODEX_HOME = o.codexHome;

  const proc = spawn(["codex", "app-server", ...o.mcpConfigArgs], env);
  const peer = new JsonRpcPeer(
    {
      write(line) {
        try {
          proc.stdin.write(line);
        } catch (e) {
          // The process is gone; its exit is reported through `exited`.
          logError(`codex app-server stdin write failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      onLine(cb) {
        void (async () => {
          for await (const line of proc.lines) {
            try {
              cb(line);
            } catch (e) {
              // One malformed message must not stop reading the rest of the stream.
              logError(`codex message handling failed: ${e instanceof Error ? e.stack : String(e)} (line: ${line.slice(0, 200)})`);
            }
          }
        })();
      },
    },
    logError,
  );

  const waiting: Turn[] = [];
  const requests = new Map<string, OpenRequest>();
  let threadId: string | null = null;
  let model = o.model;
  const effort = new EffortState(o.emit, o.effort ?? null);
  // Levels and default per model (model/list); null until read, or when it could not be read.
  let catalog: Map<string, { supported: string[]; default: string }> | null = null;
  let catalogFailed = false;
  // The thread's configured effort (config.toml), null = each model's default.
  let configured: string | null = null;
  // The model the thread runs when no model was chosen (thread/start's answer).
  let threadModel: string | null = null;
  // turn/start's effort applies to that turn and every later one: once sent, going back to the default must say so.
  // A resumed thread may carry one from an earlier bridge (its state.json does not say): its first turn says the level.
  let overridden = o.resume !== null;
  const baseline = (m: string | null): string | null => configured ?? (m !== null ? catalog?.get(m)?.default ?? null : null);
  // Without model/list nothing is checked: a choice goes to Codex as it is, and the user is told.
  const uncheckedNotice = (m: string | null) => {
    if (catalogFailed && effort.chosen !== null) {
      o.emit({ type: "bridge.notice", text: `Codex's model list could not be read, so effort ${effort.chosen} is sent without checking that ${m ?? "the model"} takes it.` });
    }
  };
  const reportEffort = (m: string | null) => {
    const supported = m === null || catalog === null ? null : catalog.get(m)?.supported ?? null;
    if (m !== null && catalog !== null && supported === null) logError(`codex: ${m} is not in model/list; its effort levels are unknown`);
    effort.update({ model: m, supported, effective: (chosen) => chosen ?? baseline(m) });
  };
  let markReady: () => void = () => {};
  let failReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // Callers that never await `ready` must not see an unhandled rejection.
  ready.catch(() => {});
  let active: ActiveRun | null = null;
  // Turns that sent turn/completed; their stragglers must not reach a later run.
  const completedTurns = new Set<string>();
  let endReason: string | null = null;

  function reportInterrupt(run: ActiveRun): void {
    if (run.interruptReported) return;
    run.interruptReported = true;
    emit({ type: "run.interrupted", runId: run.runId });
  }

  function expire(requestId: string): void {
    const r = requests.get(requestId);
    if (!r) return;
    requests.delete(requestId);
    emit({ type: "request.resolved", requestId, answer: null, by: "expired" });
    r.resolve(null);
  }

  function writeTurn(t: Turn): void {
    const run = newRun(t.runId, null);
    active = run;
    emit({ type: "run.started", runId: t.runId, origin: t.origin, nativeThreadId: threadId, model });
    const params: TurnStartParams = {
      threadId: threadId!,
      // /inbox is mounted in the container: Codex reads the files itself (no base64 in the request).
      input: [{ type: "text", text: t.text, text_elements: [] }, ...t.images.map((path) => ({ type: "localImage" as const, path }))],
      ...(model !== null ? { model } : {}),
      ...turnEffort(),
    };
    peer.request<TurnStartResponse>("turn/start", params).then(
      (r) => bindTurn(run, r.turn.id),
      (e: Error) => {
        run.failTurnId(e);
        if (active !== run) return;
        active = null;
        emit({ type: "run.failed", runId: run.runId, error: e.message });
        startNext();
      },
    );
  }

  /** The effort turn/start carries: the choice, or the default again after a choice was sent. */
  function turnEffort(): { effort?: string | null } {
    if (effort.chosen !== null) {
      overridden = true;
      return { effort: effort.chosen };
    }
    if (!overridden) return {};
    overridden = false;
    return { effort: baseline(model ?? threadModel) };
  }

  function startNext(): void {
    if (endReason !== null || active !== null || threadId === null) return;
    const next = waiting.shift();
    if (next) writeTurn(next);
  }

  function bindTurn(run: ActiveRun, turnId: string): void {
    if (run.turnId !== null) return;
    run.turnId = turnId;
    run.setTurnId(turnId);
  }

  // The active run a notification of `turnId` belongs to, or null (logged) when it belongs to none.
  // Runs are bound to a turn only by the turn/start response or turn/started, never by other notifications.
  function runFor(turnId: string, method: string): ActiveRun | null {
    if (active !== null && active.turnId === turnId) return active;
    logError(`codex ${method} for ${completedTurns.has(turnId) ? "completed" : "unknown"} turn ${turnId} dropped`);
    return null;
  }

  function finishTurn(n: TurnCompletedNotification): void {
    const run = runFor(n.turn.id, "turn/completed");
    completedTurns.add(n.turn.id);
    if (run === null) return;
    active = null;
    for (const [requestId, r] of requests) if (r.runId === run.runId) expire(requestId);
    if (run.interrupted || n.turn.status === "interrupted") reportInterrupt(run);
    else if (n.turn.status === "completed") {
      const usage = run.usageBase && run.usageTotal ? toTokenUsage(minus(run.usageTotal, run.usageBase)) : null;
      if (usage === null) logError(`codex turn ${n.turn.id} completed without a token usage update; usage is null`);
      emit({ type: "run.completed", runId: run.runId, nativeThreadId: threadId!, usage, costUsd: null });
    } else {
      emit({ type: "run.failed", runId: run.runId, error: n.turn.error?.message ?? `turn ended with status ${n.turn.status} and no error message` });
    }
    startNext();
  }

  function handle(n: CodexNotification): void {
    if (n.method === "error") {
      logError(`codex error (${n.params.willRetry ? "retrying" : "final"}): ${n.params.error.message}`);
      return;
    }
    // Global notifications carry no thread; others may belong to another thread, e.g. a Codex subagent.
    if (n.params?.threadId !== threadId) return;
    switch (n.method) {
      case "turn/started": {
        if (active === null) {
          // Codex started a turn by itself.
          active = newRun(crypto.randomUUID(), n.params.turn.id);
          emit({ type: "run.started", runId: active.runId, origin: "agent", nativeThreadId: threadId, model });
        } else if (active.turnId === null) bindTurn(active, n.params.turn.id);
        else if (active.turnId !== n.params.turn.id) logError(`codex turn/started for turn ${n.params.turn.id} while turn ${active.turnId} is active`);
        return;
      }
      case "turn/completed":
        return finishTurn(n.params);
      case "thread/tokenUsage/updated": {
        const run = runFor(n.params.turnId, n.method);
        if (run === null) return;
        const { total, last } = n.params.tokenUsage;
        run.usageBase ??= minus(total, last);
        run.usageTotal = total;
        return;
      }
      case "item/agentMessage/delta": {
        const run = runFor(n.params.turnId, n.method);
        if (run) emit({ type: "message.delta", runId: run.runId, itemId: n.params.itemId, text: n.params.delta });
        return;
      }
      case "item/started": {
        const run = runFor(n.params.turnId, n.method);
        const tool = toolName(n.params.item);
        if (run === null || tool === null) return;
        run.startedItems.add(n.params.item.id);
        emit({ type: "tool.started", runId: run.runId, itemId: n.params.item.id, tool, input: toolInput(n.params.item) });
        return;
      }
      case "item/completed": {
        const run = runFor(n.params.turnId, n.method);
        if (run === null) return;
        const item = n.params.item;
        if (item.type === "agentMessage") {
          if (item.text) emit({ type: "message.final", runId: run.runId, itemId: item.id, role: "assistant", text: item.text });
          return;
        }
        const tool = toolName(item);
        if (tool === null) return;
        if (!run.startedItems.delete(item.id)) emit({ type: "tool.started", runId: run.runId, itemId: item.id, tool, input: toolInput(item) });
        emit({ type: "tool.finished", runId: run.runId, itemId: item.id, ...toolOutput(item) });
        return;
      }
      case "turn/plan/updated": {
        // Codex's update_plan (its TodoWrite): not a thread item in the protocol, so each update becomes a tool item
        // under that name, which the thread shows and a switch's handoff carries as a plan.
        const run = runFor(n.params.turnId, n.method);
        if (run === null) return;
        const itemId = `plan:${n.params.turnId}:${++run.planUpdates}`;
        emit({ type: "tool.started", runId: run.runId, itemId, tool: "update_plan", input: { explanation: n.params.explanation, plan: n.params.plan } });
        emit({ type: "tool.finished", runId: run.runId, itemId, isError: false, output: "" });
        return;
      }
      case "serverRequest/resolved": {
        for (const [requestId, r] of requests) if (r.rpcId === n.params.requestId) expire(requestId);
        return;
      }
    }
  }

  function ask(rpcId: RequestId, opened: Opened): Promise<string | null> {
    const requestId = crypto.randomUUID();
    const runId = active!.runId;
    const answer = new Promise<string | null>((resolve) => requests.set(requestId, { rpcId, runId, resolve }));
    emit({ type: "request.opened", runId, requestId, ...opened });
    return answer;
  }

  // Prompt text for an approval: the given parts, or an explicit placeholder (logged) when all are empty.
  function approvalPrompt(method: string, parts: (string | null | undefined)[], missing: string): string {
    const text = parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n");
    if (text !== "") return text;
    logError(`codex ${method} carried no description`);
    return missing;
  }

  async function approve(rpcId: RequestId, prompt: string): Promise<boolean> {
    const answer = await ask(rpcId, { kind: "approval", prompt, options: APPROVAL_OPTIONS });
    if (answer === null) throw new Error("The approval request ended before the user answered.");
    return answer === APPROVAL_ACCEPT;
  }

  // Server requests are attached to the active run deliberately, without matching their turnId.
  async function onServerRequest(rpcId: RequestId, method: string, params: any): Promise<unknown> {
    if (active === null || endReason !== null) {
      logError(`codex ${method} arrived outside a run`);
      throw new Error(`${method} arrived outside a run; the bridge cannot ask the user.`);
    }
    if (method === "item/tool/requestUserInput") {
      const p = params as ToolRequestUserInputParams;
      if (!Array.isArray(p.questions) || p.questions.length === 0 || p.questions.some((q) => typeof q?.question !== "string" || q.question === "")) {
        logError(`codex requestUserInput had no question text: ${JSON.stringify(params)}`);
        throw new Error("requestUserInput had no question text");
      }
      // A secret answer would be stored in the thread and the event log; refuse instead of asking.
      if (p.questions.some((q) => q.isSecret)) {
        logError("codex requestUserInput: secret input requested; not supported in chat sessions");
        throw new Error("secret input requested; not supported in chat sessions");
      }
      const answers = await Promise.all(
        p.questions.map((q) =>
          ask(rpcId, {
            kind: "question",
            prompt: q.question,
            ...(q.options ? { options: q.options.map((op) => ({ label: op.label, description: op.description })) } : {}),
          }),
        ),
      );
      if (answers.some((a) => a === null)) throw new Error("The user did not answer before the turn ended.");
      const response: ToolRequestUserInputResponse = { answers: Object.fromEntries(p.questions.map((q, i) => [q.id, { answers: [answers[i]!] }])) };
      return response;
    }
    if (method === "item/commandExecution/requestApproval") {
      const p = params as CommandExecutionRequestApprovalParams;
      const ok = await approve(rpcId, approvalPrompt(method, [p.reason, p.command], "The agent asked to run a command without showing it."));
      const response: CommandExecutionRequestApprovalResponse = { decision: ok ? "accept" : "decline" };
      return response;
    }
    if (method === "item/fileChange/requestApproval") {
      const p = params as FileChangeRequestApprovalParams;
      const grant = p.grantRoot ? `Allow writes under ${p.grantRoot}` : null;
      const ok = await approve(rpcId, approvalPrompt(method, [p.reason, grant], "The agent asked to change files without saying which."));
      const response: FileChangeRequestApprovalResponse = { decision: ok ? "accept" : "decline" };
      return response;
    }
    if (method === "item/permissions/requestApproval") {
      const p = params as PermissionsRequestApprovalParams;
      const ok = await approve(rpcId, approvalPrompt(method, [p.reason, JSON.stringify(p.permissions)], "The agent asked for more permissions."));
      const response: PermissionsRequestApprovalResponse = {
        permissions: ok ? { ...(p.permissions.network ? { network: p.permissions.network } : {}), ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) } : {},
        scope: "turn",
      };
      return response;
    }
    logError(`codex server request ${method} is not handled`);
    throw new Error(`devbox does not handle ${method}`);
  }

  function endSession(reason: string): void {
    if (endReason !== null) return;
    endReason = reason;
    for (const requestId of [...requests.keys()]) expire(requestId);
    if (active?.interrupted) reportInterrupt(active);
    else if (active) emit({ type: "run.failed", runId: active.runId, error: reason });
    active = null;
    for (const t of waiting.splice(0)) emit({ type: "run.failed", runId: t.runId, error: reason });
  }

  peer.onNotification((method, params) => handle({ method, params } as CodexNotification));
  peer.onRequest((method, params, id) => onServerRequest(id, method, params));

  const sessionEnded = proc.exited.then((code) => {
    const reason = `codex app-server exited with code ${code}`;
    peer.close(reason);
    endSession(reason);
    return { error: reason };
  });

  void (async () => {
    try {
      const init: InitializeParams = { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } };
      await peer.request("initialize", init);
      peer.notify("initialized", undefined);
      const policy = { cwd: o.cwd, ...ACCESS, developerInstructions: o.developerInstructions };
      let r: ThreadStartResponse | ThreadResumeResponse;
      if (o.resume !== null) {
        try {
          r = await peer.request<ThreadResumeResponse>("thread/resume", { threadId: o.resume, ...policy } satisfies ThreadResumeParams);
        } catch (e) {
          throw new ResumeFailedError(`thread/resume ${o.resume} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        r = await peer.request<ThreadStartResponse>("thread/start", policy satisfies ThreadStartParams);
      }
      if (endReason !== null) throw new Error(endReason);
      threadId = r.thread.id;
      threadModel = r.model;
      configured = r.reasoningEffort;
      emit({ type: "thread.native", harness: "codex", nativeThreadId: threadId, account: null, model: r.model, caps: CODEX_CAPABILITIES });
      markReady();
      // Not awaited: turns need no levels, and a slow or failing model/list must not hold them.
      void readCatalog().then((c) => {
        catalog = c;
        catalogFailed = c === null;
        reportEffort(model ?? threadModel);
        uncheckedNotice(model ?? threadModel);
      });
      startNext();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logError(`codex session start failed: ${reason}`);
      failReady(e instanceof Error ? e : new Error(reason));
      endSession(reason);
      proc.kill();
    }
  })();

  /** Every page of model/list; null (logged) when it cannot be read: the levels stay unknown, turns go on. */
  async function readCatalog(): Promise<Map<string, { supported: string[]; default: string }> | null> {
    const out = new Map<string, { supported: string[]; default: string }>();
    let cursor: string | null = null;
    let pages = 0;
    try {
      do {
        if (++pages > MODEL_LIST_MAX_PAGES) throw new Error(`more than ${MODEL_LIST_MAX_PAGES} pages`);
        const page: ModelListPage = await peer.request<ModelListPage>("model/list", { cursor, limit: 100, includeHidden: true });
        for (const m of page.data) {
          const entry = { supported: m.supportedReasoningEfforts.map((x) => x.reasoningEffort), default: m.defaultReasoningEffort };
          out.set(m.model, entry);
          out.set(m.id, entry);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
    } catch (e) {
      logError(`codex: model/list failed, effort levels unknown: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    return out;
  }

  return {
    async startTurn(runId, text, origin, images = []) {
      if (endReason !== null) throw new Error(endReason);
      const turn = { runId, text, origin, images };
      // turn/start during an active turn would steer it; the message starts the next turn instead.
      if (active === null && threadId !== null) writeTurn(turn);
      else waiting.push(turn);
    },
    async interrupt() {
      if (active === null) throw new Error("no active run");
      const run = active;
      // Set first: turn/completed may arrive before turn/interrupt returns, and it must not fail the run.
      run.interrupted = true;
      try {
        const turnId = await run.turnIdKnown;
        const params: TurnInterruptParams = { threadId: threadId!, turnId };
        await peer.request("turn/interrupt", params);
      } catch (e) {
        if (!run.interruptReported) run.interrupted = false;
        throw e;
      }
      reportInterrupt(run);
    },
    async answer(requestId, answer) {
      const r = requests.get(requestId);
      if (!r) throw new Error(`no open request ${requestId}`);
      requests.delete(requestId);
      emit({ type: "request.resolved", requestId, answer, by: "user" });
      r.resolve(answer);
    },
    async setModel(next) {
      if (endReason !== null) throw new Error(endReason);
      model = next;
      reportEffort(next);
      uncheckedNotice(next);
    },
    async setEffort(level) {
      if (endReason !== null) throw new Error(endReason);
      effort.check(level);
      // Sent with the next turn/start.
      effort.choose(level, level ?? baseline(model ?? threadModel));
    },
    async injectItems(items) {
      await ready;
      const params: ThreadInjectItemsParams = { threadId: threadId!, items: items as ThreadInjectItemsParams["items"] };
      await peer.request("thread/inject_items", params);
    },
    capabilities: () => CODEX_CAPABILITIES,
    async close() {
      endSession(SESSION_ENDED);
      proc.kill();
    },
    ready,
    ended: sessionEnded,
  };
}
