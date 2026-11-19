import Foundation

// Mirror of the TypeScript types from `dashboard/src/api.ts` — dashboard/src/api.ts is the source of truth for
// shapes. Keys are 1:1 with JSON (no CodingKeys renaming); TS `?` and `| null` both map to
// Swift Optional. Decodable only for now — Encodable will be added where the app POSTs.

// MARK: - Health

/// `/api/health` response — used by onboarding (`AppModel.testConnection`) to verify
/// devd reachability and show the version to the user.
struct HealthResponse: Decodable {
    let ok: Bool
    let version: String
}

// MARK: - Sessions / Live

/// Container-to-host port mapping (devbox).
struct SessionPort: Decodable {
    let host: Int
    let container: Int
}

/// Tolerant decoding: an unknown `rawValue` falls into `.unknown` instead of failing the whole decode.
/// The list of agents (and states) in devd changes (even several times a month) — an app on an older version
/// cannot know all of it, but a new value must not break decoding of `/api/stats/live` (the
/// `sessions` array). Custom `init(from:)` instead of the automatic synthesis from `RawRepresentable`.
enum ClaudeState: String, Decodable {
    case working, waiting, idle
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ClaudeState(rawValue: raw) ?? .unknown
    }
}

enum AgentName: String, Decodable {
    case claude
    case claudeGemini = "claude-gemini"
    case claudeOpenrouter = "claude-openrouter"
    case codex
    case grok
    case antigravity
    case vibe
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentName(rawValue: raw) ?? .unknown
    }
}

enum SessionStatus: String, Decodable {
    case running, stopped
}

/// Where the session runs — `vps` (DIND container on the host) vs. `instabox` (isolated machine, no
/// clipboard/DIND). Tolerant decoding like `ClaudeState`/`AgentName`: an unknown value falls into
/// `.unknown` instead of failing the whole `sessions` array.
enum SessionHost: String, Decodable {
    case vps, instabox
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionHost(rawValue: raw) ?? .unknown
    }
}

struct SessionLive: Decodable {
    let id: String
    let folder: String
    let project: String
    let repo: String
    let container: String
    let port_base: Int
    let status: SessionStatus
    let solo: Int
    let created_at: Int
    let last_active_at: Int
    let ports: [SessionPort]
    let claudeState: ClaudeState
    let cpuPct: Double
    let memBytes: Double
    let workspace: String
    let important: Int
    /// Account from the active lease; nil = session outside the pool (old container without profile
    /// mounts, or the pool is not configured).
    let accountId: String?
    /// Nickname set in the session manager (`dev`); nil/empty = no nickname.
    let name: String?
    let critic: Int?
    let agent: AgentName?
    /// Missing on older devd (the field was added for InstaBox) — `nil` behaves everywhere in the app as
    /// "not InstaBox" (see the Share action in `SessionDetailView`), same as `s.host !== "instabox"` on the web.
    let host: SessionHost?
    /// The container was shared and has not been rebuilt yet → still restricted (devd/src/shareTaint.ts).
    /// Missing on older devd → nil = no.
    let tainted: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, folder, project, repo, container, port_base, status, solo, created_at,
             last_active_at, ports, claudeState, cpuPct, memBytes, workspace, important,
             accountId, name, critic, agent, host, tainted
    }

    /// Custom `init(from:)`: `cpuPct`/`memBytes` tolerantly `decodeIfPresent ?? 0` — devd
    /// sends them as fractions (`memBytes: 618974003.2`) and older/outlier payloads may omit them
    /// entirely. A missing or fractional metric of one session must not break decoding of
    /// the whole `sessions` array.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        folder = try c.decode(String.self, forKey: .folder)
        project = try c.decode(String.self, forKey: .project)
        repo = try c.decode(String.self, forKey: .repo)
        container = try c.decode(String.self, forKey: .container)
        port_base = try c.decode(Int.self, forKey: .port_base)
        status = try c.decode(SessionStatus.self, forKey: .status)
        solo = try c.decode(Int.self, forKey: .solo)
        created_at = try c.decode(Int.self, forKey: .created_at)
        last_active_at = try c.decode(Int.self, forKey: .last_active_at)
        ports = try c.decode([SessionPort].self, forKey: .ports)
        claudeState = try c.decode(ClaudeState.self, forKey: .claudeState)
        cpuPct = try c.decodeIfPresent(Double.self, forKey: .cpuPct) ?? 0
        memBytes = try c.decodeIfPresent(Double.self, forKey: .memBytes) ?? 0
        workspace = try c.decode(String.self, forKey: .workspace)
        important = try c.decode(Int.self, forKey: .important)
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        critic = try c.decodeIfPresent(Int.self, forKey: .critic)
        agent = try c.decodeIfPresent(AgentName.self, forKey: .agent)
        host = try c.decodeIfPresent(SessionHost.self, forKey: .host)
        tainted = try c.decodeIfPresent(Bool.self, forKey: .tainted)
    }
}

