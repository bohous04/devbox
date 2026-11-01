import type { OpenrouterView } from "./openrouterView";
import type { ProxyContextRow } from "./proxyContextView";
import type { VaultStatus } from "./vaultView";
import type { OpRow } from "./operationsView";
import { normalizeForm, type DbCandidate, type DbDiscovery, type DbRequestRow, type ProvisionForm } from "./dbRequestsView";
import type { IbxJobDto, IbxStatusDto, PlacementDto } from "./instaboxView";

export interface SessionPort { host: number; container: number }
export type ClaudeState = "working" | "waiting" | "idle";
export type AgentName = "claude" | "claude-gpt" | "claude-grok" | "claude-gemini" | "claude-openrouter" | "codex" | "grok" | "antigravity";
export interface SessionLive {
  id: string; folder: string; project: string; repo: string; container: string;
  port_base: number; status: "running" | "stopped"; solo: 0 | 1;
  created_at: number; last_active_at: number; ports: SessionPort[];
  claudeState: ClaudeState; cpuPct: number; memBytes: number; workspace: string;
  important: 0 | 1;
  // Account from the active lease; null = session outside the pool (old container without profile
  // mounts, or the pool is not configured).
  accountId: string | null;
  // Nickname set in the session manager (`dev`); null/empty = no nickname.
  // The server always sends it (spread SessionRow), we only type and display it here.
  name?: string | null;
  critic?: 0 | 1;
  agent?: AgentName;
  // Where the session runs; an InstaBox session also has the machine's ssh alias (only while running).
  host?: "vps" | "instabox";
  dockerHost?: string | null;
  // The container was shared and not rebuilt yet → still restricted (devd/src/shareTaint.ts).
  tainted?: boolean;
}
export interface ResourceRow {
  id: string; label: string; project: string; cpuPct: number; memBytes: number; dindMemBytes: number;
}
export interface Resources {
  sessions: ResourceRow[];
  otherContainers: { count: number; cpuPct: number; memBytes: number };
  codexMemBytes: number | null;
  hostOtherBytes: number;
  host: { totalBytes: number; usedBytes: number };
}
export interface LiveStats { sessions: SessionLive[]; disk: { usedBytes: number; totalBytes: number } }
export interface Totals {
  hoursToday: number; tokensToday: number; costToday: number;
  costMonth: number; commitsToday: number; unpushed: number;
}
export interface HostStat { key: string; cost: number; tokens: number; hours: number }
export interface Quantiles { count: number; avg: number; p50: number; p90: number }
export interface RangeStats {
  from: number; to: number;
  /** Active project filter, `null` = the whole devbox. The whole response is narrowed except
   *  `projects` — that stays complete as the filter's options. */
  project: string | null;
  repo?: string | null;
  repoOptions?: string[];
  totals: { cost: number; tokens: number; hours: number };
  previous: { cost: number; tokens: number; hours: number };
  daily: { day: number; cost: number; tokens: number; hours: number }[];
  hourly: { hour: number; cost: number; hours: number }[];
  projects: { project: string; cost: number; tokens: number }[];
  models: { model: string; cost: number; tokens: number }[];
  repos: { repo: string; cost: number; tokens: number }[];
  prompts: { chars: Quantiles; waitMs: Quantiles };
  hosts: HostStat[];
  hostsPrevious: HostStat[];
  accounts: HostStat[];
  dailyByHost: { host: string; days: { day: number; cost: number; tokens: number; hours: number }[] }[];
}
/** Hours worked — wall-clock from prompt to end of turn, NOT agent
 *  activity (that is in RangeStats.totals.hours from the claude_code.active_time.total metric).
 *  Exact copy of the shape from devd/src/aggregate.ts (WorkHours). */
