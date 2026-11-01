import Foundation

/// View-model for `SubscriptionsScreen` — 1:1 basis from `dashboard/src/pages/Subscriptions.tsx`.
/// Disable/Enable of an Anthropic account (H0 fix pack) is the only mutating action wired here — on the web it has
/// a direct 1:1 POST path bound to a specific account (`setAccountDisabled`). Preferred/replace-credentials/
/// per-account switch are DELIBERATELY web-only — see ruling H0:
///  - "Prefer/Unprefer" would only be possible via `PUT /api/config` (read-modify-write of the WHOLE config,
///    `pool.preferredAccountId`, see the Settings.tsx dropdown) — a footgun on mobile (risk of diverging
///    from a parallel config edit on the web) and a rarely changed policy that belongs in web Settings.
///  - "Switch to this account" for a SPECIFIC account has no server-side equivalent — web `switchAccount`
///    is SESSION-scoped (it takes no accountId, it only tells the devd policy "move this session to whatever
///    is best", see `Sessions.tsx`) and the app already has a session-scoped switch account (`SessionDetailView`/
///    `SessionActions.swift`).
///  - Replace credentials stays web-only (editing a JSON blob on mobile, see the task brief).
/// Fetch-on-appear + pull-to-refresh, no polling (the web also loads the cards only on entering the
/// page, no shared store like `LiveStore`).
@MainActor
final class SubscriptionsStore: ObservableObject {
    /// State of one "optional" card (Codex/Grok) after a poll — 1:1 `SubCardState<T>`/`subCardState`
    /// from `dashboard/src/subscriptionsView.ts`: 404 (older devd without the route) silently hides the card,
    /// anything else stays visible as an error and the last known value SURVIVES (is not overwritten).
    struct CardState<T> {
        /// `.loading` = has never successfully arrived yet (corresponds to `undefined` on the web).
        /// `.value(nil)` = the server successfully replied "not configured" (web `null`).
        enum Phase {
            case loading
            case value(T?)
        }
        var phase: Phase = .loading
        var hidden = false
        var fetchErr: String?

        /// The section is not rendered in the UI at all while `hidden`, or while we know for sure the card
        /// is not configured (successful poll with a `nil` value and no error) — mirrors
        /// `if (hidden) return null;` / `if (fetchErr === null && codex === null) return null;`.
        var visible: Bool {
            if hidden { return false }
            if case .value(let v) = phase, v == nil, fetchErr == nil { return false }
            return true
        }
    }

    enum PollOutcome<T> {
        case ok(T?)
        case failure(Error)
    }

    @Published private(set) var accounts: [AccountView]?
    @Published private(set) var pool: AccountPoolView?
    /// 503 = the account pool is not configured in this devd — the whole section is hidden, not shown as an error.
    @Published private(set) var accountsPoolOff = false
    @Published private(set) var accountsError: String?

    @Published private(set) var codex = CardState<CodexSubscriptionView>()
    @Published private(set) var grok = CardState<GrokSubscriptionView>()

    @Published private(set) var openrouter: OpenrouterView?
    /// Any error (including 503 "OpenRouter not wired") silently hides the card — mirrors
    /// `.catch(() => setAbsent(true))` in `OpenrouterCard`, which does not distinguish between causes.
    @Published private(set) var openrouterAbsent = false

    private let client: DevdClient

    init(client: DevdClient) {
        self.client = client
    }

    func load() async {
        async let a: Void = loadAccounts()
        async let c: Void = loadCodex()
        async let g: Void = loadGrok()
        async let o: Void = loadOpenrouter()
        _ = await (a, c, g, o)
    }

    private struct SetAccountDisabledBody: Encodable { let disabled: Bool }

    /// Mirrors web `toggleAccount` — POST `/api/accounts/:id/disable` (exact path from
    /// `dashboard/src/api.ts` `setAccountDisabled`), then refetch the list so the card shows the
    /// new state right away. The error bubbles up to the caller (`SubscriptionsScreen`), same pattern as
    /// `ProdWritesStore.approve`/`CronStore` actions — the Screen holds `busyId`/`actionError`.
    func setDisabled(_ account: AccountView, disabled: Bool) async throws {
        try await client.postVoid("/api/accounts/\(account.id)/disable", body: SetAccountDisabledBody(disabled: disabled))
        await loadAccounts()
    }