struct LiveStats: Decodable {
    struct Disk: Decodable {
        let usedBytes: Int
        let totalBytes: Int
    }
    let sessions: [SessionLive]
    let disk: Disk
}

struct SessionUsage: Decodable {
    let id: String
    let cost: Double
    /// `Double`, not `Int` — tolerant of fractional values from devd; display (`Format.compactNumber`)
    /// rounds by itself.
    let tokens: Double
}

/// Custom `init(from:)` in an extension (the memberwise init stays): missing `tokens` = 0, as
/// tolerant as the metrics in `SessionLive` — one row without tokens must not break the whole array.
extension SessionUsage {
    private enum CodingKeys: String, CodingKey { case id, cost, tokens }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            cost: try c.decode(Double.self, forKey: .cost),
            tokens: try c.decodeIfPresent(Double.self, forKey: .tokens) ?? 0
        )
    }
}

// MARK: - Stats / Totals / Range

struct Totals: Decodable {
    let hoursToday: Double
    let tokensToday: Int
    let costToday: Double
    let costMonth: Double
    let commitsToday: Int
    let unpushed: Int
}

struct HostStat: Decodable {
    let key: String
    let cost: Double
    let tokens: Int
    let hours: Double
}

struct Quantiles: Decodable {
    let count: Int
    let avg: Double
    let p50: Double
    let p90: Double
}

struct RangeStats: Decodable {
    struct PeriodTotals: Decodable {
        let cost: Double
        let tokens: Int
        let hours: Double
    }
    struct DailyPoint: Decodable {
        let day: Int
        let cost: Double
        let tokens: Int
        let hours: Double
    }
    struct HourlyPoint: Decodable {
        let hour: Int
        let cost: Double
        let hours: Double
    }
    struct ProjectEntry: Decodable {
        let project: String
        let cost: Double
        let tokens: Int
    }
    struct ModelEntry: Decodable {
        let model: String
        let cost: Double
        let tokens: Int
    }
    struct RepoEntry: Decodable {
        let repo: String
        let cost: Double
        let tokens: Int
    }
    struct Prompts: Decodable {
        let chars: Quantiles
        let waitMs: Quantiles
    }
    struct HostDaily: Decodable {
        let host: String
        let days: [DailyPoint]
    }

    let from: Int
    let to: Int
    /// Active project filter, nil = the whole devbox.
    let project: String?
    let totals: PeriodTotals
    let previous: PeriodTotals
    let daily: [DailyPoint]
    let hourly: [HourlyPoint]
    let projects: [ProjectEntry]
    let models: [ModelEntry]
    let repos: [RepoEntry]
    let prompts: Prompts
    let hosts: [HostStat]
    let hostsPrevious: [HostStat]
    let accounts: [HostStat]
    let dailyByHost: [HostDaily]
}

// MARK: - Tree / Config

/// `bare` = the new repo shape (bare clone, own worktree + branch per session); without it the
/// second session shares files and branch with the first. Optional — older devd does not send it.
struct TreeRepo: Decodable {
    let name: String
    let cloneUrl: String
    let provider: String
    let cloned: Bool
    let bare: Bool?
    let agent: AgentName?
}

struct TreeProject: Decodable {
    let folder: String
    let project: String
    let repos: [TreeRepo]
    let soloAgent: AgentName?
}

/// devd configuration (`/api/config`). The server also sends `folders`/`settings` and other free-form fields,
/// but the config editor comes only in stage G — for now we read just the version.
struct DevdConfig: Decodable {
    let version: Int?
}

/// `POST /api/sessions` (open/openSolo) response — mirrors `OpenResult` from `dashboard/src/api.ts`.
struct OpenResult: Decodable {
    struct Session: Decodable {
        let id: String
        let folder: String
        let project: String
        let repo: String
        let container: String
        let status: SessionStatus
        let solo: Int
    }
    /// Present only when the repo had to be fetched/updated; `status == "conflict"` means
    /// the session was already running and the agent is now resolving the merge itself (see `NewSessionSheet` messages).
    struct Pull: Decodable {
        let status: String
        let files: [String]?
    }
    let session: Session
    let created: Bool
    let pull: Pull?
    let claudePrompt: String?
}

// MARK: - Auth

struct AuthProvider: Decodable {
    let loggedIn: Bool
    let detail: String
}

struct AuthStatus: Decodable {
    let claude: AuthProvider
    let codex: AuthProvider
    let proxyCodex: AuthProvider
    let proxyXai: AuthProvider
    let grok: AuthProvider
    // Optional — older devd does not send these fields yet.
    let antigravity: AuthProvider?
    let proxyAntigravity: AuthProvider?
}