export interface WorkHours {
  totalHours: number;
  byProject: { project: string; hours: number; cappedHours: number }[];
  daily: { day: number; hours: number }[];
}
export interface SessionUsage { id: string; cost: number; tokens: number }
export interface EventPage { items: ActivityEvent[]; total: number; types: string[] }
export interface EventQuery {
  limit?: number; offset?: number; session?: string; types?: string[]; from?: number; to?: number;
}
export interface ProjectStat { project: string; costToday: number; tokensToday: number }
export interface DiskStats { usedBytes: number; totalBytes: number; growthPerDay: number; daysLeft: number | null }
// `bare` = new repo layout (bare clone), so each session gets its own worktree
// and branch; without it a second session shares files and branch with the first. Optional — older devd
// does not send it and it is then treated as the old layout. Mirrors TreeRepo in devd/src/tree.ts.
export interface TreeRepo { name: string; cloneUrl: string; provider: string; cloned: boolean; bare?: boolean; agent?: AgentName | null }
export interface TreeProject { folder: string; project: string; repos: TreeRepo[]; soloAgent?: AgentName | null }
export interface CloneResult { repo: string; ok: boolean; skipped?: boolean; error?: string }
export interface CloneJob {
  id: string; scope: unknown; status: "running" | "done" | "error";
  total: number; done: number; results: CloneResult[];
}
export interface DevdConfig {
  version?: number;
  settings?: { autoStopHours?: number; portRangeStart?: number; portsPerSession?: number; diskWarnPercent?: number };
  [key: string]: unknown;
}
export interface GithubOwner { login: string; kind: "user" | "org"; name?: string; avatarUrl?: string }
export interface GithubRepo {
  name: string; nameWithOwner: string; url: string; visibility: string;
  description: string; isPrivate: boolean; isArchived: boolean; updatedAt: string;
}
export interface GiteaInstanceInfo { name: string; url: string; hasToken: boolean }
export interface GiteaRepo {
  name: string; fullName: string; owner: string; description: string;
  isPrivate: boolean; isArchived: boolean; updatedAt: string; cloneUrl: string;
}
export type CloneScope =
  | { scope: "all" }
  | { scope: "folder"; folder: string }
  | { scope: "project"; folder: string; project: string };
export interface OpenResult {
  session: { id: string; folder: string; project: string; repo: string; container: string; status: "running" | "stopped"; solo: 0 | 1 };
  created: boolean;
  pull?: { status: string; files?: string[] };
  claudePrompt?: string;
}
export interface Schedule {
  id: string; name: string; cron: string; folder: string; project: string; repo: string;
  clone_url: string; prompt: string; important: 0 | 1; enabled: 0 | 1; last_run_at: number | null;
}
export interface ActivityEvent { id: number; ts: number; session_id: string | null; type: string; data: string | null }
export type NotifyDecision = "armed" | "sent" | "deferred" | "suppressed" | "none";
export type NotifyVerdict = "false_positive" | "missing" | "ok";
export interface NotifyLogRow {
  id: number; ts: number; session_id: string; event: string;
  decision: NotifyDecision; reason: string | null;
  inflight: number; teammates: number;
  agent_session_id: string | null; detail: string | null;
  verdict: NotifyVerdict | null; verdict_note: string | null; verdict_at: number | null;
}
export interface AuthProvider { loggedIn: boolean; detail: string }
export interface AuthStatus {
  claude: AuthProvider; codex: AuthProvider;
  proxyCodex: AuthProvider; proxyXai: AuthProvider; grok: AuthProvider;
  // Optional — older devd does not send these fields yet.
  antigravity?: AuthProvider;
  proxyAntigravity?: AuthProvider;
}
export type ProxyProvider = "codex" | "xai" | "antigravity";
export interface UsageLimit {
  kind: string; percent: number | null; severity: string | null;
  resetsAt: number | null; modelName: string | null; isActive: boolean;
}
export interface AccountLeaseView {
  client: "mac" | "devbox"; sessionId: string | null; label: string | null; createdAt: number;
}
export interface AccountView {
  id: string; label: string;
  disabled: boolean; quarantined: boolean;
  fiveHourPct: number | null; fiveHourResetsAt: number | null;
  sevenDayPct: number | null; sevenDayResetsAt: number | null;
  limits: UsageLimit[];
  fetchedAt: number | null; error: string | null;
  // Errors IN A ROW (0 = the last poll succeeded). Older devd does not send the field — readers
  // must handle `undefined` (?? 0). See accountsView.usageErrorView.
  errorCount: number;
  // `orgId` = organization recorded when the account was added, `observedOrgId` = the one the API
  // reported at the last measurement. A mismatch means the profile signed in elsewhere;
  // a match between TWO accounts means the pool runs on one. See accountsView.identityIssues.
  orgId: string | null; observedOrgId: string | null;
  leases: AccountLeaseView[];
}
/** Effective pool settings from devd — the dashboard must not guess them (it used to have the threshold
 *  hardwired to 90 and it diverged from the config). */
export interface AccountPoolView {
  thresholdPct: number; spilloverPct: number; preferredAccountId: string | null;
  projectAccounts: Record<string, string>; soloAccountId: string | null;
}
/** Codex quota from `/api/subscriptions/codex`. `state` deliberately comes from the server
 *  ready-made — the dashboard MUST NOT infer it from a combination of empty windows and `error`. */
