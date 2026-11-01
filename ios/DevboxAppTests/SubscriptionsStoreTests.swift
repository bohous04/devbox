import XCTest
@testable import DevboxApp

/// Pure functions of `SubscriptionsStore` — inputs/outputs copied from
/// `dashboard/src/accountsView.test.ts`, `dashboard/src/subscriptionsView.test.ts` and
/// `dashboard/src/openrouterView.test.ts`.
final class SubscriptionsStoreTests: XCTestCase {
    private static let now = 1_800_000_000_000
    private static let min = 60_000
    private static let nowDate = Date(timeIntervalSince1970: Double(now) / 1000)

    private func acc(
        id: String = "primary", label: String = "a@x.cz", disabled: Bool = false, quarantined: Bool = false,
        fiveHourPct: Double? = 20, fiveHourResetsAt: Int? = now + 30 * min,
        sevenDayPct: Double? = 30, sevenDayResetsAt: Int? = now + 2000 * min,
        limits: [UsageLimit] = [], fetchedAt: Int? = now - min, error: String? = nil, errorCount: Int = 0,
        orgId: String? = nil, observedOrgId: String? = nil, leases: [AccountLeaseView] = []
    ) -> AccountView {
        AccountView(
            id: id, label: label, disabled: disabled, quarantined: quarantined,
            fiveHourPct: fiveHourPct, fiveHourResetsAt: fiveHourResetsAt,
            sevenDayPct: sevenDayPct, sevenDayResetsAt: sevenDayResetsAt,
            limits: limits, fetchedAt: fetchedAt, error: error, errorCount: errorCount,
            orgId: orgId, observedOrgId: observedOrgId, leases: leases
        )
    }

    private func pool(
        thresholdPct: Double = 90, spilloverPct: Double = 60, preferredAccountId: String? = "max20",
        projectAccounts: [String: String] = [:], soloAccountId: String? = nil
    ) -> AccountPoolView {
        AccountPoolView(
            thresholdPct: thresholdPct, spilloverPct: spilloverPct, preferredAccountId: preferredAccountId,
            projectAccounts: projectAccounts, soloAccountId: soloAccountId
        )
    }

    // MARK: - usageSeverity

