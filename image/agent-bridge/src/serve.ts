import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openClaudeSession, type HarnessSession, type UsageBaseline } from "./claudeSession";
import { openCodexSession } from "./codexSession";
import { CONTINUATION_TEXT, CONTINUATION_WINDOW_MS, mayContinue } from "./continuation";
import { EventLog } from "./eventLog";
import type { BackgroundWork, BridgeEvent } from "./events";
import { DEFAULT_SOCKET } from "./mcp";
import { APPENDED_SYSTEM_PROMPT, claudeMcpServers, codexMcpArgs } from "./prompts";
import type { BridgeCommand } from "./protocol";
import { startServer } from "./server";
import { loadState, saveState, type BridgeState } from "./state";
import { DeclaredWaits } from "./waits";

export const BRIDGE_VERSION = "1.0.0";
export const DEFAULT_BRIDGE_DIR = "/run/devd/bridge";
export const CLAUDE_ACCOUNTS_ROOT = "/home/dev/.claude-accounts";
export const RESTART_LOOP_ERROR = "restart loop: no automatic continuation";
const WORKSPACE = "/workspace";
const SWEEP_MS = 30_000;

type Harness = BridgeState["harness"];

export interface HarnessOpenOptions {
  resume: string | null;
  usageBaseline: UsageBaseline | null;
  emit: (e: BridgeEvent) => void;
  onUsageBaseline: (b: UsageBaseline) => void;
}

export type OpenHarness = (o: HarnessOpenOptions) => HarnessSession;

export interface ServeOptions {
  bridgeDir: string;
  socketPath: string;
  harness: Harness;
  account: string | null;
  model: string | null;
  openHarness: OpenHarness;
  now?: () => number;
  logError?: (msg: string) => void;
}

export interface Bridge {
  /** Resolves once the bridge has shut down (after `stop` or `close`). */
  closed: Promise<void>;
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;

/** Account id for `thread.native`: the lease's profile dir for Claude, the selected Codex account otherwise. */
export function accountFromEnv(harness: Harness, env: Env): string | null {
  if (harness === "codex") return env.DEVD_CODEX_ACCOUNT_ID ? env.DEVD_CODEX_ACCOUNT_ID : null;
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir && dirname(dir) === CLAUDE_ACCOUNTS_ROOT ? basename(dir) : null;
}

export interface ServeConfig {
  harness: Harness;
  /** CLAUDE_CONFIG_DIR or CODEX_HOME. */
  configHome: string;
  account: string | null;
  model: string | null;
  bridgeDir: string;
  socketPath: string;
}

export function serveConfigFromEnv(env: Env): ServeConfig {
  if (env.DEVD_RUNTIME !== "chat") throw new Error(`agent-bridge serve needs DEVD_RUNTIME=chat (got ${JSON.stringify(env.DEVD_RUNTIME ?? null)})`);
  const harness = env.DEVD_AGENT;
  if (harness !== "claude" && harness !== "codex") throw new Error(`DEVD_AGENT must be claude or codex (got ${JSON.stringify(harness ?? null)})`);
  const homeVar = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const configHome = env[homeVar];
  if (!configHome) throw new Error(`${homeVar} is not set`);
  return {
    harness,
    configHome,
    account: accountFromEnv(harness, env),
    model: env.DEVD_AGENT_MODEL ? env.DEVD_AGENT_MODEL : null,
    bridgeDir: env.DEVD_BRIDGE_DIR ?? DEFAULT_BRIDGE_DIR,
    socketPath: env.DEVD_AGENT_SOCK ?? DEFAULT_SOCKET,
  };
}

function harnessOpener(c: ServeConfig, logError: (msg: string) => void): OpenHarness {
  if (c.harness === "codex") {
    return (o) =>
      openCodexSession({ cwd: WORKSPACE, model: c.model, codexHome: c.configHome, resume: o.resume, mcpConfigArgs: codexMcpArgs(), developerInstructions: APPENDED_SYSTEM_PROMPT, emit: o.emit, logError });
  }
  const claudeExecutable = Bun.which("claude");
  if (!claudeExecutable) throw new Error("claude binary not found on PATH");
  return (o) =>
    openClaudeSession({
      cwd: WORKSPACE,
      model: c.model,
      claudeExecutable,
      configDir: c.configHome,
      resume: o.resume,
      mcpServers: claudeMcpServers(),
      appendSystemPrompt: APPENDED_SYSTEM_PROMPT,
      emit: o.emit,
      usageBaseline: o.usageBaseline,
      onUsageBaseline: o.onUsageBaseline,
      logError,
    });
}

/** Request ids opened in the log and never resolved: a previous bridge died while they were open. */
function unresolvedRequests(log: EventLog): string[] {
  const open = new Set<string>();
  for (const { event } of log.readFrom(0)) {
    if (event.type === "request.opened") open.add(event.requestId);
    else if (event.type === "request.resolved") open.delete(event.requestId);
  }
  return [...open];
}

export async function serve(o: ServeOptions): Promise<Bridge> {
  const now = o.now ?? Date.now;
  const logError = o.logError ?? ((msg: string) => console.error(msg));
  mkdirSync(o.bridgeDir, { recursive: true });
  const statePath = join(o.bridgeDir, "state.json");
  const log = new EventLog(join(o.bridgeDir, "events.jsonl"));
  const loaded = loadState(statePath);
  if (loaded && loaded.harness !== o.harness) {
    throw new Error(`state.json belongs to a ${loaded.harness} thread but DEVD_AGENT is ${o.harness}; refusing to mix threads`);
  }
  const state: BridgeState = loaded ?? {
    harness: o.harness,
    nativeThreadId: null,
    account: o.account,
    model: o.model,
    activeRunId: null,
    queue: [],
    continuations: [],
    usageBaseline: null,
  };
  state.account = o.account;
  const persist = () => saveState(statePath, state);
  persist();

  let adapterWork: BackgroundWork[] = [];
  const publishBackground = () => server.publish({ type: "background.changed", work: [...adapterWork, ...waits.current()] });
  const waits = new DeclaredWaits(now, publishBackground);

  function onHarnessEvent(e: BridgeEvent): void {
    switch (e.type) {
      case "background.changed":
        // The adapter reports only its own work; devd sees one list including the declared wait.
        adapterWork = e.work;
        publishBackground();
        return;
      case "thread.native":
        state.nativeThreadId = e.nativeThreadId;
        state.model = e.model;
        persist();
        server.publish({ ...e, account: state.account });
        return;
      case "run.started":
        state.activeRunId = e.runId;
        state.queue = state.queue.filter((q) => q.runId !== e.runId);
        persist();
        break;
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
        if (state.activeRunId === e.runId) state.activeRunId = null;
        // A queued run fails without starting when the harness session ends.
        state.queue = state.queue.filter((q) => q.runId !== e.runId);
        persist();
        break;
    }
    server.publish(e);
  }

  const openHarness = () =>
    o.openHarness({
      resume: state.nativeThreadId,
      usageBaseline: state.usageBaseline,
      emit: onHarnessEvent,
      onUsageBaseline: (b) => {
        state.usageBaseline = b;
        persist();
      },
    });

  let closing: Promise<void> | null = null;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (markClosed = r));
  const close = () =>
    (closing ??= (async () => {
      clearInterval(sweep);
      try {
        await harness.close();
      } finally {
        await server.close();
        markClosed();
      }
    })());

