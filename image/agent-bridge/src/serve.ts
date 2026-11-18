import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openClaudeSession, type HarnessSession } from "./claudeSession";
import { openCodexSession } from "./codexSession";
import { CONTINUATION_TEXT, CONTINUATION_WINDOW_MS, mayContinue } from "./continuation";
import { EventLog } from "./eventLog";
import type { BackgroundWork, BridgeEvent, UsageBaseline } from "./events";
import { DEFAULT_SOCKET } from "./mcp";
import { APPENDED_SYSTEM_PROMPT, claudeMcpServers, codexMcpArgs } from "./prompts";
import type { BridgeCommand } from "./protocol";
import { startServer } from "./server";
import { loadState, saveState, type BridgeState } from "./state";
import { DeclaredWaits } from "./waits";

export const BRIDGE_VERSION = "1.0.0";
export const DEFAULT_BRIDGE_DIR = "/run/devd/bridge";
export const CLAUDE_ACCOUNTS_ROOT = "/home/dev/.claude-accounts";
export const CODEX_ACCOUNTS_ROOT = "/home/dev/.codex-accounts";
export const RESTART_LOOP_ERROR = "restart loop: no automatic continuation";
export const NO_THREAD_ERROR = "restart before the conversation started; resend your message";

// Exit statuses of `agent-bridge serve`, read by agent-bridge-launch.
export const EXIT_STOPPED = 0;
export const EXIT_HARNESS_ENDED = 1;
export const EXIT_CONFIG = 3;

/** A configuration problem that a restart cannot fix; serve exits with EXIT_CONFIG. */
export class ConfigError extends Error {}
const WORKSPACE = "/workspace";
const SWEEP_MS = 30_000;
// Adapter work with an `until` (a ScheduleWakeup) is dropped this long after its time: the agent was meant to
// wake by then. A wakeup that fires during a user run is folded into it and never cleared by the adapter.
export const OVERDUE_MARGIN_MS = 60_000;

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
  /** Interval of the expiry sweep; tests shorten it. */
  sweepMs?: number;
}