// MARK: - Vault

/// `GET /api/vault` and `POST /api/vault/unlock` response — mirrors `VaultStatus` from
/// `dashboard/src/vaultView.ts`.
struct VaultStatus: Decodable {
    let locked: Bool
}

// MARK: - Accounts

struct UsageLimit: Decodable {
    let kind: String
    let percent: Double?
    let severity: String?
    let resetsAt: Int?
    let modelName: String?
    let isActive: Bool
}

struct AccountLeaseView: Decodable {
    enum Client: String, Decodable {
        case mac, devbox
    }
    let client: Client
    let sessionId: String?
    let label: String?
    let createdAt: Int
}

struct AccountView: Decodable {
    let id: String
    let label: String
    let disabled: Bool
    let quarantined: Bool
    let fiveHourPct: Double?
    let fiveHourResetsAt: Int?
    let sevenDayPct: Double?
    let sevenDayResetsAt: Int?
    let limits: [UsageLimit]
    let fetchedAt: Int?
    let error: String?
    /// Consecutive errors (0 = the last poll succeeded). Older devd does not send the field.
    let errorCount: Int
    /// `orgId` = organization recorded when the account was set up, `observedOrgId` = the one the API
    /// reported at the last measurement. A mismatch means the profile logged in elsewhere.
    let orgId: String?
    let observedOrgId: String?
    let leases: [AccountLeaseView]
}

/// Effective pool settings from devd — the app must not guess them.
struct AccountPoolView: Decodable {
    let thresholdPct: Double
    let spilloverPct: Double
    let preferredAccountId: String?
    let projectAccounts: [String: String]
    let soloAccountId: String?
}

/// `/api/accounts` response — an anonymous shape from api.ts, named here for decoding.
struct AccountsResponse: Decodable {
    let accounts: [AccountView]
    let pool: AccountPoolView
}

// MARK: - Subscriptions (Codex / Grok)

/// Tolerant decoding as with `ClaudeState`/`AgentName` — a new state from the server must not break
/// decoding of `/api/subscriptions/*`.
enum SubscriptionState: String, Decodable {
    case ok
    case signedOut = "signed-out"
    case staleLogin = "stale-login"
    case error
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SubscriptionState(rawValue: raw) ?? .unknown
    }
}

struct CodexWindowView: Decodable {
    enum Kind: String, Decodable {
        case primary, secondary
    }
    let kind: Kind
    let usedPct: Double?
    let windowMinutes: Int?
    let resetsAt: Int?
}

struct CodexSubscriptionView: Decodable {
    struct Credits: Decodable {
        let balance: Double?
        let unlimited: Bool
        let hasCredits: Bool
    }
    /// `state` comes from the server deliberately precomputed — the app must not infer it from a combination of
    /// empty windows and `error`.
    let state: SubscriptionState
    let planType: String?
    let windows: [CodexWindowView]
    let credits: Credits?
    let limitReached: String?
    let fetchedAt: Int
    let error: String?
}

/// `/api/subscriptions/codex` response.
struct CodexSubscriptionResponse: Decodable {
    let codex: CodexSubscriptionView?
}

/// `usedPct: nil` is NOT zero — SuperGrok does not expose a percentage and the card draws a dash for nil.
struct GrokSubscriptionView: Decodable {
    let state: SubscriptionState
    let tier: String?
    let usedPct: Double?
    let resetsAt: Int?
    let fetchedAt: Int
    let error: String?
}

/// `/api/subscriptions/grok` response.
struct GrokSubscriptionResponse: Decodable {
    let grok: GrokSubscriptionView?
}

// MARK: - cc-upkeep

struct CcSessionStatus: Decodable {
    let id: String
    let project: String
    let repo: String
    let version: String?
    let panes: Int?
    let stalePanes: Int?
    let busyPct: Double?
}

struct CcStatus: Decodable {
    let latest: String?
    let image: String?
    let sessions: [CcSessionStatus]
}

// MARK: - Switch account / switch agent

/// `POST /api/sessions/:id/switch-account` response (devd/src/accountSwitch.ts). An exact copy of the
/// shape from `dashboard/src/api.ts` — fields are REQUIRED, not optional. `unchanged` is SUCCESS: the panel
/// on the target account was already running and was deliberately not restarted, so it would not lose an in-progress turn.
struct SwitchAccountResponse: Decodable {
    enum Outcome: String, Decodable {
        case restarted
        case alreadyOnAccount = "already-on-account"
        case didNotExit = "did-not-exit"
        case didNotReturn = "did-not-return"
        case stuckOnDialog = "stuck-on-dialog"
        case unknownSession = "unknown-session"
    }
    struct Pane: Decodable {
        let target: String
        let outcome: Outcome
    }
    let ok: Bool
    let accountId: String?
    let label: String?
    /// Target account == the one the session was already running on — nothing was restarted.
    let unchanged: Bool
    /// The target account is over the threshold anyway (the all-exhausted policy branch).
    let exhausted: Bool
    let panes: [Pane]
}

