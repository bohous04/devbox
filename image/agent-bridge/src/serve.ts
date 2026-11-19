import { mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ACP_AGENTS, isAcpAgent } from "./acpAgents";
import { openAcpSession } from "./acpSession";
import { CLAUDE_CAPABILITIES, openClaudeSession, ResumeFailedError, type HarnessSession } from "./claudeSession";
import { prepareShadowHome, type HomesPaths } from "./codexHomes";
import { CODEX_CAPABILITIES, openCodexSession } from "./codexSession";
import { CONTINUATION_TEXT, CONTINUATION_WINDOW_MS, mayContinue } from "./continuation";
import { EventLog } from "./eventLog";
import type { BackgroundWork, BridgeEvent, UsageBaseline } from "./events";
import { DEFAULT_SOCKET } from "./mcp";
import { ACP_INSTRUCTIONS, acpMcpServers, APPENDED_SYSTEM_PROMPT, claudeMcpServers, codexMcpArgs } from "./prompts";
import type { BridgeCommand, HandoffDelivery, SwitchTarget } from "./protocol";
import { INHERITED_STRIP, isProxyProfile, proxyProfileEnv } from "./proxyProfile";
import { startServer } from "./server";
import { loadState, saveState, type BridgeState, type PersistedTarget } from "./state";
import { DeclaredWaits } from "./waits";

export const BRIDGE_VERSION = "1.1.0";
export const DEFAULT_BRIDGE_DIR = "/run/devd/bridge";
export const CLAUDE_ACCOUNTS_ROOT = "/home/dev/.claude-accounts";
export const CODEX_ACCOUNTS_ROOT = "/home/dev/.codex-accounts";
export const RESTART_LOOP_ERROR = "restart loop: no automatic continuation";
export const NO_THREAD_ERROR = "restart before the conversation started; resend your message";
/** `run.failed` error for a resume that did not work, at a switch or at start (on a run id no `run.started`
 *  announced); the bridge then awaits devd's fresh target. */
export const RESUME_FAILED = "resume-failed";
const AWAITING_TARGET_ERROR = "the bridge waits for devd to send switchTarget (after a restart or a failed resume)";

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
  /** Env of the launch harness (a proxy profile's upstream); none for a subscription launch. */
  targetEnv?: Record<string, string>;
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
 *  else the standalone account home codex_account_prepare selected; none for an ACP agent (its own CLI login). */
export function accountFromEnv(harness: Harness, env: Env): string | null {
  if (harness === "claude") return accountDir(env.CLAUDE_CONFIG_DIR, CLAUDE_ACCOUNTS_ROOT);
  if (harness === "codex") return env.DEVD_CODEX_ACCOUNT_ID ? env.DEVD_CODEX_ACCOUNT_ID : accountDir(env.CODEX_HOME, CODEX_ACCOUNTS_ROOT);
  return null;
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
export interface ResolveOptions {
  codexAccountsRoot: string;
  homes?: Partial<HomesPaths>;
  /** The image's `claude`, or null when it is not on PATH. */
  claudeExecutable: string | null;
  /** PATH lookup of an ACP agent's binary; Bun.which unless a test replaces it. */
  which?: (bin: string) => string | null;
}

export function resolveTarget(t: SwitchTarget, r: ResolveOptions): SwitchTarget {
  if (isAcpAgent(t.harness)) {
    // An ACP agent runs on its own CLI login in its volume; devbox has no account to pick for it.
    if (t.account !== null) throw new Error(`switch target: ${t.harness} runs on its own CLI login, not on account ${t.account}`);
    const bin = ACP_AGENTS[t.harness].argv[0]!;
    if ((r.which ?? Bun.which)(bin) === null) throw new Error(`switch target: ${bin} (${t.harness}) not found on PATH`);
    return t;
  }
  if (t.harness === "claude") {
    if (r.claudeExecutable === null) throw new Error("switch target: claude binary not found on PATH");
    const dir = t.env.CLAUDE_CONFIG_DIR;
    if (!dir) throw new Error("switch target: CLAUDE_CONFIG_DIR is missing from the target env");
    if (!isDir(dir)) throw new Error(`switch target: Claude config dir ${dir} does not exist`);
    if (!t.env.ANTHROPIC_AUTH_TOKEN && fileSize(join(dir, ".credentials.json")) === 0) {
      throw new Error(`switch target: Claude account ${t.account ?? "(shared)"} has no credentials in ${dir} (sign it in first)`);
    }
    return t;
  }
  if (t.account === null) throw new Error("switch target: a Codex target needs an account");
  const home = prepareShadowHome(t.account, r.codexAccountsRoot, r.homes);
  return { ...t, env: { ...t.env, CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, "sqlite"), DEVD_CODEX_ACCOUNT_ID: t.account } };
}

