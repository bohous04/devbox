import Foundation

/// View-model for `SshApprovalsScreen` — mirrors `dashboard/src/pages/SshApprovals.tsx`.
/// Polls every second (not every five like `ProdWritesStore`): a request lives 90 s and the countdown on
/// screen must be truthful.
@MainActor
final class SshApprovalsStore: ObservableObject {
    @Published private(set) var rows: [SshApproval]?
    @Published private(set) var grants: [SshApproval] = []
    /// Three-state on purpose (1:1 `GateState` from `dashboard/src/pages/SshApprovals.tsx`):
    /// `.disabled` is a truthful report of a disabled gate, `.unknown` is NOT the same as `.enabled`.
    /// If the default/failure fell back to `.enabled`, a persistent outage of just `/api/ssh-gate`
    /// (version skew during a rolling devd restart, an isolated route error — while approvals/grants
    /// keep working) would hide the banner forever — false reassurance about a security feature, worse than
    /// an unnecessary warning. Default `.unknown`, not `.enabled`: at startup the app knows nothing for sure.
    enum GateState: Equatable { case enabled, disabled, unknown }
    @Published private(set) var gate: GateState = .unknown
    /// Error from `load()` (background, poll) — action errors from `approve`/`deny` are NOT stored here
    /// (see `decide`), otherwise the next successful poll would immediately overwrite them with nil before
    /// the user had a chance to see them. They propagate out of the call and `SshApprovalsScreen` handles them.
    @Published private(set) var error: String?

    private let client: DevdClient
    private let pollInterval: Duration
    /// Face ID (or passcode) BEFORE every approval — holding the phone must not be enough for an
    /// agent to get an SSH key. Denial does not go through the gate: rejecting is always safe.
    private let biometrics: BiometricGate
    private var pollTask: Task<Void, Never>?

    init(client: DevdClient, pollInterval: Duration = .seconds(1), biometrics: BiometricGate = LocalAuthGate()) {
        self.client = client
        self.pollInterval = pollInterval
        self.biometrics = biometrics
    }

    nonisolated static func pending(_ rows: [SshApproval]) -> [SshApproval] {
        rows.filter { $0.status == "pending" }
    }

    nonisolated static func secondsLeft(_ row: SshApproval, now: Double) -> Int {
        max(0, Int(((row.expires_at - now) / 1000).rounded(.up)))
    }

    /// Remaining minutes of an active grant — `grant_until ?? 0` same as the web (`SshApprovals.tsx`):
    /// a grant without `grant_until` would compute as a huge negative remainder, `max(0, …)` clamps it
    /// to zero just like a normal expiry.
    nonisolated static func minutesLeft(_ row: SshApproval, now: Double) -> Int {
        max(0, Int((((row.grant_until ?? 0) - now) / 60_000).rounded(.up)))
    }