/// `POST /api/sessions/:id/agent` response — live agent (harness) swap, devd/src/agentSwitch.ts.
/// Only `status` travels over the wire; error states (unknown/not-running/in-progress) come as HTTP
/// errors, not in this field.
struct SwitchAgentResponse: Decodable {
    enum Status: String, Decodable {
        case unchanged
        case noAgent = "no-agent"
        case switched
        case failed
    }
    enum Outcome: String, Decodable {
        case restarted
        case didNotExit = "did-not-exit"
        case didNotReturn = "did-not-return"
        case stuckOnDialog = "stuck-on-dialog"
    }
    struct Pane: Decodable {
        let target: String
        let outcome: Outcome
    }
    let ok: Bool
    let status: Status
    let panes: [Pane]
}

// MARK: - Critic

/// Mirror of `CriticReview` from `dashboard/src/criticView.ts`.
struct CriticReview: Decodable {
    enum Verdict: String, Decodable {
        case ok, issues, error
    }
    let id: Int
    let session_id: String
    let turn_id: String
    let round: Int
    let verdict: Verdict
    let findings: String
    let evidence: String?
    let ms: Int
    let at: Int
}

// MARK: - Terminal share (sharing the terminal via a short-lived link — devd/src/shares.ts)

/// `POST /api/sessions/:id/shares` response — mirrors `CreatedShare` from `dashboard/src/api.ts`.
/// `url` carries the token and is returned ONLY here, once; the app does not store it anywhere (no `Codable`
/// round-trip to disk) — after the share sheet is closed there is no way to show it again, same as on the web.
struct TerminalShare: Decodable {
    let id: String
    let url: String
    let expiresAt: Int
}

/// One row of `GET /api/shares` — mirrors `ActiveShare` from `dashboard/src/api.ts`. Cross-session
/// (the server does not filter it by session_id); `SessionDetailView` filters it itself.
struct ActiveShare: Decodable, Identifiable {
    let id: String
    let session_id: String
    let name: String?
    let created_at: Int
    let expires_at: Int
}

// MARK: - Schedules

struct Schedule: Decodable {
    let id: String
    let name: String
    let cron: String
    let folder: String
    let project: String
    let repo: String
    let clone_url: String
    let prompt: String
    let important: Int
    let enabled: Int
    let last_run_at: Int?
}

// MARK: - Notify log

enum NotifyDecision: String, Decodable {
    case armed, sent, deferred, suppressed, none
}

enum NotifyVerdict: String, Decodable {
    case falsePositive = "false_positive"
    case missing
    case ok
}

struct NotifyLogRow: Decodable {
    let id: Int
    let ts: Int
    let session_id: String
    let event: String
    let decision: NotifyDecision
    let reason: String?
    let inflight: Int
    let teammates: Int
    let agent_session_id: String?
    let detail: String?
    let verdict: NotifyVerdict?
    let verdict_note: String?
    let verdict_at: Int?
}

// MARK: - Prod DB writes

struct ProdWrite: Decodable {
    enum Status: String, Decodable {
        case pending, approved, executed, failed, rejected
    }
    let id: Int
    let ts: Int
    let session_id: String?
    let db: String
    let sql: String
    let status: Status
    let decided_at: Int?
    let result: String?
    let error: String?
}

// MARK: - SSH approvals

/// Mirrors `SshApproval` from `dashboard/src/api.ts` and a row of the `ssh_approvals` table
/// (`devd/src/sshApprovals.ts` is the source of truth for states). `revoked` is a terminal state
/// set by `revokeGrant` alongside clearing `grant_until` — separate from `expired`
/// (timed out without a decision) and `denied` (a human rejected it outright).
///
/// `project`/`repo`/`title` are VERIFIED facts (computed by the server from the session id, `title`
/// validated against the list of keys in 1Password) — `why`/`cwd`/`target` are claims the
/// container made about itself via `srv "<title>" --why "…" [user@host]` and nothing verifies them.
/// `SshApprovalsScreen` must preserve this distinction in the layout, not just describe it.
struct SshApproval: Codable, Identifiable, Equatable {
    let id: String
    let session_id: String?
    let title: String
    let why: String
    let target: String?
    let cwd: String?
    let project: String?
    let repo: String?
    let status: String
    let decided_by: String?
    let created_at: Double
    let decided_at: Double?
    let expires_at: Double
    let grant_until: Double?
    /// Alias from `sshServers` that `target` resolved to on devd (`nil` = no target, or the target
    /// matches no configured server). Also optional because of older devd versions that did not send this
    /// field yet.
    let server: String?
    /// `0`/`1` from devd (`SshApprovalRow.grant_permanent`); optional for the same reason as `server`.
    let grant_permanent: Int?
}

