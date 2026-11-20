import type { AcpAgentSpec } from "./acpAgents.ts";
import { capText, HOST_SESSION_VARS } from "./claude.ts";
import { ResumeFailedError, type HarnessSession } from "./claudeSession.ts";
import { spawnCodex, type CodexProcess } from "./codexSession.ts";
import { EffortState } from "./effort.ts";
import type { BridgeEvent, Capabilities, RunOrigin, TokenUsage } from "./events.ts";
import { readImageBase64 } from "./images.ts";
import { JsonRpcError, JsonRpcPeer, type Id } from "./jsonRpc.ts";

// Generic ACP (Agent Client Protocol) adapter over stdio. Message shapes follow the ACP schema (v1 and the v2
// draft); per-agent quirks live in ACP_AGENTS (acpAgents.ts).

export type SpawnFn = (argv: string[], env: Record<string, string>, cwd: string) => CodexProcess;

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AcpSessionOptions {
  spec: AcpAgentSpec;
  cwd: string;
  model: string | null;
  resume: string | null;
  mcpServers: AcpMcpServer[];
  emit: (e: BridgeEvent) => void;
  /** Put ahead of the first user message that gets through (ACP has no system prompt); none when omitted. The bridge
   *  passes them while its thread has not had that message yet (BridgeState.instructionsPending). */
  instructions?: string;
  /** The first prompt with the instructions got through. */
  onInstructionsDelivered?: () => void;
  /** Environment the agent starts from; the bridge's own when omitted. */
  baseEnv?: Record<string, string | undefined>;
  logError?: (msg: string) => void;
  /** The user's reasoning effort; an ACP agent has none, so a choice is dropped with a notice. */
  effort?: string | null;
}

const CLIENT_VERSION = "1.0.0";
const SESSION_ENDED = "ACP session ended";

// What no ACP agent offers devbox: injecting raw history items, background work, and questions (permission
// requests are answered automatically). Resume, images and model switching come from the agent.
const BASE_CAPABILITIES: Capabilities = { resume: false, injectItems: false, liveModelSwitch: false, questions: false, images: false, backgroundVisibility: false };

// Session updates that carry nothing devbox shows; dropped without a log line.
const IGNORED_UPDATES = new Set([
  "agent_thought_chunk",
  "agent_thought",
  "user_message_chunk",
  "user_message",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "plan_removed",
  "compaction_update",
  "compaction_summary_chunk",
]);

type Json = Record<string, any>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The protocol generation and capabilities an `initialize` result describes. The generation is read from the
 *  response shape, not `protocolVersion`: Antigravity reports 2 with the v1 shape. */
export function negotiate(initResult: unknown): { version: 1 | 2; caps: Capabilities } {
  if (!isObject(initResult)) throw new Error(`initialize returned no ACP initialize response: ${JSON.stringify(initResult)}`);
  if (typeof initResult.protocolVersion !== "number") throw new Error(`initialize response has no protocolVersion: ${JSON.stringify(initResult).slice(0, 200)}`);
  if ("info" in initResult) {
    const session = initResult.capabilities?.session;
    // v2 marks a capability by a present object (`image: {}`); `false` or null is no.
    const image = session?.prompt?.image;
    return { version: 2, caps: { ...BASE_CAPABILITIES, resume: resumeMethod(2, initResult) !== null, images: image === true || isObject(image) } };
  }
  const agent = initResult.agentCapabilities ?? {};
  return {
    version: 1,
    caps: { ...BASE_CAPABILITIES, resume: resumeMethod(1, initResult) !== null, images: agent.promptCapabilities?.image === true },
  };
}

// How the agent reopens a session: session/resume where offered (no history replay), else session/load. Only an
// explicit capability counts: v1 `sessionCapabilities.resume` / `loadSession`, v2 `capabilities.session.resume` /
// `.load`.
function resumeMethod(version: 1 | 2, init: Json): "session/resume" | "session/load" | null {
  if (version === 2) {
    const session = init.capabilities?.session ?? {};
    if (session.resume != null) return "session/resume";
    return session.load != null ? "session/load" : null;
  }
  const agent = init.agentCapabilities ?? {};
  if (agent.sessionCapabilities?.resume != null) return "session/resume";
  return agent.loadSession === true ? "session/load" : null;
}

// How the session selects its model: a config option of category "model" (or id "model"), else the older
// session/set_model when the session lists models.
type ModelControl = { configId: string } | "set_model" | null;