const SECRET_KEY = /TOKEN|KEY|SECRET|PASSWORD/i;

/** The target as state.json may hold it: values of secret env keys are dropped and only their names kept
 *  (no secrets on disk); devd re-sends the full target after a restart. */
export function persistableTarget(t: SwitchTarget): PersistedTarget {
  const env: Record<string, string> = {};
  const droppedEnvKeys: string[] = [];
  for (const [k, v] of Object.entries(t.env)) {
    if (SECRET_KEY.test(k)) droppedEnvKeys.push(k);
    else env[k] = v;
  }
  return { harness: t.harness, account: t.account, model: t.model, env, droppedEnvKeys };
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
  /** The launch harness's own env: a proxy profile's (DEVD_AGENT=claude-gemini, …), else empty. */
  targetEnv: Record<string, string>;
  /** CLAUDE_CONFIG_DIR or CODEX_HOME; null for an ACP agent (its login lives in its own volume). */
  configHome: string | null;
  account: string | null;
  model: string | null;
  bridgeDir: string;
  socketPath: string;
}

export function serveConfigFromEnv(env: Env): ServeConfig {
  if (env.DEVD_RUNTIME !== "chat") throw new ConfigError(`agent-bridge serve needs DEVD_RUNTIME=chat (got ${JSON.stringify(env.DEVD_RUNTIME ?? null)})`);
  const agent = env.DEVD_AGENT;
  // A proxy profile is Claude Code against another upstream: the claude harness with the profile's env.
  const harness = isProxyProfile(agent) ? "claude" : agent;
  if (harness !== "claude" && harness !== "codex" && !isAcpAgent(harness)) {
    throw new ConfigError(`DEVD_AGENT must be claude, codex, an ACP agent (${Object.keys(ACP_AGENTS).join(", ")}) or a proxy profile (got ${JSON.stringify(agent ?? null)})`);
  }
  let targetEnv: Record<string, string> = {};
  if (isProxyProfile(agent)) {
    try { targetEnv = proxyProfileEnv(agent, env); }
    catch (e) { throw new ConfigError(e instanceof Error ? e.message : String(e)); }
  }
  const homeVar = harness === "claude" ? "CLAUDE_CONFIG_DIR" : harness === "codex" ? "CODEX_HOME" : null;
  const configHome = homeVar === null ? null : env[homeVar];
  if (homeVar !== null && !configHome) throw new ConfigError(`${homeVar} is not set`);
  return {
    harness,
    targetEnv,
    configHome: configHome ?? null,
    account: accountFromEnv(harness, env),
    model: env.DEVD_AGENT_MODEL ? env.DEVD_AGENT_MODEL : null,
    bridgeDir: env.DEVD_BRIDGE_DIR ?? DEFAULT_BRIDGE_DIR,
    socketPath: env.DEVD_AGENT_SOCK ?? DEFAULT_SOCKET,
  };
}

/** The env a harness process starts with: the launch env without anything a proxy profile sets (and without
 *  ANTHROPIC_API_KEY), overlaid with the target's env. */
export function harnessEnv(launchEnv: Env, targetEnv: Record<string, string>): Env {
  const env: Env = { ...launchEnv };
  for (const k of INHERITED_STRIP) delete env[k];
  return { ...env, ...targetEnv };
}

/** Opens the target's harness on the launch env overlaid with the target's env; the bridge's own process.env
 *  is never changed, so one harness's account env cannot leak into the other's. */