/// `GET /api/ssh-gate` — mirrors `{ enabled: boolean }` from `dashboard/src/api.ts`. `false` means
/// `DEVD_SSH_APPROVAL=off` on the host (break-glass): keys are issued without approval and the app
/// must show a red banner about it, not stay silent (see `SshApprovalsScreen`).
struct SshGate: Decodable {
    let enabled: Bool
}

/// One configured alias (`sshServers` in `devd/src/sshServers.ts`) for a key from `SshKey.servers` —
/// for future use in the request detail (choosing a target by key).
struct SshServerRef: Decodable, Equatable {
    let name: String
    let user: String
    let host: String
    let port: Int
}

/// `GET /api/op/ssh-keys` → `{ keys: SshKey[] }` — mirrors `SshKey` from `dashboard/src/api.ts`.
/// `servers` is optional on top of the TS shape: tolerance for older devd versions that did not send the field yet.
struct SshKey: Decodable, Equatable {
    let title: String
    let vault: String
    let servers: [SshServerRef]?
}

// MARK: - Hardware

struct BeszelSystem: Decodable {
    let id: String
    let name: String
    let status: String
    let agentVersion: String?
    let uptimeSec: Int?
    let cpu: Double
    let memPct: Double
    let diskPct: Double
}

struct SshLogin: Decodable {
    let at: Int
    let user: String
    let ip: String
    let method: String
}

struct PkgEvent: Decodable {
    let at: Int
    let action: String
    let pkg: String
    let version: String
}

struct PendingUpdate: Decodable {
    let pkg: String
    let from: String
    let to: String
}

struct HostReport: Decodable {
    struct DiskInfo: Decodable {
        let totalBytes: Int
        let usedBytes: Int
    }
    let hostname: String?
    let os: String?
    let kernel: String?
    let uptimeSec: Int?
    let bootedAt: Int?
    let disk: DiskInfo?
    let rebootRequired: Bool
    let rebootPkgs: [String]
    let updates: [PendingUpdate]
    let logins: [SshLogin]
    let packages: [PkgEvent]
}

struct BorgArchive: Decodable {
    let name: String
    let at: Int
    let id: String
}

struct BorgRepo: Decodable {
    let archives: [BorgArchive]
    let lastArchiveAt: Int?
    let originalBytes: Int
    let storedBytes: Int
}

struct UnitRun: Decodable {
    let state: String
    let startedAt: Int?
    let finishedAt: Int?
    let nextAt: Int?
    let message: String?
}

struct MachineBackup: Decodable {
    struct PullStep: Decodable {
        let label: String
        let command: String
    }
    let state: String
    let startedAt: Int?
    let finishedAt: Int?
    let nextAt: Int?
    let message: String?
    let repo: BorgRepo?
    let pull: [PullStep]
}

struct Machine: Decodable {
    let id: String
    let label: String
    let beszel: BeszelSystem?
    let host: HostReport?
    let backup: MachineBackup?
    let upgrade: UnitRun?
    let checkedAt: Int
    let errors: [String]
}

struct Monitor: Decodable {
    let id: String
    let name: String
    let type: String
    let url: String?
    let hostname: String?
    let tag: String?
    let up: Bool
    let uptime1d: Double?
    let uptime30d: Double?
    let uptime365d: Double?
    let responseMs: Int?
    let certDaysLeft: Int?
}

struct HardwareSnapshot: Decodable {
    struct StorageBox: Decodable {
        let usedBytes: Int
        let totalBytes: Int
    }
    let updatedAt: Int
    let machines: [Machine]
    let monitors: [Monitor]
    let storageBox: StorageBox?
    let errors: [String]
}

// MARK: - Overview (disk prediction, event log)

/// `/api/stats/disk` response — disk growth prediction, mirrors `DiskStats` from `dashboard/src/api.ts`
/// (server side `DiskPrediction` in `devd/src/aggregate.ts`). `daysLeft: nil` = growth cannot be
/// estimated (fewer than two history samples, or usage is not growing).
struct DiskStats: Decodable {
    let usedBytes: Int
    let totalBytes: Int
    let growthPerDay: Double
    let daysLeft: Double?
}

/// A row from `/api/events` — mirrors `ActivityEvent` from `dashboard/src/api.ts`. `session_id`/`data`
/// are missing for system events (host/scheduler), not only on a decoding error.
struct ActivityEvent: Decodable {
    let id: Int
    let ts: Int
    let session_id: String?
    let type: String
    let data: String?
}