    func testUsageSeverityThresholdIsDangerTwentyPointsBelowIsWarn() {
        XCTAssertEqual(SubscriptionsStore.usageSeverity(0), .ok)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(69), .ok)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(70), .warn)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(89.9), .warn)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(90), .danger)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(100), .danger)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(nil), .ok)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(80, thresholdPct: 80), .danger)
        XCTAssertEqual(SubscriptionsStore.usageSeverity(65, thresholdPct: 80), .warn)
    }

    // MARK: - resetCountdown

    func testResetCountdown() {
        let now = Self.now
        let min = Self.min
        let nowDate = Self.nowDate
        XCTAssertEqual(SubscriptionsStore.resetCountdown(now + 45 * min, now: nowDate), "resets in 45m")
        XCTAssertEqual(SubscriptionsStore.resetCountdown(now + 150 * min, now: nowDate), "resets in 2h 30m")
        XCTAssertEqual(SubscriptionsStore.resetCountdown(now + 3000 * min, now: nowDate), "resets in 2d 2h")
        XCTAssertEqual(SubscriptionsStore.resetCountdown(now - min, now: nowDate), "reset due")
        XCTAssertEqual(SubscriptionsStore.resetCountdown(nil, now: nowDate), "—")
    }

    // MARK: - accountStatus

    func testAccountStatusQuarantineAndErrorOverrideEverything() {
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc()).text, "Active")
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(disabled: true)).text, "Disabled")
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(quarantined: true)).text, "Re-login needed")
        // quarantine wins even over disabled
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(disabled: true, quarantined: true)).text, "Re-login needed")
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(error: "quota read failed: HTTP 500")).text, "Usage unavailable")
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(fiveHourPct: 95)).text, "Exhausted")
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(sevenDayPct: 91)).text, "Exhausted")
    }

    func testAccountStatusTransient429LeavesBadgeOnLastKnownNumbers() {
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(error: "quota read failed: HTTP 429", errorCount: 1)).text, "Active")
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(fiveHourPct: 95, error: "quota read failed: HTTP 429", errorCount: 2)).text, "Exhausted")
        // a persistent 429 (≥ 5 polls in a row) IS an outage
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(error: "quota read failed: HTTP 429", errorCount: 5)).text, "Usage unavailable")
        // any other error is "Usage unavailable" right away
        XCTAssertEqual(SubscriptionsStore.accountStatus(acc(error: "quota read failed: HTTP 503", errorCount: 1)).text, "Usage unavailable")
    }

    // MARK: - usageErrorView

    func testUsageErrorViewTransient429IsQuietSentence() {
        XCTAssertNil(SubscriptionsStore.usageErrorView(nil, 0))
        let transient = SubscriptionsStore.usageErrorView("quota read failed: HTTP 429", 1)!
        XCTAssertTrue(transient.transient)
        XCTAssertTrue(transient.text.contains("retrying"))
        let persistent = SubscriptionsStore.usageErrorView("quota read failed: HTTP 429", 5)!
        XCTAssertFalse(persistent.transient)
        XCTAssertEqual(persistent.text, "quota read failed: HTTP 429")
        let other = SubscriptionsStore.usageErrorView("profile cannot be read", 1)!
        XCTAssertFalse(other.transient)
        XCTAssertEqual(other.text, "profile cannot be read")
    }

    // MARK: - leaseSummary

    func testLeaseSummary() {
        XCTAssertEqual(SubscriptionsStore.leaseSummary(acc()), "idle")
        XCTAssertEqual(
            SubscriptionsStore.leaseSummary(acc(leases: [AccountLeaseView(client: .mac, sessionId: nil, label: "vpsbetter", createdAt: Self.now)])),
            "Mac · vpsbetter"
        )
        XCTAssertEqual(
            SubscriptionsStore.leaseSummary(acc(leases: [
                AccountLeaseView(client: .devbox, sessionId: "dev-x-y", label: "x/y", createdAt: Self.now),
                AccountLeaseView(client: .mac, sessionId: nil, label: nil, createdAt: Self.now),
            ])),
            "Devbox · x/y, Mac"
        )
    }

    // MARK: - modelRows

    func testModelRowsOnlyPerModelWindowsSortedDescending() {
        let a = acc(limits: [
            UsageLimit(kind: "session", percent: 20, severity: "ok", resetsAt: nil, modelName: nil, isActive: true),
            UsageLimit(kind: "weekly_scoped", percent: 5, severity: "ok", resetsAt: nil, modelName: "Fable", isActive: true),
            UsageLimit(kind: "weekly_scoped", percent: 60, severity: "warn", resetsAt: nil, modelName: "Opus", isActive: true),
            UsageLimit(kind: "weekly_scoped", percent: 1, severity: "ok", resetsAt: nil, modelName: nil, isActive: true),
        ])
        let rows = SubscriptionsStore.modelRows(a)
        XCTAssertEqual(rows.map(\.model), ["Opus", "Fable"])
        XCTAssertEqual(rows.map(\.percent), [60, 5])
        XCTAssertTrue(SubscriptionsStore.modelRows(acc()).isEmpty)
    }

    // MARK: - splitTierLabel

    func testSplitTierLabel() {
        XCTAssertTrue(SubscriptionsStore.splitTierLabel("user@example.com (Max 20x)") == (name: "user@example.com", tier: "Max 20x"))
        XCTAssertTrue(SubscriptionsStore.splitTierLabel("team@example.com (Max 5x)") == (name: "team@example.com", tier: "Max 5x"))
        XCTAssertTrue(SubscriptionsStore.splitTierLabel("team@example.com") == (name: "team@example.com", tier: nil))
        // A parenthesis that is not a tier must not be cut off.
        XCTAssertTrue(SubscriptionsStore.splitTierLabel("team@example.com (work)") == (name: "team@example.com (work)", tier: nil))
    }

    // MARK: - poolRole

    func testPoolRoleWithoutPreferenceIsNil() {
        XCTAssertNil(SubscriptionsStore.poolRole(acc(id: "max20"), pool(preferredAccountId: nil), now: Self.nowDate))
    }

    func testPoolRolePreferredUnderThresholdIsPreferredOverIsSpilling() {
        XCTAssertEqual(SubscriptionsStore.poolRole(acc(id: "max20", fiveHourPct: 10, sevenDayPct: 10), pool(), now: Self.nowDate), .preferred)
        XCTAssertEqual(SubscriptionsStore.poolRole(acc(id: "max20", fiveHourPct: 60, sevenDayPct: 10), pool(), now: Self.nowDate), .spilling)
        // ONE window is enough.
        XCTAssertEqual(SubscriptionsStore.poolRole(acc(id: "max20", fiveHourPct: 10, sevenDayPct: 60), pool(), now: Self.nowDate), .spilling)
    }

    func testPoolRoleOtherAccountsAreBackup() {
        XCTAssertEqual(SubscriptionsStore.poolRole(acc(id: "max5", fiveHourPct: 0), pool(), now: Self.nowDate), .backup)
    }

    func testPoolRoleSoloModeSuppressesRole() {
        let solo = pool(preferredAccountId: "max20", soloAccountId: "max20")
        XCTAssertNil(SubscriptionsStore.poolRole(acc(id: "max20", fiveHourPct: 10, sevenDayPct: 10), solo, now: Self.nowDate))
        XCTAssertNil(SubscriptionsStore.poolRole(acc(id: "max5", fiveHourPct: 0), solo, now: Self.nowDate))
    }

    func testPoolRoleClosesSpillingAfterResetExpires() {
        // 99 % in the DB, but the reset already happened → the window is actually empty (effPct).
        let a = acc(id: "max20", fiveHourPct: 99, fiveHourResetsAt: Self.now - 1, sevenDayPct: 5)
        XCTAssertEqual(SubscriptionsStore.poolRole(a, pool(), now: Self.nowDate), .preferred)
    }

    func testPoolRoleLabelCoversAllRoles() {
        XCTAssertEqual(SubscriptionsStore.poolRoleLabel[.preferred], "PREFERRED")
        XCTAssertEqual(SubscriptionsStore.poolRoleLabel[.spilling], "SPILLING OVER")
        XCTAssertEqual(SubscriptionsStore.poolRoleLabel[.backup], "BACKUP")
    }

    // MARK: - pinnedProjects

    func testPinnedProjectsReturnsProjectsPinnedToAccountAlphabetically() {
        let p = pool(projectAccounts: ["websites": "max20", "games": "max5", "apps": "max20"])
        XCTAssertEqual(SubscriptionsStore.pinnedProjects("max20", p), ["apps", "websites"])
        XCTAssertEqual(SubscriptionsStore.pinnedProjects("max5", p), ["games"])
        XCTAssertEqual(SubscriptionsStore.pinnedProjects("neexistuje", p), [])
    }

    // MARK: - measuredLabel

    func testMeasuredLabelDistinguishesFreshFromStale() {
        let now = Self.nowDate
        XCTAssertEqual(SubscriptionsStore.measuredLabel(nil, now: now), "never measured")
        XCTAssertEqual(SubscriptionsStore.measuredLabel(Self.now - 5_000, now: now), "measured just now")
        XCTAssertEqual(SubscriptionsStore.measuredLabel(Self.now - 12 * 60_000, now: now), "measured 12 min ago")
        XCTAssertEqual(SubscriptionsStore.measuredLabel(Self.now - 3 * 3_600_000, now: now), "measured 3 h ago")
    }

    // MARK: - Codex: codexWindowLabel / stateBadge / codexIssue

    func testCodexWindowLabel() {
        XCTAssertEqual(SubscriptionsStore.codexWindowLabel(300), "5h")
        XCTAssertEqual(SubscriptionsStore.codexWindowLabel(10_080), "7d")
        XCTAssertEqual(SubscriptionsStore.codexWindowLabel(60), "1h")
        XCTAssertEqual(SubscriptionsStore.codexWindowLabel(90), "90m")
        XCTAssertEqual(SubscriptionsStore.codexWindowLabel(nil), "—")
    }

    func testStateBadgeDecidesTheText() {
        XCTAssertTrue(SubscriptionsStore.stateBadge(.ok) == (text: "Active", tone: .ok))
        XCTAssertTrue(SubscriptionsStore.stateBadge(.signedOut) == (text: "Not signed in", tone: .warn))
        XCTAssertTrue(SubscriptionsStore.stateBadge(.staleLogin) == (text: "Stale login", tone: .warn))
        // Same tone as "Usage unavailable" on the Anthropic cards.
        XCTAssertTrue(SubscriptionsStore.stateBadge(.error) == (text: "Usage unavailable", tone: .warn))
        XCTAssertTrue(SubscriptionsStore.stateBadge(.ok, limitReached: "workspace_member_usage_limit_reached") == (text: "Limit reached", tone: .danger))
        // An unknown state must not fall through to a silent "Active".
        XCTAssertTrue(SubscriptionsStore.stateBadge(.unknown) == (text: "Unknown status", tone: .warn))
    }

    private func codex(
        state: SubscriptionState = .ok, planType: String? = "plus",
        windows: [CodexWindowView] = [CodexWindowView(kind: .primary, usedPct: 42, windowMinutes: 300, resetsAt: nil)],
        credits: CodexSubscriptionView.Credits? = nil, limitReached: String? = nil,
        fetchedAt: Int = 1_787_224_361_140, error: String? = nil
    ) -> CodexSubscriptionView {
        CodexSubscriptionView(state: state, planType: planType, windows: windows, credits: credits, limitReached: limitReached, fetchedAt: fetchedAt, error: error)
    }

    func testCodexIssueKnownCodeGetsASentenceUnknownShowsVerbatim() {
        XCTAssertNil(SubscriptionsStore.codexIssue(codex()))
        XCTAssertTrue(SubscriptionsStore.codexIssue(codex(state: .error, error: "deactivated_workspace (HTTP 402)"))!.contains("deactivated"))
        XCTAssertTrue(SubscriptionsStore.codexIssue(codex(state: .error, error: "unknown-shape"))!.contains("shape"))
        XCTAssertTrue(SubscriptionsStore.codexIssue(codex(state: .error, error: "something else entirely"))!.contains("something else entirely"))
        XCTAssertTrue(SubscriptionsStore.codexIssue(codex(state: .signedOut))!.contains("codex login"))
        XCTAssertTrue(SubscriptionsStore.codexIssue(codex(state: .staleLogin))!.contains("codex login"))
    }

    func testCodexIssueRawCodeWithParenthesesIsNotDoubled() {
        let issue = SubscriptionsStore.codexIssue(codex(state: .error, error: "deactivated_workspace (HTTP 402)"))!
        XCTAssertFalse(issue.contains("(("))
        XCTAssertTrue(issue.contains("deactivated_workspace (HTTP 402)"))
    }

    func testCodexIssueLimitReachedHasItsOwnSentence() {
        let issue = SubscriptionsStore.codexIssue(codex(limitReached: "workspace_member_usage_limit_reached"))
        XCTAssertTrue(issue!.contains("workspace_member_usage_limit_reached"))
    }

    // MARK: - Codex/Grok: reduce (1:1 subCardState)

    func testReduce404ThenRealErrorInBetweenNoSuccess() {
        var state = SubscriptionsStore.CardState<CodexSubscriptionView>()
        state = SubscriptionsStore.reduce(state, .failure(DevdHTTPError(statusCode: 404)))
        XCTAssertTrue(state.hidden)
        XCTAssertNil(state.fetchErr)

        state = SubscriptionsStore.reduce(state, .failure(DevdHTTPError(statusCode: 500)))
        XCTAssertFalse(state.hidden)
        XCTAssertEqual(state.fetchErr, "Server error (HTTP 500)")
    }

    func testReduceSuccessAlwaysFullyDeterminesState() {
        var state = SubscriptionsStore.CardState<CodexSubscriptionView>()
        state = SubscriptionsStore.reduce(state, .failure(DevdClientError(description: "boom")))
        XCTAssertEqual(state.fetchErr, "boom")

        state = SubscriptionsStore.reduce(state, .ok(nil))
        XCTAssertFalse(state.hidden)
        XCTAssertNil(state.fetchErr)
        if case .value(let v) = state.phase { XCTAssertNil(v) } else { XCTFail("expected .value(nil)") }
    }

    func testReduceErrorAfterSuccessKeepsLastKnownValue() {
        let known = codex(planType: "plus")
        var state = SubscriptionsStore.CardState<CodexSubscriptionView>()
        state = SubscriptionsStore.reduce(state, .ok(known))
        state = SubscriptionsStore.reduce(state, .failure(DevdClientError(description: "network down")))
        XCTAssertFalse(state.hidden)
        XCTAssertEqual(state.fetchErr, "network down")
        if case .value(let v) = state.phase { XCTAssertEqual(v?.planType, known.planType) } else { XCTFail("expected .value") }
    }

    func testCardStateVisibility() {
        // Never arrived yet → visible (spinner).
        XCTAssertTrue(SubscriptionsStore.CardState<CodexSubscriptionView>().visible)
        // Hidden (404).
        XCTAssertFalse(SubscriptionsStore.CardState<CodexSubscriptionView>(phase: .loading, hidden: true, fetchErr: nil).visible)
        // Successfully measured as "not configured", no error → hidden.
        XCTAssertFalse(SubscriptionsStore.CardState<CodexSubscriptionView>(phase: .value(nil), hidden: false, fetchErr: nil).visible)
        // Value present → visible.
        XCTAssertTrue(SubscriptionsStore.CardState<CodexSubscriptionView>(phase: .value(codex()), hidden: false, fetchErr: nil).visible)
        // Error, even without a value → visible (the error banner shows).
        XCTAssertTrue(SubscriptionsStore.CardState<CodexSubscriptionView>(phase: .loading, hidden: false, fetchErr: "boom").visible)
    }

    // MARK: - Grok: stateBadge / grokIssue

    private func grok(
        state: SubscriptionState = .ok, tier: String? = "SuperGrok", usedPct: Double? = nil,
        resetsAt: Int? = 1_787_800_838_000, fetchedAt: Int = 1_787_224_361_140, error: String? = nil
    ) -> GrokSubscriptionView {
        GrokSubscriptionView(state: state, tier: tier, usedPct: usedPct, resetsAt: resetsAt, fetchedAt: fetchedAt, error: error)
    }

    func testGrokStateBadgeUnknownStateDoesNotFallBackToActive() {
        XCTAssertTrue(SubscriptionsStore.stateBadge(grok().state) == (text: "Active", tone: .ok))
        XCTAssertTrue(SubscriptionsStore.stateBadge(grok(state: .signedOut).state) == (text: "Not signed in", tone: .warn))
        XCTAssertTrue(SubscriptionsStore.stateBadge(grok(state: .staleLogin).state) == (text: "Stale login", tone: .warn))
        XCTAssertTrue(SubscriptionsStore.stateBadge(grok(state: .error).state) == (text: "Usage unavailable", tone: .warn))
        XCTAssertTrue(SubscriptionsStore.stateBadge(grok(state: .unknown).state) == (text: "Unknown status", tone: .warn))
    }

    func testGrokIssuePointsToSettingsShowsRawErrorCode() {
        XCTAssertNil(SubscriptionsStore.grokIssue(grok()))
        XCTAssertTrue(SubscriptionsStore.grokIssue(grok(state: .signedOut))!.contains("Settings"))
        XCTAssertTrue(SubscriptionsStore.grokIssue(grok(state: .staleLogin))!.contains("Settings"))
        XCTAssertTrue(SubscriptionsStore.grokIssue(grok(state: .error, error: "HTTP 401 denied"))!.contains("HTTP 401 denied"))
        XCTAssertTrue(SubscriptionsStore.grokIssue(grok(state: .error, error: "unknown-shape"))!.contains("shape"))
    }

    // MARK: - OpenRouter

    func testOpenrouterStatusDistinguishesMissingKeyVsMissingModel() {
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: false, model: nil)).text, "Not connected")
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: false, model: "stealth/ox-alpha")).text, "Not connected")
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: true, model: nil)).text, "No model set")
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: true, model: "stealth/ox-alpha")).text, "Active")
    }

    func testOpenrouterStatusGreenOnlyWhenFullyConfigured() {
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: true, model: "stealth/ox-alpha")).tone, .ok)
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: true, model: nil)).tone, .warn)
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(OpenrouterView(hasKey: false, model: nil)).tone, .warn)
    }

    func testOpenrouterStatusLoadingIsNotActive() {
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(nil).text, "Loading…")
        XCTAssertEqual(SubscriptionsStore.openrouterStatus(nil).tone, .warn)
    }

    // MARK: - setDisabled (H0 fix pack) — the only mutation wired up in this fix pack; path,
    // body and refetch via `MockURLProtocol` (same type as `DevdClientTests`/`AppModelTests`,
    // one test target).

    @MainActor
    private func makeMockedStore(_ handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> SubscriptionsStore {
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://100.100.100.100:4300")!)
        return SubscriptionsStore(client: DevdClient(endpoints: endpoints, session: URLSession(configuration: config)))
    }

    /// `URLSession` usually turns `httpBody` into `httpBodyStream` — so we read both, same pattern
    /// as `AppModelTests.bodyJSON`.
    private func bodyJSON(_ request: URLRequest) -> [String: Any] {
        if let data = request.httpBody {
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    @MainActor
    func testSetDisabledPostsToDisablePathWithBodyAndRefetchesAccounts() async throws {
        let emptyAccounts = #"{"accounts":[],"pool":{"thresholdPct":90,"spilloverPct":60,"preferredAccountId":null,"projectAccounts":{},"soloAccountId":null}}"#
        let store = makeMockedStore { req in
            req.url?.path == "/api/accounts/max20/disable"
                ? .init(statusCode: 200)
                : .init(statusCode: 200, data: emptyAccounts.data(using: .utf8)!)
        }

        try await store.setDisabled(acc(id: "max20", disabled: false), disabled: true)

        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2, "must refetch /api/accounts after a successful mutation")
        let disableReq = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(disableReq.url?.path, "/api/accounts/max20/disable")
        XCTAssertEqual(disableReq.httpMethod, "POST")
        XCTAssertEqual(bodyJSON(disableReq)["disabled"] as? Bool, true)
        XCTAssertEqual(MockURLProtocol.capturedRequests[1].url?.path, "/api/accounts")
        XCTAssertEqual(store.accounts?.count, 0)
    }

    /// A failed mutation bubbles up to the caller (Screen) — the Store MUST NOT think it succeeded, and
    /// must not refetch because of the failure.
    @MainActor
    func testSetDisabledPropagatesErrorAndDoesNotRefetch() async {
        let store = makeMockedStore { _ in .init(statusCode: 500) }

        do {
            try await store.setDisabled(acc(id: "max20"), disabled: true)
            XCTFail("expected an error — the server rejected the mutation")
        } catch {
            XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1, "no refetch may run when the mutation itself failed")
        }
    }
}

// `(text: String, tone: Severity)` tuples are not automatically Equatable — the `==` comparisons
// in the tests above need this operator.
private func == (lhs: (text: String, tone: SubscriptionsStore.Severity), rhs: (text: String, tone: SubscriptionsStore.Severity)) -> Bool {
    lhs.text == rhs.text && lhs.tone == rhs.tone
}

private func == (lhs: (name: String, tier: String?), rhs: (name: String, tier: String?)) -> Bool {
    lhs.name == rhs.name && lhs.tier == rhs.tier
}
