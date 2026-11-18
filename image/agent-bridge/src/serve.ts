import { mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLAUDE_CAPABILITIES, openClaudeSession, ResumeFailedError, type HarnessSession } from "./claudeSession";
import { prepareShadowHome, type HomesPaths } from "./codexHomes";
import { CODEX_CAPABILITIES, openCodexSession } from "./codexSession";
import { CONTINUATION_TEXT, CONTINUATION_WINDOW_MS, mayContinue } from "./continuation";
import { EventLog } from "./eventLog";
import type { BackgroundWork, BridgeEvent, UsageBaseline } from "./events";
import { DEFAULT_SOCKET } from "./mcp";
import { APPENDED_SYSTEM_PROMPT, claudeMcpServers, codexMcpArgs } from "./prompts";
import type { BridgeCommand, SwitchTarget } from "./protocol";
import { startServer } from "./server";
import { loadState, saveState, type BridgeState } from "./state";
import { DeclaredWaits } from "./waits";

export const BRIDGE_VERSION = "1.0.0";
export const DEFAULT_BRIDGE_DIR = "/run/devd/bridge";
export const CLAUDE_ACCOUNTS_ROOT = "/home/dev/.claude-accounts";
export const CODEX_ACCOUNTS_ROOT = "/home/dev/.codex-accounts";
export const RESTART_LOOP_ERROR = "restart loop: no automatic continuation";
export const NO_THREAD_ERROR = "restart before the conversation started; resend your message";
/** `run.failed` error for a switch whose resume did not work (on a run id no `run.started` announced). */
export const RESUME_FAILED = "resume-failed";

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
  /** Harness, account and model to open; `env` overrides the launch env for this harness process only. */
  target: SwitchTarget;
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
  /** Checks a switch target's account is usable and returns it with the env its harness needs; throws if not. */
  resolveTarget: (t: SwitchTarget) => SwitchTarget;
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

/** A Claude target needs its CLAUDE_CONFIG_DIR with credentials (a proxy profile authenticates with
 *  ANTHROPIC_AUTH_TOKEN instead); a Codex target gets its account's shadow home prepared, which fails without a
 *  signed-in auth.json. Throws before anything of the running session is touched. */
export function resolveTarget(t: SwitchTarget, codexAccountsRoot: string, homes?: Partial<HomesPaths>): SwitchTarget {
  if (t.harness === "claude") {
    const dir = t.env.CLAUDE_CONFIG_DIR;
    if (!dir) throw new Error("switch target: CLAUDE_CONFIG_DIR is missing from the target env");
    if (!isDir(dir)) throw new Error(`switch target: Claude config dir ${dir} does not exist`);
    if (!t.env.ANTHROPIC_AUTH_TOKEN && fileSize(join(dir, ".credentials.json")) === 0) {
      throw new Error(`switch target: Claude account ${t.account ?? "(shared)"} has no credentials in ${dir} (sign it in first)`);
    }
    return t;
  }
  if (t.account === null) throw new Error("switch target: a Codex target needs an account");
  const home = prepareShadowHome(t.account, codexAccountsRoot, homes);
  return { ...t, env: { ...t.env, CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, "sqlite"), DEVD_CODEX_ACCOUNT_ID: t.account } };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
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

/** Opens the target's harness on the launch env overlaid with the target's env; the bridge's own process.env
 *  is never changed, so one harness's account env cannot leak into the other's. */