/// Paged `/api/events` response — the server returns it instead of a bare array as soon as the request carries
/// `offset` (see `api.eventsPaged` in `dashboard/src/api.ts`); `LogScreen` therefore always sends an offset,
/// even on the first page. Mirrors `EventPage`.
struct EventPage: Decodable {
    let items: [ActivityEvent]
    let total: Int
    let types: [String]
}

// MARK: - Work hours (/api/stats/work)

/// Worked hours — wall-clock from prompt to end of turn, NOT agent activity (that is in
/// `RangeStats.totals.hours`, metric `claude_code.active_time.total`). Mirrors `WorkHours`
/// from `dashboard/src/api.ts`.
struct WorkHours: Decodable {
    struct ByProject: Decodable, Equatable {
        let project: String
        let hours: Double
        let cappedHours: Double
    }
    struct DailyHours: Decodable, Equatable {
        let day: Int
        let hours: Double
    }
    let totalHours: Double
    let byProject: [ByProject]
    let daily: [DailyHours]
}

// MARK: - Hardware series (/api/hardware/:id/series)

/// One machine history sample from Beszel — mirrors `MachineSample` from `dashboard/src/api.ts`.
struct MachineSample: Decodable {
    let at: Int
    let cpu: Double
    let memPct: Double
    let memUsedGb: Double
    let memTotalGb: Double
    let swapPct: Double
    let diskPct: Double
    let diskUsedGb: Double
    let diskTotalGb: Double
    let diskReadMbs: Double
    let diskWriteMbs: Double
    let netUpKbs: Double
    let netDownKbs: Double
    let load1: Double
    let load5: Double
    let load15: Double
}

/// History window for `GET /api/hardware/:id/series?range=` — mirrors `SeriesRange` from api.ts.
enum SeriesRange: String {
    case oneHour = "1h"
    case sixHours = "6h"
    case twentyFourHours = "24h"
    case sevenDays = "7d"
}

// MARK: - OpenRouter

/// `/api/openrouter` response — 1:1 `OpenrouterView` from `dashboard/src/openrouterView.ts`. The key itself
/// (a secret) is never returned via GET, only `hasKey`.
struct OpenrouterView: Decodable {
    let hasKey: Bool
    let model: String?
}

// MARK: - Chat threads and inbox (shared/thread.ts, devd/src/threadApi.ts)

/// Arbitrary JSON (a tool call's `input`). `null` is a value of its own: a tool started with `input: null` keeps it,
/// as in the dashboard (`it.input !== undefined`).
enum JSONValue: Decodable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    /// Indented JSON for the tool call's details (keys sorted, so the same input always reads the same).
    var pretty: String {
        guard let data = try? JSONSerialization.data(withJSONObject: foundation, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "(input not printable)" }
        return text
    }

    private var foundation: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map(\.foundation)
        case .object(let o): return o.mapValues(\.foundation)
        }
    }
}

struct TokenUsage: Decodable, Equatable {
    let input: Int
    let output: Int
    let cacheCreation: Int
    let cacheRead: Int
}

enum RunOrigin: String, Decodable {
    case user, agent, continuation, critic
}

enum RequestKind: String, Decodable {
    case question, plan, approval
}

/// One row of the conversation (`ThreadItem` in shared/thread.ts).
struct ThreadItem: Decodable, Equatable {
    enum Kind: String, Decodable { case user, assistant, tool, request, notice }
    enum Status: String, Decodable { case streaming, done, open, answered, expired }

    var seq: Int
    var runId: String?
    var itemId: String?
    var kind: Kind
    var text: String
    var tool: String?
    var input: JSONValue?
    var output: String?
    var isError: Bool?
    var status: Status?
    /// A user message's images: container paths under `/inbox/<sessionId>/`.
    var attachments: [String]?
    var ts: Int

    init(seq: Int, runId: String?, itemId: String?, kind: Kind, text: String, tool: String? = nil, input: JSONValue? = nil,
         output: String? = nil, isError: Bool? = nil, status: Status? = nil, attachments: [String]? = nil, ts: Int) {
        self.seq = seq; self.runId = runId; self.itemId = itemId; self.kind = kind; self.text = text; self.tool = tool
        self.input = input; self.output = output; self.isError = isError; self.status = status; self.attachments = attachments; self.ts = ts
    }