export interface Bridge {
  /** Resolves with the exit status once the bridge has shut down: EXIT_STOPPED after `stop` or `close`,
   *  EXIT_HARNESS_ENDED when the harness process went away by itself. */
  closed: Promise<number>;
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;

function accountDir(dir: string | undefined, root: string): string | null {
  return dir && dirname(dir) === root ? basename(dir) : null;
}

/** Account id for `thread.native`: the lease's profile dir for Claude; for Codex the explicit account,
 *  else the standalone account home codex_account_prepare selected. */
export function accountFromEnv(harness: Harness, env: Env): string | null {
  if (harness === "claude") return accountDir(env.CLAUDE_CONFIG_DIR, CLAUDE_ACCOUNTS_ROOT);
  return env.DEVD_CODEX_ACCOUNT_ID ? env.DEVD_CODEX_ACCOUNT_ID : accountDir(env.CODEX_HOME, CODEX_ACCOUNTS_ROOT);
}

/** `co`'s per-account config overrides, so app-server reads the same auth and state as the TUI would. */
export function codexAccountArgs(env: Env): string[] {
  const args = ["-c", 'cli_auth_credentials_store="file"'];
  if (env.CODEX_SQLITE_HOME) args.push("-c", `sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME)}`);
  return args;
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
  if (env.DEVD_RUNTIME !== "chat") throw new ConfigError(`agent-bridge serve needs DEVD_RUNTIME=chat (got ${JSON.stringify(env.DEVD_RUNTIME ?? null)})`);
  const harness = env.DEVD_AGENT;
  if (harness !== "claude" && harness !== "codex") throw new ConfigError(`DEVD_AGENT must be claude or codex (got ${JSON.stringify(harness ?? null)})`);
  const homeVar = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const configHome = env[homeVar];
  if (!configHome) throw new ConfigError(`${homeVar} is not set`);
  return {
    harness,
    configHome,
    account: accountFromEnv(harness, env),
    model: env.DEVD_AGENT_MODEL ? env.DEVD_AGENT_MODEL : null,
    bridgeDir: env.DEVD_BRIDGE_DIR ?? DEFAULT_BRIDGE_DIR,
    socketPath: env.DEVD_AGENT_SOCK ?? DEFAULT_SOCKET,
  };
}

function harnessOpener(c: ServeConfig, env: Env, logError: (msg: string) => void): OpenHarness {
  if (c.harness === "codex") {
    const mcpConfigArgs = [...codexMcpArgs(), ...codexAccountArgs(env)];
    return (o) =>
      openCodexSession({ cwd: WORKSPACE, model: c.model, codexHome: c.configHome, resume: o.resume, mcpConfigArgs, developerInstructions: APPENDED_SYSTEM_PROMPT, emit: o.emit, logError });
  }
  const claudeExecutable = Bun.which("claude");
  if (!claudeExecutable) throw new ConfigError("claude binary not found on PATH");
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

/** From the previous bridge's log: request ids opened and never resolved (it died while they were open), and the
 *  runs whose user message was already announced with `run.queued`. */
function scanLog(log: EventLog): { unresolved: string[]; announced: Set<string> } {
  const open = new Set<string>();
  const announced = new Set<string>();
  for (const { event } of log.readFrom(0)) {
    if (event.type === "request.opened") open.add(event.requestId);
    else if (event.type === "request.resolved") open.delete(event.requestId);
    else if (event.type === "run.queued") announced.add(event.runId);
  }
  return { unresolved: [...open], announced };
}

export async function serve(o: ServeOptions): Promise<Bridge> {
  const now = o.now ?? Date.now;
  const logError = o.logError ?? ((msg: string) => console.error(msg));
  mkdirSync(o.bridgeDir, { recursive: true });
  const statePath = join(o.bridgeDir, "state.json");
  const log = new EventLog(join(o.bridgeDir, "events.jsonl"));
  let loaded: BridgeState | null;
  try {
    loaded = loadState(statePath);
  } catch (e) {
    throw new ConfigError(`${statePath} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (loaded && loaded.harness !== o.harness) {
    throw new ConfigError(`state.json belongs to a ${loaded.harness} thread but DEVD_AGENT is ${o.harness}; refusing to mix threads`);
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
  const notOverdue = (work: BackgroundWork[]) => work.filter((w) => w.until === undefined || w.until + OVERDUE_MARGIN_MS > now());
  const publishBackground = () => server.publish({ type: "background.changed", work: [...adapterWork, ...waits.current()] });
  const waits = new DeclaredWaits(now, publishBackground);

  function onHarnessEvent(e: BridgeEvent): void {
    switch (e.type) {
      case "background.changed":
        // The adapter reports only its own work; devd sees one list including the declared wait.
        adapterWork = notOverdue(e.work);
        publishBackground();
        return;
      case "thread.native":
        state.nativeThreadId = e.nativeThreadId;
        state.model = e.model;
        persist();
        server.publish({ ...e, account: state.account });
        return;
      case "run.started": {
        const entry = state.queue.find((q) => q.runId === e.runId);
        state.activeRunId = e.runId;
        state.queue = state.queue.filter((q) => q.runId !== e.runId);
        persist();
        server.publish(e);
        // A user run that starts without having been queued carries its text nowhere else: store it right
        // after its start, before anything the agent says.
        if (entry && !announced.has(e.runId)) {
          server.publish({ type: "message.final", runId: e.runId, itemId: `user:${e.runId}`, role: "user", text: entry.text });
        }
        return;
      }
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

  let closing: Promise<void> | null = null;
  let markClosed: (status: number) => void = () => {};
  const closed = new Promise<number>((r) => (markClosed = r));
  const shutdown = (status: number) =>
    (closing ??= (async () => {
      clearInterval(sweep);
      try {
        await harness.session.close();
      } finally {
        await server.close();
        markClosed(status);
      }
    })());
  const close = () => shutdown(EXIT_STOPPED);

  // `retired` marks a harness serve closes on purpose (restartAgent, shutdown); any other end exits serve so the
  // launcher starts a fresh bridge that resumes the thread.
  function openHarness(): { session: HarnessSession; retired: boolean } {
    const h = {
      retired: false,
      session: o.openHarness({
        resume: state.nativeThreadId,
        usageBaseline: state.usageBaseline,
        emit: onHarnessEvent,
        onUsageBaseline: (b) => {
          state.usageBaseline = b;
          persist();
        },
      }),
    };
    void h.session.ended.then((r) => {
      if (h.retired || closing) return;
      logError(`agent-bridge: harness ended${r.error ? `: ${r.error}` : ""}; exiting for a restart`);
      persist();
      void shutdown(EXIT_HARNESS_ENDED).catch((e) => logError(`agent-bridge: shutdown failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    return h;
  }

  async function startTurn(text: string): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    // Persisted before the harness sees it: a crash from here on still runs the message after the restart.
    // `run.started` removes it again.
    state.queue.push({ runId, text, attachments: [] });
    persist();
    try {
      await harness.session.startTurn(runId, text, "user");
    } catch (e) {
      state.queue = state.queue.filter((q) => q.runId !== runId);
      persist();
      throw e;
    }
    // The harness holds the turn (a run is active, or Codex has no thread yet).
    if (state.queue.some((q) => q.runId === runId)) announceQueued(runId, text);
    return { runId };
  }

  function announceQueued(runId: string, text: string): void {
    announced.add(runId);
    server.publish({ type: "run.queued", runId, text, attachments: [] });
  }

  async function handle(cmd: BridgeCommand): Promise<unknown> {
    switch (cmd.kind) {
      case "startTurn":
        // HarnessSession has no attachment input yet; refusing beats dropping files the user sent.
        if (cmd.attachments?.length) throw new Error("attachments are not supported yet");
        return startTurn(cmd.text);
      case "interrupt":
        return harness.session.interrupt();
      case "answer":
        return harness.session.answer(cmd.requestId, cmd.answer);
      case "declareWait":
        return waits.declare(cmd.reason, cmd.waitKind, cmd.timeoutMinutes);
      case "endWait":
        return waits.clear();
      case "restartAgent": {
        if (state.activeRunId !== null || state.queue.length > 0) throw new Error("restart refused: a run is active or queued");
        harness.retired = true;
        await harness.session.close();
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

  const { unresolved, announced } = scanLog(log);
  const server = startServer({ socketPath: o.socketPath, log, onCommand: handle, logError });
  const sweep = setInterval(() => {
    waits.sweep();
    const live = notOverdue(adapterWork);
    if (live.length !== adapterWork.length) {
      adapterWork = live;
      publishBackground();
    }
  }, o.sweepMs ?? SWEEP_MS);
  server.publish({ type: "bridge.started", version: BRIDGE_VERSION, resumed: state.nativeThreadId !== null });
  // The previous process's background work and declared waits died with it.
  server.publish({ type: "background.changed", work: [] });
  for (const requestId of unresolved) server.publish({ type: "request.resolved", requestId, answer: null, by: "expired" });

  let harness = openHarness();

  const interrupted = state.activeRunId;
  const queued = state.queue.map((q) => ({ ...q }));
  if (interrupted !== null) {
    state.activeRunId = null;
    persist();
    const t = now();
    if (state.nativeThreadId === null) {
      // Nothing to resume: a continuation would land in a fresh conversation without the user's message.
      server.publish({ type: "run.failed", runId: interrupted, error: NO_THREAD_ERROR });
    } else if (mayContinue(state.continuations, t)) {
      server.publish({ type: "run.interrupted", runId: interrupted });
      state.continuations = [...state.continuations.filter((c) => t - c < CONTINUATION_WINDOW_MS), t];
      persist();
      await harness.session.startTurn(crypto.randomUUID(), CONTINUATION_TEXT, "continuation");
    } else {
      server.publish({ type: "run.failed", runId: interrupted, error: RESTART_LOOP_ERROR });
    }
  }
  // Messages queued before the restart were accepted; they start after the continuation, in order.
  for (const q of queued) {
    await harness.session.startTurn(q.runId, q.text, "user");
    // A crash between persist() and the run.queued publish left the message unannounced.
    if (!announced.has(q.runId) && state.queue.some((x) => x.runId === q.runId)) announceQueued(q.runId, q.text);
  }

  return { closed, close };
}

/** Entry for `agent-bridge serve`. Resolves with the exit status when the bridge stops; throws ConfigError. */
export async function runServe(env: Env = process.env): Promise<number> {
  const config = serveConfigFromEnv(env);
  const logError = (msg: string) => console.error(msg);
  const bridge = await serve({ ...config, openHarness: harnessOpener(config, env, logError), logError });
  return bridge.closed;
}