    /// Idempotent — a second call without `stop()` does not double the polling.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.load()
                if Task.isCancelled { return }
                try? await Task.sleep(for: self.pollInterval)
            }
        }
    }

    func stop() { pollTask?.cancel(); pollTask = nil }
    deinit { pollTask?.cancel() }

    /// `async let` + `Result`, not sequential `try await`: if one call fails, the others are
    /// still applied, same pattern as `OverviewStore.load()`. The gate fetch is NOT in the
    /// `errorMessage` chain below — its failure goes to `gate = .unknown` (its own banner),
    /// not to the generic `error` section, otherwise the app would report "Error: …" even though rows/grants
    /// arrived fine (same fix as web `SshApprovals.tsx`).
    func load() async {
        async let rowsResult: Result<[SshApproval], Error> = fetchResult("/api/ssh-approvals")
        async let grantsResult: Result<[SshApproval], Error> = fetchResult("/api/ssh-grants")
        async let gateResult: Result<SshGate, Error> = fetchResult("/api/ssh-gate")
        let (r, g, gateR) = await (rowsResult, grantsResult, gateResult)

        var errorMessage: String?
        switch r {
        case .success(let value): rows = value
        case .failure(let error): errorMessage = errorText(error)
        }
        switch g {
        case .success(let value): grants = value
        case .failure(let error): errorMessage = errorMessage ?? errorText(error)
        }
        switch gateR {
        case .success(let value): gate = value.enabled ? .enabled : .disabled
        case .failure: gate = .unknown
        }
        error = errorMessage
    }

    private func fetchResult<T: Decodable>(_ path: String) async -> Result<T, Error> {
        do {
            return .success(try await client.get(path))
        } catch {
            return .failure(error)
        }
    }

    /// Approval duration choice from the UI — 1:1 web `<select>` (`SshApprovals.tsx`): a preset in minutes,
    /// one-time approval (0 min) or forever (`grantPermanent: true` + 0 min).
    enum GrantChoice: Equatable {
        case once
        case minutes(Int)
        case permanent
    }

    /// Same presets as web `GRANT_MINUTE_PRESETS` (`sshApprovalsView.ts`): 10 min, 1 h, 4 h,
    /// 8 h, 12 h, 16 h.
    static let grantPresets = [10, 60, 240, 480, 720, 960]

    /// `grantPermanent` is encoded only for `.permanent` — the synthesized `Encodable` for an Optional
    /// property calls `encodeIfPresent`, so `nil` (default) omits the key from the JSON entirely; the server
    /// (`parseGrantDuration`) would reject a non-zero `grantMinutes` together with `grantPermanent: true`.
    struct Decision: Encodable {
        let by: String
        let grantMinutes: Int
        let grantPermanent: Bool?

        init(by: String, grantMinutes: Int, grantPermanent: Bool? = nil) {
            self.by = by
            self.grantMinutes = grantMinutes
            self.grantPermanent = grantPermanent
        }
    }

    private static func decisionParams(_ choice: GrantChoice) -> (minutes: Int, permanent: Bool?) {
        switch choice {
        case .once: return (0, nil)
        case .minutes(let minutes): return (minutes, nil)
        case .permanent: return (0, true)
        }
    }

    /// Text in the Face ID dialog — in English (system dialog, same language as the rest of the app
    /// outside this screen). It says WHICH key and FOR WHOM, so approval happens with eyes open;
    /// the row can disappear between the poll and the tap, then a generic reason instead of an empty one.
    nonisolated static func approveReason(_ row: SshApproval?, choice: GrantChoice) -> String {
        let duration: String
        switch choice {
        case .once: duration = "once"
        case .minutes(let minutes): duration = "\(minutes) min"
        case .permanent: duration = "permanently"
        }
        guard let row else { return "Approve SSH key request (\(duration))" }
        let target = row.project.flatMap { p in row.repo.map { "\(p)/\($0)" } } ?? row.session_id ?? "the agent"
        return "Approve SSH key “\(row.title)” for \(target) (\(duration))"
    }

    /// Target line for a request or a live grant — 1:1 `sshTargetLabel` from `sshApprovalsView.ts`: known
    /// server + normalized target, a target with no match in the config, or no target at all.
    nonisolated static func targetLabel(_ row: SshApproval) -> String {
        if let server = row.server { return "\(server) · \(row.target ?? "")" }
        if let target = row.target { return "unknown server: \(target)" }
        return "no target"
    }

    /// Time remaining on a live grant ("9 min left", "2 h 30 min left"). `grant_permanent == 1` wins over
    /// the computed minutes, even if `grant_until` for some reason is not in the future.
    nonisolated static func grantLabel(_ row: SshApproval, now: Date) -> String {
        if row.grant_permanent == 1 { return "Forever" }
        let minutes = minutesLeft(row, now: now.timeIntervalSince1970 * 1000)
        guard minutes >= 60 else { return "\(minutes) min left" }
        return "\(minutes / 60) h \(minutes % 60) min left"
    }

    /// `throws`, not swallowing into `error` — `SshApprovalsScreen.performAction` catches the result itself
    /// (same `busyId`/`actionError` pattern as `ProdWritesScreen`) and distinguishes 409 (mac/dashboard
    /// decided first — a normal lost race, not an error) from a real error.
    ///
    /// Order matters: biometrics BEFORE the POST. A cancelled or failed prompt throws
    /// `BiometricError` and nothing is sent to devd — the screen suppresses `cancelled`, shows the rest.
    func approve(id: String, choice: GrantChoice) async throws {
        try await biometrics.confirm(reason: Self.approveReason(rows?.first { $0.id == id }, choice: choice))
        let (minutes, permanent) = Self.decisionParams(choice)
        try await decide(path: "/api/ssh-approvals/\(id)/approve", body: Decision(by: "ios", grantMinutes: minutes, grantPermanent: permanent))
    }

    func deny(id: String) async throws {
        try await decide(path: "/api/ssh-approvals/\(id)/deny", body: Decision(by: "ios", grantMinutes: 0))
    }

    /// Revoking a live grant — WITHOUT biometrics (see `SshApprovalsScreen`, confirmed by a dialog
    /// instead of Face ID: holding the phone does not hand the agent a key, revoking only removes access that
    /// a human with the same phone already approved once).
    func revoke(grantId: String) async throws {
        try await reloadingOnCompletion { try await self.client.deleteVoid("/api/ssh-grants/\(grantId)") }
    }

    /// Always reloads — whether the action succeeds or not (same `finally` pattern as web `act()`):
    /// if the request fails, the next poll still shows the current state (typically who decided first).
    private func decide(path: String, body: Decision) async throws {
        try await reloadingOnCompletion { try await self.client.postVoid(path, body: body) }
    }

    private func reloadingOnCompletion(_ operation: () async throws -> Void) async throws {
        do {
            try await operation()
            await load()
        } catch {
            await load()
            throw error
        }
    }
}