    private enum CodingKeys: String, CodingKey { case seq, runId, itemId, kind, text, tool, input, output, isError, status, attachments, ts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        itemId = try c.decodeIfPresent(String.self, forKey: .itemId)
        kind = try c.decode(Kind.self, forKey: .kind)
        text = try c.decode(String.self, forKey: .text)
        tool = try c.decodeIfPresent(String.self, forKey: .tool)
        // Present = a value, JSON null included (decodeIfPresent would turn null into "no input").
        input = c.contains(.input) ? try c.decode(JSONValue.self, forKey: .input) : nil
        output = try c.decodeIfPresent(String.self, forKey: .output)
        isError = try c.decodeIfPresent(Bool.self, forKey: .isError)
        status = try c.decodeIfPresent(Status.self, forKey: .status)
        attachments = try c.decodeIfPresent([String].self, forKey: .attachments)
        ts = try c.decode(Int.self, forKey: .ts)
    }
}

struct RunRow: Decodable, Equatable {
    enum Status: String, Decodable { case queued, running, completed, interrupted, failed }

    var runId: String
    var origin: RunOrigin
    var status: Status
    /// nil until the bridge has announced its native thread.
    var harness: String?
    var nativeThreadId: String?
    var model: String?
    var queuedAt: Int?
    var startedAt: Int?
    var endedAt: Int?
    /// Seq of the terminal event.
    var endedSeq: Int?
    var usage: TokenUsage?
    var error: String?
    /// Only `rate-limited` (the bridge's `run.failed.reason`); nil otherwise.
    var failureReason: String?
}

struct RequestOption: Decodable, Equatable {
    let label: String
    let description: String?
}

/// What `request.opened` carries, plus when it opened.
struct PendingRequest: Decodable, Equatable {
    let requestId: String
    let runId: String
    let kind: RequestKind
    let prompt: String
    let options: [RequestOption]?
    let multiSelect: Bool?
    let openedAt: Int
}

struct BackgroundWork: Decodable, Equatable {
    /// subagent, workflow, monitor, wakeup, declared-wait or command; shown as is.
    let id: String
    let kind: String
    let label: String
    let holding: Bool
    let until: Int?
}

struct NativeThread: Decodable, Equatable {
    let harness: String
    let nativeThreadId: String
    let account: String?
    let model: String?
}

struct ThreadSnapshot: Decodable, Equatable {
    var lastSeq: Int
    var seenSeq: Int
    var runs: [RunRow]
    var items: [ThreadItem]
    var pending: [PendingRequest]
    var background: [BackgroundWork]
    var native: NativeThread?

    static let empty = ThreadSnapshot(lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: nil)
}

/// The agent bridge's events (image/agent-bridge/src/events.ts). A type this app does not know decodes to
/// `.unknown`, which the thread shows as a notice (as the dashboard does), never silently dropped.
enum BridgeEvent: Decodable, Equatable {
    case threadNative(harness: String, nativeThreadId: String, account: String?, model: String?)
    case runQueued(runId: String, text: String, attachments: [String], origin: RunOrigin?)
    case runStarted(runId: String, origin: RunOrigin, nativeThreadId: String?, model: String?)
    case messageDelta(runId: String, itemId: String, text: String)
    case messageFinal(runId: String, itemId: String, role: String, text: String, attachments: [String]?)
    case toolStarted(runId: String, itemId: String, tool: String, input: JSONValue?)
    case toolFinished(runId: String, itemId: String, isError: Bool, output: String)
    case requestOpened(runId: String, requestId: String, kind: RequestKind, prompt: String, options: [RequestOption]?, multiSelect: Bool?)
    case requestResolved(requestId: String, answer: String?, by: String)
    case backgroundChanged(work: [BackgroundWork])
    case runCompleted(runId: String, nativeThreadId: String, usage: TokenUsage?)
    case runInterrupted(runId: String)
    case runFailed(runId: String, error: String, reason: String?)
    case bridgeStarted(version: String, resumed: Bool)
    case unknown(type: String)