function modelOf(setup: Json): { control: ModelControl; current: string | null } {
  const options: Json[] = Array.isArray(setup.configOptions) ? setup.configOptions : [];
  const option = options.find((op) => op?.category === "model") ?? options.find((op) => op?.id === "model");
  if (option && typeof option.id === "string") return { control: { configId: option.id }, current: typeof option.currentValue === "string" ? option.currentValue : null };
  if (isObject(setup.models)) return { control: "set_model", current: typeof setup.models.currentModelId === "string" ? setup.models.currentModelId : null };
  return { control: null, current: null };
}

function toTokenUsage(u: unknown): TokenUsage | null {
  if (!isObject(u) || typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") return null;
  return { input: u.inputTokens, output: u.outputTokens, cacheCreation: u.cachedWriteTokens ?? 0, cacheRead: u.cachedReadTokens ?? 0 };
}

const PLAN_MARK: Record<string, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };

function renderPlan(entries: Json[]): string {
  return entries.map((e) => `${PLAN_MARK[e?.status] ?? `[${String(e?.status)}]`} ${String(e?.content)}`).join("\n");
}

function blockText(block: unknown): string | null {
  return isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : null;
}

function toolOutput(t: ToolState): string {
  if (t.content !== undefined) {
    const parts = t.content.map((c) => {
      if (c?.type === "content") return blockText(c.content) ?? `[${String(c.content?.type)} content]`;
      if (c?.type === "diff") return `diff ${c.path ?? (Array.isArray(c.changes) ? c.changes.map((ch: Json) => ch?.path).join(", ") : "")}`;
      if (c?.type === "terminal") return `terminal ${String(c.terminalId)}`;
      return `[${String(c?.type)}]`;
    });
    return capText(parts.join("\n"));
  }
  if (t.rawOutput !== undefined) return capText(typeof t.rawOutput === "string" ? t.rawOutput : JSON.stringify(t.rawOutput));
  return "";
}

interface ToolState {
  finished: boolean;
  content?: Json[];
  rawOutput?: unknown;
}

interface ActiveRun {
  runId: string;
  interrupted: boolean;
  /** session/prompt was sent; before that an interrupt has nothing to cancel at the agent. */
  prompted: boolean;
  message: { itemId: string; text: string } | null;
  messages: number;
  tools: Map<string, ToolState>;
  plan: { itemId: string; output: string } | null;
}

interface Turn {
  runId: string;
  text: string;
  origin: RunOrigin;
  /** ACP image content blocks, read when the turn was accepted. */
  images: { type: "image"; mimeType: string; data: string }[];
}

interface Conn {
  proc: CodexProcess;
  peer: JsonRpcPeer;
}

function spawnAgent(argv: string[], env: Record<string, string>, cwd: string): CodexProcess {
  return spawnCodex(argv, env, cwd);
}