export interface CodexWindowView {
  kind: "primary" | "secondary";
  usedPct: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
}
export interface CodexSubscriptionView {
  state: "ok" | "signed-out" | "stale-login" | "error";
  planType: string | null;
  windows: CodexWindowView[];
  credits: { balance: number | null; unlimited: boolean; hasCredits: boolean } | null;
  limitReached: string | null;
  fetchedAt: number;
  error: string | null;
}
export interface CodexAccountView {
  id: string;
  label: string;
  isDefault: boolean;
  disabled: boolean;
  usage: CodexSubscriptionView | null;
  sharedUsageWith?: string[];
}
export interface CodexAccountsView {
  accounts: CodexAccountView[];
  preferredAccountId: string | null;
}
export interface CodexSessionAccountsView {
  accounts: (CodexAccountView & { available: boolean; unavailableReason: string | null })[];
  panes: { target: string; accountId: string | null;
    pending?: { accountId: string; threadId: string | null; phase: "identify" | "transfer" | "resume" } }[];
  currentAccountId: string | null;
  /** A switch still running in the background (it outlived its request). */
  switching?: true;
  /** Result of a background switch, reported once after it finished. */
  lastSwitch?: CodexAccountSwitchResponse;
}
export interface CodexAccountSwitchResponse {
  ok: boolean;
  accountId: string;
  label: string;
  unchanged: boolean;
  panes: { target: string; outcome: string }[];
  error?: string;
}
export interface CodexAccountLogin {
  id: string;
  url: string;
  code: string;
  expiresInSec: number;
}
/** Grok quota from `/api/subscriptions/grok`. `usedPct: null` is NOT zero — SuperGrok
 *  does not expose a percentage and the card draws a dash for null (see devd/src/grokUsageFetch.ts). */
export interface GrokSubscriptionView {
  state: "ok" | "signed-out" | "stale-login" | "error";
  tier: string | null;
  usedPct: number | null;
  resetsAt: number | null;
  fetchedAt: number;
  error: string | null;
}
/** Response of POST /api/sessions/:id/switch-account (see devd/src/accountSwitch.ts).
 *  Exact copy of the shape from `cli/src/api.ts` — the fields are REQUIRED, not optional.
 *  "already-on-account" is SUCCESS: the pane was already running on the target account and deliberately
 *  was not restarted, so it would not lose an unfinished turn. */
export interface SwitchAccountResponse {
  ok: boolean;
  accountId: string | null;
  label: string | null;
  unchanged: boolean;   // target account == the one the session was already running on — nothing was restarted
  exhausted: boolean;   // target account is over the threshold anyway (all-exhausted branch of the policy)
  panes: { target: string; outcome: "restarted" | "already-on-account" | "did-not-exit" | "did-not-return" | "stuck-on-dialog" | "unknown-session" }[];
}

// Response of POST /api/sessions/:id/agent — live agent swap (devd/src/agentSwitch.ts).
// On the wire it carries `status`; error states (unknown/not-running/in-progress) arrive as
// HTTP errors. Manual mirror of devd types (vite bundle for the browser, see AGENT_PROFILES).
export interface SwitchAgentResponse {
  ok: boolean;
  status: "unchanged" | "no-agent" | "switched" | "failed";
  panes: { target: string; outcome: "restarted" | "did-not-exit" | "did-not-return" | "stuck-on-dialog" }[];
}
export interface CcSessionStatus {
  id: string; project: string; repo: string;
  version: string | null; panes: number | null; stalePanes: number | null; busyPct: number | null;
}
export interface CcStatus { latest: string | null; image: string | null; sessions: CcSessionStatus[] }
export interface CcRunResult {
  latest: string | null; built: boolean; updated: string[]; restarted: string[]; skipped: string[];
}