    private enum K: String, CodingKey {
        case type, harness, nativeThreadId, account, model, runId, text, attachments, origin, itemId, role, tool, input
        case isError, output, requestId, kind, prompt, options, multiSelect, answer, by, work, usage, error, reason, version, resumed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        func s(_ k: K) throws -> String { try c.decode(String.self, forKey: k) }
        func o(_ k: K) throws -> String? { try c.decodeIfPresent(String.self, forKey: k) }
        switch type {
        case "thread.native":
            self = .threadNative(harness: try s(.harness), nativeThreadId: try s(.nativeThreadId), account: try o(.account), model: try o(.model))
        case "run.queued":
            self = .runQueued(runId: try s(.runId), text: try s(.text), attachments: try c.decode([String].self, forKey: .attachments),
                              origin: try c.decodeIfPresent(RunOrigin.self, forKey: .origin))
        case "run.started":
            self = .runStarted(runId: try s(.runId), origin: try c.decode(RunOrigin.self, forKey: .origin), nativeThreadId: try o(.nativeThreadId), model: try o(.model))
        case "message.delta":
            self = .messageDelta(runId: try s(.runId), itemId: try s(.itemId), text: try s(.text))
        case "message.final":
            self = .messageFinal(runId: try s(.runId), itemId: try s(.itemId), role: try s(.role), text: try s(.text),
                                 attachments: try c.decodeIfPresent([String].self, forKey: .attachments))
        case "tool.started":
            self = .toolStarted(runId: try s(.runId), itemId: try s(.itemId), tool: try s(.tool),
                                input: c.contains(.input) ? try c.decode(JSONValue.self, forKey: .input) : nil)
        case "tool.finished":
            self = .toolFinished(runId: try s(.runId), itemId: try s(.itemId), isError: try c.decode(Bool.self, forKey: .isError), output: try s(.output))
        case "request.opened":
            self = .requestOpened(runId: try s(.runId), requestId: try s(.requestId), kind: try c.decode(RequestKind.self, forKey: .kind), prompt: try s(.prompt),
                                  options: try c.decodeIfPresent([RequestOption].self, forKey: .options), multiSelect: try c.decodeIfPresent(Bool.self, forKey: .multiSelect))
        case "request.resolved":
            self = .requestResolved(requestId: try s(.requestId), answer: try o(.answer), by: try s(.by))
        case "background.changed":
            self = .backgroundChanged(work: try c.decode([BackgroundWork].self, forKey: .work))
        case "run.completed":
            self = .runCompleted(runId: try s(.runId), nativeThreadId: try s(.nativeThreadId), usage: try c.decodeIfPresent(TokenUsage.self, forKey: .usage))
        case "run.interrupted":
            self = .runInterrupted(runId: try s(.runId))
        case "run.failed":
            self = .runFailed(runId: try s(.runId), error: try s(.error), reason: try o(.reason))
        case "bridge.started":
            self = .bridgeStarted(version: try s(.version), resumed: try c.decode(Bool.self, forKey: .resumed))
        default:
            self = .unknown(type: type)
        }
    }
}

struct LoggedEvent: Decodable, Equatable {
    let seq: Int
    let ts: Int
    let event: BridgeEvent
}

/// SSE `thread-snapshot` (and `GET /thread?afterSeq=`): every item and run changed after `afterSeq`.
struct ThreadSnapshotFrame: Decodable {
    let afterSeq: Int
    let snapshot: ThreadSnapshot
}

/// The inbox's sections; `settled` and `snoozed` are shelves (devd/src/sessionAttention.ts).
enum InboxSection: String, Decodable {
    case needsYou = "needs_you"
    case working, idle, settled, snoozed
}

enum AttentionReason: String, Decodable {
    case request, failed, completed, disconnected, running, background, queued
    case rateLimited = "rate-limited"
    case bridgeBehind = "bridge-behind"
    case prChecks = "pr-checks"
    case ciFailed = "ci-failed"
}

struct Attention: Decodable, Equatable {
    let section: InboxSection
    let reason: AttentionReason?
    /// When that state began (epoch ms; 0 = nothing happened yet).
    let since: Int
    /// Snoozed only: when the snooze ends (epoch ms).
    let until: Int?
}

/// One session in the inbox (`GET /api/inbox`, SSE `inbox`).
struct InboxItem: Decodable, Equatable, Identifiable {
    enum Runtime: String, Decodable { case tmux, chat }

    let sessionId: String
    let runtime: Runtime
    let title: String
    let project: String
    let repo: String
    let agent: String
    let attention: Attention
    /// Newest user or assistant message of a chat session, clipped; nil for tmux sessions and empty threads.
    let lastText: String?

    var id: String { sessionId }
}

/// SSE `inbox` frame: a session's current item, or `{sessionId, removed: true}` when it left the inbox.
enum InboxChange: Decodable, Equatable {
    case item(InboxItem)
    case removed(sessionId: String)

    private enum K: String, CodingKey { case sessionId, removed }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if c.contains(.removed) {
            self = .removed(sessionId: try c.decode(String.self, forKey: .sessionId))
        } else {
            self = .item(try InboxItem(from: decoder))
        }
    }
}

struct InboxList: Decodable {
    let items: [InboxItem]
}

/// `GET /api/sessions/:id/snooze-reset`: when the active usage limit resets, or why "until reset" is not possible.
enum SnoozeReset: Decodable, Equatable {
    case resetsAt(Int)
    case reason(String)

    private enum K: String, CodingKey { case resetsAt, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if let at = try c.decodeIfPresent(Int.self, forKey: .resetsAt) { self = .resetsAt(at) }
        else { self = .reason(try c.decode(String.self, forKey: .reason)) }
    }
}

/// `POST /api/sessions/:id/inbox?for=thread`: the image's container path, sent with the message.
struct ThreadUpload: Decodable {
    let path: String
    let size: Int
}
