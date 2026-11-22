import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ACP_AGENTS, isAcpAgent } from "./acpAgents";
import { openAcpSession } from "./acpSession";
import { CLAUDE_CAPABILITIES, openClaudeSession, ResumeFailedError, type HarnessSession } from "./claudeSession";
import { prepareShadowHome, type HomesPaths } from "./codexHomes";
import { CODEX_CAPABILITIES, openCodexSession } from "./codexSession";
import { CONTINUATION_TEXT, CONTINUATION_WINDOW_MS, mayContinue } from "./continuation";
import { EventLog, type LogScan } from "./eventLog";
import type { BackgroundWork, BridgeEvent, RunOrigin, UsageBaseline } from "./events";
import { withImagePaths } from "./images";
import { DEFAULT_SOCKET } from "./mcp";
import { ACP_INSTRUCTIONS, acpMcpServers, APPENDED_SYSTEM_PROMPT, claudeMcpServers, codexMcpArgs } from "./prompts";
import type { BridgeCommand, HandoffDelivery, SwitchTarget, TurnOrigin } from "./protocol";
import { INHERITED_STRIP, isProxyProfile, proxyProfileEnv } from "./proxyProfile";
import { startServer } from "./server";
import { BRIDGE_SECRET_ENV, isBridgeSecret } from "./binding";
import { loadState, saveState, StateCorruptError, type BridgeState, type PersistedTarget } from "./state";
import { BRIDGE_VERSION } from "./version";
import { DeclaredWaits } from "./waits";

export { BRIDGE_VERSION };
export const DEFAULT_BRIDGE_DIR = "/run/devd/bridge";
export const CLAUDE_ACCOUNTS_ROOT = "/home/dev/.claude-accounts";
export const CODEX_ACCOUNTS_ROOT = "/home/dev/.codex-accounts";
export const RESTART_LOOP_ERROR = "restart loop: no automatic continuation";
export const NO_THREAD_ERROR = "restart before the conversation started; resend your message";
/** `run.failed` error for a message the log shows queued that the bridge's state no longer holds (state.json was
 *  lost, or a crash came between saving the state and announcing the message's end). */
export const LOST_QUEUED_ERROR = "the bridge lost this queued message in a restart; resend it";
/** `run.failed` error for a resume that did not work, at a switch or at start (on a run id no `run.started`
 *  announced); the bridge then awaits devd's fresh target. */
export const RESUME_FAILED = "resume-failed";
/** `run.failed` error (on a run id no `run.started` announced) for a switched target the bridge could not open at
 *  start, for another reason than a failed resume (an ACP agent without its login): the bridge awaits devd's target
 *  instead of exiting into a restart loop on it. */
export const OPEN_FAILED = "open-failed";
const AWAITING_TARGET_ERROR = "the bridge waits for devd to send switchTarget (after a restart or a failed resume)";

// Exit statuses of `agent-bridge serve`, read by agent-bridge-launch.
export const EXIT_STOPPED = 0;
export const EXIT_HARNESS_ENDED = 1;
export const EXIT_CONFIG = 3;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A configuration problem that a restart cannot fix; serve exits with EXIT_CONFIG. */
export class ConfigError extends Error {}
const WORKSPACE = "/workspace";
const SWEEP_MS = 30_000;
/** How old devd's ack must be before the event log is trimmed to it (ruling S6-R19). */
export const ACK_TRIM_DELAY_MS = 10 * 60_000;
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
  /** The thread has not had a prompt get through since it was opened new (BridgeState.instructionsPending). */
  instructionsPending: boolean;
  onInstructionsDelivered: () => void;
  /** The user's reasoning effort (BridgeState.effort); null = the harness's default. */
  effort: string | null;
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
  /** Size below which the event log is not trimmed (eventLog.ts COMPACT_MIN_BYTES); tests lower it. */
  logCompactMinBytes?: number;
  /** Answers devd's hello nonce (server.ts); none serves unbound. */
  binding?: { session: string; secret: string } | null;
  /** devd's one-time `<harness> <thread id>` for a session that continues an ended one (POST /api/ended/:id/continue):
   *  the first start resumes that thread. Consumed at every start. */
  resumeFile?: string;
}