export function openAcpSession(o: AcpSessionOptions, spawn: SpawnFn = spawnAgent): HarnessSession {
  const { spec, emit } = o;
  const logError = o.logError ?? ((msg: string) => console.error(msg));
  const agentName = spec.argv[0]!;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.baseEnv ?? process.env)) if (v !== undefined && !HOST_SESSION_VARS.includes(k)) env[k] = v;
  Object.assign(env, spec.env ?? {});
  const clientInfo = { name: spec.clientName ?? "devbox-agent-bridge", version: CLIENT_VERSION };

  let conn: Conn | null = null;
  let version: 1 | 2 = 1;
  let caps: Capabilities = BASE_CAPABILITIES;
  let reopen: "session/resume" | "session/load" | null = null;
  let sessionId: string | null = null;
  // `model` is the one asked for (null: the agent's own); `appliedModel` the one the session runs.
  let model = o.model;
  // ACP agents take no reasoning effort here: reported as a model without levels.
  const effort = new EffortState(o.emit, o.effort ?? null);
  effort.update({ model, supported: [] });
  let appliedModel: string | null = null;
  let modelControl: ModelControl = null;
  let active: ActiveRun | null = null;
  const waiting: Turn[] = [];
  let starting: Promise<void> | null = null;
  // While session/load replays the history: those updates belong to no run.
  let replaying = false;
  let endReason: string | null = null;
  // Until the first prompt got through.
  let instructions = o.instructions ?? null;

  let markReady: () => void = () => {};
  let failReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => {});
  let resolveEnded: (r: { error?: string }) => void = () => {};
  const ended = new Promise<{ error?: string }>((r) => (resolveEnded = r));

  function connect(): Conn {
    const proc = spawn(spec.argv, env, o.cwd);
    const peer = new JsonRpcPeer(
      {
        write(line) {
          try {
            proc.stdin.write(line);
          } catch (e) {
            // The process is gone; its exit is reported through `exited`.
            logError(`${spec.id}: stdin write failed: ${message(e)}`);
          }
        },
        onLine(cb) {
          void (async () => {
            for await (const line of proc.lines) {
              try {
                cb(line);
              } catch (e) {
                // One malformed message must not stop reading the rest of the stream.
                logError(`${spec.id}: message handling failed: ${e instanceof Error ? e.stack : String(e)} (line: ${line.slice(0, 200)})`);
              }
            }
          })();
        },
      },
      logError,
      { jsonrpc: "2.0" },
    );
    const c = { proc, peer };
    peer.onNotification((method, params) => {
      if (conn === c) onNotification(method, params);
    });
    peer.onRequest((method, params, id) => onAgentRequest(method, params, id));
    void proc.exited.then((code) => onExit(c, code));
    return c;
  }

  function mcpServers(): Json[] {
    return o.mcpServers.map((s) => ({
      ...(version === 2 ? { type: "stdio" } : {}),
      name: s.name,
      command: s.command,
      args: s.args,
      env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
    }));
  }

  async function applyModel(c: Conn, next: string): Promise<void> {
    if (modelControl === null) throw new Error(`${spec.id} cannot select model ${next}: the session offers no model option`);
    if (modelControl === "set_model") await c.peer.request("session/set_model", { sessionId, modelId: next });
    else await c.peer.request("session/set_config_option", { sessionId, configId: modelControl.configId, value: next, ...(version === 2 ? { type: "id" } : {}) });
    appliedModel = next;
  }

  /** Starts the agent and opens (resume === null) or reopens a session on it. */
  async function start(resume: string | null): Promise<void> {
    const c = connect();
    conn = c;
    const init = await c.peer.request<unknown>("initialize", {
      protocolVersion: 2,
      // Both shapes, so a v1 and a v2 agent each find theirs.
      clientInfo,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      info: clientInfo,
      capabilities: {},
    });
    const n = negotiate(init);
    version = n.version;
    reopen = resumeMethod(n.version, init as Json);
    let setup: unknown;
    if (resume !== null) {
      if (reopen === null) throw new ResumeFailedError(`${spec.id} cannot resume session ${resume}: the agent offers neither session/load nor session/resume`);
      replaying = true;
      try {
        setup = await c.peer.request(reopen, { sessionId: resume, cwd: o.cwd, mcpServers: mcpServers() });
      } catch (e) {
        throw new ResumeFailedError(`${reopen} ${resume} failed: ${message(e)}`);
      } finally {
        replaying = false;
      }
      sessionId = resume;
    } else {
      setup = await c.peer.request("session/new", { cwd: o.cwd, mcpServers: mcpServers() });
      if (!isObject(setup) || typeof setup.sessionId !== "string") throw new Error(`session/new returned no sessionId: ${JSON.stringify(setup)}`);
      sessionId = setup.sessionId;
    }
    const s = isObject(setup) ? setup : {};
    const currentMode = s.modes?.currentModeId;
    if (spec.modes && typeof currentMode === "string" && !spec.modes.allowed.includes(currentMode)) {
      await c.peer.request("session/set_mode", { sessionId, modeId: spec.modes.allowed[0] });
    }
    const m = modelOf(s);
    modelControl = m.control;
    appliedModel = m.current;
    if (model !== null && model !== appliedModel) await applyModel(c, model);
    caps = { ...n.caps, liveModelSwitch: modelControl !== null, ...spec.overrides };
    if (conn !== c) throw new Error(`${agentName} exited while the session was opening`);
  }

  function newRun(runId: string): ActiveRun {
    return { runId, interrupted: false, prompted: false, message: null, messages: 0, tools: new Map(), plan: null };
  }

  function flushMessage(run: ActiveRun): void {
    const m = run.message;
    run.message = null;
    if (m && m.text !== "") emit({ type: "message.final", runId: run.runId, itemId: m.itemId, role: "assistant", text: m.text });
  }

  // Closes the run's open message and its plan item (a plan is shown as it stands when the run ends).
  function closeItems(run: ActiveRun): void {
    flushMessage(run);
    if (run.plan) emit({ type: "tool.finished", runId: run.runId, itemId: run.plan.itemId, isError: false, output: run.plan.output });
    run.plan = null;
  }

  function writeTurn(t: Turn): void {
    const c = conn!;
    const run = newRun(t.runId);
    active = run;
    emit({ type: "run.started", runId: t.runId, origin: t.origin, nativeThreadId: sessionId, model: model ?? appliedModel });
    void (async () => {
      try {
        if (model !== null && model !== appliedModel) await applyModel(c, model);
        // Interrupted while the model was being applied: the prompt is never sent.
        if (run.interrupted) return finishRun(run, "cancelled", undefined);
        const text = instructions === null ? t.text : `${instructions}\n\n${t.text}`;
        run.prompted = true;
        const r = await c.peer.request<unknown>("session/prompt", { sessionId, prompt: [{ type: "text", text }, ...t.images] });
        if (instructions !== null) {
          instructions = null;
          o.onInstructionsDelivered?.();
        }
        // v2 only accepts the prompt here; its idle state update ends the turn.
        if (version === 1) finishRun(run, isObject(r) ? r.stopReason : undefined, isObject(r) ? r.usage : undefined);
      } catch (e) {
        failRun(run, e);
      }
    })();
  }

  function finishRun(run: ActiveRun, stopReason: unknown, usage: unknown): void {
    if (active !== run) {
      logError(`${spec.id}: end of run ${run.runId}, which is no longer active, dropped`);
      return;
    }
    closeItems(run);
    active = null;
    if (run.interrupted || stopReason === "cancelled") emit({ type: "run.interrupted", runId: run.runId });
    else if (stopReason === "end_turn") {
      const tokens = toTokenUsage(usage);
      if (tokens === null && usage != null) logError(`${spec.id}: unreadable usage ${JSON.stringify(usage)}; usage is null`);
      emit({ type: "run.completed", runId: run.runId, nativeThreadId: sessionId!, usage: tokens, costUsd: null });
    }
    else if (typeof stopReason === "string") emit({ type: "run.failed", runId: run.runId, error: `agent stopped: ${stopReason}` });
    else {
      logError(`${spec.id}: turn ended without a stop reason: ${JSON.stringify(stopReason)}`);
      emit({ type: "run.failed", runId: run.runId, error: "agent ended the turn without a stop reason" });
    }
    startNext();
  }

  function failRun(run: ActiveRun, e: unknown): void {
    if (active !== run) return;
    closeItems(run);
    active = null;
    if (run.interrupted) emit({ type: "run.interrupted", runId: run.runId });
    else {
      const rateLimited = e instanceof JsonRpcError && (spec.rateLimitCodes ?? []).includes(e.code);
      emit(rateLimited
        ? { type: "run.failed", runId: run.runId, error: `rate-limited: ${message(e)}`, reason: "rate-limited" }
        : { type: "run.failed", runId: run.runId, error: message(e) });
    }
    startNext();
  }

  function startNext(): void {
    if (endReason !== null || active !== null || starting !== null || waiting.length === 0) return;
    if (conn === null) restart();
    else writeTurn(waiting.shift()!);
  }

  // The agent exited between turns: start it again on its session for the waiting turn.
  function restart(): void {
    starting = start(sessionId).then(
      () => {
        starting = null;
        startNext();
      },
      (e) => {
        starting = null;
        const reason = `${spec.id} restart failed: ${message(e)}`;
        logError(reason);
        endSession(reason);
      },
    );
  }

  function onExit(c: Conn, code: number): void {
    if (conn !== c) return;
    const reason = `${agentName} exited with code ${code}`;
    conn = null;
    c.peer.close(reason);
    // A start in progress fails through its pending requests.
    if (endReason !== null || starting !== null) return;
    if (active !== null) {
      const run = active;
      closeItems(run);
      active = null;
      emit(run.interrupted ? { type: "run.interrupted", runId: run.runId } : { type: "run.failed", runId: run.runId, error: reason });
    }
    if (caps.resume && reopen !== null) {
      logError(`${spec.id}: ${reason}; restarting it with the next message`);
      startNext();
    } else endSession(reason);
  }

  function endSession(reason: string, error = true): void {
    if (endReason !== null) return;
    endReason = reason;
    if (active !== null) {
      const run = active;
      closeItems(run);
      emit(run.interrupted ? { type: "run.interrupted", runId: run.runId } : { type: "run.failed", runId: run.runId, error: reason });
    }
    active = null;
    for (const t of waiting.splice(0)) emit({ type: "run.failed", runId: t.runId, error: reason });
    const c = conn;
    conn = null;
    const result = error ? { error: reason } : {};
    if (c === null) return resolveEnded(result);
    c.peer.close(reason);
    void c.proc.exited.then(() => resolveEnded(result));
    c.proc.kill();
  }

  function messageChunk(run: ActiveRun, messageId: unknown, content: unknown): void {
    const text = blockText(content);
    if (text === null) {
      logError(`${spec.id}: message content of type ${isObject(content) ? String(content.type) : typeof content} dropped`);
      return;
    }
    if (run.message && typeof messageId === "string" && run.message.itemId !== messageId) flushMessage(run);
    run.message ??= { itemId: typeof messageId === "string" ? messageId : `message-${run.runId}-${++run.messages}`, text: "" };
    run.message.text += text;
    emit({ type: "message.delta", runId: run.runId, itemId: run.message.itemId, text });
  }

  // v2 sends a whole message after (or instead of) its chunks.
  function wholeMessage(run: ActiveRun, messageId: string, content: unknown): void {
    if (!Array.isArray(content)) {
      // What was streamed under this id stays the message.
      logError(`${spec.id}: agent_message ${messageId} has no content list (${typeof content}); keeping the streamed text`);
      return flushMessage(run);
    }
    const text = content.map((b) => blockText(b) ?? "").join("");
    if (run.message?.itemId !== messageId) flushMessage(run);
    run.message = { itemId: messageId, text };
    flushMessage(run);
  }

  // v1 sends tool_call then tool_call_update; v2 only upserts with tool_call_update.
  function toolUpdate(run: ActiveRun, u: Json): void {
    const id = u.toolCallId;
    if (typeof id !== "string") {
      logError(`${spec.id}: ${u.sessionUpdate} without a toolCallId dropped`);
      return;
    }
    flushMessage(run);
    let t = run.tools.get(id);
    if (t === undefined) {
      t = { finished: false };
      run.tools.set(id, t);
      const input: Json = { title: u.title ?? null };
      if (u.rawInput !== undefined) input.rawInput = u.rawInput;
      if (u.locations != null) input.locations = u.locations;
      emit({ type: "tool.started", runId: run.runId, itemId: id, tool: typeof u.kind === "string" ? u.kind : "other", input });
    }
    if (Array.isArray(u.content)) t.content = u.content;
    if (u.rawOutput !== undefined) t.rawOutput = u.rawOutput;
    if (!t.finished && (u.status === "completed" || u.status === "failed")) {
      t.finished = true;
      emit({ type: "tool.finished", runId: run.runId, itemId: id, isError: u.status === "failed", output: toolOutput(t) });
    }
  }

  function planUpdate(run: ActiveRun, input: unknown, output: string): void {
    flushMessage(run);
    if (run.plan === null) {
      run.plan = { itemId: `plan-${run.runId}`, output };
      emit({ type: "tool.started", runId: run.runId, itemId: run.plan.itemId, tool: "plan", input });
    } else run.plan.output = output;
  }

  function onNotification(method: string, params: any): void {
    if (method !== "session/update") {
      logError(`${spec.id}: notification ${method} ignored`);
      return;
    }
    if (replaying) return;
    const u = params?.update;
    const kind = isObject(u) ? u.sessionUpdate : undefined;
    // Before the session check: Vibe reports usage for the session session/new is still creating.
    if (typeof kind === "string" && IGNORED_UPDATES.has(kind)) return;
    if (params?.sessionId !== sessionId) {
      logError(`${spec.id}: ${String(kind)} for session ${String(params?.sessionId)}, not ${sessionId}, dropped`);
      return;
    }
    if (!isObject(u) || typeof kind !== "string") {
      logError(`${spec.id}: session/update without an update kind dropped`);
      return;
    }
    if (kind === "state_update" && u.state !== "idle") return;
    const run = active;
    if (run === null) {
      logError(`${spec.id}: ${kind} outside a run dropped`);
      return;
    }
    switch (kind) {
      case "agent_message_chunk":
        return messageChunk(run, u.messageId, u.content);
      case "agent_message":
        if (typeof u.messageId === "string") return wholeMessage(run, u.messageId, u.content);
        break;
      case "tool_call":
      case "tool_call_update":
        return toolUpdate(run, u);
      case "plan":
        return planUpdate(run, u.entries, renderPlan(Array.isArray(u.entries) ? u.entries : []));
      case "plan_update": {
        const plan = u.plan;
        if (plan?.type === "items") return planUpdate(run, plan.entries, renderPlan(Array.isArray(plan.entries) ? plan.entries : []));
        if (plan?.type === "markdown") return planUpdate(run, plan.content, String(plan.content));
        logError(`${spec.id}: plan_update of type ${String(plan?.type)} dropped`);
        return;
      }
      case "state_update":
        if (version === 2) return finishRun(run, u.stopReason, u.usage);
        break;
    }
    logError(`${spec.id}: session update ${kind} is not handled`);
  }

  // devbox runs agents with everything approved: a permission request is answered with its allow option.
  async function onAgentRequest(method: string, params: any, id: Id): Promise<unknown> {
    if (method !== "session/request_permission") {
      logError(`${spec.id}: agent request ${method} is not handled`);
      throw new Error(`devbox does not handle ${method}`);
    }
    const options: Json[] = Array.isArray(params?.options) ? params.options : [];
    const pick = options.find((op) => op?.kind === "allow_always") ?? options.find((op) => op?.kind === "allow_once");
    const toolCall = params?.toolCall ?? params?.subject?.toolCall;
    const title = params?.title ?? toolCall?.title ?? null;
    if (!pick) {
      logError(`${spec.id}: permission request ${JSON.stringify(title)} has no allow option; refused`);
      throw new Error("devbox answers permission requests automatically, and this one has no allow option");
    }
    const run = active;
    if (run !== null) {
      const itemId = `permission-${String(id)}`;
      emit({ type: "tool.started", runId: run.runId, itemId, tool: "permission", input: { title, toolCallId: toolCall?.toolCallId ?? null } });
      emit({ type: "tool.finished", runId: run.runId, itemId, isError: false, output: `Auto-allowed: ${String(pick.name)}` });
    } else logError(`${spec.id}: permission request ${JSON.stringify(title)} outside a run auto-allowed`);
    return { outcome: { outcome: "selected", optionId: pick.optionId } };
  }

  starting = start(o.resume);
  starting.then(
    () => {
      starting = null;
      emit({ type: "thread.native", harness: spec.id, nativeThreadId: sessionId!, account: null, model: appliedModel, caps });
      markReady();
      startNext();
    },
    (e) => {
      starting = null;
      const reason = message(e);
      logError(`${spec.id} session start failed: ${reason}`);
      failReady(e instanceof Error ? e : new Error(reason));
      endSession(reason);
    },
  );

  return {
    async startTurn(runId, text, origin, images = []) {
      if (endReason !== null) throw new Error(endReason);
      // Read now: a file that cannot be read refuses the turn instead of failing it later.
      const blocks = images.map((p) => {
        const { mediaType, data } = readImageBase64(p);
        return { type: "image" as const, mimeType: mediaType, data };
      });
      waiting.push({ runId, text, origin, images: blocks });
      startNext();
    },
    async interrupt() {
      if (active === null) throw new Error("no active run");
      active.interrupted = true;
      // A notification: the prompt then ends with stopReason "cancelled". A prompt not sent yet is never sent.
      if (active.prompted) conn!.peer.notify("session/cancel", { sessionId });
    },
    async answer(requestId) {
      // Permission requests are answered automatically; ACP agents open no requests for the user.
      throw new Error(`no open request ${requestId}`);
    },
    async setModel(next) {
      await ready;
      if (endReason !== null) throw new Error(endReason);
      if (modelControl === null) throw new Error(`${spec.id} cannot switch models: the session offers no model option`);
      model = next;
      effort.update({ model });
    },
    async setEffort(level) {
      effort.check(level);
      effort.choose(level, null);
    },
    async injectItems() {
      throw new Error("injecting history items is not supported by ACP agents");
    },
    capabilities: () => caps,
    async close() {
      endSession(SESSION_ENDED, false);
    },
    ready,
    ended,
  };
}