    // MARK: - Pure: Anthropic accounts (1:1 `dashboard/src/accountsView.ts`)

    enum Severity: Equatable { case ok, warn, danger }

    nonisolated static let defaultThresholdPct: Double = 90
    private nonisolated static let warnBand: Double = 20

    /// Mirrors `usageSeverity`.
    nonisolated static func usageSeverity(_ pct: Double?, thresholdPct: Double = defaultThresholdPct) -> Severity {
        guard let pct else { return .ok }
        if pct >= thresholdPct { return .danger }
        if pct >= thresholdPct - warnBand { return .warn }
        return .ok
    }

    /// Mirrors `resetCountdown`.
    nonisolated static func resetCountdown(_ resetsAt: Int?, now: Date) -> String {
        guard let resetsAt else { return "—" }
        let ms = Double(resetsAt) - now.timeIntervalSince1970 * 1000
        if ms <= 0 { return "reset due" }
        let minutes = Int(ms / 60_000)
        if minutes < 60 { return "resets in \(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "resets in \(hours)h \(minutes % 60)m" }
        return "resets in \(hours / 24)d \(hours % 24)h"
    }

    /// Mirrors `measuredLabel` — `Format.agoLabel` is from another task, but ONLY CALLING the existing
    /// static function (not editing `Format.swift`) is fine.
    nonisolated static func measuredLabel(_ fetchedAt: Int?, now: Date) -> String {
        guard let fetchedAt else { return "never measured" }
        let ms = now.timeIntervalSince1970 * 1000 - Double(fetchedAt)
        return ms < 60_000 ? "measured just now" : "measured \(Format.agoLabel(ms))"
    }

    private nonisolated static let transientRateLimitPolls = 5

    private nonisolated static func transientRateLimit(_ error: String?, _ errorCount: Int?) -> Bool {
        guard let error, error.contains("HTTP 429") else { return false }
        return (errorCount ?? 0) < transientRateLimitPolls
    }

    struct UsageErrorView { let text: String; let transient: Bool }

    /// Mirrors `usageErrorView`.
    nonisolated static func usageErrorView(_ error: String?, _ errorCount: Int?) -> UsageErrorView? {
        guard let error else { return nil }
        if transientRateLimit(error, errorCount) {
            return UsageErrorView(
                text: "Rate-limited by Anthropic — retrying automatically; showing last known usage.",
                transient: true
            )
        }
        return UsageErrorView(text: error, transient: false)
    }

    /// Mirrors `accountStatus`.
    nonisolated static func accountStatus(_ a: AccountView, thresholdPct: Double = defaultThresholdPct) -> (text: String, tone: Severity) {
        if a.quarantined { return ("Re-login needed", .danger) }
        if a.disabled { return ("Disabled", .warn) }
        if let error = a.error, !transientRateLimit(error, a.errorCount) { return ("Usage unavailable", .warn) }
        let spent = (a.fiveHourPct ?? 0) >= thresholdPct || (a.sevenDayPct ?? 0) >= thresholdPct
        if spent { return ("Exhausted", .danger) }
        return ("Active", .ok)
    }

    /// Mirrors `splitTierLabel` (regex `/^(.*\S)\s+\((Max \d+x)\)$/`).
    nonisolated static func splitTierLabel(_ label: String) -> (name: String, tier: String?) {
        guard let regex = try? NSRegularExpression(pattern: #"^(.*\S)\s+\((Max \d+x)\)$"#) else { return (label, nil) }
        let range = NSRange(label.startIndex..., in: label)
        guard let match = regex.firstMatch(in: label, range: range),
              let nameRange = Range(match.range(at: 1), in: label),
              let tierRange = Range(match.range(at: 2), in: label)
        else { return (label, nil) }
        return (String(label[nameRange]), String(label[tierRange]))
    }

    enum PoolRole: Hashable { case preferred, spilling, backup }

    nonisolated static let poolRoleLabel: [PoolRole: String] = [.preferred: "PREFERRED", .spilling: "SPILLING OVER", .backup: "BACKUP"]

    /// Mirrors `effPct`: once the reset has passed, the stored percentage is invalid, the window restarted from zero.
    private nonisolated static func effPct(_ pct: Double?, _ resetsAt: Int?, now: Date) -> Double {
        guard let pct else { return 0 }
        if let resetsAt, Double(resetsAt) <= now.timeIntervalSince1970 * 1000 { return 0 }
        return pct
    }

    /// Mirrors `poolRole`.
    nonisolated static func poolRole(_ a: AccountView, _ pool: AccountPoolView, now: Date) -> PoolRole? {
        guard pool.soloAccountId == nil else { return nil }
        guard let preferred = pool.preferredAccountId else { return nil }
        guard a.id == preferred else { return .backup }
        let over = effPct(a.fiveHourPct, a.fiveHourResetsAt, now: now) >= pool.spilloverPct
            || effPct(a.sevenDayPct, a.sevenDayResetsAt, now: now) >= pool.spilloverPct
        return over ? .spilling : .preferred
    }

    /// Mirrors `pinnedProjects` — projects pinned to the given account, alphabetical (the key order of the
    /// `projectAccounts` object is not guaranteed, so the badge on the card must not shuffle between
    /// loads).
    nonisolated static func pinnedProjects(_ accountId: String, _ pool: AccountPoolView) -> [String] {
        pool.projectAccounts
            .filter { $0.value == accountId }
            .map { $0.key }
            .sorted()
    }

    private nonisolated static let clientLabel: [AccountLeaseView.Client: String] = [.mac: "Mac", .devbox: "Devbox"]

    /// Mirrors `leaseSummary`.
    nonisolated static func leaseSummary(_ a: AccountView) -> String {
        guard !a.leases.isEmpty else { return "idle" }
        return a.leases.map { lease -> String in
            let client = clientLabel[lease.client] ?? lease.client.rawValue
            if let label = lease.label, !label.isEmpty { return "\(client) · \(label)" }
            return client
        }.joined(separator: ", ")
    }

    /// Mirrors `modelRows` — only windows with a model, sorted from the most utilized.
    nonisolated static func modelRows(_ a: AccountView) -> [(model: String, percent: Double?)] {
        a.limits
            .compactMap { limit -> (model: String, percent: Double?)? in
                guard let model = limit.modelName else { return nil }
                return (model, limit.percent)
            }
            .sorted { ($0.percent ?? 0) > ($1.percent ?? 0) }
    }

    // MARK: - Pure: Codex/Grok (1:1 `dashboard/src/subscriptionsView.ts`)

    /// Mirrors the shared `stateBadge` — the rule "an unknown state must not fall through to Active" applies
    /// to both cards (Codex and Grok) in one place. Only Codex sends `limitReached`.
    nonisolated static func stateBadge(_ state: SubscriptionState, limitReached: String? = nil) -> (text: String, tone: Severity) {
        if state == .signedOut { return ("Not signed in", .warn) }
        if state == .staleLogin { return ("Stale login", .warn) }
        if state == .error { return ("Usage unavailable", .warn) }
        if limitReached != nil { return ("Limit reached", .danger) }
        if state == .ok { return ("Active", .ok) }
        return ("Unknown status", .warn)
    }

    /// Mirrors `codexWindowLabel`.
    nonisolated static func codexWindowLabel(_ windowMinutes: Int?) -> String {
        guard let windowMinutes, windowMinutes > 0 else { return "—" }
        if windowMinutes % 1440 == 0 { return "\(windowMinutes / 1440)d" }
        if windowMinutes % 60 == 0 { return "\(windowMinutes / 60)h" }
        return "\(windowMinutes)m"
    }

    private nonisolated static let codeHints: [(match: String, text: String)] = [
        ("deactivated_workspace", "the ChatGPT workspace behind this login is deactivated"),
        ("unknown-shape", "the API answered in an unexpected shape — devd needs updating"),
    ]

    /// Mirrors `usageErrorText` — the literal code stays visible next to the translated hint (#9: no
    /// doubled parentheses, so the code goes after a colon, not in another pair of parentheses).
    nonisolated static func usageErrorText(_ error: String?) -> String {
        let raw = error ?? "unknown error"
        if let hint = codeHints.first(where: { raw.contains($0.match) }) {
            return "\(hint.text): \(raw)"
        }
        return "Couldn't read usage: \(raw)"
    }

    /// Mirrors `codexIssue`.
    nonisolated static func codexIssue(_ c: CodexSubscriptionView) -> String? {
        if c.state == .signedOut { return "Not signed in — run `codex login` in the devbox." }
        if c.state == .staleLogin { return "The stored token expired — run `codex login` in the devbox." }
        if c.state == .error { return usageErrorText(c.error) }
        if let limitReached = c.limitReached {
            return "Codex plan limit reached: \(limitReached). It resets automatically — no action needed."
        }
        return nil
    }

    /// Mirrors `grokIssue` — Grok is signed in from Settings, not by a command in the devbox.
    nonisolated static func grokIssue(_ g: GrokSubscriptionView) -> String? {
        if g.state == .signedOut { return "Not signed in — use Log in with Grok in Settings." }
        if g.state == .staleLogin { return "The stored token expired — log in with Grok again in Settings." }
        if g.state == .error { return usageErrorText(g.error) }
        return nil
    }

    /// Mirrors `subCardState` — one generic reduction shared by Codex and Grok.
    nonisolated static func reduce<T>(_ prev: CardState<T>, _ outcome: PollOutcome<T>) -> CardState<T> {
        switch outcome {
        case .ok(let value):
            return CardState(phase: .value(value), hidden: false, fetchErr: nil)
        case .failure(let error):
            if let httpError = error as? DevdHTTPError, httpError.statusCode == 404 {
                return CardState(phase: prev.phase, hidden: true, fetchErr: nil)
            }
            return CardState(phase: prev.phase, hidden: false, fetchErr: errorText(error))
        }
    }

    // MARK: - Pure: OpenRouter (1:1 `dashboard/src/openrouterView.ts`, only the status part — the app
    // does not edit the key/model, see the task brief)

    /// Mirrors `openrouterStatus`.
    nonisolated static func openrouterStatus(_ v: OpenrouterView?) -> (text: String, tone: Severity) {
        guard let v else { return ("Loading…", .warn) }
        if !v.hasKey { return ("Not connected", .warn) }
        if v.model == nil || v.model?.isEmpty == true { return ("No model set", .warn) }
        return ("Active", .ok)
    }

    // MARK: - Private

    private func loadAccounts() async {
        do {
            let resp: AccountsResponse = try await client.get("/api/accounts")
            accounts = resp.accounts
            pool = resp.pool
            accountsPoolOff = false
            accountsError = nil
        } catch {
            if let httpError = error as? DevdHTTPError, httpError.statusCode == 503 {
                accountsPoolOff = true
            } else {
                accountsError = errorText(error)
            }
        }
    }

    private func loadCodex() async {
        do {
            let resp: CodexSubscriptionResponse = try await client.get("/api/subscriptions/codex")
            codex = Self.reduce(codex, .ok(resp.codex))
        } catch {
            codex = Self.reduce(codex, .failure(error))
        }
    }

    private func loadGrok() async {
        do {
            let resp: GrokSubscriptionResponse = try await client.get("/api/subscriptions/grok")
            grok = Self.reduce(grok, .ok(resp.grok))
        } catch {
            grok = Self.reduce(grok, .failure(error))
        }
    }

    /// Any error silently hides the card — mirrors the web (no distinction between 503 and another error for
    /// OpenRouter, unlike Codex/Grok).
    private func loadOpenrouter() async {
        do {
            openrouter = try await client.get("/api/openrouter")
            openrouterAbsent = false
        } catch {
            openrouterAbsent = true
        }
    }

}