/** Where devd leaves the thread a new session continues (devd/src/sessions.ts, also read by agent-launch.sh). */
export const DEFAULT_RESUME_FILE = "/run/devd/resume";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads and removes the resume file. `thread`: what to resume; `notice`: what bridge.started says about it. Only a
 *  first start (`fresh`) uses it: a bridge with state already has its thread. */
function takeResumeFile(path: string, harness: Harness, fresh: boolean): { thread: string | null; notice: string | null } {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { thread: null, notice: null }; }
  rmSync(path, { force: true });
  if (!fresh) return { thread: null, notice: null };
  const [h, id] = text.trim().split(/\s+/);
  if (h === harness && id !== undefined && THREAD_ID.test(id)) {
    return { thread: id, notice: `This session continues ${harness === "claude" ? "Claude" : harness} conversation ${id} of an ended session.` };
  }
  return { thread: null, notice: `The ended session's conversation was not resumed: devd asked for ${JSON.stringify(text.trim().slice(0, 80))}, which this ${harness} bridge cannot open; a new conversation starts.` };
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
  /** From DEVD_SESSION_ID and DEVD_BRIDGE_SECRET; null when devd gave no secret. */
  binding: { session: string; secret: string } | null;
  resumeFile: string;
}

function bindingFromEnv(env: Env): ServeConfig["binding"] {
  const secret = env[BRIDGE_SECRET_ENV];
  if (secret === undefined || secret === "") return null;
  if (!isBridgeSecret(secret)) throw new ConfigError(`${BRIDGE_SECRET_ENV} must be 64 lowercase hex characters`);
  const session = env.DEVD_SESSION_ID;
  if (!session) throw new ConfigError(`${BRIDGE_SECRET_ENV} is set but DEVD_SESSION_ID is not`);
  return { session, secret };
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
    resumeFile: env.DEVD_RESUME_FILE ?? DEFAULT_RESUME_FILE,
    binding: bindingFromEnv(env),
  };
}

/** The env a harness process starts with: the launch env without anything a proxy profile sets (and without
 *  ANTHROPIC_API_KEY), overlaid with the target's env. */
export function harnessEnv(launchEnv: Env, targetEnv: Record<string, string>): Env {
  const env: Env = { ...launchEnv };
  for (const k of INHERITED_STRIP) delete env[k];
  delete env[BRIDGE_SECRET_ENV]; // only the bridge proves the session; a harness has no use for the secret
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
        ...(o.instructionsPending ? { instructions: ACP_INSTRUCTIONS } : {}),
        onInstructionsDelivered: o.onInstructionsDelivered,
        baseEnv: env,
        emit: o.emit,
        effort: o.effort,
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
        effort: o.effort,
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
      effort: o.effort,
      logError,
    });
  };
}

/** A state.json that cannot be used, rebuilt from the event log (never a silent reset). What the log holds: the
 *  latest thread (`thread.native`), the run that was running (the last one started without an end) and the messages
 *  queued behind it (announced with `run.queued`, never started). What it does not: the continuation history, Claude's
 *  usage baseline, a pending handoff, a switched target's env, a message's harness text. A thread of another harness
 *  or account than the launch one cannot be opened with the launch env: the bridge awaits devd's target for it. */
function recoverState(scan: LogScan, launch: { harness: Harness; account: string | null; model: string | null }): { state: BridgeState; outcome: string } {
  const native = scan.lastNative?.event ?? null;
  const open = [...scan.openRuns];
  const started = open.filter(([, r]) => r.started);
  const state: BridgeState = {
    harness: launch.harness, nativeThreadId: null, account: launch.account, model: launch.model,
    activeRunId: started.length ? started[started.length - 1]![0] : null,
    queue: open.flatMap(([runId, r]) => (r.started || r.queued === null ? [] : [{ runId, text: r.queued.text, attachments: r.queued.attachments, ...(r.queued.origin ? { origin: r.queued.origin } : {}) }])),
    continuations: [], usageBaseline: null, target: null, pendingHandoff: null, instructionsPending: false, trimSeq: 0, ackCandidate: null, awaitingTarget: false,
    // The log does not keep the choice: a rebuilt state starts on the harness's default (effort.state says so).
    effort: null,
  };
  if (native === null) return { state, outcome: "there is no thread to resume, a new one opens" };
  if (native.harness === launch.harness && native.account === launch.account) {
    return { state: { ...state, nativeThreadId: native.nativeThreadId, model: native.model ?? launch.model }, outcome: `it resumes thread ${native.nativeThreadId}` };
  }
  // Another harness, or another account's home (the thread lives there): the launch env must not open it.
  const on = native.harness !== launch.harness ? native.harness : `account ${native.account ?? "(shared)"}, not this launch's ${launch.account ?? "(shared)"}`;
  return {
    state: { ...state, harness: native.harness as Harness, nativeThreadId: native.nativeThreadId, account: native.account, model: native.model, awaitingTarget: true },
    outcome: `thread ${native.nativeThreadId} is on ${on}, it waits for devd to send that target`,
  };
}