// Carries the HTTP status code next to the message — an optional endpoint (503 = "not configured")
// can thus be told apart from a real error without parsing localized text.
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) throw new ApiError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`, r.status);
  // 202/204 and similar can arrive without a body (e.g. "Run now" for schedules) — r.json() would throw.
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export interface ProdWrite {
  id: number; ts: number; session_id: string | null; db: string; sql: string;
  status: "blocked" | "pending" | "approved" | "executed" | "failed" | "rejected";
  decided_at: number | null; result: string | null; error: string | null;
  scope?: "dml" | "migration"; exception?: string | null; code?: string | null; requestId?: number | null; nextAction?: string;
  access?: { state: string; engine: string | null; blocks: { code: string; message: string; action: string }[]; nextAction: string } | null;
}

// Mirror of devd/src/unpushed.ts — unpushed commits per folder (the Work in
// progress page). `commits` is a truncated listing, `count` is the exact count.
export interface UnpushedCommit { hash: string; subject: string; at: number; author: string }
export interface UnpushedBranch { branch: string; upstream: string | null; count: number; commits: UnpushedCommit[]; truncated: boolean }
export interface RemoteInfo { provider: "github" | "gitea" | "other"; url: string; host: string; owner: string; name: string }
export interface UnpushedRepo {
  folder: string; project: string; repo: string; path: string; bare: boolean; noRemote: boolean;
  count: number; branches: UnpushedBranch[]; error?: string;
  // Only for repos with something to push: origin (for Create PR) and the remote's default branch.
  remote?: RemoteInfo | null; base?: string;
}
export interface UnpushedFolder { folder: string; count: number; repos: UnpushedRepo[] }
export interface UnpushedReport { at: number; total: number; scanned: number; folders: UnpushedFolder[] }

// Mirror of SshApprovalRow from devd/src/sshApprovals.ts. `revoked` is a terminal state
// set by revokeGrant alongside clearing grant_until — separate from `expired`
// (expired without a decision) and `denied` (a human rejected it outright).
export interface SshApproval {
  id: string; session_id: string | null; title: string; why: string;
  target: string | null; cwd: string | null; project: string | null; repo: string | null;
  // Alias from sshServers (configEdit.ts) that `target` resolved to — `null` when
  // the target matches no configured server (or the request has no target). See
  // resolveSshTarget in devd/src/sshServers.ts and sshTargetLabel in sshApprovalsView.ts.
  server: string | null;
  status: "pending" | "approved" | "denied" | "expired" | "activated" | "revoked";
  decided_by: "mac" | "ios" | "dashboard" | null;
  created_at: number; decided_at: number | null; expires_at: number; grant_until: number | null;
  grant_permanent: 0 | 1;
}

// Mirror of the GET /api/op/ssh-keys response — `servers` are the configured aliases (sshServers)
// for this particular key, not just their names (devd/src/api.ts).
export interface SshKey { title: string; vault: string; servers: { name: string; user: string; host: string; port: number }[] }

/* ------------------------------- Hardware ------------------------------- */

export interface BeszelSystem {
  id: string; name: string; status: string; agentVersion: string | null;
  uptimeSec: number | null; cpu: number; memPct: number; diskPct: number;
}
export interface MachineSample {
  at: number; cpu: number;
  memPct: number; memUsedGb: number; memTotalGb: number; swapPct: number; swapUsedGb: number; swapTotalGb: number;
  diskPct: number; diskUsedGb: number; diskTotalGb: number; diskReadMbs: number; diskWriteMbs: number;
  netUpKbs: number; netDownKbs: number; load1: number; load5: number; load15: number;
}
export interface SshLogin { at: number; user: string; ip: string; method: string }
export interface PkgEvent { at: number; action: string; pkg: string; version: string }
export interface PendingUpdate { pkg: string; from: string; to: string }
export interface HostReport {
  hostname: string | null; os: string | null; kernel: string | null;
  uptimeSec: number | null; bootedAt: number | null;
  disk: { totalBytes: number; usedBytes: number } | null;
  rebootRequired: boolean; rebootPkgs: string[];
  updates: PendingUpdate[]; logins: SshLogin[]; packages: PkgEvent[];
}
export interface BorgArchive { name: string; at: number; id: string }
export interface BorgRepo { archives: BorgArchive[]; lastArchiveAt: number | null; originalBytes: number; storedBytes: number }
export interface UnitRun {
  state: string; startedAt: number | null; finishedAt: number | null; nextAt: number | null; message: string | null;
}
export interface MachineBackup {
  state: string; startedAt: number | null; finishedAt: number | null; nextAt: number | null; message: string | null;
  repo: BorgRepo | null; pull: { label: string; command: string }[];
}
export interface Machine {
  id: string; label: string;
  beszel: BeszelSystem | null;
  host: HostReport | null;
  backup: MachineBackup | null;
  upgrade: UnitRun | null;
  checkedAt: number;
  errors: string[];
}
export interface Monitor {
  id: string; name: string; type: string; url: string | null; hostname: string | null; tag: string | null;
  up: boolean; uptime1d: number | null; uptime30d: number | null; uptime365d: number | null;
  responseMs: number | null; certDaysLeft: number | null;
}
export interface HardwareSnapshot {
  updatedAt: number;
  machines: Machine[];
  monitors: Monitor[];
  storageBox: { usedBytes: number; totalBytes: number } | null;
  errors: string[];
}
export type SeriesRange = "1h" | "6h" | "24h" | "7d";

// Terminal sharing (devd/src/shares.ts). `url` with the token comes only from POST — once.
export interface CreatedShare { id: string; url: string; expiresAt: number }
export interface ActiveShare { id: string; session_id: string; name: string | null; created_at: number; expires_at: number }

export const api = {
  health: () => j<{ ok: boolean; version: string; commit: string | null }>("/api/health"),
  hardware: () => j<HardwareSnapshot>("/api/hardware"),
  hardwareSeries: (id: string, range: SeriesRange) => j<MachineSample[]>(`/api/hardware/${encodeURIComponent(id)}/series?range=${range}`),
  runBackup: (id: string) => j<{ ok: true }>(`/api/hardware/${encodeURIComponent(id)}/backup/run`, { method: "POST" }),
  runUpdate: (id: string) => j<{ ok: true }>(`/api/hardware/${encodeURIComponent(id)}/update`, { method: "POST" }),
  rebootHost: (id: string) => j<{ ok: true }>(`/api/hardware/${encodeURIComponent(id)}/reboot`, { method: "POST" }),
  live: () => j<LiveStats>("/api/stats/live"),
  resources: () => j<Resources>("/api/stats/resources"),
  totals: () => j<Totals>("/api/stats/totals"),
  projects: () => j<ProjectStat[]>("/api/stats/projects"),
  statsRange: (from: number, to: number, project?: string | null, repo?: string | null) =>
    j<RangeStats>(`/api/stats/range?from=${from}&to=${to}${project ? `&project=${encodeURIComponent(project)}` : ""}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`),
  workHours: (from: number, to: number, project?: string | null, repo?: string | null) => j<WorkHours>(`/api/stats/work?from=${from}&to=${to}${project ? `&project=${encodeURIComponent(project)}` : ""}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`),
  disk: () => j<DiskStats>("/api/stats/disk"),
  resetStats: () => j<{ ok: true }>("/api/stats/reset", { method: "POST" }),
  tree: () => j<TreeProject[]>("/api/tree"),
  config: () => j<DevdConfig>("/api/config"),
  auth: () => j<AuthStatus>("/api/auth"),
  codexLoginStart: () => j<{ url: string; code: string; expiresInSec: number }>("/api/auth/codex/login/start", post({})),
  codexLoginStatus: () => j<{ status: "pending" | "done" | "error" }>("/api/auth/codex/login/status"),
  codexLogout: () => j<void>("/api/auth/codex/logout", post({})),
  // `bridge`: devd asked the listener on the mac for a temporary bridge for the OAuth callback
  // (localhost:1455 → VPS). "unavailable" (or the field missing from an older devd)
  // = the UI should suggest a manual SSH tunnel.
  proxyLoginStart: (provider: ProxyProvider) => j<{ url: string; bridge?: "ok" | "unavailable" }>(`/api/auth/proxy/${provider}/login/start`, post({})),
  proxyLoginStatus: (provider: ProxyProvider) => j<{ status: "pending" | "done" | "error" }>(`/api/auth/proxy/${provider}/login/status`),
  // No expiresInSec (unlike Codex) — the real validity of the Grok code has not been
  // measured, see the comment at grokLoginStart in devd/src/agentAuth.ts.
  grokLoginStart: () => j<{ url: string; code: string }>("/api/auth/grok/login/start", post({})),
  grokLoginStatus: () => j<{ status: "pending" | "done" | "error" }>("/api/auth/grok/login/status"),
  // Google OAuth without a browser on the server: devd opens a login container, the user
  // pastes the authorization code that agy waits for on stdin.
  agyLoginStart: () => j<{ url: string }>("/api/auth/antigravity/login/start", post({})),
  agyLoginCode: (code: string) => j<void>("/api/auth/antigravity/login/code", post({ code })),
  agyLoginStatus: () => j<{ status: "pending" | "done" | "error" }>("/api/auth/antigravity/login/status"),
  agyLogout: () => j<void>("/api/auth/antigravity/logout", post({})),
  accounts: () => j<{ accounts: AccountView[]; pool: AccountPoolView }>("/api/accounts"),
  addAccount: (id: string, credentials: string, label?: string) =>
    j<{ id: string; label: string }>("/api/accounts", post({ id, credentials, label })),
  setAccountDisabled: (id: string, disabled: boolean) =>
    j<void>(`/api/accounts/${encodeURIComponent(id)}/disable`, post({ disabled })),
  // Forced quota re-measurement. Responds 200 even when the measurement itself failed —
  // the result (including `error`) is in the returned view, not in the HTTP status.
  refreshAccount: (id: string) =>
    j<{ account: AccountView | null }>(`/api/accounts/${encodeURIComponent(id)}/refresh`, { method: "POST" }),
  // Overwrites .credentials.json inside an existing profile. Needed because deleting and
  // re-adding an account is impossible while even one session runs (each mounts all profiles).
  replaceAccountCredentials: (id: string, credentials: string) =>
    j<{ account: AccountView | null }>(`/api/accounts/${encodeURIComponent(id)}/credentials`, post({ credentials })),
  codexSubscription: () => j<{ codex: CodexSubscriptionView | null }>("/api/subscriptions/codex"),
  codexAccounts: () => j<CodexAccountsView>("/api/codex-accounts"),
  sessionCodexAccounts: (sessionId: string) =>
    j<CodexSessionAccountsView>(`/api/sessions/${encodeURIComponent(sessionId)}/codex-account`),
  switchCodexAccount: (sessionId: string, accountId: string) =>
    j<CodexAccountSwitchResponse | { running: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/codex-account`, post({ accountId })),
  codexAccountReauthStart: (id: string) =>
    j<CodexAccountLogin>(`/api/codex-accounts/${encodeURIComponent(id)}/reauth/start`, post({})),
  codexAccountReauthStatus: (id: string) =>
    j<{ status: "pending" | "done" | "error"; error?: string }>(`/api/codex-accounts/${encodeURIComponent(id)}/reauth/status`),
  codexAccountReauthCancel: (id: string) =>
    j<{ ok: true }>(`/api/codex-accounts/${encodeURIComponent(id)}/reauth/cancel`, post({})),
  codexAccountLoginStart: (label: string) =>
    j<CodexAccountLogin>("/api/codex-accounts/login/start", post({ label })),
  codexAccountLoginStatus: (id: string) =>
    j<{ status: "pending" | "done" | "error"; error?: string }>(`/api/codex-accounts/${encodeURIComponent(id)}/login/status`),
  codexAccountLoginCancel: (id: string) =>
    j<{ ok: true }>(`/api/codex-accounts/${encodeURIComponent(id)}/login/cancel`, post({})),
  refreshCodexAccount: (id: string) =>
    j<{ account: CodexAccountView | null }>(`/api/codex-accounts/${encodeURIComponent(id)}/refresh`, post({})),
  updateCodexAccount: (id: string, patch: { label?: string; disabled?: boolean }) =>
    j<{ ok: true }>(`/api/codex-accounts/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
    }),
  preferCodexAccount: (accountId: string | null) =>
    j<{ ok: true }>("/api/codex-accounts/preference", post({ accountId })),
  deleteCodexAccount: (id: string) =>
    j<{ ok: true }>(`/api/codex-accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  grokSubscription: () => j<{ grok: GrokSubscriptionView | null }>("/api/subscriptions/grok"),
  // The key goes only ONE way: GET returns `hasKey`, never the value (see devd/src/api.ts).
  openrouter: () => j<OpenrouterView>("/api/openrouter"),
  openrouterSetKey: (key: string) =>
    j<void>("/api/openrouter/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }),
  openrouterSetModel: (model: string) =>
    j<void>("/api/openrouter/model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }),
  proxyContext: () => j<{ profiles: ProxyContextRow[] }>("/api/proxy-context"),
  proxyContextSet: (key: string, tokens: number | null) =>
    j<void>(`/api/proxy-context/${encodeURIComponent(key)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokens }) }),
  // `removal: "purged"` = the volume holds mounts of running sessions, so it could not be deleted;
  // the profile is emptied (no live token on disk) and `leftoverVolume` remains
  // to be deleted after a recreate. See removeProfile in devd/src/accountProfiles.ts.
  deleteAccount: (id: string) =>
    j<{ removal: "removed" | "purged"; leftoverVolume: string | null }>(
      `/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  saveConfig: (config: unknown) => j<{ ok: true }>("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }) }),
  githubOwners: () => j<{ owners: GithubOwner[] }>("/api/github/owners"),
  githubRepos: (owner: string) => j<{ repos: GithubRepo[] }>(`/api/github/repos?owner=${encodeURIComponent(owner)}`),
  giteaInstances: () => j<{ instances: GiteaInstanceInfo[] }>("/api/gitea/instances"),
  giteaRepos: (instance: string) => j<{ repos: GiteaRepo[] }>(`/api/gitea/repos?instance=${encodeURIComponent(instance)}`),
  giteaSetToken: (instance: string, token: string) => j<{ ok: true; login: string }>("/api/gitea/token", post({ instance, token })),
  clone: (scope: CloneScope) => j<{ jobId: string }>("/api/clone", post(scope)),
  job: (id: string) => j<CloneJob>(`/api/jobs/${id}`),
  // `fresh` = create ANOTHER session, not attach to the existing one (see sessionsFor
  // in newSession.ts). openSolo does not know `fresh` — the server does not accept it for solo
  // (`d.mgr.openSolo`), see devd/src/api.ts.
  openSession: (t: { folder: string; project: string; repo: string; cloneUrl?: string; agent?: AgentName; fresh?: boolean }) => j<OpenResult>("/api/sessions", post(t)),
  openSolo: (t: { folder: string; project: string; agent?: AgentName }) => j<OpenResult>("/api/sessions", post({ ...t, solo: true })),
  openInstabox: (t: { folder: string; project: string; repo: string; cloneUrl: string; agent?: AgentName }) =>
    j<{ jobId: string; sessionId: string }>("/api/sessions", post({ ...t, host: "instabox" })),
  instaboxJob: (id: string) => j<IbxJobDto>(`/api/instabox/jobs/${encodeURIComponent(id)}`),
  instaboxStatus: () => j<IbxStatusDto>("/api/instabox/status"),
  placement: () => j<PlacementDto>("/api/placement"),
  rebuildBase: () => j<{ jobId: string }>("/api/instabox/base/rebuild", { method: "POST" }),
  baseJob: (id: string) => j<IbxJobDto>(`/api/instabox/base/jobs/${encodeURIComponent(id)}`),
  killOrphan: (id: string) => j<void>(`/api/instabox/machines/${encodeURIComponent(id)}`, { method: "DELETE" }),
  desktopLink: (id: string, control: boolean, refresh = false) => j<{ url: string; expiresAt: number }>(`/api/sessions/${encodeURIComponent(id)}/desktop-link`, post({ control, refresh })),
  createShare: (sessionId: string, minutes: number) => j<CreatedShare>(`/api/sessions/${encodeURIComponent(sessionId)}/shares`, post({ minutes })),
  shares: () => j<ActiveShare[]>("/api/shares"),
  revokeShare: (id: string) => j<void>(`/api/shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // Container rebuild (new docker id) — the only thing that lifts the restriction after sharing.
  recreateSession: (id: string) => j<{ session: unknown }>(`/api/sessions/${encodeURIComponent(id)}/recreate`, post({})),
  desktopRevoke: (id: string) => j<void>(`/api/sessions/${encodeURIComponent(id)}/desktop-link`, { method: "DELETE" }),
  stop: (id: string) => j<void>(`/api/sessions/${id}/stop`, { method: "POST" }),
  restart: (id: string) => j<void>(`/api/sessions/${id}/restart`, { method: "POST" }),
  end: (id: string, soloAction?: "keep" | "delete") => j<void>(`/api/sessions/${id}/end`, post({ soloAction })),
  setImportant: (id: string, important: boolean) => j<void>(`/api/sessions/${id}/important`, post({ important })),
  setCritic: (id: string, critic: boolean) => j<void>(`/api/sessions/${id}/critic`, post({ critic })),
  switchAccount: (sessionId: string) =>
    j<SwitchAccountResponse>(`/api/sessions/${sessionId}/switch-account`, post({})),
  // Live agent (harness) swap of a running session — claude→claude* keeps the conversation
  // (best-effort --resume), switching to a different CLI loses it (see devd/src/agentSwitch.ts).
  switchAgent: (sessionId: string, agent: AgentName) =>
    j<SwitchAgentResponse>(`/api/sessions/${sessionId}/agent`, post({ agent })),
  reviews: (id: string) => j<import("./criticView").CriticReview[]>(`/api/sessions/${id}/reviews?limit=5`),
  // Session nickname (an empty string clears it) — the server sanitizes the input itself.
  setName: (id: string, name: string) => j<void>(`/api/sessions/${id}/name`, post({ name })),
  schedules: () => j<Schedule[]>("/api/schedules"),
  createSchedule: (s: { name: string; cron: string; folder: string; project: string; repo: string; cloneUrl: string; prompt: string; important?: 0 | 1 }) => j<Schedule>("/api/schedules", post(s)),
  updateSchedule: (id: string, patch: Partial<Pick<Schedule, "name" | "cron" | "prompt" | "enabled" | "important">>) => j<Schedule>(`/api/schedules/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => j<void>(`/api/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) => j<void>(`/api/schedules/${id}/run`, { method: "POST" }),
  prodWriteCount: () => j<{ count: number }>("/api/prod-db/write-count"),
  prodWrites: (status?: string) => j<ProdWrite[]>(`/api/prod-db/writes${status ? `?status=${status}` : ""}`),
  prodWritePreview: (id: number) => j<{ rows: number; note: string }>(`/api/prod-db/writes/${id}/preview`),
  prodWriteApprove: (id: number) => j<{ rows: number; note: string }>(`/api/prod-db/writes/${id}/approve`, { method: "POST" }),
  prodWriteReject: (id: number) => j<{ ok: true }>(`/api/prod-db/writes/${id}/reject`, { method: "POST" }),
  events: (opts?: { limit?: number; session?: string }) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.session) q.set("session", opts.session);
    const qs = q.toString();
    return j<ActivityEvent[]>(`/api/events${qs ? `?${qs}` : ""}`);
  },
  /** Paginated variant for Log — also returns `total` and the list of existing types. */
  eventsPaged: (o: EventQuery) => {
    const q = new URLSearchParams();
    q.set("offset", String(o.offset ?? 0));          // offset enables the envelope on the server
    if (o.limit) q.set("limit", String(o.limit));
    if (o.session) q.set("session", o.session);
    if (o.types?.length) q.set("types", o.types.join(","));
    if (o.from !== undefined) q.set("from", String(o.from));
    if (o.to !== undefined) q.set("to", String(o.to));
    return j<EventPage>(`/api/events?${q.toString()}`);
  },
  sessionUsage: () => j<SessionUsage[]>("/api/stats/sessions"),
  ccUpkeep: () => j<CcStatus>("/api/cc-upkeep"),
  ccUpkeepRun: (session?: string) => j<CcRunResult>("/api/cc-upkeep/run", post(session ? { session } : {})),
  notifyLog: (opts?: { sessionId?: string; verdict?: string; decision?: NotifyDecision; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.sessionId) q.set("sessionId", opts.sessionId);
    if (opts?.verdict) q.set("verdict", opts.verdict);
    if (opts?.decision) q.set("decision", opts.decision);
    if (opts?.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return j<NotifyLogRow[]>(`/api/notify-log${qs ? `?${qs}` : ""}`);
  },
  setNotifyVerdict: (id: number, verdict: NotifyVerdict | null, note?: string) =>
    j<{ ok: true }>(`/api/notify-log/${id}/verdict`, post({ verdict, note })),
  dbRequests: () => j<DbRequestRow[]>("/api/prod-db/requests"),
  dbRequest: (id: number) => j<DbRequestRow>(`/api/prod-db/requests/${id}`),
  dbRequestDiscovery: (id: number) => j<DbDiscovery>(`/api/prod-db/requests/${id}/discovery`),
  coolifyDatabases: (instance: string) =>
    j<{ databases: DbCandidate[] }>(`/api/coolify/${encodeURIComponent(instance.trim())}/databases`),
  prepareDbRequest: (id: number, form: ProvisionForm) =>
    j<DbRequestRow>(`/api/prod-db/requests/${id}/prepare`, post(normalizeForm(form))),
  resumeDbRequest: (id: number) => j<DbRequestRow>(`/api/prod-db/requests/${id}/resume`, { method: "POST" }),
  rejectDbRequest: (id: number) =>
    j<{ ok: true }>(`/api/prod-db/requests/${id}/reject`, { method: "POST" }),
  operations: () => j<OpRow[]>("/api/operations"),
  approveOperation: (id: number) => j<{ status: string; result: string }>(`/api/operations/${id}/approve`, { method: "POST" }),
  rejectOperation: (id: number) => fetch(`/api/operations/${id}/reject`, { method: "POST" }).then(() => undefined),
  vault: () => j<VaultStatus>("/api/vault"),
  unlockVault: (passphrase: string) => j<VaultStatus>("/api/vault/unlock", post({ passphrase })),
  sshKeys: () => j<{ keys: SshKey[] }>("/api/op/ssh-keys"),
  sshApprovals: () => j<SshApproval[]>("/api/ssh-approvals"),
  sshApprove: (id: string, grantMinutes = 0, grantPermanent = false) => j<{ ok: true }>(`/api/ssh-approvals/${id}/approve`, post({ by: "dashboard", grantMinutes, ...(grantPermanent ? { grantPermanent: true } : {}) })),
  sshDeny: (id: string) => j<{ ok: true }>(`/api/ssh-approvals/${id}/deny`, post({ by: "dashboard" })),
  sshGrants: () => j<SshApproval[]>("/api/ssh-grants"),
  sshRevokeGrant: (id: string) => j<{ ok: true }>(`/api/ssh-grants/${id}`, { method: "DELETE" }),
  sshGate: () => j<{ enabled: boolean }>("/api/ssh-gate"),
  // `fresh` = Refresh in the UI: the server drops the cache and waits for a full scan.
  unpushed: (fresh = false) => j<UnpushedReport>(fresh ? "/api/unpushed?fresh=1" : "/api/unpushed"),
  unpushedPush: (path: string, branch: string) => j<{ ok: true }>("/api/unpushed/push", post({ path, branch })),
  // The server pushes first, then creates the PR — one click from the UI.
  unpushedPr: (path: string, branch: string, title: string, body: string) =>
    j<{ url: string; number: number | null }>("/api/unpushed/pr", post({ path, branch, title, body })),
};