  async function startTurn(text: string): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    const queued = state.activeRunId !== null || state.queue.length > 0;
    if (queued) {
      state.queue.push({ runId, text, attachments: [] });
      persist();
      server.publish({ type: "run.queued", runId, text, attachments: [] });
    }
    try {
      await harness.startTurn(runId, text, "user");
    } catch (e) {
      if (queued) {
        state.queue = state.queue.filter((q) => q.runId !== runId);
        persist();
        server.publish({ type: "run.failed", runId, error: e instanceof Error ? e.message : String(e) });
      }
      throw e;
    }
    return { runId };
  }

  async function handle(cmd: BridgeCommand): Promise<unknown> {
    switch (cmd.kind) {
      case "startTurn":
        // HarnessSession has no attachment input yet; refusing beats dropping files the user sent.
        if (cmd.attachments?.length) throw new Error("attachments are not supported yet");
        return startTurn(cmd.text);
      case "interrupt":
        return harness.interrupt();
      case "answer":
        return harness.answer(cmd.requestId, cmd.answer);
      case "declareWait":
        return waits.declare(cmd.reason, cmd.waitKind, cmd.timeoutMinutes);
      case "endWait":
        return waits.clear();
      case "restartAgent": {
        if (state.activeRunId !== null || state.queue.length > 0) throw new Error("restart refused: a run is active or queued");
        await harness.close();
        if (adapterWork.length) {
          adapterWork = [];
          publishBackground();
        }
        harness = openHarness();
        return;
      }
      case "stop":
        // After the reply is written: closing first would drop the client before it sees `res`.
        setTimeout(() => void close().catch((e) => logError(`agent-bridge: stop failed: ${e instanceof Error ? e.message : String(e)}`)), 0);
        return;
    }
  }

  const unresolved = unresolvedRequests(log);
  const server = startServer({ socketPath: o.socketPath, log, onCommand: handle, logError });
  const sweep = setInterval(() => waits.sweep(), SWEEP_MS);
  server.publish({ type: "bridge.started", version: BRIDGE_VERSION, resumed: state.nativeThreadId !== null });
  for (const requestId of unresolved) server.publish({ type: "request.resolved", requestId, answer: null, by: "expired" });

  let harness = openHarness();

  const interrupted = state.activeRunId;
  const queued = state.queue.map((q) => ({ ...q }));
  if (interrupted !== null) {
    state.activeRunId = null;
    persist();
    server.publish({ type: "run.interrupted", runId: interrupted });
    const t = now();
    if (mayContinue(state.continuations, t)) {
      state.continuations = [...state.continuations.filter((c) => t - c < CONTINUATION_WINDOW_MS), t];
      persist();
      await harness.startTurn(crypto.randomUUID(), CONTINUATION_TEXT, "continuation");
    } else {
      server.publish({ type: "run.failed", runId: interrupted, error: RESTART_LOOP_ERROR });
    }
  }
  // Messages queued before the restart were accepted; they start after the continuation, in order.
  for (const q of queued) await harness.startTurn(q.runId, q.text, "user");

  return { closed, close };
}

/** Entry for `agent-bridge serve`. Resolves when the bridge stops. */
export async function runServe(env: Env = process.env): Promise<void> {
  const config = serveConfigFromEnv(env);
  const logError = (msg: string) => console.error(msg);
  const bridge = await serve({ ...config, openHarness: harnessOpener(config, logError), logError });
  await bridge.closed;
}