export async function serve(o: ServeOptions): Promise<Bridge> {
  const now = o.now ?? Date.now;
  const logError = o.logError ?? ((msg: string) => console.error(msg));
  mkdirSync(o.bridgeDir, { recursive: true });
  const statePath = join(o.bridgeDir, "state.json");
  const log = new EventLog(join(o.bridgeDir, "events.jsonl"), { logError, ...(o.logCompactMinBytes === undefined ? {} : { compactMinBytes: o.logCompactMinBytes }) });
  let loaded: BridgeState | null;
  /** Said in this start's `bridge.started` when state.json had to be rebuilt, or about devd's resume file. */
  let recoveryNotice: string | null = null;
  try {
    loaded = loadState(statePath);
  } catch (e) {
    if (!(e instanceof StateCorruptError)) throw new ConfigError(`${statePath} is unreadable: ${errorText(e)}`);
    // Kept for inspection; the rebuilt state replaces it.
    const kept = `${statePath}.corrupt-${now()}`;
    renameSync(statePath, kept);
    const r = recoverState(log.scan(), { harness: o.harness, account: o.account, model: o.model });
    loaded = r.state;
    recoveryNotice = `state.json was unusable (${e.message}); the bridge rebuilt its state from the event log: ${r.outcome}. `
      + `Lost with it: the automatic-continuation history, the usage baseline, an undelivered switch handoff, the chosen reasoning effort (back to the model's default). The damaged file is kept as ${basename(kept)}.`;
    logError(`agent-bridge: ${recoveryNotice}`);
  }
  // After a switch the persisted target is the session's harness, whatever the container was launched with (or,
  // after a recovery, devd sends it).
  if (loaded && loaded.target === null && !loaded.awaitingTarget && loaded.harness !== o.harness) {
    throw new ConfigError(`state.json belongs to a ${loaded.harness} thread but DEVD_AGENT is ${o.harness}; refusing to mix threads`);
  }
  const resume = o.resumeFile === undefined ? { thread: null, notice: null } : takeResumeFile(o.resumeFile, o.harness, loaded === null);
  if (resume.thread === null && resume.notice !== null) logError(`agent-bridge: ${resume.notice}`);
  if (resume.notice !== null) recoveryNotice = recoveryNotice === null ? resume.notice : `${recoveryNotice} ${resume.notice}`;
  const state: BridgeState = loaded ?? {
    harness: o.harness,
    nativeThreadId: resume.thread,
    account: o.account,
    model: o.model,
    activeRunId: null,
    queue: [],
    continuations: [],
    usageBaseline: null,
    target: null,
    pendingHandoff: null,
    instructionsPending: false,
    trimSeq: 0,
    ackCandidate: null,
    awaitingTarget: false,
    effort: null,
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
  let awaitingTarget = state.awaitingTarget || (state.target !== null && state.target.droppedEnvKeys.length > 0);
  let current: SwitchTarget | null = awaitingTarget ? null
    : state.target === null ? { harness: o.harness, account: o.account, model: o.model, env: o.targetEnv ?? {} }
    : { harness: state.target.harness, account: state.target.account, model: state.target.model, env: state.target.env };
  // Interrupted and queued runs of the previous bridge wait for a harness: from the start, or the next switchTarget.
  let recoveryPending = true;
  let switching = false;
  const persist = () => saveState(statePath, state);
  persist();
  // What devd acknowledged before this start is dropped from the log (once it is big), then what is still open read.
  // A failed trim is an explicit, logged degrade, not a silent fallback: the untrimmed log is complete and safe to run
  // on, while exiting would put the launcher into a restart loop over a size optimisation.
  try {
    const dropped = log.compact(state.trimSeq);
    if (dropped !== null) logError(`agent-bridge: trimmed ${dropped} acknowledged events from events.jsonl at start`);
  } catch (e) {
    logError(`agent-bridge: trimming events.jsonl at start failed, running on the untrimmed log: ${errorText(e)}`);
  }
  const scan = log.scan();

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
      case "effort.state":
        // The harness may have dropped a choice its (new) model does not offer: the state follows it.
        if (state.effort !== e.chosen) {
          state.effort = e.chosen;
          persist();
        }
        server.publish(e);
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
          server.publish({ type: "message.final", runId: e.runId, itemId: `user:${e.runId}`, role: "user", text: entry.text,
            ...(entry.attachments.length > 0 ? { attachments: entry.attachments } : {}) });
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
  /** No usable harness is left: exit for a restart once the command's reply is written (as for `stop`). */
  const exitAfterReply = () => {
    harness = null;
    setTimeout(() => void shutdown(EXIT_HARNESS_ENDED).catch((err) => logError(`agent-bridge: shutdown failed: ${errorText(err)}`)), 0);
  };

  // `retired` marks a harness serve closes on purpose (restartAgent, shutdown) or, opened by a switch or at start, one
  // that failed to open in a way the caller handles (`handlesFailure`: a failed resume, devd re-plans; a switched
  // target that cannot open); any other end exits serve so the launcher starts a fresh bridge that resumes the thread.
  function openHarness(handlesFailure: (e: unknown) => boolean = () => false): { session: HarnessSession; retired: boolean } {
    // No thread yet: the harness opens a new one, whose first prompt is still to come.
    if (state.nativeThreadId === null && !state.instructionsPending) {
      state.instructionsPending = true;
      persist();
    }
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
        instructionsPending: state.instructionsPending,
        onInstructionsDelivered: () => {
          state.instructionsPending = false;
          persist();
        },
        effort: state.effort,
      }),
    };
    // Registered before the end handler, so a handled failure is retired before its session's end is looked at.
    h.session.ready.catch((e) => {
      if (handlesFailure(e)) h.retired = true;
    });
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
  async function consumeHandoff(h: HarnessSession, text: string, origin: TurnOrigin): Promise<{ harnessText: string; putBack: HandoffDelivery | null }> {
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
    const label = origin === "critic" ? "Critic review" : "User message";
    return { harnessText: handoff.preamble === null ? text : `${handoff.preamble}\n\n${label}:\n${text}`, putBack: handoff };
  }

  /** Images go to a harness that takes them; any other gets their paths in its text (the thread still shows the
   *  user's own text with the images). */
  function sendTurn(session: HarnessSession, runId: string, harnessText: string, origin: RunOrigin, attachments: string[]): Promise<void> {
    if (attachments.length === 0) return session.startTurn(runId, harnessText, origin);
    if (!session.capabilities().images) return session.startTurn(runId, withImagePaths(harnessText, attachments), origin);
    return session.startTurn(runId, harnessText, origin, attachments);
  }

  async function startTurn(text: string, origin: TurnOrigin, attachments: string[]): Promise<{ runId: string }> {
    // The critic reviews the run that just ended; behind another run its follow-up would review stale work.
    if (origin === "critic" && (state.activeRunId !== null || state.queue.length > 0)) throw new Error("run-active");
    const runId = crypto.randomUUID();
    const queuedOrigin = origin === "critic" ? { origin } : {};
    if (recoveryPending) {
      // No usable harness yet: the message waits in the queue and starts with the recovered ones.
      state.queue.push({ runId, text, attachments, ...queuedOrigin });
      persist();
      announceQueued(runId, text, origin, attachments);
      return { runId };
    }
    const session = harness!.session;
    const { harnessText, putBack } = await consumeHandoff(session, text, origin);
    // Persisted before the harness sees it: a crash from here on still runs the message after the restart.
    // `run.started` removes it again.
    state.queue.push({ runId, text, attachments, ...(harnessText !== text ? { harnessText } : {}), ...queuedOrigin });
    persist();
    try {
      await sendTurn(session, runId, harnessText, origin, attachments);
    } catch (e) {
      state.queue = state.queue.filter((q) => q.runId !== runId);
      state.pendingHandoff = putBack;
      persist();
      throw e;
    }
    // The harness holds the turn (a run is active, or Codex has no thread yet).
    if (state.queue.some((q) => q.runId === runId)) announceQueued(runId, text, origin, attachments);
    return { runId };
  }

  function announceQueued(runId: string, text: string, origin: TurnOrigin, attachments: string[]): void {
    announced.add(runId);
    server.publish({ type: "run.queued", runId, text, attachments, ...(origin === "critic" ? { origin } : {}) });
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
    const previous = {
      current, target: state.target, harness: state.harness, account: state.account, model: state.model,
      nativeThreadId: state.nativeThreadId, pendingHandoff: state.pendingHandoff, usageBaseline: state.usageBaseline,
      instructionsPending: state.instructionsPending,
    };
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
    // Another thread resumed: it had its first prompt (a new one is marked when it opens).
    if (cmd.resume !== state.nativeThreadId) state.instructionsPending = false;
    state.nativeThreadId = cmd.resume;
    if (cmd.handoff !== null || !sameThread) state.pendingHandoff = cmd.handoff;
    persist();
    // Persisting a target that cannot open would restart the bridge into it forever, while devd's DB still names
    // the previous one: go back to that.
    const restorePrevious = () => {
      current = previous.current;
      state.target = previous.target;
      state.harness = previous.harness;
      state.account = previous.account;
      state.model = previous.model;
      state.nativeThreadId = previous.nativeThreadId;
      state.pendingHandoff = previous.pendingHandoff;
      state.usageBaseline = previous.usageBaseline;
      state.instructionsPending = previous.instructionsPending;
      persist();
    };
    let h: { session: HarnessSession; retired: boolean };
    try {
      h = openHarness(() => true);
    } catch (e) {
      // No harness at all now (the old one is retired): back to the previous target on disk, answer with the error,
      // then exit so the launcher starts a fresh bridge on it (as restartAgent).
      logError(`agent-bridge: opening ${target.harness} failed: ${errorText(e)}; back to ${previous.harness}, exiting for a restart`);
      restorePrevious();
      exitAfterReply();
      throw e;
    }
    harness = h;
    try {
      await h.session.ready;
    } catch (e) {
      if (e instanceof ResumeFailedError) {
        resumeFailed(e);
        return;
      }
      // Fail the switch with the agent's error and reopen the previous target.
      logError(`agent-bridge: opening ${target.harness} failed: ${errorText(e)}; back to ${previous.harness}`);
      restorePrevious();
      if (current !== null) await openCurrent();
      throw e;
    }
    awaitingTarget = false;
    if (state.awaitingTarget) {
      state.awaitingTarget = false;
      persist();
    }
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
        return startTurn(cmd.text, cmd.origin ?? "user", cmd.attachments ?? []);
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
        try {
          harness = openHarness();
        } catch (e) {
          // The old harness is closed and no new one opened: exit so the launcher starts a fresh bridge, after the
          // reply is written (as for `stop`).
          logError(`agent-bridge: reopening the harness failed: ${errorText(e)}; exiting for a restart`);
          exitAfterReply();
          throw e;
        }
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
      case "setEffort":
        // The harness being replaced would take it and the new one open without it.
        refuseWhileSwitching("effort change");
        await liveHarness().session.setEffort(cmd.effort);
        state.effort = cmd.effort;
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

  // Runs whose `run.queued` is in the log: their user message is stored already.
  const announced = new Set([...scan.openRuns].filter(([, r]) => r.queued !== null).map(([id]) => id));

  /** A hello: devd has stored everything up to `afterSeq`. Below the trim point it is told what it can no longer get. */
  function onHello(afterSeq: number): void {
    if (afterSeq < state.trimSeq) {
      // devd's store went back (restored from an older backup?): what was trimmed above its seq is gone here too.
      const text = `devd's thread store asked for events after seq ${afterSeq}, but the agent bridge's log was trimmed `
        + `through seq ${state.trimSeq}: events ${afterSeq + 1}-${state.trimSeq} are no longer available, except runs and `
        + `questions still open and the latest thread announcement.`;
      logError(`agent-bridge: ${text}`);
      try { server.publish({ type: "bridge.notice", text }); }
      catch (e) { logError(`agent-bridge: cannot publish the trim notice: ${errorText(e)}`); }
    }
    acknowledge(afterSeq);
  }

  /** devd has stored everything up to `seq` (a hello's afterSeq, or a periodic ack on a live link, S6-R21), but its
   *  store may still lose the newest of them in a power loss (WAL, synchronous=NORMAL). So the trim lags one ack
   *  (ruling S6-R19): an ack becomes the trim point only when a later ack comes at least ACK_TRIM_DELAY_MS after it and
   *  is not below it (a devd that came back lower replaces the candidate and keeps everything it misses). Persisted, so
   *  the next start trims with it too; a failure here is logged and never drops the link (the log just stays longer). */
  /** devd re-acknowledged `state.ackCandidate` in this process (never true for a candidate loaded from disk). */
  let candidateConfirmed = false;
  function acknowledge(seq: number): void {
    try {
      const ack = Math.min(seq, log.lastSeq());
      const t = now();
      const c = state.ackCandidate;
      if (c === null || ack < c.seq) {
        // A first ack, or devd came back below the candidate (it lost events it had acknowledged): the candidate is
        // not trimmed to; this ack starts ageing instead.
        state.ackCandidate = { seq: ack, at: t };
        candidateConfirmed = false;
      } else if (t - c.at >= ACK_TRIM_DELAY_MS) {
        state.trimSeq = c.seq;
        state.ackCandidate = { seq: ack, at: t };
        candidateConfirmed = false;
      } else {
        // devd still has the candidate: the sweep may promote it once it is old enough.
        candidateConfirmed = true;
      }
      persist();
      const n = log.compact(state.trimSeq);
      if (n !== null) logError(`agent-bridge: trimmed ${n} events devd acknowledged from events.jsonl`);
    } catch (e) {
      logError(`agent-bridge: trimming events.jsonl failed: ${errorText(e)}`);
    }
  }

  /** Promotes a candidate that devd confirmed in this process (a later hello or ack not below it) once it is
   *  ACK_TRIM_DELAY_MS old (S6-R19), and compacts the log once it has grown past the thresholds (one fstat per sweep
   *  otherwise; a compaction is one streamed pass, at most once per doubling of the log). Age alone never promotes: a
   *  candidate loaded from disk may predate a power loss that devd's store did not survive whole. Failures are logged;
   *  the log just stays longer. */
  function maintainLog(): void {
    try {
      const c = state.ackCandidate;
      if (c !== null && candidateConfirmed && now() - c.at >= ACK_TRIM_DELAY_MS) {
        state.trimSeq = c.seq;
        state.ackCandidate = null;
        candidateConfirmed = false;
        persist();
      }
      const n = log.compact(state.trimSeq);
      if (n !== null) logError(`agent-bridge: trimmed ${n} events devd acknowledged from events.jsonl`);
    } catch (e) {
      logError(`agent-bridge: trimming events.jsonl failed: ${errorText(e)}`);
    }
  }

  const server = startServer({ socketPath: o.socketPath, log, onCommand: handle, handshake: () => ({ version: BRIDGE_VERSION, awaitingTarget }), binding: o.binding ?? null, onHello, onAck: acknowledge, logError });
  const sweep = setInterval(() => {
    maintainLog();
    waits.sweep();
    const live = notOverdue(adapterWork);
    if (live.length !== adapterWork.length) {
      adapterWork = live;
      publishBackground();
    }
  }, o.sweepMs ?? SWEEP_MS);
  /** Opens `current` (at start, or again after a switch that could not open its target). A thread that cannot be
   *  resumed is devd's to re-plan (resumeFailed); a switched target that cannot open awaits devd's target (the user
   *  can switch away from it); any other failure ends the harness and serve exits for a restart. */
  async function openCurrent(): Promise<void> {
    const switched = state.target !== null;
    const h = openHarness((e) => e instanceof ResumeFailedError || switched);
    harness = h;
    try {
      await h.session.ready;
    } catch (e) {
      if (e instanceof ResumeFailedError) resumeFailed(e);
      else if (switched) openFailed(e);
      return;
    }
    awaitingTarget = false;
    if (recoveryPending) await recover();
  }

  function openFailed(e: unknown): void {
    logError(`agent-bridge: opening ${state.harness} failed: ${errorText(e)}; waiting for devd's target`);
    current = null;
    recoveryPending = true;
    awaitingTarget = true;
    server.publish({ type: "run.failed", runId: crypto.randomUUID(), error: OPEN_FAILED });
  }

  server.publish({
    type: "bridge.started",
    version: BRIDGE_VERSION,
    resumed: awaitingTarget || state.nativeThreadId !== null,
    ...(awaitingTarget ? { awaitingTarget: true } : {}),
    ...(recoveryNotice !== null ? { notice: recoveryNotice } : {}),
  });
  // The previous process's background work and declared waits died with it.
  server.publish({ type: "background.changed", work: [] });
  for (const requestId of scan.openRequests) server.publish({ type: "request.resolved", requestId, answer: null, by: "expired" });
  // Runs the log leaves open that state does not hold any more (a crash between saving the state and publishing their
  // end, or a lost state.json) would stay "running" or "queued" in devd's store forever: end them now. The active run
  // and the queue are recover()'s.
  const held = new Set([state.activeRunId, ...state.queue.map((q) => q.runId)]);
  for (const [runId, r] of scan.openRuns) {
    if (held.has(runId)) continue;
    if (r.started) server.publish({ type: "run.interrupted", runId });
    else server.publish({ type: "run.failed", runId, error: LOST_QUEUED_ERROR });
  }

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
      // An image deleted meanwhile fails that message, visibly; the ones behind it still run.
      const missing = q.attachments.find((p) => !existsSync(p));
      if (missing !== undefined) {
        state.queue = state.queue.filter((x) => x.runId !== q.runId);
        persist();
        if (!announced.has(q.runId)) announceQueued(q.runId, q.text, q.origin ?? "user", q.attachments);
        server.publish({ type: "run.failed", runId: q.runId, error: `attachment missing: ${missing}` });
        continue;
      }
      let sent = q.harnessText;
      if (sent === undefined) {
        // Queued while no harness was open: a pending handoff goes with the first of them.
        sent = (await consumeHandoff(session, q.text, q.origin ?? "user")).harnessText;
        const entry = state.queue.find((x) => x.runId === q.runId);
        if (entry && sent !== q.text) {
          entry.harnessText = sent;
          persist();
        }
      }
      await sendTurn(session, q.runId, sent, q.origin ?? "user", q.attachments);
      // A crash between persist() and the run.queued publish left the message unannounced.
      if (!announced.has(q.runId) && state.queue.some((x) => x.runId === q.runId)) announceQueued(q.runId, q.text, q.origin ?? "user", q.attachments);
    }
  }

  let harness: { session: HarnessSession; retired: boolean } | null = null;
  if (!awaitingTarget) await openCurrent();

  return { closed, close };
}

/** Entry for `agent-bridge serve`. Resolves with the exit status when the bridge stops; throws ConfigError. */
export async function runServe(env: Env = process.env): Promise<number> {
  const config = serveConfigFromEnv(env);
  if (config.harness === "claude" && !Bun.which("claude")) throw new ConfigError("claude binary not found on PATH");
  const logError = (msg: string) => console.error(msg);
  if (!config.binding) logError(`agent-bridge: ${BRIDGE_SECRET_ENV} is not set; serving unbound (devd refuses an unbound bridge for a session it gave a secret)`);
  const resolveOptions: ResolveOptions = { codexAccountsRoot: env.DEVD_CODEX_ACCOUNTS_DIR || CODEX_ACCOUNTS_ROOT, claudeExecutable: Bun.which("claude") };
  const bridge = await serve({ ...config, openHarness: harnessOpener(env, logError), resolveTarget: (t) => resolveTarget(t, resolveOptions), logError });
  return bridge.closed;
}