function harnessOpener(launchEnv: Env, logError: (msg: string) => void): OpenHarness {
  return (o) => {
    const env = harnessEnv(launchEnv, o.target.env);
    if (isAcpAgent(o.target.harness)) {
      const mcpCommand = Bun.which("agent-bridge");
      if (!mcpCommand) throw new Error("agent-bridge (the devbox MCP server) not found on PATH");
      return openAcpSession({
        spec: ACP_AGENTS[o.target.harness],
        cwd: WORKSPACE,
        model: o.target.model,
        resume: o.resume,
        mcpServers: acpMcpServers(mcpCommand),
        instructions: ACP_INSTRUCTIONS,
        baseEnv: env,
        emit: o.emit,
        logError,
      });
    }
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
  // A Claude/Codex target without its own home (a setModel on the launch target) keeps only the model choice: the
  // account is the one this launch leased, which a recreated container may have changed. An ACP target has no home
  // either, but it runs on the agent's own login and must never inherit the launch account.
  if (state.target !== null && !isAcpAgent(state.target.harness) && !state.target.env.CLAUDE_CONFIG_DIR && !state.target.env.CODEX_HOME) {
    state.target = persistableTarget({ harness: state.target.harness, account: o.account, model: state.target.model, env: o.targetEnv ?? {} });
  }
  state.account = state.target === null ? o.account : state.target.account;
  // A persisted target whose secret env values were dropped cannot be opened until devd sends it again. Also set
  // after a failed resume, until devd sends the fresh target; every handshake reports it.
  let awaitingTarget = state.target !== null && state.target.droppedEnvKeys.length > 0;
  let current: SwitchTarget | null = state.target === null
    ? { harness: o.harness, account: o.account, model: o.model, env: o.targetEnv ?? {} }
    : awaitingTarget ? null : { harness: state.target.harness, account: state.target.account, model: state.target.model, env: state.target.env };
  // Interrupted and queued runs of the previous bridge wait for a harness: from the start, or the next switchTarget.
  let recoveryPending = true;
  let switching = false;
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
        // A resumed Claude thread is announced before the CLI names its model; that null is not a model change.
        if (e.model !== null) state.model = e.model;
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
        await harness?.session.close();
      } finally {
        await server.close();
        markClosed(status);
      }
    })());
  const close = () => shutdown(EXIT_STOPPED);

  // `retired` marks a harness serve closes on purpose (restartAgent, shutdown) or, opened by a switch or at start, one
  // whose resume failed (devd re-plans); any other end exits serve so the launcher starts a fresh bridge that resumes
  // the thread.
  function openHarness(handlesResumeFailure = false): { session: HarnessSession; retired: boolean } {
    const h = {
      retired: false,
      session: o.openHarness({
        target: current!,
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
    if (handlesResumeFailure) {
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

  /** A switch's handoff goes with one user message: injected where the harness can, else as its preamble
   *  (devd's deliverInline format); the user's own text stays what the thread shows. It is cleared on disk before
   *  an injection, so a crash never injects it twice; `putBack` is what to restore if the turn does not start
   *  (null once injected). */
  async function consumeHandoff(h: HarnessSession, text: string): Promise<{ harnessText: string; putBack: HandoffDelivery | null }> {
    const handoff = state.pendingHandoff;
    if (handoff === null) return { harnessText: text, putBack: null };
    state.pendingHandoff = null;
    persist();
    if (handoff.injectItems && h.capabilities().injectItems) {
      try {
        await h.injectItems(handoff.injectItems);
      } catch (e) {
        state.pendingHandoff = handoff;
        persist();
        throw e;
      }
      return { harnessText: text, putBack: null };
    }
    return { harnessText: handoff.preamble === null ? text : `${handoff.preamble}\n\nUser message:\n${text}`, putBack: handoff };
  }

  async function startTurn(text: string): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    if (recoveryPending) {
      // No usable harness yet: the message waits in the queue and starts with the recovered ones.
      state.queue.push({ runId, text, attachments: [] });
      persist();
      announceQueued(runId, text);
      return { runId };
    }
    const session = harness!.session;
    const { harnessText, putBack } = await consumeHandoff(session, text);
    // Persisted before the harness sees it: a crash from here on still runs the message after the restart.
    // `run.started` removes it again.
    state.queue.push({ runId, text, attachments: [], ...(harnessText !== text ? { harnessText } : {}) });
    persist();
    try {
      await session.startTurn(runId, harnessText, "user");
    } catch (e) {
      state.queue = state.queue.filter((q) => q.runId !== runId);
      state.pendingHandoff = putBack;
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

  /** The harness, or an explicit error while there is none to talk to. */
  function liveHarness(): { session: HarnessSession; retired: boolean } {
    if (recoveryPending || harness === null) throw new Error(`no harness: ${AWAITING_TARGET_ERROR}`);
    return harness;
  }

  function refuseWhileSwitching(what: string): void {
    if (switching) throw new Error(`${what} refused: a switch is in progress`);
  }

  async function retireHarness(): Promise<void> {
    if (harness === null) return;
    harness.retired = true;
    await harness.session.close();
    if (adapterWork.length) {
      adapterWork = [];
      publishBackground();
    }
  }

  async function switchTarget(cmd: Extract<BridgeCommand, { kind: "switchTarget" }>): Promise<void> {
    refuseWhileSwitching("switch");
    switching = true;
    try {
      await doSwitch(cmd);
    } finally {
      switching = false;
    }
  }

  async function doSwitch(cmd: Extract<BridgeCommand, { kind: "switchTarget" }>): Promise<void> {
    // Runs left by the previous bridge are not active here: they start once this switch has opened the harness.
    if (!recoveryPending) refuseWhileRunning("switch");
    const target = o.resolveTarget(cmd.target);
    // ACP agents take no raw history items (acpSession.ts).
    const injects = target.harness === "claude" ? CLAUDE_CAPABILITIES.injectItems : target.harness === "codex" ? CODEX_CAPABILITIES.injectItems : false;
    if (cmd.handoff?.injectItems && cmd.handoff.preamble === null && !injects) {
      throw new Error(`switch refused: ${target.harness} cannot inject handoff items and the handoff has no preamble`);
    }
    await retireHarness();
    // A different thread (or harness) does not continue the old running usage totals.
    if (target.harness !== state.harness || cmd.resume !== state.nativeThreadId) state.usageBaseline = null;
    // The bridge owns the pending handoff: a handoff is a delta for its thread, so a switch without one that resumes
    // that same thread (a re-send after a restart, or another account or model on it) keeps it; a fresh or different
    // thread replaces it.
    const sameThread = cmd.resume !== null && cmd.resume === state.nativeThreadId;
    current = target;
    state.target = persistableTarget(target);
    state.harness = target.harness;
    state.account = target.account;
    state.model = target.model;
    state.nativeThreadId = cmd.resume;
    if (cmd.handoff !== null || !sameThread) state.pendingHandoff = cmd.handoff;
    persist();
    const h = openHarness(true);
    harness = h;
    try {
      await h.session.ready;
    } catch (e) {
      if (!(e instanceof ResumeFailedError)) throw e;
      resumeFailed(e);
      return;
    }
    awaitingTarget = false;
    if (recoveryPending) await recover();
  }

  /** The harness could not resume the thread: devd re-plans a fresh thread with a full handoff and sends it as
   *  switchTarget. Until then the bridge awaits that target (reported on every handshake); queued and new messages
   *  wait for it. A handoff still pending was a delta for the dead thread. The run id is new and never started:
   *  nothing ran. */
  function resumeFailed(e: ResumeFailedError): void {
    logError(`agent-bridge: ${e.message}; waiting for devd's fresh target`);
    state.nativeThreadId = null;
    state.pendingHandoff = null;
    persist();
    recoveryPending = true;
    awaitingTarget = true;
    server.publish({ type: "run.failed", runId: crypto.randomUUID(), error: RESUME_FAILED });
  }

  async function handle(cmd: BridgeCommand): Promise<unknown> {
    switch (cmd.kind) {
      case "startTurn":
        // HarnessSession has no attachment input yet; refusing beats dropping files the user sent.
        if (cmd.attachments?.length) throw new Error("attachments are not supported yet");
        return startTurn(cmd.text);
      case "interrupt":
        return liveHarness().session.interrupt();
      case "answer":
        return liveHarness().session.answer(cmd.requestId, cmd.answer);
      case "declareWait":
        return waits.declare(cmd.reason, cmd.waitKind, cmd.timeoutMinutes);
      case "endWait":
        return waits.clear();
      case "restartAgent": {
        refuseWhileSwitching("restart");
        liveHarness();
        refuseWhileRunning("restart");
        await retireHarness();
        harness = openHarness();
        return;
      }
      case "setModel":
        refuseWhileSwitching("model switch");
        liveHarness();
        refuseWhileRunning("model switch");
        await liveHarness().session.setModel(cmd.model);
        current = { ...current!, model: cmd.model };
        state.target = persistableTarget(current);
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
  const server = startServer({ socketPath: o.socketPath, log, onCommand: handle, handshake: () => ({ version: BRIDGE_VERSION, awaitingTarget }), logError });
  const sweep = setInterval(() => {
    waits.sweep();
    const live = notOverdue(adapterWork);
    if (live.length !== adapterWork.length) {
      adapterWork = live;
      publishBackground();
    }
  }, o.sweepMs ?? SWEEP_MS);
  /** Opens the target at start; a thread that cannot be resumed is devd's to re-plan (resumeFailed), any other
   *  failure ends the harness and serve exits for a restart. */
  async function startHarness(): Promise<void> {
    const h = openHarness(true);
    harness = h;
    try {
      await h.session.ready;
    } catch (e) {
      if (e instanceof ResumeFailedError) resumeFailed(e);
      return;
    }
    await recover();
  }

  server.publish({
    type: "bridge.started",
    version: BRIDGE_VERSION,
    resumed: awaitingTarget || state.nativeThreadId !== null,
    ...(awaitingTarget ? { awaitingTarget: true } : {}),
  });
  // The previous process's background work and declared waits died with it.
  server.publish({ type: "background.changed", work: [] });
  for (const requestId of unresolved) server.publish({ type: "request.resolved", requestId, answer: null, by: "expired" });

  /** Continues what the previous bridge left: the interrupted run, then the queued messages in order. */
  async function recover(): Promise<void> {
    recoveryPending = false;
    const session = harness!.session;
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
        await session.startTurn(crypto.randomUUID(), CONTINUATION_TEXT, "continuation");
      } else {
        server.publish({ type: "run.failed", runId: interrupted, error: RESTART_LOOP_ERROR });
      }
    }
    // Messages queued before the restart were accepted; they start after the continuation, in order.
    for (const q of queued) {
      let sent = q.harnessText;
      if (sent === undefined) {
        // Queued while no harness was open: a pending handoff goes with the first of them.
        sent = (await consumeHandoff(session, q.text)).harnessText;
        const entry = state.queue.find((x) => x.runId === q.runId);
        if (entry && sent !== q.text) {
          entry.harnessText = sent;
          persist();
        }
      }
      await session.startTurn(q.runId, sent, "user");
      // A crash between persist() and the run.queued publish left the message unannounced.
      if (!announced.has(q.runId) && state.queue.some((x) => x.runId === q.runId)) announceQueued(q.runId, q.text);
    }
  }

  let harness: { session: HarnessSession; retired: boolean } | null = null;
  if (!awaitingTarget) await startHarness();

  return { closed, close };
}

/** Entry for `agent-bridge serve`. Resolves with the exit status when the bridge stops; throws ConfigError. */
export async function runServe(env: Env = process.env): Promise<number> {
  const config = serveConfigFromEnv(env);
  if (config.harness === "claude" && !Bun.which("claude")) throw new ConfigError("claude binary not found on PATH");
  const logError = (msg: string) => console.error(msg);
  const resolveOptions: ResolveOptions = { codexAccountsRoot: env.DEVD_CODEX_ACCOUNTS_DIR || CODEX_ACCOUNTS_ROOT, claudeExecutable: Bun.which("claude") };
  const bridge = await serve({ ...config, openHarness: harnessOpener(env, logError), resolveTarget: (t) => resolveTarget(t, resolveOptions), logError });
  return bridge.closed;
}