function harnessOpener(launchEnv: Env, logError: (msg: string) => void): OpenHarness {
  return (o) => {
    const env: Env = { ...launchEnv, ...o.target.env };
    if (o.target.harness === "codex") {
      if (!env.CODEX_HOME) throw new Error("CODEX_HOME is not set for the Codex harness");
      return openCodexSession({
        cwd: WORKSPACE,
        model: o.target.model,
        codexHome: env.CODEX_HOME,
        baseEnv: env,
        resume: o.resume,
        mcpConfigArgs: [...codexMcpArgs(), ...codexAccountArgs(env)],
        developerInstructions: APPENDED_SYSTEM_PROMPT,
        emit: o.emit,
        logError,
      });
    }
    const claudeExecutable = Bun.which("claude");
    if (!claudeExecutable) throw new Error("claude binary not found on PATH");
    if (!env.CLAUDE_CONFIG_DIR) throw new Error("CLAUDE_CONFIG_DIR is not set for the Claude harness");
    return openClaudeSession({
      cwd: WORKSPACE,
      model: o.target.model,
      claudeExecutable,
      configDir: env.CLAUDE_CONFIG_DIR,
      baseEnv: env,
      resume: o.resume,
      mcpServers: claudeMcpServers(),
      appendSystemPrompt: APPENDED_SYSTEM_PROMPT,
      emit: o.emit,
      usageBaseline: o.usageBaseline,
      onUsageBaseline: o.onUsageBaseline,
      logError,
    });
  };
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
  // After a switch the persisted target is the session's harness, whatever the container was launched with.
  if (loaded && loaded.target === null && loaded.harness !== o.harness) {
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
    target: null,
    pendingHandoff: null,
  };
  if (state.target === null) state.account = o.account;
  let current: SwitchTarget = state.target ?? { harness: o.harness, account: o.account, model: o.model, env: {} };
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

  // `retired` marks a harness serve closes on purpose (restartAgent, shutdown) or, opened by a switch, one whose
  // resume failed (devd re-plans); any other end exits serve so the launcher starts a fresh bridge that resumes the
  // thread.
  function openHarness(forSwitch = false): { session: HarnessSession; retired: boolean } {
    const h = {
      retired: false,
      session: o.openHarness({
        target: current,
        resume: state.nativeThreadId,
        usageBaseline: state.usageBaseline,
        emit: onHarnessEvent,
        onUsageBaseline: (b) => {
          state.usageBaseline = b;
          persist();
        },
      }),
    };
    // Registered before the end handler, so a failed resume is retired before its session's end is looked at.
    if (forSwitch) {
      h.session.ready.catch((e) => {
        if (e instanceof ResumeFailedError) h.retired = true;
      });
    }
    const settled = h.session.ready.catch(() => {});
    void settled.then(async () => {
      const r = await h.session.ended;
      if (h.retired || closing) return;
      logError(`agent-bridge: harness ended${r.error ? `: ${r.error}` : ""}; exiting for a restart`);
      persist();
      void shutdown(EXIT_HARNESS_ENDED).catch((e) => logError(`agent-bridge: shutdown failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    return h;
  }

  async function startTurn(text: string): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    // A switch's handoff goes with this one message: injected where the harness can, else as its preamble
    // (devd's deliverInline format). The user's own text stays what the thread shows.
    const handoff = state.pendingHandoff;
    let harnessText = text;
    if (handoff?.injectItems && harness.session.capabilities().injectItems) await harness.session.injectItems(handoff.injectItems);
    else if (handoff && handoff.preamble !== null) harnessText = `${handoff.preamble}\n\nUser message:\n${text}`;
    // Persisted before the harness sees it: a crash from here on still runs the message after the restart.
    // `run.started` removes it again.
    state.queue.push({ runId, text, attachments: [], ...(harnessText !== text ? { harnessText } : {}) });
    state.pendingHandoff = null;
    persist();
    try {
      await harness.session.startTurn(runId, harnessText, "user");
    } catch (e) {
      state.queue = state.queue.filter((q) => q.runId !== runId);
      state.pendingHandoff = handoff;
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

  function refuseWhileRunning(what: string): void {
    if (state.activeRunId !== null || state.queue.length > 0) throw new Error(`${what} refused: a run is active or queued`);
  }

  async function retireHarness(): Promise<void> {
    harness.retired = true;
    await harness.session.close();
    if (adapterWork.length) {
      adapterWork = [];
      publishBackground();
    }
  }

  async function switchTarget(cmd: Extract<BridgeCommand, { kind: "switchTarget" }>): Promise<void> {
    refuseWhileRunning("switch");
    const target = o.resolveTarget(cmd.target);
    const caps = target.harness === "claude" ? CLAUDE_CAPABILITIES : CODEX_CAPABILITIES;
    if (cmd.handoff?.injectItems && cmd.handoff.preamble === null && !caps.injectItems) {
      throw new Error(`switch refused: ${target.harness} cannot inject handoff items and the handoff has no preamble`);
    }
    await retireHarness();
    // A different thread (or harness) does not continue the old running usage totals.
    if (target.harness !== current.harness || cmd.resume !== state.nativeThreadId) state.usageBaseline = null;
    current = target;
    state.target = target;
    state.harness = target.harness;
    state.account = target.account;
    state.model = target.model;
    state.nativeThreadId = cmd.resume;
    state.pendingHandoff = cmd.handoff;
    persist();
    const h = openHarness(true);
    harness = h;
    try {
      await h.session.ready;
    } catch (e) {
      if (!(e instanceof ResumeFailedError)) throw e;
      // devd re-plans with a fresh thread and a full handoff; this one's handoff was a delta for the dead thread.
      // The run id is new and never started: nothing ran.
      logError(`agent-bridge: ${e.message}`);
      state.nativeThreadId = null;
      state.pendingHandoff = null;
      persist();
      server.publish({ type: "run.failed", runId: crypto.randomUUID(), error: RESUME_FAILED });
    }
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
        refuseWhileRunning("restart");
        await retireHarness();
        harness = openHarness();
        return;
      }
      case "setModel":
        refuseWhileRunning("model switch");
        await harness.session.setModel(cmd.model);
        current = { ...current, model: cmd.model };
        state.target = current;
        state.model = cmd.model;
        persist();
        return;
      case "switchTarget":
        return switchTarget(cmd);
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
    await harness.session.startTurn(q.runId, q.harnessText ?? q.text, "user");
    // A crash between persist() and the run.queued publish left the message unannounced.
    if (!announced.has(q.runId) && state.queue.some((x) => x.runId === q.runId)) announceQueued(q.runId, q.text);
  }

  return { closed, close };
}

/** Entry for `agent-bridge serve`. Resolves with the exit status when the bridge stops; throws ConfigError. */
export async function runServe(env: Env = process.env): Promise<number> {
  const config = serveConfigFromEnv(env);
  if (config.harness === "claude" && !Bun.which("claude")) throw new ConfigError("claude binary not found on PATH");
  const logError = (msg: string) => console.error(msg);
  const codexAccountsRoot = env.DEVD_CODEX_ACCOUNTS_DIR || CODEX_ACCOUNTS_ROOT;
  const bridge = await serve({ ...config, openHarness: harnessOpener(env, logError), resolveTarget: (t) => resolveTarget(t, codexAccountsRoot), logError });
  return bridge.closed;
}
