import type { AgentUpkeepResult, AgentUpkeepStatus, UpkeepProvider } from "../../shared/agentUpkeep";
import { createCodexResetReader } from "./codexResets";
import { buildWeeklyUsage, weeklyUsageRange } from "./weeklyUsage";
import { safeOperationError } from "./operationExec";
import { RemoteRestoreError } from "../../infra/codex-remote/restoreSession";
import { Hono, type Context } from "hono";
import { OpRateLimited } from "./opRateLimit";
import { upgradeWebSocket } from "hono/bun";
import { dashboardOrigins, originGuard, stateChangingGetGuard } from "./originGuard";
import { shareHostFromEnv } from "./shareListener";
import { compress } from "hono/compress";
import { StaticFiles } from "./static";
import type { Vault } from "./vault";
import { OPERATIONS, validateParams } from "./operations";
import type { DbTargets } from "./dbTargets";
import { createDbRequest, getDbRequest, listDbRequests, serverReady, setDbRequestStatus } from "./dbRequests";
import { addGrant, grantAccess, reloadCatalog } from "./prodDb";
import { createDbOnboarding, type OnboardingHost } from "./dbOnboarding";
import { discoverDatabaseTargets, listCoolifyDatabases, type CoolifyInstance } from "./coolify";
import { addDatabase, type Engine } from "./prodDb";
import { getOperation, listOperations, proposeOperation, setOperationStatus } from "./operationStore";
import type { Database } from "bun:sqlite";
import { createBridge, terminalGuard, terminalTarget, type Bridge, type SpawnPty } from "./terminal";
import { execInContainer } from "./docker";
import { createReadStream, openSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { liveActivitiesRoutes, type LiveActivities } from "./liveActivities";
import { AGENT_EVENTS, type AgentEvent, type AgentEventHub, type HookMeta, type NotifyFn } from "./agentEvents";
import { AGENT_IDS, AGENTS, instaboxAgentBlock, specFor, type Upstream } from "./agents";
import { buildProjectLeaderboard, buildRange, buildSessionUsage, buildTotals, buildWorkHours, predictDisk, PROMPT_CHARS, PROMPT_WAIT } from "./aggregate";
import { buildAccountViews, toCandidates } from "./accounts";
import { currentAccount, lastSwitchAt } from "./accountLease";
import { chooseAccount } from "./accountPolicy";
import type { SwitchAccountResult } from "./accountSwitch";
import type { SwitchAgentResult } from "./agentSwitch";
import { isValidAccountId, profileIdentity, profileVolume, provisionProfile, removeProfile, writeProfileCredentials, type ProfileDeps, type ProfileRemoval } from "./accountProfiles";
import { credentialsInputError, normalizeCredentialsInput, parseTierWeight, withTierLabel } from "./accountTokens";
import type { CloneQueue } from "./clone";
import { validateConfig, type AccountPoolSettings, type DevConfig, type InstaboxSettings } from "./config";
import { remoteDockerAlias } from "./dockerTarget";
import { IbxPreconditionError, type InstaboxSessions } from "./instabox/sessions";
import type { IbxStatus } from "./instabox/reconcile";
import { suggestPlacement, type HostLoad } from "./placement";
import { proxyContextRows } from "./proxyContext";
import type { ConfigRepo } from "./configrepo";
import { countEvents, diskHistoryEnds, distinctEventTypes, getHarvestState, getRepoAgent, getSession, insertMetrics, insertNotifyLog, isAgentName, lastMetricTs, listCriticReviews, listEvents, listNotifyLog, listRepoAgents, listSessions, logEvent, resetStats, sanitizeSessionName, setCritic, setHarvestState, setImportant, setNotifyVerdict, setSessionName, deleteSchedule, getSchedule, insertSchedule, listSchedules, updateSchedule, deleteAccount, getAccount, insertAccount, insertLease, isLeaseClient, leaseHistory, setAccountDisabled, setAccountLabel, setAccountOrgId, setAccountQuarantined, setAccountWeight, ackPushAlert, upsertPushDevice, type AgentName, type LeaseClient, type NotifyDecision, type NotifyVerdict, type ScheduleRow, type SessionRow } from "./db";
import { validCron } from "./cron";
import { memoAsync } from "./cache";
import { GithubError, listOwners, listRepos, validOwner, type GithubOwner, type GithubRepo } from "./github";
import { GiteaAuthError, GiteaError, GiteaUnknownInstanceError, type GiteaApi } from "./gitea";
import { join } from "node:path";
import { stageFile, stageShared } from "./inbox";
import type { SshKeyRef } from "./op";
import { resolveSshTarget, type SshServer } from "./sshServers";
import { dbEntry, roUrl, entitledDbs, type Catalog, type Access, type DbEntry, type ServerRef } from "./prodDb";
import { createProposal, listProposals, getProposal, setStatus, type WriteStatus, type WriteScope } from "./prodWrites";
import type { ListenerClient } from "./listener";
import { agentContextTokens, ExternalStartError, resolveAgent, RestartError, SessionBusyError, type SessionManager } from "./sessions";
import { localEnvProfiles } from "./localEnv";
import { parseOtlpMetrics, pointsToRows } from "./metrics";
import { classifyClaudeState } from "./stats";
import { isValidTmuxName, killSessionCmd, labelSetCmd, parseProbe, probeCmd, type TmuxSession } from "./tmux";
import { sessionWorkdir, type TreeProject } from "./tree";
import { COMMIT, VERSION } from "./version";
import type { Decision } from "./criticGate";
import {
  authStatus, codexLoginStart, codexLoginStatus, codexLogout, CLIPROXY_CALLBACK_PORT,
  grokLoginStart, grokLoginStatus, proxyLoginStart, proxyLoginStatus, isProxyProvider,
  agyLoginStart, agyLoginCode, agyLoginStatus, agyLogout, isValidAgyCode,
  type CodexAuthDeps,
} from "./agentAuth";
import type { CodexView } from "./codexPoller";
import type { GrokView } from "./grokPoller";
import type { GrokSidMap } from "./grokHarvester";
import type { AgySidMap } from "./antigravityHarvester";
import type { CcStatus, UpkeepResult } from "./ccUpkeep";
import { isRangeKey } from "./beszel";
import type { Hardware } from "./hardware";
import type { SshAgents } from "./sshAgent";
import {
  activateApproval, parseGrantDuration, createApproval, decideApproval, getApproval,
  listApprovals, listGrants, liveGrant, liveKeyGrant, pendingSshLabel, revokeGrant, APPROVAL_TTL_MS,
} from "./sshApprovals";
import { isApprovalAllowed, isInstaboxAddress } from "./network";
import { createShare, isShared, listActiveShares, revokeShare, SHARE_MAX_MINUTES } from "./shares";
import { containerIdentity as defaultContainerIdentity, type ContainerIdentity, SHARED_DENIED, SharedSessions, sharedContainerGuard } from "./containerIdentity";
import { dockerContainerId, isTainted, markTainted, sessionsWithTaint, stopDindSidecar } from "./shareTaint";
import { createRateLimiter } from "./rateLimit";
import type { PushResult, UnpushedReport } from "./unpushed";
import { codexAccountsRoutes, type CodexAccounts } from "./codexAccounts";
import { CodexSessionAccountError, type CodexSessionAccounts } from "./codexSessionAccounts";

export interface IbxBaseJobView { id: string; status: "running" | "done" | "error"; step: string; error?: string; startedAt: number }

/** Steps restricting a session when a share is created. */
export interface ShareLockdown {
  /** Docker id of the session container (null = does not exist). */
  containerId(container: string): Promise<string | null>;
  /** Stops the session's dind sidecar; failure = exception (the share is then not created). */
  stopDind(session: string): Promise<void>;
  /** Recomputes network rules for restricted containers (shareFirewall.ts); failure = exception. */
  syncFirewall?(): Promise<void>;
}

const endSyncWaitMs = () => Number(process.env.DEVD_END_SYNC_WAIT_MS ?? 20_000);

export interface ApiDeps { mgr: SessionManager; db: Database; cfg: DevConfig; root: string; tree: () => Promise<TreeProject[]>; listener: ListenerClient; notify: NotifyFn; stats: () => unknown; resources?: () => unknown; cloneQueue: CloneQueue; configRepo: ConfigRepo; dashboardDir?: string; previewHost?: string; backup: { build: () => Promise<string>; restore: (tarPath: string) => Promise<void> }; github?: { owners: () => GithubOwner[] | Promise<GithubOwner[]>; repos: (owner: string) => GithubRepo[] | Promise<GithubRepo[]> }; gitea?: GiteaApi; opToken?: string; vault?: Vault; gitProxy?: Hono; prodCatalogPath?: string; prodAccessPath?: string; sshKeyTitles?: () => Promise<string[]>; coolifyInstances?: () => Record<string, CoolifyInstance>; execOperation?: (op: string, params: Record<string, string>) => Promise<string>; dbTargets?: DbTargets; dbProxyHost?: string; agentEvents?: AgentEventHub; spawnPty?: SpawnPty; scheduler?: { fireNow: (id: string) => Promise<boolean> }; prodCatalog?: Catalog; prodDbAccess?: Record<string, Access>; readProdSecret?: (opItem: string) => string | Promise<string>; execProdWrite?: (opts: { entry: DbEntry; server: ServerRef; sql: string; preview: boolean; scope?: WriteScope }) => Promise<{ rows: number; note: string }>; tmuxProbe?: (containers: string[], now?: number) => Promise<Record<string, TmuxSession[]>>; onConfigWritten?: () => void;
  liveActivities?: LiveActivities;
  /** Dashboard origins allowed to mutate the API from a browser; default see originGuard.ts (+ DEVD_DASHBOARD_ORIGINS). */
  dashboardOrigins?: string[];
  /** Container IP → session for restricting a shared session (containerIdentity.ts);
   *  the default is the process instance filled by index.ts. Tests supply their own. */
  containerIdentity?: ContainerIdentity;
  /** Session containers have their own dind daemon (DEVD_DIND=1). Without it the session has
   *  the host docker.sock and IP-based container restriction can be bypassed — sharing is then refused (409). */
  dind?: boolean;
  /** What must happen before a share link is created (final review C2/C4/I5). Default =
   *  real docker; tests supply a stub. */
  shareLockdown?: ShareLockdown;
  /** Is the share listener (:4302) running? false = bind failed, sharing is disabled (503). Default: yes. */
  shareAvailable?: () => boolean;
  dbOnboardingHost?: OnboardingHost;
  /** Defaults to automatic verified host setup; false retains manual operation approval. */
  dbOnboardingAutoApprove?: boolean;
  /** Poll interval for approved operations waiting on the vault/SQL (default 2 s; tests shorten it). */
  operationPollMs?: number;
  dbProxyReady?: () => boolean;
  mysqlProxyHost?: string;
  mysqlProxyReady?: () => boolean;
  discoverDbTargets?: typeof discoverDatabaseTargets;
  prepareDeployment?: (params: Record<string, string>) => Promise<{ project: string; application: string; instance?: string; commit?: string; previousCommit?: string; changes: string[] }>;
  /** OpenRouter API key. Deliberately only `hasKey`, not `getKey`: the HTTP layer sees this
   *  object, and whatever can be read from here sooner or later gets returned to someone in a response. */
  openrouter?: { hasKey: () => boolean; setKey: (key: string) => void };
  /** Catalog window of the OpenRouter model for /api/proxy-context. Optional (tests,
   *  older wiring): without it the openrouter row reports as "unknown". */
  orCtxLookup?: (model: string) => Promise<number | null>;
  /** Upstream keys for /api/local-env (dev local on the mac). Optional: without them
   *  all profiles report as not ready. */
  upstreamKeys?: (u: Upstream) => string | null;
  /** InstaBox overflow. Without it (no `settings.instabox.devdUrl`) InstaBox routes report disabled. */
  instabox?: {
    sessions: Pick<InstaboxSessions, "startCreate" | "job" | "desktopLink" | "desktopRevoke">;
    status: () => Promise<IbxStatus>;
    settings: InstaboxSettings;
    hostLoad: () => HostLoad;
    rebuildBase: () => { jobId: string } | null;
    baseJob: (id: string) => IbxBaseJobView | null;
    killOrphan: (machineId: string) => Promise<boolean>;
  };
  /** Where devd forwards /api/cliproxy/* — from the HOST's point of view, not the container's (hence
   *  not settings.cliproxyUrl, which carries host.docker.internal). In tests a fake server. */
  cliproxyLocalUrl?: string;
  tmuxExec?: (container: string, cmd: string) => Promise<{ code: number; stdout: string }>;
  // Critic gate (criticGate). Optional: without it devd behaves as before.
  critic?: { onPrompt: (s: SessionRow, task: string) => void; onStop: (s: SessionRow) => Promise<Decision> };
  // Sign-in of critic providers (Codex/Claude) via ephemeral containers. Optional.
  codexAuth?: CodexAuthDeps;
  /** Last measured Codex quota. `undefined` = devd without Codex; the route then returns
   *  `codex: null` and the page does not render the section. The route DOES NOT POLL — measuring belongs to the timer. */
  codexUsage?: { view: () => CodexView | null };
  codexAccounts?: CodexAccounts;
  codexSessionAccounts?: Pick<CodexSessionAccounts, "view" | "switch">;
  /** How long a switch POST waits before answering 202 and finishing in the background. */
  codexSwitchWaitMs?: number;
  /** Last measured Grok quota — same contract as codexUsage. */
  grokUsage?: { view: () => GrokView | null };
  // ccUpkeep status and manual trigger for the dashboard. `run` returns null when the job is already running.
  agentUpkeep?: { status: (provider: UpkeepProvider) => Promise<AgentUpkeepStatus>; run: (provider: UpkeepProvider, only?: string[]) => Promise<AgentUpkeepResult | null> };
  ccUpkeep?: { status: () => Promise<CcStatus>; run: (only?: string[]) => Promise<UpkeepResult | null> };
  // Hardware tab: Beszel + host probe + borg + Uptime Kuma. Optional — without secrets
  // the page reports itself as not configured instead of devd crashing.
  hardware?: Hardware;
  // Pool of Anthropic accounts. Optional: without it the /api/accounts endpoints return 503 and
  // the shims (mac and container) silently fall back to the default profile.
  // `leaseMaxAgeMs` and `settings` are FUNCTIONS, not values — they are read from config on
  // EVERY request (same convention as `freshCfg()` elsewhere in this file),
  // so a change of `autoStopHours`/`thresholdPct` from the dashboard applies immediately, not after a
  // devd restart. `d.cfg` is the startup SNAPSHOT (see the constructor in index.ts) —
  // the lease handler therefore has to use `settings()`, not `d.cfg.settings` (review
  // round 4, I5).
  // `switchAccount` is `dev switch`: all logic (decision, panel restart,
  // DB write) lives in accountSwitch.ts, just like `ccUpkeep.run` below delegates
  // to ccUpkeep.ts — the handler is only thin routing to an HTTP status.
  accounts?: {
    profiles: ProfileDeps; leaseMaxAgeMs: () => number;
    settings: () => AccountPoolSettings;
    switchAccount: (sessionId: string) => Promise<SwitchAccountResult>;
    // Forced re-measurement of one account (POST /api/accounts/:id/refresh). Coalescing
    // concurrent calls and re-entrance against the regular poller is handled by index.ts —
    // the handler just waits for the result.
    refresh: (id: string) => Promise<void>;
  };
  /** Live swap of the agent (harness) of a running session — logic in agentSwitch.ts,
   *  the handler only validates input and maps the status to an HTTP code (like switchAccount).
   *  index.ts always wires it; optionality is a convention of test fixtures
   *  (partial ApiDeps), same as tmuxExec — without wiring the route returns 503. */
  switchAgent?: (sessionId: string, agent: AgentName) => Promise<SwitchAgentResult>;
  sshAgents?: SshAgents;
  /** false = break-glass (DEVD_SSH_APPROVAL=off): the key is issued without asking. */
  sshApprovalEnabled?: boolean;
  /** List of SSH-key items from 1Password, injected (not a direct `listSshKeys` call),
   *  so tests do not have to shell out to the real `op` binary. POST /api/ssh-approvals
   *  uses it to verify `title` before creating the approval row — without that the agent
   *  could make up any name and the approver would see it as a fact verified by devd.
   *  Not configured/throws (1Password unavailable) → fail-closed, no
   *  row, no prompt. In index.ts it is wired behind `memoAsyncStrict` (60 s TTL) —
   *  `op item list` runs via `run()` (see proc.ts), so the cache bounds the call cost;
   *  the call count is bounded by `approvalLimiter`/`keyListLimiter` in createApp. */
  sshKeyLister?: () => Promise<SshKeyRef[]>;
  /** Servers attached to SSH keys from config (see sshServers.ts). A FUNCTION, not a value — read
   *  fresh on every request (index.ts: `freshCfg().sshServers`), so a new server
   *  from the dashboard applies immediately. Not wired = no servers. */
  sshServers?: () => SshServer[];
  /** Source address of the request, injected (not a direct `getConnInfo(c)` call in the
   *  handler) — tests call the app via `app.request(...)`, where `c.env` does not carry a
   *  real Bun server and `getConnInfo` would crash on it (verified by a smoke test).
   *  In production a thin wrapper over `getConnInfo` from `hono/bun` (see index.ts); tests
   *  supply a fake. `undefined` when the address cannot be determined → `approvalGate` below
   *  behaves fail-closed. */
  remoteAddr?: (c: Context) => string | undefined;
  /** `DEVD_APPROVAL_ALLOW` — escape hatch for `approvalGate` (see there and network.ts):
   *  extra CIDRs/addresses added to the default loopback+tailnet list. Optional,
   *  empty array = no extension. */
  sshApprovalAllowExtra?: readonly string[];
  /** Scan of unpushed commits across the whole workspace (unpushed.ts), wrapped in
   *  `memoAsync` in index.ts — scanning dozens of repos takes seconds and the page is opened
   *  repeatedly. `?fresh=1` drops the cache (Refresh button). Optional: route tests
   *  do not wire it and the route then returns 503. */
  unpushed?: {
    get: () => Promise<UnpushedReport>; invalidate: () => void;
    /** Branch push / PR creation (unpushed.ts `unpushedOps`). `push` returns the git result
     *  (502 in the route), but input rejection (foreign path, unknown branch) THROWS → 400. */
    push?: (path: string, branch: string) => Promise<PushResult>;
    createPr?: (p: { path: string; branch: string; title: string; body: string }) => Promise<{ url: string; number: number | null }>;
  };
}

const validSeg = (s: string) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";
const validCloneUrl = (s: string) => /^(https?:\/\/|ssh:\/\/|git@)/.test(s);

// Concurrent operation on the same session (see SessionManager.locked): 409 with what is running.
// The dashboard and `dev` show the message via their usual error path (ApiError /
// `err.error`), just like today's "switch for this session is already running".
const busy = (c: { json: (b: unknown, s: 409) => Response }, e: unknown) =>
  e instanceof SessionBusyError ? c.json({ error: `operation already running: ${e.op}`, inProgress: e.op }, 409) : null;

// Features that live on the VPS (Finder, port preview, inbox, critic, recreate) — for a session
// on InstaBox 409. Returns null when the session is not InstaBox (continue normally).
const ibxOnly = (c: { json: (b: unknown, s: 409) => Response }, s: { host?: string } | null | undefined, what: string) =>
  s?.host === "instabox" ? c.json({ error: `${what} is VPS-only (InstaBox session)` }, 409) : null;

// Long routes (backup, restore, open with clone, manual upkeep) can take minutes.
// Bun closes an idle connection after `idleTimeout` (max 255 s), so for them the
// timer is disabled per request: under Bun.serve `c.env` is the real server
// (see getConnInfo above); in tests via app.request() it carries only what the test passes.
const noIdleTimeout = (c: { env: unknown; req: { raw: Request } }) => {
  const srv = c.env as { timeout?: (req: Request, seconds: number) => void } | undefined;
  try { srv?.timeout?.(c.req.raw, 0); } catch { /* no Bun server (tests) */ }
};
const giteaStatus = (e: unknown): 400 | 404 | 500 | 502 => {
  if (e instanceof GiteaUnknownInstanceError) return 404;
  if (e instanceof GiteaAuthError) return 400;
  if (e instanceof GiteaError) return 502;
  return 500;
};

// Optional fields from devd-hook.sh; unknown ones are ignored, the prompt is not copied into the log in full.
function hookMeta(b: Record<string, unknown>): HookMeta {
  const s = (k: string) => (typeof b[k] === "string" && b[k] !== "" ? (b[k] as string) : undefined);
  // backgroundTasks must stay undefined (not 0) for anything that is not a valid non-negative
  // integer — a forged value must not replace "we don't know" with "nothing is running" and
  // let a notification through in the middle of work (see agentEvents.ts, stop branch).
  const bg = b.backgroundTasks;
  const backgroundTasks = typeof bg === "number" && Number.isFinite(bg) && bg >= 0 ? bg : undefined;
  return {
    notificationType: s("notificationType"), agentSessionId: s("agentSessionId"), agentType: s("agentType"),
    taskId: s("taskId"), taskSubject: s("taskSubject"), teammateName: s("teammateName"), teamName: s("teamName"),
    prompt: s("prompt"), toolName: s("toolName"), toolCallId: s("toolCallId"), promptId: s("promptId"), question: s("question"), backgroundTasks,
  };
}

export function createApp(d: ApiDeps): Hono {
  // Live Activity: an unapproved SSH key = the session is waiting. State is read from the DB (newest
  // open request), so deciding one request does not clear the wait for another.
  const syncSshWaiting = (session: string | null | undefined) => {
    if (!session || !d.agentEvents) return;
    d.agentEvents.setSshWaiting(session, pendingSshLabel(d.db, session));
    d.liveActivities?.request();
  };
  const app = new Hono();
  // Only /api/*: static files are served by StaticFiles with precomputed gzip (see static.ts),
  // double compression would be pure extra overhead. This is about responses like
  // /api/notify-log (74 kB) or /api/events (34 kB), which used to go out uncompressed.
  // MUST come before the first /api route: Hono applies middleware only to routes registered
  // after it. /api/usage used to sit above it and Overview thus pulled 1.45 MB
  // of raw JSON every minute (gzip ~100 kB).
  app.use("/api/*", compress());
  // CSRF from previews (p0…p9.<DEVD_PREVIEW_DOMAIN>): foreign Origin on mutations and WS → 403, body from a browser
  // only JSON (415). Exceptions to the body-type rule: backup upload and passthrough to CLIProxyAPI.
  // Like compress, MUST come before the first /api route.
  const allowedOrigins = d.dashboardOrigins ?? dashboardOrigins();
  app.use("/api/*", originGuard(allowedOrigins,
    (path) => path === "/api/restore" || path.startsWith("/api/cliproxy/")));
  // OTel (/v1/metrics): exporters send no Origin, they pass; forged metrics from a preview do not.
  // The body type is not checked — OTLP may also be protobuf.
  app.use("/v1/*", originGuard(allowedOrigins, () => true));
  // The container of a shared session may only reach an allowlist of routes behind its session
  // (identity = source IP, see containerIdentity.ts). "*" and BEFORE the git proxy and all routes —
  // Hono applies middleware only to routes registered after it.
  const identity = d.containerIdentity ?? defaultContainerIdentity;
  const sharedSessions = new SharedSessions(d.db, Date.now, identity);
  app.use("*", sharedContainerGuard({ db: d.db, remoteAddr: d.remoteAddr, identity, shared: sharedSessions, approvalAllowExtra: d.sshApprovalAllowExtra }));
  /** Shared or tainted (shareTaint.ts) session — same restrictions. */
  const restricted = (sessionId: string) => sharedSessions.current().has(sessionId);
  /** Approval prompts (SSH key, prod-db, production SQL) from a shared/tainted session
   *  carry a label — the owner must know the request may have come from the terminal guest,
   *  not their agent (final review I4). */
  const SHARED_LABEL = "from a shared session";
  const fromShared = (sessionId: string | null | undefined) => !!sessionId && restricted(sessionId);
  const sharedTitle = (title: string, sessionId: string | null | undefined) => fromShared(sessionId) ? `${title} (${SHARED_LABEL})` : title;
  const lockdown: ShareLockdown = d.shareLockdown ?? {
    containerId: (container) => dockerContainerId(container),
    stopDind: (session) => stopDindSidecar(session),
  };
  const readCodexResets = createCodexResetReader();
  app.get("/api/codex-resets", async (c) => c.json(await readCodexResets()));
  app.get("/api/usage", (c) => {
    const now = Date.now();
    const range = weeklyUsageRange({days:c.req.query("days"),from:c.req.query("from"),to:c.req.query("to")},now);
    if (!range) return c.json({error:"Invalid range; select at most 90 days."},400);
    return c.json(buildWeeklyUsage(d.db,range.from,range.to,now));
  });
  app.route("/api/live-activities", liveActivitiesRoutes(d.db, d.liveActivities));

  // The git proxy MUST be registered first: further down the file is a catch-all that
  // serves the dashboard SPA, and Hono matches in registration order — otherwise requests
  // to /git/* would get HTML instead of git (verified live 2026-08-22).
  if (d.gitProxy) app.route("/", d.gitProxy);

  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, commit: COMMIT }));
  app.route("/api/codex-accounts", codexAccountsRoutes(d.codexAccounts));
  // Cloudflare cuts a response after 100 s, but handing off a conversation with
  // hundreds of agents takes minutes. A slow switch answers 202 and finishes in
  // the background; the next GET reports `switching` and then, once, `lastSwitch`.
  const codexSwitches = new Map<string, { running: boolean; status: 200 | 400 | 404 | 409 | 502; body: unknown }>();
  const codexSwitchFailed = "Could not check or switch this session's Codex account. Refresh the accounts and try again.";
  app.on(["GET", "POST"], "/api/sessions/:id/codex-account", async (c) => {
    c.header("Cache-Control", "no-store");
    const service = d.codexSessionAccounts;
    if (!service) return c.json({ error: "Codex account switching is not configured." }, 503);
    const id = c.req.param("id");
    try {
      if (c.req.method === "GET") {
        const view = await service.view(id);
        const job = codexSwitches.get(id);
        if (job?.running) return c.json({ ...view, switching: true });
        if (job) codexSwitches.delete(id);
        return c.json(job ? { ...view, lastSwitch: job.status === 200 ? job.body : { ok: false, ...(job.body as object) } } : view);
      }
      if (codexSwitches.get(id)?.running) return c.json({ error: "This session is busy with another lifecycle operation. Try again shortly." }, 409);
      noIdleTimeout(c); // Multiple exact conversation handoffs may take minutes.
      const body = await c.req.json().catch(() => null);
      const job: { running: boolean; status: 200 | 400 | 404 | 409 | 502; body: unknown } = { running: true, status: 200, body: null };
      codexSwitches.set(id, job);
      const work = service.switch(id, body?.accountId).then(
        (result) => { job.body = result; },
        (err) => {
          job.status = err instanceof CodexSessionAccountError ? err.status : 502;
          job.body = { error: err instanceof CodexSessionAccountError ? err.message : codexSwitchFailed };
        },
      ).finally(() => { job.running = false; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([work.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), d.codexSwitchWaitMs ?? 60_000); })]);
      clearTimeout(timer);
      if (!finished) return c.json({ running: true }, 202);
      codexSwitches.delete(id);
      return c.json(job.body as object, job.status);
    } catch (err) {
      if (err instanceof CodexSessionAccountError) return c.json({ error: err.message }, err.status);
      return c.json({ error: codexSwitchFailed }, 502);
    }
  });

  // Vault. The passphrase is never logged or stored — it goes straight into vault.unlock.
  // When `d.vault` is missing (older deploy without a vault), we pretend it is unlocked, so
  // the code deploy itself does not change the behavior of the running devd.
  app.get("/api/vault", (c) => c.json({ locked: d.vault ? d.vault.isLocked() : false }));

  // Broker of named operations: the agent sends a PROPOSAL with parameters, never a credential.
  // Whether separate approval is needed is set by the catalog; credentials are read only at execution.
  app.post("/api/operations", async (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { op?: string; params?: Record<string, unknown> };
    const v = validateParams(body.op ?? "", body.params ?? {});
    if (!v.ok) return c.json({ error: v.error }, 400);
    const session = c.req.header("x-devbox-session")?.trim() || null;
    const intent = JSON.stringify(v.params);
    const earlier = listOperations(d.db, { limit: 500 }).find((row) => {
      if (row.session_id !== session || row.op !== body.op) return false;
      const params = JSON.parse(row.params);
      return v.params.idempotencyKey ? params.idempotencyKey === v.params.idempotencyKey : params.intent === intent;
    });
    if (earlier) {
      if (JSON.parse(earlier.params).intent !== intent) return c.json({ error: "Idempotency key belongs to a different operation scope.", code: "idempotency_conflict" }, 409);
      return c.json(earlier);
    }
    if (body.op === "deploy") {
      if (v.params.afterWrite) {
        const w = getProposal(d.db, Number(v.params.afterWrite));
        if (!w || w.session_id !== session) return c.json({ error: "afterWrite must reference this session's exact SQL proposal" }, 400);
      }
      if (d.prepareDeployment) {
        try {
          const p = await d.prepareDeployment(v.params);
          for (const [k, value] of Object.entries(p)) if (typeof value === "string") v.params[k] = value;
          v.params.changes = JSON.stringify(p.changes);
        } catch (e) { const detail = safeOperationError(e); return c.json({ ...detail, error: detail.message }, 409); }
      } else if (v.params.application || v.params.commit || !v.params.project) return c.json({ error: "deployment preflight unavailable" }, 503);
    }
    v.params.intent = intent;
    const id = proposeOperation(d.db, { session, op: body.op!, params: v.params });
    logEvent(d.db, session, "operation_proposed", { op: body.op, id });
    if (!OPERATIONS[body.op!]!.needsApproval &&
        d.db.query("UPDATE operations SET status='approved',decided_at=? WHERE id=? AND status='pending'").run(Date.now(), id).changes) {
      logEvent(d.db, session, "operation_approved", { id, op: body.op, automatic: true });
      await executeQueuedOperation(id);
    }
    return c.json(getOperation(d.db, id));
  });

  app.get("/api/operations", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    return c.json(listOperations(d.db).filter((r) => isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? []) || r.session_id === c.req.header("x-devbox-session")));
  });
  app.get("/api/operations/:id", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const row = getOperation(d.db, Number(c.req.param("id")));
    if (!row) return c.json({ error: "unknown operation" }, 404);
    if (!isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? []) && row.session_id !== c.req.header("x-devbox-session")) return c.json({ error: "operation belongs to another session" }, 403);
    return c.json(row);
  });

  const onboarding = createDbOnboarding({
    db: d.db, catalog: d.prodCatalog, catalogPath: d.prodCatalogPath,
    access: d.prodDbAccess, accessPath: d.prodAccessPath, host: d.dbOnboardingHost,
    proxyReady: (engine) => !!d.dbTargets && (engine === "mariadb" ? !!d.mysqlProxyHost && (d.mysqlProxyReady?.() ?? false) : !!d.dbProxyHost && (d.dbProxyReady?.() ?? true)), notify: d.notify,
    // Onboarding can only install isolated tunnels and scoped roles after full
    // preflight. Concrete DML/DDL stays in the separate human approval queue.
    autoApprove: d.dbOnboardingAutoApprove ?? true,
    discover: async (row) => {
      if (!d.prodCatalog) return { candidates: [], blocks: [{ code: "catalog_unconfigured", category: "configuration" as const, message: "Server catalog is unavailable.", action: "Configure the host database catalog." }] };
      try { return await (d.discoverDbTargets ?? discoverDatabaseTargets)({ catalog: d.prodCatalog, instances: d.coolifyInstances?.() ?? {}, wanted: row.wanted, project: row.project ?? undefined }); }
      catch { return { candidates: [], blocks: [{ code: "discovery_unavailable", category: "connection" as const, message: "Coolify discovery is unavailable.", action: "Unlock the vault and check the Coolify connection." }] }; }
    },
  });
  // Existing agent identity and human approval boundaries are reused throughout.
  const requestGate = (c: Context, id: number) => {
    const denied = sessionGate(c); if (denied) return denied;
    if (isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? [])) return null;
    const row = getDbRequest(d.db, id);
    return row?.session_id === c.req.header("x-devbox-session") ? null : c.json({ error: "request belongs to another session" }, 403);
  };
  const requestAccess = (session: string | null, name: string, why: string, scope: "read" | "dml" | "migration" = "read") => {
    const before = d.db.query("SELECT id,requested_scope FROM db_requests WHERE session_id IS ? AND wanted=? ORDER BY id DESC LIMIT 1").get(session, name) as { id: number; requested_scope: string } | null;
    const id = createDbRequest(d.db, { session, project: session ? prodDbKey(session) : null, wanted: name, why, scope });
    if (before?.id !== id) {
      logEvent(d.db, session, "db_request", { id, wanted: name });
      d.notify(sharedTitle("Database access requested", session), `#${id}: ${name} — ${why.slice(0, 100)}`, { target: { kind: "prodWrites" }, blocked: true });
      void d.listener.dbRequest({ id, wanted: name, why, project: session ? prodDbKey(session) : null, session, ...(fromShared(session) ? { shared: true } : {}) }, () => { try { onboarding.reject(id); } catch {} });
    }
    const result = onboarding.view(id)!;
    if (before?.id === id && before.requested_scope !== result.requested_scope) {
      logEvent(d.db, session, "db_request_scope_changed", { id, from: before.requested_scope, to: result.requested_scope });
      d.notify(sharedTitle("Database access scope updated", session), `#${id}: ${name} — ${result.requested_scope}. Review the updated setup plan.`, { target: { kind: "prodWrites" }, blocked: true });
    }
    return result;
  };
  const requestUnknown = (c: Context, name: string, why: string, scope: "read" | "dml" | "migration" = "read") =>
    requestAccess(c.req.header("x-devbox-session")?.trim() || null, name, why, scope);
  app.post("/api/prod-db/requests", async (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.wanted !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(b.wanted.trim())) return c.json({ error: "wanted must be a database identifier" }, 400);
    if (typeof b.why !== "string" || !b.why.trim()) return c.json({ error: "why is required" }, 400);
    if (b.scope !== undefined && !["read", "dml", "migration"].includes(b.scope)) return c.json({ error: "scope must be read, dml or migration" }, 400);
    return c.json(requestUnknown(c, b.wanted.trim(), b.why.trim(), b.scope ?? "read"));
  });
  app.get("/api/prod-db/requests", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const all = isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? []);
    return c.json(onboarding.list().filter((r) => all || r.session_id === c.req.header("x-devbox-session")));
  });
  app.get("/api/prod-db/requests/:id", (c) => {
    const id = Number(c.req.param("id")), denied = requestGate(c, id); if (denied) return denied;
    const row = onboarding.view(id); return row ? c.json(row) : c.json({ error: "unknown request" }, 404);
  });
  app.get("/api/prod-db/requests/:id/discovery", async (c) => {
    const id = Number(c.req.param("id")), denied = requestGate(c, id); if (denied) return denied;
    const row = getDbRequest(d.db, id); if (!row) return c.json({ error: "unknown request" }, 404);
    return c.json(await onboarding.discover(row));
  });
  app.post("/api/prod-db/requests/:id/prepare", async (c) => {
    const id = Number(c.req.param("id")), denied = requestGate(c, id); if (denied) return denied;
    if (!getDbRequest(d.db, id)) return c.json({ error: "unknown request" }, 404);
    return c.json(await onboarding.prepare(id, await c.req.json().catch(() => ({}))));
  });
  app.post("/api/prod-db/requests/:id/resume", async (c) => {
    const id = Number(c.req.param("id")), denied = requestGate(c, id); if (denied) return denied;
    const row = onboarding.view(id);
    if (!row?.operationId || !["approved", "failed"].includes(getOperation(d.db, row.operationId)?.status ?? "")) return c.json({ error: "this setup has no reusable approval" }, 409);
    void onboarding.resume(id);
    return c.json(onboarding.view(id), 202);
  });
  for (const legacy of ["command", "confirm"]) app.post(`/api/prod-db/requests/:id/${legacy}`, (c) => c.json({
    error: "Manual setup attestation is retired. Prepare and approve a verified host operation.", code: "use_prepared_operation", nextAction: `/api/prod-db/requests/${c.req.param("id")}/prepare`,
  }, 410));
  app.post("/api/prod-db/requests/:id/reject", (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    try { onboarding.reject(Number(c.req.param("id"))); return c.body(null, 204); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });
  app.get("/api/coolify/instances", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const locked = vaultGate(c); if (locked) return locked;
    return c.json({ instances: Object.keys(d.coolifyInstances?.() ?? {}).sort() });
  });
  app.get("/api/coolify/:instance/databases", async (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const locked = vaultGate(c); if (locked) return locked;
    const inst = d.coolifyInstances?.()[c.req.param("instance").trim()];
    if (!inst) return c.json({ error: "unknown Coolify instance", code: "missing_configuration" }, 404);
    try { return c.json({ databases: await listCoolifyDatabases(inst) }); }
    catch { return c.json({ error: "Coolify database discovery failed; check connectivity and API permissions.", code: "coolify_unavailable" }, 502); }
  });
  // Rechecks read-only prerequisites and continues the same approved plan after a
  // temporary outage/manual 1Password step, even when the dashboard is closed.
  const onboardingTimer = setInterval(() => { void onboarding.tick().catch(() => {}); }, 15_000);
  onboardingTimer.unref();

  const executeQueuedOperation = async (id: number) => {
    const row = getOperation(d.db, id); if (!row || row.status !== "approved" || !d.execOperation || d.vault?.isLocked()) return;
    const params = JSON.parse(row.params) as Record<string, string>;
    if (params.afterWrite) {
      const write = getProposal(d.db, Number(params.afterWrite));
      if (!write || write.status !== "executed") {
        if (!write || ["failed", "rejected"].includes(write.status)) setOperationStatus(d.db, id, "failed", { error: `Dependent SQL proposal #${params.afterWrite} ${write?.status ?? "is missing"}; deployment was not started.` });
        return;
      }
    }
    if (!d.db.query("UPDATE operations SET status='running' WHERE id=? AND status='approved'").run(id).changes) return;
    try {
      const result = await d.execOperation(row.op, params);
      setOperationStatus(d.db, id, "executed", { result });
      logEvent(d.db, row.session_id, "operation_executed", { id, op: row.op, afterWrite: params.afterWrite });
    } catch (e) {
      const detail = safeOperationError(e);
      setOperationStatus(d.db, id, "failed", { error: detail.message, errorDetails: detail });
      logEvent(d.db, row.session_id, "operation_failed", { id, ...detail });
    }
  };
  d.db.query("UPDATE operations SET status='failed',error='Host restarted during execution; verify external result before creating another operation.' WHERE status='running'").run();
  d.db.query("UPDATE prod_writes SET status='failed',error='Host restarted during SQL execution; transaction result must be verified before any new proposal.' WHERE status='approved'").run();
  const operationTimer = setInterval(() => {
    if (d.vault?.isLocked()) return;
    // A synchronous throw in setInterval is an uncaught exception (crashes the process);
    // a closed DB (end of the app's lifetime, typically in tests) stops the timer.
    try {
      for (const op of listOperations(d.db, { status: "approved" })) if (op.op !== "db-onboard") void executeQueuedOperation(op.id);
    } catch (e) {
      if (e instanceof RangeError && /closed database/.test(e.message)) clearInterval(operationTimer);
      else console.error("operations tick failed:", e);
    }
  }, d.operationPollMs ?? 2000);
  operationTimer.unref();
  app.post("/api/operations/:id/approve", async (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    // Vault gate FIRST: execution touches credentials, so locked = 423,
    // not a crash somewhere inside the operation.
    const locked = vaultGate(c); if (locked) return locked;
    const id = Number(c.req.param("id"));
    const row = getOperation(d.db, id);
    if (!row) return c.json({ error: "unknown proposal" }, 404);
    if (row.op === "db-onboard") {
      try { return c.json(onboarding.approve(id), 202); }
      catch (e) { return c.json({ error: (e as Error).message }, 409); }
    }
    if (!d.execOperation) return c.json({ error: "broker is not configured" }, 503);
    // The state guards against double approval and approval of an already rejected proposal.
    if (row.status !== "pending") return c.json({ error: `proposal is in state ${row.status}` }, 409);
    if (!d.db.query("UPDATE operations SET status='approved',decided_at=? WHERE id=? AND status='pending'").run(Date.now(), id).changes) return c.json({ error: "operation already decided" }, 409);
    logEvent(d.db, row.session_id, "operation_approved", { id, op: row.op });
    await executeQueuedOperation(id);
    const current = getOperation(d.db, id)!;
    return c.json(current, current.status === "approved" ? 202 : current.status === "failed" ? 502 : 200);
  });

  app.post("/api/operations/:id/reject", (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const id = Number(c.req.param("id"));
    const row = getOperation(d.db, id);
    if (!row) return c.json({ error: "unknown proposal" }, 404);
    if (row.status !== "pending") return c.json({ error: `proposal is in state ${row.status}` }, 409);
    if (row.op === "db-onboard") onboarding.reject(Number(JSON.parse(row.params).requestId));
    else setOperationStatus(d.db, id, "rejected");
    return c.body(null, 204);
  });

  app.post("/api/vault/unlock", async (c) => {
    if (!d.vault) return c.json({ error: "vault is not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { passphrase?: string };
    if (typeof body.passphrase !== "string" || !body.passphrase) return c.json({ error: "passphrase is required" }, 400);
    // We do not distinguish the error (wrong phrase vs. broken file) — there is no point advising
    // someone guessing the phrase. The detail goes to the server log, not the response.
    try { d.vault.unlock(body.passphrase); return c.json({ locked: false }); }
    catch (e) { console.error("vault unlock failed:", (e as Error).message); return c.json({ error: "wrong passphrase" }, 401); }
  });

  app.post("/api/vault/lock", (c) => { d.vault?.lock(); return c.body(null, 204); });

  /** Gate for routes touching credentials. Returns a Response when locked, otherwise null.
   *  Called as the FIRST thing in the route — before config checks, otherwise a locked
   *  vault with unconfigured 1P would return 503 and the lock would never show. */
  const vaultGate = (c: Context): Response | null =>
    d.vault?.isLocked() ? c.json({ error: "vault is locked — unlock it in the dashboard" }, 423) : null;

  /** Network gate for HUMAN decisions on SSH keys (approve/deny, grant revoke)
   *  and for cross-session listing (GET of approvals/grants lists) — without it an agent
   *  in a container could approve its own request and see `why`/`cwd`/`target`
   *  of other sessions (see devd network model, docs/mac.md). `srv` inside the
   *  container only calls create/poll/activate (POST /api/ssh-approvals, GET
   *  /api/ssh-approvals/:id, POST /:id/activate) — those DO NOT have this gate, otherwise
   *  the whole approval flow would break (poll waits for the human's answer, activate takes
   *  the socket for a request the container itself created).
   *
   *  Called BEFORE `vaultGate`, not after it: `vaultGate` reveals the vault state
   *  (423 vs. another code) to a caller we have not yet verified is allowed
   *  here at all — perimeter first (where the request came from), then business state
   *  (vault) for whoever passed the perimeter.
   *
   *  Unknown/unrecognized address → fail-closed (403); the log line carries either the address
   *  or that it was determined as "unknown" — that is the only way to tell from the production
   *  log a misconfigured source (typically the dashboard's cloudflared tunnel,
   *  see DEVD_APPROVAL_ALLOW in docs/mac.md) from a real attempt from outside. */
  const approvalGate = (c: Context): Response | null => {
    const addr = d.remoteAddr?.(c);
    if (isApprovalAllowed(addr, d.sshApprovalAllowExtra ?? [])) return null;
    console.warn(`SSH approval: denied (${c.req.method} ${c.req.path}) — address ${addr ?? "unknown"} ${isInstaboxAddress(addr) ? "belongs to an InstaBox machine" : "is not in the allowlist"}`);
    return c.json({ error: "this network address has no access to SSH approvals" }, 403);
  };

  // --- Limits and caller identity for the SSH gate ---------------------------------
  // EVERY container on the host can reach the SSH gate routes: devd listens on 0.0.0.0
  // and ufw allows 4300/tcp from all docker bridge networks (see configure_ufw in setup.sh). So it is not
  // only devbox sessions, but everything else running on the host — Coolify
  // apps, gh-runner, databases. The routes are NOT reachable from the internet.
  //
  // `approvalGate` (address allowlist) cannot be applied to them: `image/srv` calls them precisely
  // from a container, so the gate would lock out its own clients. The spec intends this
  // (2026-09-02-ssh-key-approval-design.md: "Remains: GET /api/op/ssh-keys"). Instead
  // two weaker but compatible restrictions apply: you must prove an existing
  // session (sessionGate) and must not hammer (the limiters below).

  /** How many approval prompts one caller may trigger. Eight per ten minutes is
   *  an order of magnitude above normal traffic (`srv` is called a few times per hour) and far below
   *  the point where a human could be clicked into consent. */
  const approvalLimiter = createRateLimiter(8, 10 * 60_000);
  /** Key listing is cheap (in production behind `memoAsyncStrict`); this limit is against
   *  enumeration and watching for changes, not against call cost — hence it is looser. */
  const keyListLimiter = createRateLimiter(30, 10 * 60_000);

  /** Limit key: the session, and when the caller did not send one, their address. Falling back to a
   *  constant (not to "no limit") keeps the gate fail-closed even for a caller we know
   *  nothing about — several such callers then share one window, which is intended. */
  const limitKey = (c: Context): string =>
    c.req.header("x-devbox-session") || d.remoteAddr?.(c) || "unknown";

  const limitGate = (c: Context, limiter: { take: (k: string) => { ok: boolean; retryAfterSec: number } }): Response | null => {
    const { ok, retryAfterSec } = limiter.take(limitKey(c));
    if (ok) return null;
    console.warn(`SSH gate: rate limit exhausted (${c.req.method} ${c.req.path}) — ${limitKey(c)}, next in ${retryAfterSec}s`);
    return c.json({ error: `too many requests — try again in ${retryAfterSec} s` }, 429, { "retry-after": String(retryAfterSec) });
  };

  /** The caller is either the approving human (mac/phone/dashboard — address from the allowlist),
   *  or a running devbox session. A foreign container on one of the docker bridges is neither.
   *
   *  The session is verified against the DB, not just for non-emptiness: without that a
   *  made-up header would suffice. It is a weak identity (a running session's id is not a secret and
   *  a container can read it from docker.sock), so it does not form a boundary — it only
   *  narrows the circle from "anything on the host" to "devbox", which for a key-name listing is the
   *  difference that matters. */
  const sessionGate = (c: Context): Response | null => {
    if (isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? [])) return null;
    const session = c.req.header("x-devbox-session") ?? "";
    if (session && getSession(d.db, session)) return null;
    console.warn(`SSH gate: denied (${c.req.method} ${c.req.path}) — caller is neither a session nor an approving address`);
    return c.json({ error: "this request must come from a running devbox session" }, 403);
  };

  /** The prod-db catalog key is `<project>-<repo>` (same semantics as
   *  `SessionManager.prodMounts`) — built from the session row's columns, not from
   *  parsing its id, because after Task 3 the id may carry a sequence suffix.
   *  When the row does not exist (empty header, deleted session, foreign value),
   *  it falls back to today's derivation from the string, so behavior does not change where
   *  it passes today without a DB row. */
  const prodDbKey = (session: string): string => {
    const row = getSession(d.db, session);
    if (row) return `${row.project}-${row.repo}`;
    return session.startsWith("dev-") ? session.slice(4) : session;
  };

  const writeGate = (c: Context, id: number) => {
    const denied = sessionGate(c); if (denied) return denied;
    const w = getProposal(d.db, id);
    return isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? []) || w?.session_id === c.req.header("x-devbox-session") ? null : c.json({ error: "write belongs to another session" }, 403);
  };
  const blockedWrite = (w: ReturnType<typeof getProposal>) => {
    if (!w) return "unknown write";
    const entry = d.prodCatalog && dbEntry(d.prodCatalog, w.db);
    if (!entry) return "database_unknown";
    if (!entry.rwUser || !entry.rwOpItem) return "write_access_not_configured";
    if (w.scope === "migration" && (!entry.migrationUser || !entry.migrationOpItem)) return "migration_access_not_configured";
    if (!entitledDbs(d.prodDbAccess ?? {}, prodDbKey(w.session_id ?? ""), "write").includes(w.db)) return "write_access_not_granted";
    return null;
  };
  const notifyWriteReady = (w: NonNullable<ReturnType<typeof getProposal>>) => {
    d.notify(sharedTitle("Production SQL awaiting approval", w.session_id), `#${w.id}: ${w.db} — ${w.scope}. Review the exact SQL in Operations.`, { target: { kind: "prodWrites", id: String(w.id) }, blocked: true });
  };
  const writeView = (id: number) => {
    let w = getProposal(d.db, id); if (!w) return null;
    const reason = blockedWrite(w);
    if (w.status === "blocked" && !reason) { setStatus(d.db, id, "pending"); w = getProposal(d.db, id)!; notifyWriteReady(w); }
    const writeSession = w.session_id, writeDb = w.db;
    let request = listDbRequests(d.db).find((r) => r.session_id === writeSession && r.wanted === writeDb);
    if (reason && ["pending", "blocked"].includes(w.status)) {
      if (w.status === "pending") { setStatus(d.db, id, "blocked"); w = getProposal(d.db, id)!; }
      // A prior immutable read setup may have completed while this SQL waited.
      // Polling the durable write creates/reuses its scoped access extension;
      // it never changes the previous plan or grants SQL approval.
      request = requestAccess(w.session_id, w.db, `Prepare ${w.scope} proposal #${w.id}; SQL approval remains separate`, w.scope);
    }
    const access = request ? onboarding.view(request.id) : undefined;
    const waiting = ["pending", "blocked"].includes(w.status);
    return { ...w, code: waiting ? reason : null, requestId: request?.id ?? null,
      access: access ? { state: access.state, engine: access.plan?.entry.engine ?? null,
        blocks: access.blocks, nextAction: access.nextAction } : null,
      nextAction: reason && waiting ? access?.nextAction ?? "Prepare database access in Operations, then poll this same write ID."
        : w.status === "pending" ? "Approve this exact SQL and scope in Operations." : "Poll this write ID for its execution result." };
  };
  app.get("/api/prod-db/catalog", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    return c.json({ databases: (d.prodCatalog?.databases ?? []).map(({ name, server, engine }) => ({ name, server, engine })) });
  });
  app.get("/api/prod-db/:name/url", async (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const session = c.req.header("x-devbox-session")?.trim() ?? "", project = prodDbKey(session), name = c.req.param("name").trim();
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return c.json({ error: "invalid database identifier" }, 400);
    if (!d.prodCatalog) return c.json({ error: "host database catalog is not configured", code: "catalog_unconfigured" }, 503);
    const entry = dbEntry(d.prodCatalog, name);
    if (!entry) {
      const request = requestUnknown(c, name, "Agent needs a database not yet in the catalog");
      return c.json({ error: `Unknown database '${name}'; I requested access (request #${request.id}).`, code: "database_unknown", requestId: request.id, request, nextAction: `db-request status ${request.id}` }, 404);
    }
    if (!entitledDbs(d.prodDbAccess ?? {}, project, "read").includes(name)) {
      const request = requestUnknown(c, name, "Request read access to an existing catalog database");
      return c.json({ error: "This project has no approved read access.", code: "read_access_not_granted", requestId: request.id, request, nextAction: `db-request prepare ${request.id}` }, 403);
    }
    const locked = vaultGate(c); if (locked) return locked;
    const proxyHost = entry.engine === "mariadb" ? d.mysqlProxyHost : d.dbProxyHost;
    const proxyReady = entry.engine === "mariadb" ? d.mysqlProxyReady?.() ?? false : d.dbProxyReady?.() ?? true;
    if (!d.dbTargets || !proxyHost || !proxyReady) return c.json({ error: "Host DB proxy is unavailable; real credentials cannot be sent to a session.", code: "proxy_unavailable" }, 503);
    const cred = d.dbTargets.issue(session, name);
    logEvent(d.db, session || null, "prod_db_access", { db: name });
    const auth = `${cred.user}:${cred.password}@${proxyHost}/${entry.db}`;
    return c.text(entry.engine === "postgres" ? `postgresql://${auth}?sslmode=disable` : `mysql://${auth}`);
  });
  app.post("/api/prod-db/:name/write", async (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const session = c.req.header("x-devbox-session")?.trim() || null, name = c.req.param("name").trim();
    const body = await c.req.json().catch(() => ({}));
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return c.json({ error: "invalid database identifier" }, 400);
    if (typeof body.sql !== "string" || !body.sql.trim() || body.sql.length > 1_000_000) return c.json({ error: "SQL is required (up to 1 MB)" }, 400);
    if (body.scope && body.scope !== "dml" && body.scope !== "migration") return c.json({ error: "scope must be dml or migration" }, 400);
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.idempotencyKey))) return c.json({ error: "invalid idempotency key" }, 400);
    const scope: WriteScope = body.scope ?? "dml";
    // No production SQL is executed while access is being prepared. Preserve the
    // exact proposal now so the waiting agent can continue with the same ID.
    const previousId = (d.db.query("SELECT COALESCE(MAX(id),0) AS id FROM prod_writes").get() as { id: number }).id;
    let id: number;
    try { id = createProposal(d.db, { session, db: name, sql: body.sql, scope, idempotencyKey: body.idempotencyKey,
      exception: typeof body.exception === "string" ? body.exception.trim().slice(0, 2000) : undefined }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
    const w = getProposal(d.db, id)!;
    if (w.status === "pending" && blockedWrite(w)) {
      setStatus(d.db, id, "blocked");
    }
    if (id > previousId) {
      logEvent(d.db, session, "prod_write_proposed", { id, db: name, scope });
      if (w.status === "pending" && !blockedWrite(w)) notifyWriteReady(w);
    }
    return c.json(writeView(id), w.status === "blocked" || blockedWrite(w) ? 202 : 200);
  });
  app.get("/api/prod-db/write-count", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const all = isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? []);
    const row = d.db.query(`SELECT COUNT(*) AS count FROM prod_writes WHERE status IN ('blocked','pending','approved')${all ? "" : " AND session_id=?"}`).get(...(all ? [] : [c.req.header("x-devbox-session") ?? ""])) as { count: number };
    return c.json({ count: row.count });
  });
  app.get("/api/prod-db/writes", (c) => {
    const denied = sessionGate(c); if (denied) return denied;
    const all = isApprovalAllowed(d.remoteAddr?.(c), d.sshApprovalAllowExtra ?? []);
    return c.json(listProposals(d.db).filter((w) => all || w.session_id === c.req.header("x-devbox-session")).map((w) => writeView(w.id)).filter((w) => !c.req.query("status") || w?.status === c.req.query("status")));
  });
  app.get("/api/prod-db/writes/:id", (c) => {
    const id = Number(c.req.param("id")), denied = writeGate(c, id); if (denied) return denied;
    const w = writeView(id); return w ? c.json(w) : c.json({ error: "unknown write" }, 404);
  });
  app.post("/api/prod-db/writes/:id/reject", (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const id = Number(c.req.param("id")), w = getProposal(d.db, id);
    if (!w || !["pending", "blocked"].includes(w.status)) return c.json({ error: "write is not awaiting a decision" }, 409);
    setStatus(d.db, id, "rejected"); logEvent(d.db, w.session_id, "prod_write_rejected", { id });
    return c.json({ ok: true });
  });
  app.get("/api/prod-db/writes/:id/preview", (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const w = getProposal(d.db, Number(c.req.param("id")));
    if (!w) return c.json({ error: "unknown write" }, 404);
    // ROLLBACK cannot undo sequence changes or external function effects. Preview is
    // a review of the exact proposal, never speculative SQL execution on production.
    return c.json({ rows: 0, note: "SQL has not run. Review the exact statement, target and scope before approval.", sql: w.sql, scope: w.scope, database: w.db, exception: w.exception });
  });
  app.post("/api/prod-db/writes/:id/approve", async (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const locked = vaultGate(c); if (locked) return locked;
    const id = Number(c.req.param("id")), w = writeView(id);
    if (!w || w.status !== "pending") return c.json({ error: "write is not ready for approval", write: w }, 409);
    const reason = blockedWrite(w); if (reason) return c.json({ error: reason, write: w }, 409);
    if (!d.execProdWrite || !d.prodCatalog) return c.json({ error: "write executor unavailable" }, 503);
    if (!d.db.query("UPDATE prod_writes SET status='approved',decided_at=? WHERE id=? AND status='pending'").run(Date.now(), id).changes) return c.json({ error: "write already decided" }, 409);
    logEvent(d.db, w.session_id, "prod_write_approved", { id, db: w.db, scope: w.scope, exception: w.exception });
    try {
      const entry = dbEntry(d.prodCatalog, w.db)!;
      const res = await d.execProdWrite({ entry, server: d.prodCatalog.servers[entry.server], sql: w.sql, preview: false, scope: w.scope });
      setStatus(d.db, id, "executed", { result: res.note }); logEvent(d.db, w.session_id, "prod_write_executed", { id, scope: w.scope });
      return c.json(res);
    } catch (e) {
      const message = /^(ddl_permission_denied|write_permission_denied|database_write_failed|migration_credentials_missing|write_credentials_missing)/.test((e as Error).message)
        ? (e as Error).message : "write_execution_failed: inspect host diagnostics; do not retry through SSH";
      setStatus(d.db, id, "failed", { error: message });
      logEvent(d.db, w.session_id, "prod_write_failed", { id, scope: w.scope });
      return c.json({ error: message, id }, 502);
    }
  });

  // To each repo we attach the remembered agent choice (repo_prefs). The merge IS HERE,
  // not in buildTree — the tree is cached and this information changes independently of it.
  app.get("/api/tree", async (c) => {
    const tree = await d.tree();
    const key = (f: string, p: string, r: string) => `${f}/${p}/${r}`;
    const prefs = new Map(listRepoAgents(d.db).map((x) => [key(x.folder, x.project, x.repo), x.agent]));
    return c.json(tree.map((p) => ({
      ...p,
      soloAgent: prefs.get(key(p.folder, p.project, "claudeSolo")) ?? null,
      repos: p.repos.map((r) => ({ ...r, agent: prefs.get(key(p.folder, p.project, r.name)) ?? null })),
    })));
  });

  // `?tmux=1` = additionally the list of tmux sessions in the container (name + label + Claude title).
  // Without the parameter the response is bit-for-bit as before — the dashboard polls often and a fan-out
  // through docker would make it pay needlessly.
  app.get("/api/sessions", async (c) => {
    const n = d.cfg.settings.portsPerSession;
    const now = Date.now();
    // Taint (shareTaint.ts) is computed from the docker id in the container map — after a rebuild the
    // map must be fresh, otherwise the session would look restricted until the next event.
    const taints = sessionsWithTaint(d.db);
    if (taints.size) await identity.refreshIfStale().catch(() => {});
    const rows = listSessions(d.db).map((s) => ({
      ...s,
      // The container was shared and has not been rebuilt yet → still restricted (UI offers a rebuild).
      tainted: taints.has(s.id) && isTainted(d.db, s.id, identity.containerIdFor(s.id)),
      ports: Array.from({ length: n }, (_, i) => ({ host: s.port_base + i, container: 3000 + i })),
      // Live agent state from metrics — so the manager CLI does not show an autonomously working
      // session (long subagent, no prompt) as "active X min ago". See stats.ts.
      claudeState: classifyClaudeState(lastMetricTs(d.db, s.id), s.last_active_at, now),
      // The CLI builds `docker -H ssh://…` from it for attaching to an InstaBox session (null = local docker).
      dockerHost: remoteDockerAlias(s.container),
    }));
    if (c.req.query("tmux") !== "1" || !d.tmuxProbe) return c.json(rows);
    const byContainer = await d.tmuxProbe(rows.filter((s) => s.status === "running").map((s) => s.container));
    return c.json(rows.map((s) => ({ ...s, tmux: byContainer[s.container] ?? [] })));
  });

  // Progress of a running POST /api/sessions for the same repo (clone, worktree, pull, container) —
  // the CLI polls it until open finishes. `null` = nothing running (or already finished).
  app.get("/api/open-progress", (c) => {
    const folder = c.req.query("folder") ?? "", project = c.req.query("project") ?? "", repo = c.req.query("repo") ?? "";
    if (!validSeg(folder) || !validSeg(project) || !validSeg(repo)) return c.json({ error: "invalid folder/project/repo" }, 400);
    return c.json({ progress: d.mgr.openProgressFor({ folder, project, repo }) });
  });

  app.post("/api/sessions", async (c) => {
    noIdleTimeout(c);
    const body = (await c.req.json().catch(() => null)) as { folder: string; project: string; repo?: string; cloneUrl?: string; solo?: boolean; agent?: string; fresh?: boolean; host?: string; sessionId?: string } | null;
    if (!body) return c.json({ error: "invalid JSON body" }, 400);
    if (body.agent !== undefined && !isAgentName(body.agent))
      return c.json({ error: `invalid agent (${AGENT_IDS.join("|")})` }, 400);
    const agent = body.agent as AgentName | undefined;
    if (body.host !== undefined && body.host !== "vps" && body.host !== "instabox") return c.json({ error: "invalid host (vps|instabox)" }, 400);
    if (body.host === "instabox") {
      if (body.solo) return c.json({ error: "claudeSolo runs only on the VPS" }, 400);
      if (!body.folder || !body.project || !body.repo || !body.cloneUrl) return c.json({ error: "folder, project, repo and cloneUrl are required" }, 400);
      if (!validSeg(body.folder) || !validSeg(body.project) || !validSeg(body.repo) || !validCloneUrl(body.cloneUrl)) return c.json({ error: "invalid folder/project/repo/cloneUrl" }, 400);
      // Proxy profiles and Antigravity run only on the VPS (instaboxAgentBlock). The repo's
      // remembered agent is checked too (startCreate uses it when `agent` is missing).
      const effective = resolveAgent(agent, getRepoAgent(d.db, body.folder, body.project, body.repo));
      const blocked = instaboxAgentBlock(effective);
      if (blocked) return c.json({ error: blocked }, 400);
      if (!d.instabox) return c.json({ error: "InstaBox is not configured" }, 503);
      try {
        const job = await d.instabox.sessions.startCreate({ folder: body.folder, project: body.project, repo: body.repo, cloneUrl: body.cloneUrl, agent });
        return c.json({ jobId: job.id, sessionId: job.sessionId }, 202);
      } catch (e) {
        if (e instanceof IbxPreconditionError) return c.json({ error: e.message }, e.status);
        return busy(c, e) ?? c.json({ error: (e as Error).message }, 502);
      }
    }
    try {
      if (body.solo) {
        if (!body.folder || !body.project) return c.json({ error: "folder and project are required" }, 400);
        if (!validSeg(body.folder) || !validSeg(body.project)) return c.json({ error: "invalid folder/project/repo" }, 400);
        const r = await d.mgr.openSolo(body.folder, body.project, agent);
        return c.json(r, 201);
      }
      if (!body.folder || !body.project || !body.repo) return c.json({ error: "folder, project and repo are required" }, 400);
      if (!validSeg(body.folder) || !validSeg(body.project) || !validSeg(body.repo)) return c.json({ error: "invalid folder/project/repo" }, 400);
      if (body.cloneUrl && !validCloneUrl(body.cloneUrl)) return c.json({ error: "invalid cloneUrl" }, 400);
      // `sessionId`: reopen a specific existing session of the repo (even a paused InstaBox one).
      if (body.sessionId !== undefined) {
        if (typeof body.sessionId !== "string" || body.fresh) return c.json({ error: "sessionId must be a string and cannot be combined with fresh" }, 400);
        const s = getSession(d.db, body.sessionId);
        if (!s || s.folder !== body.folder || s.project !== body.project || s.repo !== body.repo) return c.json({ error: `unknown session ${body.sessionId} for this repo` }, 404);
      }
      const r = await d.mgr.open({ folder: body.folder, project: body.project, repo: body.repo, cloneUrl: body.cloneUrl, agent, fresh: body.fresh, sessionId: body.sessionId });
      return c.json(r, r.created ? 201 : 200);
    } catch (e) {
      return busy(c, e) ?? c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/api/sessions/:id/resume-remote", async (c) => {
    noIdleTimeout(c);
    try { return c.json(await d.mgr.resumeRemote(c.req.param("id"))); }
    catch (e) {
      if (e instanceof RemoteRestoreError) return c.json({ error: e.message }, e.status);
      return busy(c, e) ?? c.json({ error: "Exact Remote session restore failed" }, 502);
    }
  });

  app.post("/api/sessions/:id/externally-started", async (c) => {
    try { return c.json({ session: await d.mgr.markExternallyStarted(c.req.param("id")) }); }
    catch (e) {
      if (e instanceof ExternalStartError) return c.json({ error: e.message }, e.kind === "unknown" ? 404 : 409);
      return busy(c, e) ?? c.json({ error: (e as Error).message }, 502);
    }
  });

  app.post("/api/sessions/:id/stop", async (c) => {
    try { await d.mgr.stop(c.req.param("id")); return c.body(null, 204); }
    catch (e) { return busy(c, e) ?? c.json({ error: (e as Error).message }, 404); }
  });

  // End may wait tens of minutes for the offsite backup (storageGuard.ts). The client must not
  // hang: after endSyncWaitMs() it gets 202 and End finishes in the background — it keeps holding the "end"
  // lock (second click = "end already running"), the result arrives as a notification.
  app.post("/api/sessions/:id/end", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { soloAction?: "keep" | "delete" };
    const p = d.mgr.end(id, body.soloAction ?? "keep");
    const first = await Promise.race([
      p.then(() => null, (e: unknown) => e as Error),
      Bun.sleep(endSyncWaitMs()).then(() => "pending" as const),
    ]);
    if (first === "pending") {
      p.then(() => d.notify("Session ended", `${id}: backup and cleanup finished.`),
        (e: Error) => { console.error(`background end ${id} failed:`, e); d.notify("Ending session failed", `${id}: ${e.message}`); });
      return c.json({ pending: true }, 202);
    }
    if (first) return busy(c, first) ?? c.json({ error: first.message }, 404);
    return c.body(null, 204);
  });

  app.get("/api/instabox/jobs/:id", (c) => {
    const j = d.instabox?.sessions.job(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "unknown job" }, 404);
  });

  // reconcile() never throws (API outage → ok:false); the try/catch is a safeguard so the route
  // does not return 500 even on an error outside reconcile (the dashboard would not show the panel at all).
  app.get("/api/instabox/status", async (c) => {
    if (!d.instabox) return c.json({ enabled: false });
    try { return c.json(await d.instabox.status()); }
    catch (e) { return c.json({ enabled: true, ok: false, error: (e as Error).message }); }
  });

  app.get("/api/placement", (c) => {
    if (!d.instabox) return c.json({ suggest: "vps", reason: null });
    const load = d.instabox.hostLoad();
    return c.json({ ...suggestPlacement(load, d.instabox.settings), load });
  });

  app.post("/api/instabox/base/rebuild", (c) => {
    if (!d.instabox) return c.json({ error: "InstaBox is not configured" }, 503);
    const j = d.instabox.rebuildBase();
    return j ? c.json(j, 202) : c.json({ error: "base rebuild is already running", inProgress: "instabox-base" }, 409);
  });

  app.get("/api/instabox/base/jobs/:id", (c) => {
    const j = d.instabox?.baseJob(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "unknown job" }, 404);
  });

  // Deletes ONLY an orphaned machine (devbox=1 without a session). A session's machine is deleted via End session.
  app.delete("/api/instabox/machines/:id", async (c) => {
    if (!d.instabox) return c.json({ error: "InstaBox is not configured" }, 503);
    try {
      return (await d.instabox.killOrphan(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "not an orphaned devbox machine" }, 409);
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  app.post("/api/sessions/:id/desktop-link", async (c) => {
    const s = getSession(d.db, c.req.param("id"));
    if (!s || s.host !== "instabox" || !d.instabox) return c.json({ error: "desktop exists only for InstaBox sessions" }, 404);
    if (s.status !== "running") return c.json({ error: "session is not running" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { control?: boolean; refresh?: boolean };
    // `refresh`: the dashboard just fetches a fresh link in advance for a possible reconnect
    // (M7) — the open iframe keeps running, so nothing is invalidated or logged.
    const refresh = body.refresh === true;
    try {
      const l = await d.instabox.sessions.desktopLink(s, body.control === true, refresh);
      if (!refresh) logEvent(d.db, s.id, body.control === true ? "desktop_control" : "desktop_view");
      return c.json(l);
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  app.delete("/api/sessions/:id/desktop-link", async (c) => {
    const s = getSession(d.db, c.req.param("id"));
    if (!s || s.host !== "instabox" || !d.instabox) return c.json({ error: "desktop exists only for InstaBox sessions" }, 404);
    // Pause has already invalidated the links, and an API call could wake the paused machine.
    if (s.status !== "running") return c.body(null, 204);
    try { await d.instabox.sessions.desktopRevoke(s); return c.body(null, 204); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Marking a session as "important": its notifications (done/blocked/stuck) go out
  // as a loud persistent Pushover emergency (see index.ts notify + stuck check).
  app.post("/api/sessions/:id/important", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { important?: boolean };
    const s = getSession(d.db, c.req.param("id"));
    if (!s) return c.json({ error: "unknown session" }, 404);
    setImportant(d.db, s.id, body.important ? 1 : 0);
    return c.body(null, 204);
  });

  // Renaming a session: optional nickname for display (otherwise project/repo).
  // Empty/whitespace → null (clears the nickname). The server sanitizes the input (sanitizeSessionName).
  app.post("/api/sessions/:id/name", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const s = getSession(d.db, c.req.param("id"));
    if (!s) return c.json({ error: "unknown session" }, 404);
    const name = sanitizeSessionName(body.name);
    setSessionName(d.db, s.id, name);
    logEvent(d.db, s.id, "rename", { name });
    return c.body(null, 204);
  });

  // Critic toggle: an enabled session must not end a turn without review (criticGate).
  app.post("/api/sessions/:id/critic", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { critic?: boolean };
    const s = getSession(d.db, c.req.param("id"));
    if (!s) return c.json({ error: "unknown session" }, 404);
    if (body.critic) { const g = ibxOnly(c, s, "Critic"); if (g) return g; }
    setCritic(d.db, s.id, body.critic ? 1 : 0);
    logEvent(d.db, s.id, "critic_toggle", { critic: !!body.critic });
    return c.body(null, 204);
  });

  app.get("/api/sessions/:id/reviews", (c) => {
    const limit = Number(c.req.query("limit")) || undefined;
    return c.json(listCriticReviews(d.db, c.req.param("id"), limit));
  });

  // Sharing a session terminal via a short-lived link. Admin only (approvalGate) — the share
  // listener (Task 4/5) never calls its own path, it targets shares.ts directly.
  // The token is returned ONLY here, once, in the URL; afterwards only its hash is kept in the DB and log.
  app.post("/api/sessions/:id/shares", async (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { minutes?: number };
    const minutes = body.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > SHARE_MAX_MINUTES) {
      return c.json({ error: `minutes must be an integer 1…${SHARE_MAX_MINUTES}` }, 400);
    }
    const s = getSession(d.db, c.req.param("id"));
    if (!s) return c.json({ error: "unknown session" }, 404);
    { const g = ibxOnly(c, s, "Terminal share"); if (g) return g; }
    if (s.status !== "running") return c.json({ error: "session is not running" }, 409);
    if (!d.dind) return c.json({ error: "sharing requires DEVD_DIND=1 — without it the session has the host docker.sock" }, 409);
    if (d.shareAvailable && !d.shareAvailable()) return c.json({ error: "sharing is disabled — the share listener (port 4302) is not running, see the devd log" }, 503);
    // Restriction BEFORE the link (final review C2/C4): the guest must not get a terminal until
    // (1) the privileged dind sidecar is not running — from it they could reach host root, and
    // (2) the container is recorded as tainted — the restriction then survives link revocation
    // and devd restart and ends only with a container rebuild (new docker id).
    // All under the session lock (rereview N4): open/recover/recreate (ensureDind) run under
    // the same key, so between determining the docker id, the taint, stopping dind and creating
    // the link nobody can rebuild the container or start the sidecar again.
    try {
      return await d.mgr.withLock([s.id], "share", async () => {
        let containerId: string | null;
        try { containerId = await lockdown.containerId(s.container); }
        catch (e) { return c.json({ error: `could not determine the session container — sharing was not created: ${(e as Error).message}` }, 502); }
        if (!containerId) return c.json({ error: "session container does not exist — sharing was not created" }, 409);
        // Taint BEFORE stopping dind (rereview N4): ensureDind does not start the sidecar for a tainted
        // session, so after stopping nothing brings it back. A failure below leaves the taint —
        // fail-closed, the session stays restricted until a rebuild.
        markTainted(d.db, s.id, containerId);
        sharedSessions.invalidate(); // the container is restricted immediately, not after the cache expires
        try { await lockdown.stopDind(s.id); }
        catch (e) { return c.json({ error: `could not stop the session's docker (dind) sidecar — sharing was not created (the session stays restricted until you rebuild it): ${(e as Error).message}` }, 502); }
        identity.markChanged(); // the stopped sidecar's IP no longer belongs to the session
        if (lockdown.syncFirewall) {
          try { await lockdown.syncFirewall(); }
          catch (e) {
            logEvent(d.db, s.id, "terminal_share_firewall_failed", { message: (e as Error).message });
            return c.json({ error: `could not set up the firewall for the restricted container — sharing was not created (the session stays restricted until you rebuild it): ${(e as Error).message}` }, 502);
          }
        }
        const { id, token, expiresAt } = createShare(d.db, s.id, minutes);
        sharedSessions.invalidate();
        logEvent(d.db, s.id, "terminal_share_created", { id, minutes });
        return c.json({ id, url: `https://${shareHostFromEnv()}/s/${token}`, expiresAt }, 201);
      });
    } catch (e) {
      const b = busy(c, e); if (b) return b;
      throw e;
    }
  });

  // Cross-session listing — same reason as GET /api/ssh-approvals: without approvalGate
  // any container would see active shares of other sessions too.
  app.get("/api/shares", (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    return c.json(listActiveShares(d.db));
  });

  app.delete("/api/shares/:id", (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const id = c.req.param("id");
    const sessionId = revokeShare(d.db, id);
    if (!sessionId) return c.json({ error: "unknown or already revoked share" }, 404);
    logEvent(d.db, sessionId, "terminal_share_revoked", { id });
    return c.body(null, 204);
  });

  // Renaming ONE tmux session (Claude) inside the container: @devd_label. Empty → clear.
  app.post("/api/sessions/:id/tmux/:name/label", async (c) => {
    const name = c.req.param("name");
    if (!isValidTmuxName(name)) return c.json({ error: "invalid tmux session name" }, 400);
    const s = getSession(d.db, c.req.param("id"));
    if (!s || s.status !== "running") return c.json({ error: "unknown or not running session" }, 404);
    if (!d.tmuxExec) return c.json({ error: "tmux exec unavailable" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const label = sanitizeSessionName(body.name);
    await d.tmuxExec(s.container, labelSetCmd(name, label));
    logEvent(d.db, s.id, "tmux_rename", { session: name, label });
    return c.body(null, 204);
  });

  // Ending ONE tmux session (Claude). Last session → ends the whole devd session.
  app.post("/api/sessions/:id/tmux/:name/kill", async (c) => {
    const name = c.req.param("name");
    if (!isValidTmuxName(name)) return c.json({ error: "invalid tmux session name" }, 400);
    const s = getSession(d.db, c.req.param("id"));
    if (!s || s.status !== "running") return c.json({ error: "unknown or not running session" }, 404);
    if (!d.tmuxExec) return c.json({ error: "tmux exec unavailable" }, 503);
    await d.tmuxExec(s.container, killSessionCmd(name));
    const remaining = parseProbe((await d.tmuxExec(s.container, probeCmd())).stdout);
    if (remaining.length === 0) {
      // end() goes through the same lock as recreate/stop (SessionManager.locked) —
      // closing the last panel while a recreate is running on the session used to fall
      // into a bare 500 (api.ts has no app.onError). Same busy() as the other
      // five lifecycle routes, i.e. 409 with `inProgress`.
      try { await d.mgr.end(s.id, "keep"); }
      catch (e) { return busy(c, e) ?? c.json({ error: (e as Error).message }, 404); }
      logEvent(d.db, s.id, "tmux_kill", { session: name, ended: true });
      return c.json({ ended: true });
    }
    logEvent(d.db, s.id, "tmux_kill", { session: name, ended: false });
    return c.json({ ended: false });
  });

  // Sign-in of critic providers. codexAuth runs over the shared auth volumes via
  // ephemeral containers. Behind the same boundary (CF Access + tailnet) as the rest of the dashboard.
  const needAuth = () => d.codexAuth ?? null;
  // Review round 1, Minor: previously ALL auth endpoints (including proxy and Grok) reported 503
  // with a hardcoded "codex auth" regardless of which provider was missing — whoever debugs
  // a Grok-specific 503 sees a misleading "codex". `what` names the ACTUAL source
  // (one and the same `d.codexAuth`, just a different label depending on which endpoint family
  // calls it) — without the `what` parameter it would be purely cosmetic (still the same variable).
  const authMissing = (c: Context, what: string) => c.json({ error: `${what} is not configured` }, 503);
  app.get("/api/auth", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "agent auth");
    try { return c.json(await authStatus(ca)); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.post("/api/auth/codex/login/start", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "codex auth");
    try { return c.json(await codexLoginStart(ca)); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.get("/api/auth/codex/login/status", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "codex auth");
    try { return c.json({ status: await codexLoginStatus(ca) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.post("/api/auth/codex/logout", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "codex auth");
    try { await codexLogout(ca); return c.body(null, 204); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Proxy accounts (CLIProxyAPI): Codex and xAI/Grok subscriptions behind the shared proxy. `:provider`
  // is validated manually (Hono has no enum param), a bad value → 400 before docker
  // is touched at all.
  app.post("/api/auth/proxy/:provider/login/start", async (c) => {
    const provider = c.req.param("provider");
    if (!isProxyProvider(provider)) return c.json({ error: "unknown provider" }, 400);
    const ca = needAuth(); if (!ca) return authMissing(c, "proxy auth");
    try {
      const r = await proxyLoginStart(ca, provider);
      // The OAuth redirect goes to http://localhost:1455 — in the browser ON THE MAC. The bridge
      // (listener /proxy-bridge → relay below → login container) is built right at
      // login start, so the path is ready before the user finishes signing in.
      // Bridge failure does not block login: the `bridge` field just tells the dashboard to
      // suggest a manual SSH tunnel. The port is sent because the relay runs on THIS devd,
      // wherever it listens; the host takes the listener from the request's source address.
      let bridge: "ok" | "unavailable" = "unavailable";
      try {
        await d.listener.proxyBridge(900, Number(process.env.DEVD_PORT ?? "4300"));
        bridge = "ok";
      } catch { /* mac asleep / old listener without /proxy-bridge — instructions in the UI */ }
      return c.json({ ...r, bridge });
    }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // Last hop of the OAuth callback: the listener on the mac forwards here what the browser sent
  // to localhost:1455, and from here it goes to the login container (CLIPROXY_CALLBACK_PORT is
  // published only on the host loopback). The target is hardwired; a path with a scheme or
  // protocol-relative (`//host`) is rejected, otherwise the relay would be an SSRF.
  // Changes state (completes the OAuth login) via GET — an `<img>` from a preview would otherwise perform login CSRF.
  app.get("/api/auth/proxy/relay", stateChangingGetGuard(allowedOrigins), async (c) => {
    const path = c.req.query("path") ?? "";
    if (!path.startsWith("/") || path.startsWith("//")) return c.json({ error: "path must start with a single slash" }, 400);
    try {
      const r = await fetch(`http://127.0.0.1:${CLIPROXY_CALLBACK_PORT}${path}`, { signal: AbortSignal.timeout(10_000) });
      return new Response(await r.arrayBuffer(), {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") ?? "text/plain; charset=utf-8" },
      });
    } catch (e) { return c.json({ error: `login container is not responding: ${(e as Error).message}` }, 502); }
  });
  app.get("/api/auth/proxy/:provider/login/status", async (c) => {
    const provider = c.req.param("provider");
    if (!isProxyProvider(provider)) return c.json({ error: "unknown provider" }, 400);
    const ca = needAuth(); if (!ca) return authMissing(c, "proxy auth");
    try { return c.json({ status: await proxyLoginStatus(ca, provider) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Grok Build: own account (not proxy) via headless device-auth, with XAI_API_KEY as a
  // fallback path.
  app.post("/api/auth/grok/login/start", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "grok auth");
    try { return c.json(await grokLoginStart(ca)); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.get("/api/auth/grok/login/status", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "grok auth");
    try { return c.json({ status: await grokLoginStatus(ca) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Antigravity CLI (agy): Google OAuth with code paste. The code is validated HERE, before
  // docker is touched — it goes into the login container's terminal as keystrokes.
  app.post("/api/auth/antigravity/login/start", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "antigravity auth");
    try { return c.json(await agyLoginStart(ca)); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.post("/api/auth/antigravity/login/code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    if (!isValidAgyCode(body?.code)) return c.json({ error: "invalid authorization code" }, 400);
    const ca = needAuth(); if (!ca) return authMissing(c, "antigravity auth");
    try { await agyLoginCode(ca, body.code); return c.body(null, 204); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.get("/api/auth/antigravity/login/status", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "antigravity auth");
    try { return c.json({ status: await agyLoginStatus(ca) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.post("/api/auth/antigravity/logout", async (c) => {
    const ca = needAuth(); if (!ca) return authMissing(c, "antigravity auth");
    try { await agyLogout(ca); return c.body(null, 204); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Web terminal: WS bridge to a tmux session (target via ?tmux=, default main). Read-only until the client sends
  // {t:"unlock"}. Behind CF Access + Tailscale (same origin) — no new token.
  const terminalCounts = new Map<string, number>();
  const MAX_TERMINALS_PER_SESSION = 4;
  app.get("/api/sessions/:id/terminal", upgradeWebSocket((c) => {
    const id = c.req.param("id") ?? ""; // param typing does not propagate into the upgradeWebSocket callback
    const s = getSession(d.db, id);
    let bridge: Bridge | null = null;
    let counted = false;
    return {
      onOpen(_evt, ws) {
        const guard = terminalGuard(s);
        if (!guard.ok) { ws.close(guard.code, guard.reason); return; }
        if (!d.spawnPty) { ws.close(1011, "terminal is not enabled"); return; }
        const n = terminalCounts.get(id) ?? 0;
        if (n >= MAX_TERMINALS_PER_SESSION) { ws.close(1013, "too many terminals"); return; }
        terminalCounts.set(id, n + 1); counted = true;
        const target = terminalTarget(c.req.query("tmux"), isValidTmuxName);
        bridge = createBridge({
          db: d.db, sessionId: s!.id, container: s!.container, target, spawn: d.spawnPty,
          cols: 80, rows: 24, sink: { send: (data) => ws.send(data), close: () => ws.close() },
          // The "↓" jump-to-bottom button: exits copy-mode of the grouped session (pty runs as the same user → same tmux socket).
          // `=` = exact name match, so a dead web-X-1 does not catch web-X-10 by prefix.
          exitCopyMode: async (name) => { await execInContainer(s!.container, ["tmux", "send-keys", "-t", `=${name}`, "-X", "cancel"]); },
        });
      },
      onMessage(evt) { if (typeof evt.data === "string") bridge?.onClientMessage(evt.data); },
      onClose() {
        bridge?.dispose();
        if (counted) { const n = (terminalCounts.get(id) ?? 1) - 1; if (n <= 0) terminalCounts.delete(id); else terminalCounts.set(id, n); }
      },
    };
  }));

  app.post("/api/open", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionId?: string; path?: string } | null;
    if (typeof body?.sessionId !== "string" || typeof body.path !== "string") return c.json({ error: "sessionId and path required" }, 400);
    const p = body.path;
    const suffix = p === "/workspace" ? "" : p.startsWith("/workspace/") ? p.slice("/workspace".length) : null;
    if (suffix === null || suffix.split("/").some((seg) => seg === ".." || seg === ".")) return c.json({ error: "invalid path" }, 400);
    const s = getSession(d.db, body.sessionId);
    if (!s) return c.json({ error: `unknown session ${body.sessionId}` }, 404);
    { const g = ibxOnly(c, s, "Open in Finder"); if (g) return g; }
    // The workspace of a shared/tainted session could have been written by the terminal guest — not to the mac with it.
    if (restricted(s.id)) return c.json({ error: SHARED_DENIED }, 403);
    const hostPath = sessionWorkdir(d.root, s) + suffix;
    try { await d.listener.open(hostPath); return c.body(null, 204); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // The container sends the CONTAINER port (3000+i), which it knows from /proc/net/tcp; base must
  // match the mapping in docker.ts (`-p bindIp:port_base+i:3000+i`).
  const CONTAINER_PORT_BASE = 3000;

  // Like /api/open, this endpoint trusts the sessionId in the body and is reachable
  // without authentication from the docker bridge (deliberately).
  app.post("/api/preview", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionId?: string; containerPort?: number; path?: string } | null;
    if (typeof body?.sessionId !== "string" || typeof body?.containerPort !== "number") return c.json({ error: "sessionId and containerPort required" }, 400);
    const s = getSession(d.db, body.sessionId);
    if (!s) return c.json({ error: `unknown session ${body.sessionId}` }, 404);
    // InstaBox session ports are bound only inside the VM.
    { const g = ibxOnly(c, s, "Preview"); if (g) return g; }
    const n = d.cfg.settings.portsPerSession;
    const containerPort = body.containerPort;
    if (!Number.isInteger(containerPort) || containerPort < CONTAINER_PORT_BASE || containerPort >= CONTAINER_PORT_BASE + n) {
      return c.json({ error: `containerPort mimo rozsah (${CONTAINER_PORT_BASE}–${CONTAINER_PORT_BASE + n - 1})` }, 403);
    }
    // An empty string (the shim always sends path, even without an explicit sub-path) is
    // equivalent to a missing path — both mean "no sub-path, root".
    let path = "";
    if (body.path) {
      if (typeof body.path !== "string" || !body.path.startsWith("/") || body.path.split("/").some((seg) => seg === "." || seg === "..")) {
        return c.json({ error: "invalid path" }, 400);
      }
      path = body.path;
    }
    if (!d.previewHost) return c.json({ error: "preview host is not configured (DEVD_BIND_IP)" }, 500);
    const hostPort = s.port_base + (containerPort - CONTAINER_PORT_BASE);
    const url = `http://${d.previewHost}:${hostPort}${path}`;
    // Shared session: the agent must not send the guest a Tailscale address (the guest cannot open it and it reveals
    // the tailnet) — it gets only the port; the guest opens the preview via the p<N> link on the share page.
    // For the owner the preview opens on the mac as always; listener failure does not matter here.
    // Shared and tainted session: the preview content is (or was) controlled by the terminal guest, so
    // it is NOT opened automatically on the owner's mac (final review I3) — the owner opens it themselves.
    if (restricted(s.id)) {
      return c.json({ publicPreview: isShared(d.db, s.id), port: containerPort }, 200);
    }
    try { await d.listener.openUrl(url); return c.json({ url }, 200); }
    catch (e) { return c.json({ error: (e as Error).message, url }, 502); }
  });

  app.post("/api/notify", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { title?: string; message?: string } | null;
    if (typeof body?.title !== "string" || typeof body?.message !== "string") return c.json({ error: "title and message required" }, 400);
    d.notify(body.title, body.message);
    return c.body(null, 204);
  });

  // Claude hook events from containers (image/vendor/devd-hooks). No auth, like
  // /v1/metrics — reachable only from the docker bridge / tailnet.
  app.post("/api/agent-event", async (c) => {
    if (!d.agentEvents) return c.json({ error: "agent events are not enabled" }, 503);
    const body = (await c.req.json().catch(() => null)) as (Record<string, unknown> & { sessionId?: string; event?: string }) | null;
    if (!body || typeof body.sessionId !== "string") {
      return c.json({ error: "sessionId and a valid event are required" }, 400);
    }
    // session_start is not a notification event (AGENT_EVENTS) — it serves ONLY attribution
    // of grok usage: sid from hook stdin → devbox session, read by grokHarvester.
    if (body.event === "session_start") {
      const s = getSession(d.db, body.sessionId);
      if (!s) return c.json({ error: `unknown session ${body.sessionId}` }, 404);
      const sid = typeof body.agentSessionId === "string" ? body.agentSessionId : null;
      if (sid && specFor(s.agent).runtime === "grok") {
        const map = getHarvestState<GrokSidMap>(d.db, "grok-sids") ?? {};
        // project/repo are stored IMMEDIATELY — grokHarvester can then use them even if
        // the session ends in the meantime and getSession stops seeing it (deleteSession).
        map[sid] = { session: s.id, project: s.project, repo: s.repo, ts: Date.now() };
        // The map must not grow forever: keep the ~200 newest.
        const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, 200);
        setHarvestState(d.db, "grok-sids", Object.fromEntries(entries));
      }
      // Antigravity: conversation → session for antigravityHarvester (the transcript lives on the
      // shared volume under conversationId). The hook sends the model at SessionStart and again
      // with every new prompt (agy-hook.sh: PreInvocation 0 → session_start) — the user
      // switches it between prompts with `/model` and the transcript does not carry the model per step. Hence
      // a `models` history (since when which), not just the last value: the harvester runs
      // every minute and steps before the switch must get the OLD model (and its price).
      if (sid && specFor(s.agent).runtime === "agy" && /^[0-9a-f-]+$/i.test(sid)) {
        const map = getHarvestState<AgySidMap>(d.db, "agy-sids") ?? {};
        const model = typeof body.agentModel === "string" && body.agentModel.length <= 120 ? body.agentModel : null;
        const now = Date.now();
        const prev = map[sid];
        const models = [...(prev?.models ?? (prev?.model ? [{ from: prev.ts, model: prev.model }] : []))];
        if (model && models.at(-1)?.model !== model) models.push({ from: now, model });
        map[sid] = { session: s.id, project: s.project, repo: s.repo, model: model ?? prev?.model ?? null, ts: now, models: models.slice(-50) };
        const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, 200);
        setHarvestState(d.db, "agy-sids", Object.fromEntries(entries));
      }
      return c.json({ ok: true });
    }
    if (!AGENT_EVENTS.includes(body.event as AgentEvent)) {
      return c.json({ error: "sessionId and a valid event are required" }, 400);
    }
    const s = getSession(d.db, body.sessionId);
    if (!s) return c.json({ error: `unknown session ${body.sessionId}` }, 404);
    // Critic: prompt starts the turn (baseline + task), stop is the gate before "done".
    if (d.critic && body.event === "user_prompt_submit") {
      d.critic.onPrompt(s, typeof body.prompt === "string" ? body.prompt : "");
    }
    // Prompt statistics. ONLY the length and wait time go to the DB — the prompt text is
    // the user's work content and has no business in the database (and would bloat it).
    if (body.event === "user_prompt_submit" && typeof body.prompt === "string" && body.prompt.length > 0) {
      const now = Date.now();
      const lastStop = d.agentEvents.lastStopTs(s.id);
      const attrs = JSON.stringify({ project: s.project, repo: s.repo });
      const rows = [{ ts: now, session_id: s.id, name: PROMPT_CHARS, value: body.prompt.length, attrs }];
      // waitMs only when we know when the agent finished — after a devd restart the first prompt
      // of a session has no reference, and inventing one would skew the median. `>=` on purpose:
      // we reject only a negative value (clock skew); zero is legitimate.
      if (lastStop !== null && now >= lastStop) {
        rows.push({ ts: now, session_id: s.id, name: PROMPT_WAIT, value: now - lastStop, attrs });
      }
      insertMetrics(d.db, rows);
    }
    if (d.critic && body.event === "stop") {
      const decision = await d.critic.onStop(s);
      // Block = the turn continues. Stop is DELIBERATELY not passed to the hub, otherwise a
      // "finished" notification would be scheduled in the middle of a fix round.
      if (decision.block) {
        // Real counters from the hub, not a hardcoded 0 — the row serves diagnosis, a fabricated
        // value would defeat it (see notify_log spec §4).
        const counters = d.agentEvents.counters(s.id);
        insertNotifyLog(d.db, {
          ts: Date.now(), session_id: s.id, event: "stop", decision: "suppressed", reason: "critic-block",
          inflight: counters.inflight, teammates: counters.teammates,
          agent_session_id: hookMeta(body).agentSessionId ?? null, detail: null,
        });
        return c.json({ decision: "block", reason: decision.reason });
      }
    }
    d.agentEvents.handle(s, body.event as AgentEvent, hookMeta(body));
    d.liveActivities?.request();
    return c.json({ ok: true });
  });

  // Registration of iOS (APNs) devices for emergency push notifications. No extra
  // auth — same exposure as /api/agent-event (behind CF/tailnet).
  app.post("/api/push/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: string; platform?: string; name?: string } | null;
    if (!body || !body.token || !body.platform) return c.json({ error: "token and platform are required" }, 400);
    // An APNs device token is a hex string. The token is then passed directly into curl argv
    // (see apnsCurlArgs) as part of the URL — validation here is defense in depth
    // next to `-g`/globoff in curl, not the only safeguard.
    if (!/^[0-9a-f]{8,}$/i.test(body.token)) return c.json({ error: "token must be a hex string" }, 400);
    upsertPushDevice(d.db, { token: body.token, platform: body.platform, name: body.name ?? null });
    return c.json({ ok: true });
  });

  // Acknowledgement of an emergency push notification from the phone — stops further alert re-sends.
  app.post("/api/push/ack", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { alertId?: string } | null;
    if (!body || !body.alertId) return c.json({ error: "alertId is required" }, 400);
    const stopped = ackPushAlert(d.db, body.alertId, Date.now());
    return c.json({ ok: true, stopped });
  });

  // Notification debug log for the /notifications page: reading and manually flagging
  // a wrong decision (both sides — falsely sent and missing notifications).
  app.get("/api/notify-log", (c) => {
    const verdict = c.req.query("verdict");
    const allowed = ["false_positive", "missing", "ok", "flagged"];
    if (verdict !== undefined && !allowed.includes(verdict)) return c.json({ error: "invalid verdict" }, 400);
    // Server-side filter on decision: without it "only sent" would filter client-side over
    // the last 300 rows of ALL decisions, and on a live devbox the sent/sweep_done rows would
    // be buried under subagent_start/stop noise — the page would show empty even when sent exists.
    const decision = c.req.query("decision");
    const allowedDecision = ["armed", "sent", "deferred", "suppressed", "none"];
    if (decision !== undefined && !allowedDecision.includes(decision)) return c.json({ error: "invalid decision" }, 400);
    // A non-numeric ?limit= (e.g. "abc") would put NaN into SQL LIMIT and bun:sqlite would throw
    // "datatype mismatch" — the clamp in listNotifyLog does not save NaN (Math.min/max propagates it).
    const rawLimit = Number(c.req.query("limit") ?? 200);
    return c.json(listNotifyLog(d.db, {
      session: c.req.query("sessionId") || undefined,
      verdict: verdict as NotifyVerdict | "flagged" | undefined,
      decision: decision as NotifyDecision | undefined,
      limit: Number.isFinite(rawLimit) ? rawLimit : 200,
    }));
  });

  app.post("/api/notify-log/:id/verdict", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const body = (await c.req.json().catch(() => null)) as { verdict?: unknown; note?: unknown } | null;
    const v = body?.verdict ?? null;
    if (v !== null && !["false_positive", "missing", "ok"].includes(v as string)) {
      return c.json({ error: "invalid verdict" }, 400);
    }
    const note = typeof body?.note === "string" ? body.note : null;
    return setNotifyVerdict(d.db, id, v as NotifyVerdict | null, note)
      ? c.json({ ok: true })
      : c.json({ error: `unknown row ${id}` }, 404);
  });

  app.post("/v1/metrics", async (c) => {
    try {
      const rows = pointsToRows(parseOtlpMetrics(await c.req.json()));
      if (rows.length) insertMetrics(d.db, rows);
      return c.json({ accepted: rows.length });
    } catch { return c.json({ accepted: 0 }); }
  });

  app.get("/api/stats/live", (c) => c.json(d.stats()));
  app.get("/api/stats/resources", (c) => d.resources ? c.json(d.resources()) : c.json({ error: "resource overview is not available" }, 503));
  app.get("/api/stats/totals", (c) => c.json(buildTotals(d.db, Date.now())));
  app.get("/api/stats/projects", (c) => c.json(buildProjectLeaderboard(d.db, Date.now())));
  app.get("/api/stats/sessions", (c) => c.json(buildSessionUsage(d.db, Date.now())));
  app.get("/api/stats/disk", (c) => {
    const live = d.stats() as { disk: { usedBytes: number; totalBytes: number } };
    return c.json(predictDisk(diskHistoryEnds(d.db), live.disk.totalBytes));
  });
  app.post("/api/stats/reset", (c) => { resetStats(d.db); return c.json({ ok: true }); });
  app.get("/api/stats/range", (c) => {
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return c.json({ error: "invalid range: expected from<to in epoch ms" }, 400);
    }
    // An unknown project is deliberately NOT a 400 — it returns zeros just like a range without data.
    // A link with ?project=... thus survives even project deletion (shows empty, does not crash).
    const project = c.req.query("project")?.trim() || null;
    const repo = c.req.query("repo")?.trim() || null;
    return c.json(buildRange(d.db, from, to, project, repo));
  });

  // Hours worked (wall-clock, not agent activity — see the comment at buildWorkHours).
  app.get("/api/stats/work", (c) => {
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return c.json({ error: "from and to must be numbers and to > from" }, 400);
    }
    return c.json(buildWorkHours(d.db, from, to, c.req.query("project")?.trim() || null, c.req.query("repo")?.trim() || null));
  });

  // Log: surface of the events table (newest first). Filters session/type(s)/from-to,
  // pagination via offset. `total` is the count after filters — without it the dashboard
  // could not compute the number of pages.
  app.get("/api/events", (c) => {
    const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const typesRaw = c.req.query("types");
    const filter = {
      limit: num(c.req.query("limit")),
      offset: num(c.req.query("offset")),
      session: c.req.query("session") || undefined,
      type: c.req.query("type") || undefined,
      types: typesRaw ? typesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      from: num(c.req.query("from")),
      to: num(c.req.query("to")),
    };
    // Without pagination parameters the response stays a bare array (older clients, CLI).
    const paged = c.req.query("offset") !== undefined || c.req.query("paged") === "1";
    const items = listEvents(d.db, filter);
    return paged
      ? c.json({ items, total: countEvents(d.db, filter), types: distinctEventTypes(d.db) })
      : c.json(items);
  });

  const opLimited = (c: Context, e: unknown): Response | null => {
    if (!(e instanceof OpRateLimited)) return null;
    const retryAfterSeconds = e.retryAfterSeconds();
    c.header("Retry-After", String(retryAfterSeconds));
    return c.json({ error: e.message, code: "OP_RATE_LIMITED", retryAfterSeconds,
      retryAt: e.retryAt, resetKnown: e.resetKnown }, 429);
  };
  // 1Password SSH-key broker: the token lives only here (host), never in a container.
  // Containers' `srv` lists keys and fetches ONE (whitelisted to SSH-key items); every
  // fetch is logged. Read-only, SSH-keys-only — no path to passwords/API tokens.
  app.get("/api/op/ssh-keys", async (c) => {
    const stranger = sessionGate(c); if (stranger) return stranger;
    const flooded = limitGate(c, keyListLimiter); if (flooded) return flooded;
    const locked = vaultGate(c); if (locked) return locked;
    // Via `sshKeyLister` (memoAsyncStrict in index.ts), NOT a direct `listSshKeys(d.opToken)`:
    // that goes through `run()` and the route is reachable from the container (`image/srv`) without
    // arguments. The cache bounds the call cost, `keyListLimiter` above bounds the call count.
    const sshKeyLister = d.sshKeyLister;
    if (!sshKeyLister) return c.json({ error: "1Password is not configured" }, 503);
    try {
      const keys = await sshKeyLister();
      const servers = d.sshServers?.() ?? [];
      return c.json({ keys: keys.map((k) => ({ ...k, servers: servers
        .filter((s) => s.key === k.title)
        .map(({ name, user, host, port }) => ({ name, user, host, port })) })) });
    }
    catch (e) { return opLimited(c, e) ?? c.json({ error: (e as Error).message }, 502); }
  });
  // Approval gate: srv asks for a key, a human decides, and only then is an
  // ssh-agent created on the host. Key material never reaches the container or the response.
  app.post("/api/ssh-approvals", async (c) => {
    // Limit BEFORE vaultGate and before everything else: the point is not to let spam through, whether
    // it would end in a prompt or just an error.
    const flooded = limitGate(c, approvalLimiter); if (flooded) return flooded;
    const locked = vaultGate(c); if (locked) return locked;
    // One gate for "1Password is not available" (there used to be two identical 503s here —
    // opToken and sshKeyLister; in production both come from the same token, see index.ts,
    // so the second check only confused readers). `sshKeyLister` is also a local variable,
    // not just a narrowed `d.sshKeyLister`, so the TS narrowing survives the `await` below.
    const sshKeyLister = d.sshKeyLister;
    if (!sshKeyLister) return c.json({ error: "1Password is not configured" }, 503);
    if (!d.sshAgents) return c.json({ error: "ssh-agent broker is not configured" }, 503);
    const body = (await c.req.json().catch(() => null)) as
      { title?: string; session?: string; why?: string; cwd?: string; target?: unknown; server?: unknown } | null;
    if (!body?.title) return c.json({ error: "title required" }, 400);
    if (!body.why?.trim()) return c.json({ error: "why required" }, 400);
    const session = c.req.header("x-devbox-session") || body.session || "";
    if (!session) return c.json({ error: "session required" }, 400);
    const row = getSession(d.db, session);
    // `target`/`server` are optional, but when present they must be strings —
    // otherwise typeof below would silently drop them and the request would pass as "no target".
    if (body.target !== undefined && typeof body.target !== "string") return c.json({ error: "target must be a string" }, 400);
    if (body.server !== undefined && typeof body.server !== "string") return c.json({ error: "server must be a string" }, 400);
    // The raw target goes into the DB, the notification and the dialog on the mac — no control characters or
    // spaces (an ssh target never has them) and a reasonable length.
    if (typeof body.target === "string" && (body.target.length > 255 || /[\s\x00-\x1f\x7f]/.test(body.target))) {
      return c.json({ error: "invalid target" }, 400);
    }

    // `target` only for the grant path — bypass ignores the target.
    const issue = async (why: "bypass" | "grant", target: string | null = null) => {
      try {
      const { agentSock } = await d.sshAgents!.activate(session, body.title!);
      // Activation yields while loading the key; the grant may be revoked meanwhile.
      // Recheck the grant for THIS target; the kill, though, is key-level: the agent
      // holds the key for every target, so it stays while any other target's grant
      // of the same key is live (liveKeyGrant, see sshApprovals.ts).
      const grant = why === "grant" ? liveGrant(d.db, session, body.title!, target) : undefined;
      if (why === "grant" && !grant) {
        if (!liveKeyGrant(d.db, session, body.title!)) await d.sshAgents!.kill(session, body.title!);
        return c.json({ error: "the approval expired or was revoked in the meantime" }, 403);
      }
      logEvent(d.db, session, "ssh_key_access", { title: body.title, via: why });
      return c.json({ agentSock, expiresAt: grant?.grant_until ?? null });
      } catch (e) { return opLimited(c, e) ?? c.json({ error: "Loading the SSH key failed" }, 502); }
    };
    if (d.sshApprovalEnabled === false) {
      logEvent(d.db, session, "ssh_key_bypass", { title: body.title });
      return await issue("bypass");
    }
    // A grant applies to (session, key, target) — so the target is resolved (server alias
    // from config, or a normalized free-form `user@host:port`) BEFORE looking for a live
    // grant. A request without a target looks only for a grant without a target (NULL covers only NULL).
    const resolved = resolveSshTarget(d.sshServers?.() ?? [], body.title, {
      server: typeof body.server === "string" ? body.server : undefined,
      target: typeof body.target === "string" ? body.target : undefined,
    });
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);
    // A shared/tainted session must not silently use a grant the owner approved earlier
    // for their agent — every request goes to the owner again, with a label (final review I4).
    if (!fromShared(session) && liveGrant(d.db, session, body.title, resolved.target)) return await issue("grant", resolved.target);

    // title is chosen by the container (srv gets it as $1) — before we create the approval row
    // and send the prompt, verify it against the real SSH-key items in 1Password (via
    // sshKeyLister above — in index.ts it sits behind the memoAsyncStrict cache, so verification
    // does not fire `op` on every request; see the comment there). Without verification a
    // made-up/official-sounding name would look to the approver like a fact verified by devd.
    // An unknown title is 400; the list of available keys is not reflected in the message. All
    // cheap rejections (title/why/session) happened above — only a valid
    // request that really needs to call `op` gets here.
    let knownKeys: SshKeyRef[];
    try { knownKeys = await sshKeyLister(); }
    catch (e) { return opLimited(c, e) ?? c.json({ error: "1Password is currently unavailable, try again" }, 502); }
    if (!knownKeys.some((k) => k.title === body.title)) {
      return c.json({ error: "no SSH key with this name exists" }, 400);
    }

    const id = createApproval(d.db, {
      session, title: body.title, why: body.why.trim(),
      target: resolved.target, server: resolved.server, cwd: body.cwd ?? null,
      project: row?.project ?? null, repo: row?.repo ?? null,
    });
    logEvent(d.db, session, "ssh_key_requested", { id, title: body.title });
    d.notify(sharedTitle("SSH key awaiting approval", session),
      `${body.title} → ${(resolved.server ?? resolved.target ?? "no target").slice(0, 120)} · ${row?.project ?? session}: ${body.why.trim().slice(0, 120)}`,
      { target: { kind: "sshApprovals", id }, blocked: true });
    void d.listener.sshApproval({ ...getApproval(d.db, id)!, ...(fromShared(session) ? { shared: true } : {}) }, (ans) => {
      const now = Date.now();
      const duration = parseGrantDuration(ans, now);
      if (!duration || (ans.decision !== "approve" && ans.decision !== "deny")) return;
      decideApproval(d.db, id, {
        status: ans.decision === "approve" ? "approved" : "denied",
        by: "mac", grantUntil: duration.grantUntil, grantPermanent: duration.grantPermanent,
      }, now);
      syncSshWaiting(session);
    });
    syncSshWaiting(session);
    return c.json({ id, expiresAt: Date.now() + APPROVAL_TTL_MS }, 202);
  });

  // Cross-session listing — without approvalGate any container would see `why`,
  // `cwd`, `target`, `project` and the approval id of EVERY session, not just its own.
  app.get("/api/ssh-approvals", (c) => {
    const blocked = approvalGate(c); if (blocked) return blocked;
    return c.json(listApprovals(d.db, { status: c.req.query("status") as never }));
  });

  // DELIBERATELY without approvalGate: `srv` POLLS this route until a human decides
  // (see sshApprovals.ts/listener.ts) — if the gate blocked it, the whole approval
  // flow would get stuck. It reveals one row to whoever knows its unguessable UUID
  // (in practice only the requester who created the id) — that is an accepted trade-off, not
  // an oversight, so leave it be.
  app.get("/api/ssh-approvals/:id", (c) => {
    const row = getApproval(d.db, c.req.param("id"));
    return row ? c.json(row) : c.json({ error: "unknown request" }, 404);
  });

  app.post("/api/ssh-approvals/:id/approve", async (c) => {
    const blocked = approvalGate(c); if (blocked) return blocked;
    const locked = vaultGate(c); if (locked) return locked;
    const b: unknown = await c.req.json().catch(() => null);
    const now = Date.now();
    const duration = parseGrantDuration(b, now);
    if (!duration) return c.json({ error: "enter whole non-negative minutes within the valid range, or a standalone permanent approval" }, 400);
    const rawBy = (b as Record<string, unknown>).by;
    const by = (typeof rawBy === "string" && ["mac", "ios", "dashboard"].includes(rawBy) ? rawBy : "dashboard") as "mac" | "ios" | "dashboard";
    const ok = decideApproval(d.db, c.req.param("id"), {
      status: "approved", by, grantUntil: duration.grantUntil, grantPermanent: duration.grantPermanent,
    }, now);
    if (!ok) return c.json({ error: "request is no longer open" }, 409);
    syncSshWaiting(getApproval(d.db, c.req.param("id"))?.session_id);
    logEvent(d.db, null, "ssh_key_approved", { id: c.req.param("id"), by,
      grantMinutes: duration.grantMinutes, grantPermanent: duration.grantPermanent === true });
    return c.json({ ok: true });
  });

  app.post("/api/ssh-approvals/:id/deny", async (c) => {
    const blocked = approvalGate(c); if (blocked) return blocked;
    const locked = vaultGate(c); if (locked) return locked;
    const b = (await c.req.json().catch(() => ({}))) as { by?: string };
    const by = (["mac", "ios", "dashboard"].includes(b.by ?? "") ? b.by : "dashboard") as "mac" | "ios" | "dashboard";
    const ok = decideApproval(d.db, c.req.param("id"), { status: "denied", by });
    if (!ok) return c.json({ error: "request is no longer open" }, 409);
    syncSshWaiting(getApproval(d.db, c.req.param("id"))?.session_id);
    logEvent(d.db, null, "ssh_key_denied", { id: c.req.param("id"), by });
    return c.json({ ok: true });
  });

  // ONLY the holder of the id with the correct session gets the socket — not whoever clicked approve.
  // DELIBERATELY without approvalGate, for the same reason as GET /:id above: `srv` uses this
  // to fetch the socket for ITS OWN already approved request — the container must stay allowed.
  app.post("/api/ssh-approvals/:id/activate", async (c) => {
    const locked = vaultGate(c); if (locked) return locked;
    if (!d.sshAgents) return c.json({ error: "ssh-agent broker is not configured" }, 503);
    const id = c.req.param("id");
    const session = c.req.header("x-devbox-session") || "";
    const row = getApproval(d.db, id);
    if (!row) return c.json({ error: "unknown request" }, 404);
    if (!activateApproval(d.db, id, session)) return c.json({ error: "cannot activate" }, 403);
    try {
      const { agentSock } = await d.sshAgents.activate(session, row.title);
      const current = getApproval(d.db, id);
      if (current?.status !== "activated" ||
          (current.grant_permanent !== 1 && (current.grant_until ?? current.expires_at) <= Date.now())) {
        // Key-level (liveKeyGrant): the agent needs a grant for another target of the same key.
        if (!liveKeyGrant(d.db, session, row.title)) await d.sshAgents.kill(session, row.title);
        return c.json({ error: "the approval expired or was revoked in the meantime" }, 403);
      }
      logEvent(d.db, session, "ssh_key_access", { title: row.title, via: "approval", id });
      return c.json({ agentSock, expiresAt: row.grant_until });
    } catch (e) { return opLimited(c, e) ?? c.json({ error: (e as Error).message }, 502); }
  });

  // Cross-session listing — same reason as GET /api/ssh-approvals above.
  app.get("/api/ssh-grants", (c) => {
    const blocked = approvalGate(c); if (blocked) return blocked;
    return c.json(listGrants(d.db));
  });

  // Break-glass visibility: `DEVD_SSH_APPROVAL=off` disables the gate (see issue() above),
  // but without this endpoint the dashboard/iOS would not know and would show a false
  // calm. No vaultGate or approvalGate — it is just the gate state (a boolean), not
  // access to a secret or to other sessions' data, and `srv` may want to check it too.
  app.get("/api/ssh-gate", (c) => c.json({ enabled: d.sshApprovalEnabled !== false }));

  // Unpushed commits by folder (Work in progress page). `fresh=1` = Refresh
  // in the UI: drops the cache and waits for the full scan; otherwise the cached value is returned (stale
  // values are refreshed in the background, see memoAsync).
  app.get("/api/unpushed", async (c) => {
    if (!d.unpushed) return c.json({ error: "unpushed commit scan is not wired up" }, 503);
    if (c.req.query("fresh") === "1") d.unpushed.invalidate();
    return c.json(await d.unpushed.get());
  });

  // Push of one branch to origin. Body `{path, branch}`; the path is verified only in ops
  // (must be a repo in the workspace) — input rejection throws and maps to 400, a git
  // error (auth, non-fast-forward) comes back as a result → 502 with git's text.
  const unpushedBody = async (c: Context) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    return { path: s("path"), branch: s("branch"), title: s("title").trim(), body: s("body") };
  };
  app.post("/api/unpushed/push", async (c) => {
    if (!d.unpushed?.push) return c.json({ error: "push is not wired up" }, 503);
    const { path, branch } = await unpushedBody(c);
    if (!path || !branch) return c.json({ error: "missing path or branch" }, 400);
    try {
      const r = await d.unpushed.push(path, branch);
      d.unpushed.invalidate();
      return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 502);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // PR creation = push + PR at the provider (GitHub via gh, Gitea via API). Push always goes
  // first: `gh pr create` requires the branch on the remote, and Gitea has the same shape.
  app.post("/api/unpushed/pr", async (c) => {
    if (!d.unpushed?.push || !d.unpushed.createPr) return c.json({ error: "PR creation is not wired up" }, 503);
    const { path, branch, title, body } = await unpushedBody(c);
    if (!path || !branch) return c.json({ error: "missing path or branch" }, 400);
    if (!title) return c.json({ error: "missing PR title" }, 400);
    try {
      const pushed = await d.unpushed.push(path, branch);
      d.unpushed.invalidate();
      if (!pushed.ok) return c.json({ error: `push failed: ${pushed.error}` }, 502);
      return c.json(await d.unpushed.createPr({ path, branch, title, body }));
    } catch (e) {
      const msg = (e as Error).message;
      // Input rejection (foreign path, unknown branch) is 400; anything from the provider 502.
      return c.json({ error: msg }, /unknown repo|invalid branch|branch .* does not exist/.test(msg) ? 400 : 502);
    }
  });

  app.delete("/api/ssh-grants/:id", async (c) => {
    const blocked = approvalGate(c); if (blocked) return blocked;
    const locked = vaultGate(c); if (locked) return locked;
    const id = c.req.param("id");
    const row = getApproval(d.db, id);
    if (!row) return c.json({ error: "unknown request" }, 404);
    // revokeGrant itself rejects anything without a live grant (see sshApprovals.ts) — without
    // this check one could call DELETE on a `pending` id and thereby silently deny it
    // before a human ever saw it (review finding). A `pending`/`denied`/already
    // revoked row therefore gets 409, not a silent 200.
    if (!revokeGrant(d.db, id)) return c.json({ error: "request has no live grant to revoke" }, 409);
    // Log RIGHT AFTER revokeGrant, not after the kill: revokeGrant has already performed the DB mutation
    // (review finding) — if the log waited until after the try/catch, a kill failure (502) would
    // skip it and the audit log would not say the grant was revoked.
    logEvent(d.db, null, "ssh_grant_revoked", { id });
    try {
      // Key-level (liveKeyGrant): revoking the grant for target A must not kill an agent that
      // is held by a live grant for target B of the same key.
      if (row.session_id && !liveKeyGrant(d.db, row.session_id, row.title)) await d.sshAgents?.kill(row.session_id, row.title);
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
    return c.json({ ok: true });
  });

  app.post("/api/clone", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { scope?: string; folder?: string; project?: string } | null;
    if (!body?.scope) return c.json({ error: "scope required" }, 400);
    let scope;
    if (body.scope === "all") scope = { kind: "all" as const };
    else if (body.scope === "folder" && body.folder) scope = { kind: "folder" as const, folder: body.folder };
    else if (body.scope === "project" && body.folder && body.project) scope = { kind: "project" as const, folder: body.folder, project: body.project };
    else return c.json({ error: "invalid scope" }, 400);
    const jobId = await d.cloneQueue.start(scope); // returns promptly; loop runs in background
    return c.json({ jobId }, 202);
  });
  app.get("/api/jobs/:id", (c) => {
    const j = d.cloneQueue.get(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "unknown job" }, 404);
  });

  // Scheduled (cron) runs: CRUD + manual trigger. Firing is handled by the scheduler (index.ts).
  app.get("/api/schedules", (c) => c.json(listSchedules(d.db)));
  app.post("/api/schedules", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Partial<ScheduleRow & { cloneUrl: string }> | null;
    if (!b || !b.name || !b.cron || !b.folder || !b.project || !b.repo || !b.cloneUrl || !b.prompt) return c.json({ error: "required fields: name, cron, folder, project, repo, cloneUrl, prompt" }, 400);
    if (!validCron(b.cron)) return c.json({ error: "invalid cron expression" }, 400);
    if (![b.folder, b.project, b.repo].every((s) => validSeg(s!))) return c.json({ error: "invalid folder/project/repo" }, 400);
    if (!validCloneUrl(b.cloneUrl)) return c.json({ error: "invalid cloneUrl" }, 400);
    // `important` is OPT-IN, not opt-out: it means Pushover emergency (priority 2 =
    // a persistent alarm until acknowledged) for that session's notifications. Until the UI had a
    // toggle for it, all schedules were created with a one and the morning cron then rang.
    const row: ScheduleRow = { id: crypto.randomUUID(), name: b.name, cron: b.cron, folder: b.folder, project: b.project, repo: b.repo, clone_url: b.cloneUrl, prompt: b.prompt, important: b.important === 1 ? 1 : 0, enabled: 1, last_run_at: null };
    insertSchedule(d.db, row);
    return c.json(row, 201);
  });
  app.put("/api/schedules/:id", async (c) => {
    const id = c.req.param("id");
    if (!getSchedule(d.db, id)) return c.json({ error: "unknown schedule" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Partial<ScheduleRow>;
    if (b.cron !== undefined && !validCron(b.cron)) return c.json({ error: "invalid cron expression" }, 400);
    const patch: Partial<ScheduleRow> = {};
    for (const k of ["name", "cron", "prompt", "enabled", "important"] as const) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
    updateSchedule(d.db, id, patch);
    return c.json(getSchedule(d.db, id));
  });
  app.delete("/api/schedules/:id", (c) => {
    if (!getSchedule(d.db, c.req.param("id"))) return c.json({ error: "unknown schedule" }, 404);
    deleteSchedule(d.db, c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/api/schedules/:id/run", async (c) => {
    if (!d.scheduler) return c.json({ error: "scheduler is not enabled" }, 503);
    const okRun = await d.scheduler.fireNow(c.req.param("id"));
    return okRun ? c.body(null, 202) : c.json({ error: "unknown schedule" }, 404);
  });

  // cc upkeep: read status for the dashboard + manual trigger with the same lock as the
  // nightly tick (see index.ts). `run` returns null when the job is already running → 409.
  app.get("/api/agent-upkeep", async (c) => {
    if (!d.agentUpkeep) return c.json({error:"Agent upkeep is unavailable."},503);
    const provider = c.req.query("provider") ?? "claude";
    if (provider !== "claude" && provider !== "codex" && provider !== "grok" && provider !== "agy") return c.json({error:"Unknown provider."},400);
    return c.json(await d.agentUpkeep.status(provider));
  });
  app.post("/api/agent-upkeep/run", async (c) => {
    noIdleTimeout(c);
    if (!d.agentUpkeep) return c.json({error:"Agent upkeep is unavailable."},503);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({error:"Invalid request."},400);
    const provider = body.provider;
    if (provider !== "claude" && provider !== "codex" && provider !== "grok" && provider !== "agy") return c.json({error:"Unknown provider."},400);
    if (body.session !== undefined && typeof body.session !== "string") return c.json({error:"Invalid session."},400);
    if (body.session && !getSession(d.db,body.session)) return c.json({error:"Unknown session."},404);
    const result = await d.agentUpkeep.run(provider,body.session ? [body.session] : undefined);
    return result === null ? c.json({error:"An upkeep operation is already running."},409) : c.json(result);
  });

  app.get("/api/cc-upkeep", async (c) => {
    if (!d.ccUpkeep) return c.json({ error: "cc upkeep is not available" }, 404);
    return c.json(await d.ccUpkeep.status());
  });

  app.post("/api/cc-upkeep/run", async (c) => {
    noIdleTimeout(c);
    if (!d.ccUpkeep) return c.json({ error: "cc upkeep is not available" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { session?: string };
    if (body.session && !getSession(d.db, body.session)) return c.json({ error: "unknown session" }, 404);
    const res = await d.ccUpkeep.run(body.session ? [body.session] : undefined);
    if (res === null) return c.json({ error: "cc upkeep is already running" }, 409);
    return c.json(res);
  });

  // Hardware: machines, monitors and backups. The response is ALWAYS from cache (see hardware.ts) —
  // this endpoint must not wait on SSH or the Storage Box.
  app.get("/api/hardware", (c) => {
    if (!d.hardware) return c.json({ error: "monitoring is not configured" }, 503);
    return c.json(d.hardware.snapshot());
  });

  app.get("/api/hardware/:id/series", async (c) => {
    if (!d.hardware) return c.json({ error: "monitoring is not configured" }, 503);
    const range = c.req.query("range") ?? "6h";
    if (!isRangeKey(range)) return c.json({ error: "invalid range (1h|6h|24h|7d)" }, 400);
    try { return c.json(await d.hardware.series(c.req.param("id"), range)); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  app.post("/api/hardware/:id/backup/run", async (c) => {
    if (!d.hardware) return c.json({ error: "monitoring is not configured" }, 503);
    try { await d.hardware.runBackup(c.req.param("id")); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Host maintenance. Both are detached from the request (systemd-run / --no-block), so
  // the response means "started", not "done" — the result shows up in /api/hardware.
  app.post("/api/hardware/:id/update", async (c) => {
    if (!d.hardware) return c.json({ error: "monitoring is not configured" }, 503);
    const id = c.req.param("id");
    try {
      await d.hardware.runUpgrade(id);
      logEvent(d.db, null, "host_update", { machine: id });
      return c.json({ ok: true }, 202);
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // Machine restart. An irreversible action — the dashboard has it behind a two-step confirmation and
  // on the devbox this call kills ourselves, so we never return here.
  // The log is therefore written BEFORE starting, otherwise it would not be written at all.
  app.post("/api/hardware/:id/reboot", async (c) => {
    if (!d.hardware) return c.json({ error: "monitoring is not configured" }, 503);
    const id = c.req.param("id");
    logEvent(d.db, null, "host_reboot", { machine: id });
    try { await d.hardware.reboot(id); return c.json({ ok: true }, 202); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // GitHub browsing for the visual config editor. Shells out to `gh` (like the
  // tree lister); when gh is missing/unauthenticated we answer 502 with a clear
  // message so the dashboard can show a friendly "gh auth login" state.
  // Owners (account + organizations) change rarely, but two `gh api` calls in a row cost
  // ~0.8 s on every opening of the repository browser in Folders. SWR cache: the first
  // opening waits, later ones get the value immediately and the refresh runs in the background.
  const ownersCache = memoAsync(() => listOwners(), 10 * 60_000);
  const github = d.github ?? { owners: () => ownersCache.get(), repos: (o: string) => listRepos(o) };
  app.get("/api/github/owners", async (c) => {
    try { return c.json({ owners: await github.owners() }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  app.get("/api/github/repos", async (c) => {
    const owner = c.req.query("owner") ?? "";
    if (!validOwner(owner)) return c.json({ error: "invalid owner" }, 400);
    try { return c.json({ repos: await github.repos(owner) }); }
    catch (e) { return c.json({ error: (e as Error).message }, e instanceof GithubError ? 502 : 500); }
  });

  // Gitea browsing + token for the visual config editor. Instances are read
  // fresh from the config on disk (see index.ts); the token never leaves the server.
  app.get("/api/gitea/instances", (c) => {
    if (!d.gitea) return c.json({ error: "gitea is not available" }, 503);
    return c.json({ instances: d.gitea.instances() });
  });
  app.get("/api/gitea/repos", async (c) => {
    if (!d.gitea) return c.json({ error: "gitea is not available" }, 503);
    try { return c.json({ repos: await d.gitea.repos(c.req.query("instance") ?? "") }); }
    catch (e) { return c.json({ error: (e as Error).message }, giteaStatus(e)); }
  });
  app.post("/api/gitea/token", async (c) => {
    if (!d.gitea) return c.json({ error: "gitea is not available" }, 503);
    const body = (await c.req.json().catch(() => null)) as { instance?: string; token?: string } | null;
    if (!body?.instance || !body?.token) return c.json({ error: "instance and token are required" }, 400);
    try { const { login } = await d.gitea.setToken(body.instance, body.token); return c.json({ ok: true, login }); }
    catch (e) { return c.json({ error: (e as Error).message }, giteaStatus(e)); }
  });

  // Clipboard bridge: xclip shim in the container → here → mac listener. Reading content
  // (image/text) is audited as ssh_key_access; targets is only a metadata poll.
  // `file` is special: the file is saved directly into the session workspace (stageFile) and
  // a container path is returned, not bytes — hence its own branch before the generic proxy.
  // The clipboard is unavailable (locked vault = no listenerToken, sleeping mac, disabled
  // listener). This used to yield a 502 with a JSON error that the shim dropped → paste silently
  // did NOTHING and there was no way to tell why. Now we return 503 with a bare sentence: the shim inserts it into
  // the prompt and flashes it in the tmux bar.
  //
  // `targets` is an exception — it must answer 200 and offer text/plain, otherwise cc
  // gives up on the very first query and never gets to the message.
  const clipboardDown = (c: Context, kind: string, why: string) =>
    kind === "targets"
      ? c.text("text/plain\n", 200)
      : c.text(d.vault?.isLocked()
          ? "⚠ Vault is locked — unlock it in the dashboard and paste again."
          : `⚠ Mac is not responding — clipboard is not available (${why}).`, 503);

  app.get("/api/clipboard/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "targets" && kind !== "image" && kind !== "text" && kind !== "file") return c.json({ error: "unknown kind" }, 400);
    const session = c.req.query("session") ?? "";
    // The file inbox and the shared _inbox are directories on the VPS — a container in the VM cannot see them.
    if (kind === "file" || c.req.query("target") === "shared") {
      const g = ibxOnly(c, getSession(d.db, session), "File inbox");
      if (g) return g;
    }
    // A locked vault is detected without calling the listener — it would have nothing to authenticate with anyway.
    if (d.vault?.isLocked()) return clipboardDown(c, kind, "vault");

    if (kind === "file") {
      let r;
      try { r = await d.listener.clipboard("file"); }
      catch (e) { return clipboardDown(c, kind, (e as Error).message); }
      if (r.status === 204) return c.body(null, 204);
      if (r.status === 413) return c.text("⚠ file is too large (>25 MB) — drop it into /Volumes/dev", 413);
      if (r.status !== 200) return clipboardDown(c, kind, `listener returned ${r.status}`);
      // Shared inbox (?target=shared): no session, saves into <root>/_inbox, which is
      // bind-mounted as /inbox in every container → a uniform path, we do not have to
      // guess the target session on the mac. Returns /inbox/<name>.
      if (c.req.query("target") === "shared") {
        let sp: string;
        try { sp = stageShared(join(d.root, "_inbox"), r.filename ?? "file", r.body); }
        catch (e) { return c.json({ error: (e as Error).message }, 400); }
        logEvent(d.db, null, "file_inbox", { name: sp.split("/").pop(), size: r.body.length, shared: true });
        return c.text(sp, 200);
      }
      const s = getSession(d.db, session);
      if (!s) return c.json({ error: "unknown session" }, 400);
      const workspace = sessionWorkdir(d.root, s);
      let path: string;
      try { path = stageFile(workspace, r.filename ?? "file", r.body); }
      catch (e) { return c.json({ error: (e as Error).message }, 400); }
      logEvent(d.db, validSeg(session) ? session : null, "file_inbox", { name: path.split("/").pop(), size: r.body.length });
      return c.text(path, 200);
    }

    // Image for harnesses without xclip (Codex, Grok Build): their arboard talks
    // to X11/Wayland directly and there is no display server in the container, so they have no way
    // to read the bytes from the clipboard. ?target=shared therefore saves the PNG into the shared
    // _inbox (mount /inbox in every container) and returns the container path — the tmux
    // C-v binding (devbox-ctrlv) inserts it into the prompt; both TUIs attach the path
    // the same way as a drag&drop file.
    if (kind === "image" && c.req.query("target") === "shared") {
      let r;
      try { r = await d.listener.clipboard("image"); }
      catch (e) { return clipboardDown(c, kind, (e as Error).message); }
      if (r.status === 204) return c.body(null, 204);
      if (r.status !== 200) return clipboardDown(c, kind, `listener returned ${r.status}`);
      const t = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
      let sp: string;
      try { sp = stageShared(join(d.root, "_inbox"), `img-${stamp}.png`, r.body); }
      catch (e) { return c.json({ error: (e as Error).message }, 400); }
      logEvent(d.db, validSeg(session) ? session : null, "clipboard_access", { kind: "image", target: "shared", name: sp.split("/").pop(), size: r.body.length });
      return c.text(sp, 200);
    }

    try {
      const r = await d.listener.clipboard(kind);
      if (r.status === 204) return c.body(null, 204);
      if (r.status !== 200) return clipboardDown(c, kind, `listener returned ${r.status}`);
      if (kind !== "targets") logEvent(d.db, validSeg(session) ? session : null, "clipboard_access", { kind });
      return new Response(r.body, { status: 200, headers: { "content-type": r.contentType ?? "application/octet-stream" } });
    } catch (e) {
      return clipboardDown(c, kind, (e as Error).message);
    }
  });

  app.get("/api/config", (c) => { try { return c.json(d.configRepo.read()); } catch (e) { return c.json({ error: (e as Error).message }, 500); } });
  app.put("/api/config", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { config?: unknown } | null;
    if (!body?.config) return c.json({ error: "config required" }, 400);
    try {
      await d.configRepo.write(validateConfig(body.config));
      d.onConfigWritten?.();   // the repos tree is derived from config, its cache must go
      return c.json({ ok: true });
    }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // Rebuild of a session's container (see SessionManager.recreate). Needed after removing an
  // account from the pool: its volume is held by every container built with the old list
  // of mounts, so `docker volume rm` fails until all of them are rebuilt.
  app.post("/api/sessions/:id/recreate", async (c) => {
    const id = c.req.param("id");
    const s = getSession(d.db, id);
    if (!s) return c.json({ error: "unknown session" }, 404);
    { const g = ibxOnly(c, s, "Recreate"); if (g) return g; }
    try {
      const session = await d.mgr.recreate(id);
      // New container = new docker id → the share taint (shareTaint.ts) does not apply to it;
      // let the guard and GET /api/sessions see that immediately, not only after a docker event.
      identity.markChanged(); sharedSessions.invalidate();
      return c.json({ session });
    }
    catch (e) { return busy(c, e) ?? c.json({ error: (e as Error).message }, 502); }
  });

  app.post("/api/sessions/:id/restart", async (c) => {
    try { await d.mgr.restartSolo(c.req.param("id")); return c.body(null, 204); }
    catch (e) {
      const b = busy(c, e);
      if (b) return b;
      if (e instanceof RestartError) return c.json({ error: e.message }, e.kind === "unknown" ? 404 : 409);
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  // Backup and restore share one flag: both touch the same docker volume and
  // each other, so a second one running concurrently would read/write half-baked data.
  let backupRunning = false;
  app.get("/api/backup", async (c) => {
    noIdleTimeout(c);
    if (backupRunning) return c.json({ error: "backup is already running", inProgress: "backup" }, 409);
    backupRunning = true;
    try {
      // In production the archive can easily be ~1.5 GB — readFileSync would pull all of it into
      // process memory. Instead it is streamed directly from the file: we open an fd,
      // immediately delete the file name (unlink-after-open — on POSIX, macOS and
      // Linux an open fd survives the unlink of its name, so the plaintext bundle
      // with secrets+db disappears from the directory namespace immediately, not after
      // the download finishes) and only then read.
      // `Bun.file(fd).stream()` DOES NOT CLOSE the fd after reading (verified) — every download
      // would thus leak one file descriptor forever. `createReadStream` with
      // `autoClose` (default true) closes the fd after read/error, which is why this
      // path is used instead of Bun.file even though Bun.file(fd) works by itself.
      const p = await d.backup.build();
      const size = statSync(p).size;
      const fd = openSync(p, "r");
      rmSync(p, { force: true });
      const body = Readable.toWeb(createReadStream("", { fd })) as ReadableStream<Uint8Array>;
      return new Response(body, {
        headers: {
          "content-disposition": 'attachment; filename="devbox-backup.tgz"',
          "content-type": "application/gzip",
          "content-length": String(size),
        },
      });
    }
    catch (e) { return c.json({ error: (e as Error).message }, 500); }
    // `backupRunning` is released as soon as the Response above is returned — NOW, not when the client
    // finishes downloading the stream. Same behavior as before (it was released after
    // synchronously reading the whole file); a parallel GET /api/backup in the middle of a
    // streamed download therefore still gets 200, not 409. Unchanged.
    finally { backupRunning = false; }
  });
  app.post("/api/restore", async (c) => {
    noIdleTimeout(c);
    // Reading the body BEFORE the flag: a failed/interrupted read (connection dropped in the middle
    // of the upload) must not set the flag at all, otherwise it would stay up forever —
    // hence no `await` between `backupRunning = true` and the `try` below.
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (backupRunning) return c.json({ error: "backup is already running", inProgress: "backup" }, 409);
    backupRunning = true;
    const tmp = `/tmp/devd-restore-${buf.length}.tgz`;
    try {
      await Bun.write(tmp, buf);
      await d.backup.restore(tmp);
      return c.json({ ok: true });
    } catch (e) { return c.json({ error: (e as Error).message }, 500); }
    finally { rmSync(tmp, { force: true }); backupRunning = false; }
  });

  // Pool of Anthropic accounts. Lease returns ONLY the profile name — no endpoint returns a token.
  const needAccounts = () => d.accounts ?? null;

  // Alongside the accounts, the effective pool SETTINGS are returned too. Without them the dashboard colored the gauge
  // by a hardwired ninety and the "Exhausted" badge did not follow the config;
  // the preferred account and the overflow threshold cannot be obtained anywhere else either.
  app.get("/api/accounts", (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const s = acc.settings();
    return c.json({
      accounts: buildAccountViews(d.db, Date.now(), acc.leaseMaxAgeMs()),
      pool: {
        thresholdPct: s.thresholdPct, spilloverPct: s.spilloverPct, preferredAccountId: s.preferredAccountId,
        projectAccounts: s.projectAccounts, soloAccountId: s.soloAccountId,
      },
    });
  });

  // Lease: who is asking (`client`), on whose behalf (`session`, devbox only), a human description for the UI
  // (`label`) and `force=1` for a manual `dev switch` (skips cooldown and hysteresis).
  // When there is nothing to offer, it returns 200 with accountId=null — the client then sets NOTHING
  // and runs on the default profile. An error state would only tempt it into a hard failure.
  app.get("/api/accounts/lease", (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const client = c.req.query("client");
    if (!isLeaseClient(client)) return c.json({ error: "client must be mac or devbox" }, 400);
    const sessionId = client === "devbox" ? (c.req.query("session") ?? null) : null;
    const label = c.req.query("label") ?? null;
    const now = Date.now();

    // Project for pinning (accountPolicy.allowedAccounts). A mac lease has no
    // session_id, so the project stays null and behaves as unpinned.
    const sess = sessionId === null ? null : getSession(d.db, sessionId);
    const project = sess?.project ?? null;
    const repo = sess?.repo ?? null;

    const history = leaseHistory(d.db, client as LeaseClient, sessionId);
    const decision = chooseAccount({
      candidates: toCandidates(d.db),
      current: currentAccount(history),
      lastSwitchAt: lastSwitchAt(history),
      now, force: c.req.query("force") === "1",
      project, repo,
      settings: acc.settings(),
    });
    if (decision.accountId === null) return c.json({ accountId: null, label: null, exhausted: true });

    // CAUTION: this endpoint NEVER releases previous leases of the same session —
    // DEVD_SESSION_ID is a container-level env, so main/main-2/main-3 share
    // one sessionId and EACH their own lease (see accountsApi.test.ts,
    // regression test below). Releasing the appropriate old lease on `dev switch`
    // is done by the dedicated `switchAccount` (accountSwitch.ts), and only AFTER a verified
    // panel restart — not here, not on every acquire.
    insertLease(d.db, {
      account_id: decision.accountId, client: client as LeaseClient,
      session_id: sessionId, label, created_at: now, released_at: null,
    });
    return c.json({ accountId: decision.accountId, label: decision.label, exhausted: decision.exhausted });
  });

  // `dev switch`: restarts a running session onto another account. POST (not GET like the lease
  // above) — this CHANGES live state (panel restart), so safe
  // repetition must be excluded from GET semantics (retry/prefetch could otherwise discard the
  // in-progress turn a second time). All logic is in accountSwitch.switchAccount;
  // this handler only maps the result to an HTTP status, just like /api/cc-upkeep/run
  // delegates to ccUpkeep.ts.
  app.post("/api/sessions/:id/switch-account", async (c) => {
    noIdleTimeout(c);
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const r = await acc.switchAccount(c.req.param("id"));
    switch (r.status) {
      case "unknown-session": return c.json({ error: "unknown session" }, 404);
      case "not-running": return c.json({ error: "session is not running" }, 409);
      case "wrong-agent": return c.json({ error: "the session profile does not run on an Anthropic account — the pool does not apply to it" }, 400);
      case "in-progress": return c.json({ error: "a switch for this session is already running" }, 409);
      case "no-account": return c.json({ ok: false, accountId: null, label: null, unchanged: false, exhausted: false, panes: [] });
      case "unchanged": return c.json({ ok: true, accountId: r.accountId, label: r.label, unchanged: true, exhausted: false, panes: [] });
      case "failed": return c.json({ ok: false, accountId: r.accountId, label: r.label, unchanged: false, exhausted: r.exhausted, panes: r.panes });
      case "switched": return c.json({ ok: true, accountId: r.accountId, label: r.label, unchanged: false, exhausted: r.exhausted, panes: r.panes });
    }
  });

  // Live swap of the agent (harness) of a running session. POST for the same reason as
  // switch-account above: it restarts panels, retry/prefetch must not discard the turn a second time.
  // All logic is in agentSwitch.switchAgent; here only input validation (same
  // as for POST /api/sessions) and mapping the status to an HTTP code. On the wire goes
  // `status` (not a triple of booleans) — two clients (CLI, dashboard) compose
  // sentences from it and would have to decode booleans back; `ok` remains as a shortcut.
  app.post("/api/sessions/:id/agent", async (c) => {
    if (!d.switchAgent) return c.json({ error: "agent switching is not wired up" }, 503);
    const body = (await c.req.json().catch(() => null)) as { agent?: string } | null;
    if (!body || !isAgentName(body.agent))
      return c.json({ error: `invalid agent (${AGENT_IDS.join("|")})` }, 400);
    // I4: swapping to a proxy agent would send proxy keys into the VM (proxyEnvFor → tmux env).
    if (getSession(d.db, c.req.param("id"))?.host === "instabox") {
      const blocked = instaboxAgentBlock(body.agent);
      if (blocked) return c.json({ error: blocked }, 400);
    }
    const r = await d.switchAgent(c.req.param("id"), body.agent);
    switch (r.status) {
      case "unknown-session": return c.json({ error: "unknown session" }, 404);
      case "not-running": return c.json({ error: "session is not running" }, 409);
      case "in-progress": return c.json({ error: "a switch (agent or account) for this session is already running" }, 409);
      case "unchanged":
      case "no-agent": return c.json({ ok: r.status === "unchanged", status: r.status, panes: [] });
      case "failed":
      case "switched": return c.json({ ok: r.status === "switched", status: r.status, panes: r.panes });
    }
  });

  // Adding an account: the profile is set up by UPLOADING a blob. `claude auth login` waits for an OAuth
  // callback on localhost, which does not work on a headless VPS, and Claude has no device-auth —
  // so the sign-in happens on the mac and finished credentials arrive here.
  app.post("/api/accounts", async (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const b = (await c.req.json().catch(() => null)) as { id?: string; credentials?: string; label?: string } | null;
    if (!b?.id || !isValidAccountId(b.id)) return c.json({ error: "id must be [A-Za-z0-9-], max 31 characters" }, 400);
    if (typeof b.credentials !== "string") return c.json({ error: "credentials must be the contents of .credentials.json with claudeAiOauth" }, 400);
    const input = normalizeCredentialsInput(b.credentials);
    if (!input.ok) return c.json({ error: credentialsInputError(input.reason) }, 400);
    const creds = input.blob;
    if (getAccount(d.db, b.id)) return c.json({ error: `account ${b.id} already exists` }, 409);
    try {
      // `input.text` goes into the profile, not `b.credentials` — terminal input carries
      // junk around the JSON (see normalizeCredentialsInput) and it would be a problem in the file.
      await provisionProfile(acc.profiles, b.id, input.text);
      const ident = await profileIdentity(acc.profiles, b.id);
      const auto = ident.email ? (ident.orgName ? `${ident.email} (${ident.orgName})` : ident.email) : null;
      const baseLabel = b.label?.trim() || auto || b.id;
      // The operator was confused that the SMALLER account was named "primary" — so the label carries
      // the plan ("(Max Nx)"), derived from the same `rateLimitTier` as `weight`
      // (accountPolicy then computes the remaining capacity by weight, see accountPolicy.ts).
      const weight = parseTierWeight(creds.claudeAiOauth.rateLimitTier);
      const label = withTierLabel(baseLabel, weight);
      // `org_id` is deliberately NOT taken from `claude auth status`, even though we have it at hand:
      // the registered identity is compared with the one OBSERVED during measurement and those two numbers
      // do not come from the same source. `auth status` reports the PERSONAL organization
      // of the signed-in e-mail, whereas the quota header reports the organization the measurement
      // is BILLED to. For an account that is a member of a foreign organization (typically a company seat) they differ
      // permanently — and the card would report "Profile switched accounts" forever, even though the account
      // is fine. `null` is filled in by the poller from the first measurement (accountPoller), so then
      // measured identity is compared with measured.
      insertAccount(d.db, { id: b.id, label, disabled: 0, quarantined_at: null, added_at: Date.now(), weight, org_id: null });
      logEvent(d.db, null, "account_added", { id: b.id, label, orgId: ident.orgId });
      return c.json({ id: b.id, label }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // Replacing the credentials of an existing account. Without it a skipped profile (the profile
  // signed in with a different account than the one it is registered under) was practically unfixable:
  // `POST /api/accounts` on an existing id returns 409 and `DELETE` removes the VOLUME, which
  // `docker volume rm` refuses while even one session is running — each one mounts
  // all profiles. The fix would thus mean taking down the whole devbox. This endpoint
  // only overwrites `.credentials.json` inside the existing volume.
  app.post("/api/accounts/:id/credentials", async (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const id = c.req.param("id");
    if (!getAccount(d.db, id)) return c.json({ error: "unknown account" }, 404);
    const b = (await c.req.json().catch(() => null)) as { credentials?: string } | null;
    if (typeof b?.credentials !== "string") return c.json({ error: "credentials must be the contents of .credentials.json with claudeAiOauth" }, 400);
    const input = normalizeCredentialsInput(b.credentials);
    if (!input.ok) return c.json({ error: credentialsInputError(input.reason) }, 400);
    const creds = input.blob;
    try {
      await writeProfileCredentials(acc.profiles, id, input.text);
      // The identity is read from the PROFILE after the write, not from the request body — the blob itself
      // does not say whose it is, and that very mismatch is what is being cured here. `claude auth status` on
      // the profile is the only place that answers authoritatively.
      const ident = await profileIdentity(acc.profiles, id);
      const weight = parseTierWeight(creds.claudeAiOauth.rateLimitTier);
      const baseLabel = ident.email ? (ident.orgName ? `${ident.email} (${ident.orgName})` : ident.email) : id;
      setAccountLabel(d.db, id, withTierLabel(baseLabel, weight));
      setAccountWeight(d.db, id, weight);
      // New reference point for the identity watcher. `null`, not `ident.orgId` — the poller
      // fills it in from the measurement a few lines below (`acc.refresh`), so the registered and observed
      // identities are read from the same source. See the comment at insertAccount above.
      setAccountOrgId(d.db, id, null);
      setAccountQuarantined(d.db, id, null);    // a new sign-in clears the quarantine reason
      logEvent(d.db, null, "account_credentials_replaced", { id, email: ident.email, orgId: ident.orgId });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
    // Measure right away, so the card redraws with fresh numbers of THAT account, not leftovers from the previous one.
    await acc.refresh(id);
    const view = buildAccountViews(d.db, Date.now(), acc.leaseMaxAgeMs()).find((v) => v.id === id) ?? null;
    return c.json({ account: view });
  });

  // Codex quota. Deliberately a SEPARATE route, not part of /api/accounts: Codex can
  // break (deactivated workspace, moved endpoint) without taking down the Anthropic
  // cards on the same page.
  app.get("/api/subscriptions/codex", (c) => c.json({ codex: d.codexUsage?.view() ?? null }));

  // Grok quota — same separation as Codex above, for the same reason.
  app.get("/api/subscriptions/grok", (c) => c.json({ grok: d.grokUsage?.view() ?? null }));

  // OpenRouter. The key comes here from the dashboard and is NEVER returned — GET says only
  // YES/NO. The model sits next to the key on purpose: stealth models on OpenRouter appear
  // and disappear within weeks, so switching must not mean SSH to the VPS and manual config editing.
  const openrouterGate = (c: Context) =>
    d.openrouter ? null : c.json({ error: "OpenRouter is not wired up in this devd" }, 503);

  app.get("/api/openrouter", (c) => {
    const off = openrouterGate(c); if (off) return off;
    // From disk, not from d.cfg: PUT /api/config writes and the process does not keep the config.
    const model = d.configRepo.read().settings.proxyModels?.openrouter ?? null;
    return c.json({ hasKey: d.openrouter!.hasKey(), model: model || null });
  });

  app.put("/api/openrouter/key", async (c) => {
    const off = openrouterGate(c); if (off) return off;
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
    // An empty string is legitimate input ("disconnect OpenRouter"), a missing field is not.
    if (typeof body?.key !== "string") return c.json({ error: "key required" }, 400);
    d.openrouter!.setKey(body.key);
    return c.body(null, 204);
  });

  app.put("/api/openrouter/model", async (c) => {
    const off = openrouterGate(c); if (off) return off;
    const body = (await c.req.json().catch(() => null)) as { model?: unknown } | null;
    if (typeof body?.model !== "string") return c.json({ error: "model required" }, 400);
    try {
      const cfg = d.configRepo.read();
      // A copy, not a mutation: `read()` may return a shared object and overwriting "in place"
      // would change the config for whoever holds it too (and in tests DEFAULT_CONFIG as well).
      await d.configRepo.write(validateConfig({
        ...cfg,
        settings: { ...cfg.settings, proxyModels: { ...(cfg.settings.proxyModels ?? {}), openrouter: body.model.trim() } },
      }));
      d.onConfigWritten?.();
      return c.body(null, 204);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  // ── Context windows of proxy profiles (dashboard: Model context windows) ──────────
  // No gate on the `openrouter` dep: the gpt/grok rows make sense even where OpenRouter
  // is not wired — only its row then stays "unknown".
  app.get("/api/proxy-context", async (c) => {
    const settings = d.configRepo.read().settings;
    const profiles = await proxyContextRows(settings, d.orCtxLookup ?? (async () => null));
    return c.json({ profiles });
  });

  // ── Local launch of proxy profiles (dev local on the mac) ─────────────────────────
  // Issues KEYS (cliproxy and OpenRouter) — a deliberate decision: the devd API lives only on the
  // tailnet (WireGuard) and /api/accounts/lease and backup (which carries all secrets) already have
  // the same trust boundary. The cliproxy base is derived from the Host header: the client gets
  // the passthrough on the same address it used to ask.
  app.get("/api/local-env", async (c) => {
    const settings = d.configRepo.read().settings;
    const base = `http://${c.req.header("host") ?? "127.0.0.1:4300"}/api/cliproxy`;
    const profiles = await localEnvProfiles(
      settings,
      d.upstreamKeys ?? (() => null),
      (agent) => agentContextTokens(agent, settings, d.orCtxLookup ?? (async () => null)),
      base,
    );
    return c.json({ profiles });
  });

  // Passthrough to CLIProxyAPI: it binds only to 127.0.0.1 + the docker bridge (its key
  // covers three paid subscriptions) and is not reachable from the tailnet — tunneling through devd
  // keeps it private and requires no change to its binding. It handles authorization itself
  // (the Authorization header passes through unchanged). The response is returned as a stream —
  // content-encoding/length are dropped, fetch has already decompressed the body.
  app.all("/api/cliproxy/*", async (c) => {
    const target = d.cliproxyLocalUrl ?? "http://127.0.0.1:8317";
    const search = new URL(c.req.url).search;
    const rest = c.req.path.slice("/api/cliproxy".length) || "/";
    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let res: Response;
    try {
      res = await fetch(`${target}${rest}${search}`, {
        method: c.req.method, headers,
        body: hasBody ? c.req.raw.body : undefined,
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (e) {
      return c.json({ error: `cliproxy unreachable: ${(e as Error).message}` }, 502);
    }
    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(res.body, { status: res.status, headers: out });
  });

  app.put("/api/proxy-context/:key", async (c) => {
    const key = c.req.param("key");
    // Valid keys = modelKey of proxy profiles (today gpt/grok/openrouter). From agents.ts,
    // not hardcoded — a new proxy profile shows up here by itself.
    const known = AGENT_IDS.map((id) => AGENTS[id].modelKey).filter((k): k is string => !!k);
    if (!known.includes(key)) return c.json({ error: `unknown profile "${key}"` }, 400);
    const body = (await c.req.json().catch(() => null)) as { tokens?: unknown } | null;
    // null = delete the override (back to automatic). Neither a missing field nor a non-number passes —
    // silent coercion would store a window nobody entered.
    const t = body?.tokens;
    if (t !== null && !(typeof t === "number" && Number.isInteger(t) && t > 0))
      return c.json({ error: "tokens must be a positive integer or null" }, 400);
    try {
      const cfg = d.configRepo.read();
      const ctx = { ...(cfg.settings.proxyContext ?? {}) };
      if (t === null) delete ctx[key]; else ctx[key] = t;
      await d.configRepo.write(validateConfig({ ...cfg, settings: { ...cfg.settings, proxyContext: ctx } }));
      d.onConfigWritten?.();
      return c.body(null, 204);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  // Manual quota re-measurement. After an error the poller waits (see accountPoller.errorBackoffMs) and
  // the dashboard shows the old reading until then — this is the way to force a measurement
  // NOW, regardless of backoff. It works on a disabled account too: before you return it to rotation, you want
  // to see how much is left on it. The response is the new view of the account directly, so the UI does not have to
  // pull the whole /api/accounts right afterwards.
  app.post("/api/accounts/:id/refresh", async (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const id = c.req.param("id");
    if (!getAccount(d.db, id)) return c.json({ error: "unknown account" }, 404);
    // `pollAccount` DOES NOT THROW errors — it writes them into account_usage. 200 therefore means
    // "measured", not "succeeded": the result (including a possible `error`) is in the body.
    await acc.refresh(id);
    const view = buildAccountViews(d.db, Date.now(), acc.leaseMaxAgeMs()).find((v) => v.id === id) ?? null;
    return c.json({ account: view });
  });

  app.post("/api/accounts/:id/disable", async (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    // This endpoint is the only manual switch for a permanently failing account (see
    // toCandidates/permanentlyUnmeasured) — a missing/invalid body MUST NOT be silently
    // evaluated as `disabled: false`, otherwise a broken request would accidentally TURN THE ACCOUNT ON
    // back into rotation instead of removing it.
    const b = (await c.req.json().catch(() => null)) as { disabled?: unknown } | null;
    if (typeof b?.disabled !== "boolean") return c.json({ error: "disabled must be a boolean" }, 400);
    const id = c.req.param("id");
    if (!getAccount(d.db, id)) return c.json({ error: "unknown account" }, 404);
    setAccountDisabled(d.db, id, b.disabled ? 1 : 0);
    logEvent(d.db, null, "account_disabled", { id, disabled: b.disabled });
    return c.body(null, 204);
  });

  // Profile first, row after it: if the profile could be neither deleted nor
  // emptied, the row stays and it can be retried — an account never disappears from the UI
  // before its refresh token dies on disk (see removeProfile).
  //
  // The response is 200 with `removal`, not a bare 204: the usual result on a full devbox is
  // `purged` (the volume is held by the mounts of all sessions) and the operator MUST read that —
  // the empty `claude-acct-<id>` shell remains to be deleted after recreating sessions.
  app.delete("/api/accounts/:id", async (c) => {
    const acc = needAccounts(); if (!acc) return c.json({ error: "account pool is not configured" }, 503);
    const id = c.req.param("id");
    if (!getAccount(d.db, id)) return c.json({ error: "unknown account" }, 404);
    let removal: ProfileRemoval;
    try { removal = await removeProfile(acc.profiles, id); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
    deleteAccount(d.db, id);
    logEvent(d.db, null, "account_removed", { id, removal });
    return c.json({ removal, leftoverVolume: removal === "purged" ? profileVolume(id) : null });
  });

  // Static dashboard serving. MUST stay last so it never shadows /api or /v1 routes.
  const files = d.dashboardDir ? new StaticFiles(d.dashboardDir) : null;
  app.get("/*", async (c) => {
    const reqPath = new URL(c.req.url).pathname;
    if (reqPath.startsWith("/api/") || reqPath.startsWith("/v1/")) return c.json({ error: "not found" }, 404);
    if (!files) return c.text("dashboard not built", 503);
    const res = await files.serve(reqPath, c.req.header("accept-encoding") ?? null, c.req.header("if-none-match") ?? null);
    // `null` = the file is not there. This used to fall through to `200` with a text body, so
    // a dynamic import of a missing chunk (old hash after a deploy) got text instead of
    // a module and failed with an incomprehensible MIME error. 404 is the honest answer.
    return res ?? c.text("not found", 404);
  });

  return app;
}
