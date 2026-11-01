import XCTest
@testable import DevboxApp

/// Pure `OverviewStore` functions — inputs/outputs copied from `dashboard/src/format.test.ts`
/// (pctOf/daysLeftLabel), a `dashboard/src/components/Gauge.test.ts` equivalent (diskSeverity,
/// derived directly from `Gauge.tsx`) and `dashboard/src/eventLabels.test.ts` (eventLabel/eventDetail/
/// sessionShort). Plus `loaded` (fetch via `MockURLProtocol`, defined in `DevdClientTests.swift`)
/// — same pattern as `LogStoreTests`.
@MainActor
final class OverviewStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> OverviewStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return OverviewStore(client: DevdClient(endpoints: endpoints, session: session))
    }
    // MARK: - pctOf

    func testPctOfClampsAndHandlesZeroTotal() {
        XCTAssertEqual(OverviewStore.pctOf(50, 200), 25)
        XCTAssertEqual(OverviewStore.pctOf(300, 200), 100)
        XCTAssertEqual(OverviewStore.pctOf(-5, 200), 0)
        XCTAssertEqual(OverviewStore.pctOf(10, 0), 0)
    }

    // MARK: - daysLeftLabel

    func testDaysLeftLabel() {
        XCTAssertEqual(OverviewStore.daysLeftLabel(7), "~7 days")
        XCTAssertEqual(OverviewStore.daysLeftLabel(nil), "plenty of space")
    }

    // MARK: - diskSeverity

    func testDiskSeverity() {
        XCTAssertEqual(OverviewStore.diskSeverity(0), .ok)
        XCTAssertEqual(OverviewStore.diskSeverity(79), .ok)
        XCTAssertEqual(OverviewStore.diskSeverity(80), .warn)
        XCTAssertEqual(OverviewStore.diskSeverity(91.9), .warn)
        XCTAssertEqual(OverviewStore.diskSeverity(92), .danger)
        // A custom warnPct from the config moves the threshold — 65 % is below the default (80) but above 50.
        XCTAssertEqual(OverviewStore.diskSeverity(65, warnPct: 80), .ok)
        XCTAssertEqual(OverviewStore.diskSeverity(65, warnPct: 50), .warn)
    }

    // MARK: - eventLabel

    func testEventLabelKnownTypeHasLabelAndKind() {
        let done = OverviewStore.eventLabel("agent_done")
        XCTAssertEqual(done.label, "Claude finished the work")
        XCTAssertEqual(done.kind, .ok)
        XCTAssertEqual(OverviewStore.eventLabel("agent_stuck").kind, .danger)
        XCTAssertTrue(OverviewStore.eventLabel("schedule_run").label.contains("Scheduled"))
    }

    func testEventLabelUnknownTypeFallsBackToItself() {
        let unknown = OverviewStore.eventLabel("unknown_type")
        XCTAssertEqual(unknown.label, "unknown_type")
        XCTAssertEqual(unknown.kind, .info)
    }

    func testAgentSwitchEventsHaveHumanLabels() {
        XCTAssertTrue(OverviewStore.eventLabel("agent-switch").label.contains("Agent"))
        XCTAssertTrue(OverviewStore.eventLabel("agent-switch-live").label.contains("Agent"))
    }

    func testCriticEvents() {
        XCTAssertEqual(OverviewStore.eventLabel("critic_pass").label, "Critic approved the work")
        XCTAssertEqual(OverviewStore.eventLabel("critic_pass").kind, .ok)
        XCTAssertEqual(OverviewStore.eventLabel("critic_block").kind, .warn)
        XCTAssertEqual(OverviewStore.eventLabel("critic_giveup").kind, .warn)
        XCTAssertEqual(OverviewStore.eventLabel("critic_error").kind, .danger)
        XCTAssertEqual(OverviewStore.eventLabel("critic_toggle").label, "Critic toggled")
    }

    func testCcEvents() {
        XCTAssertEqual(OverviewStore.eventLabel("cc_upgraded").kind, .ok)
        XCTAssertEqual(OverviewStore.eventLabel("cc_skipped").kind, .info)
        XCTAssertEqual(OverviewStore.eventLabel("cc_restart_failed").kind, .warn)
        XCTAssertEqual(OverviewStore.eventLabel("cc_upgrade_failed").kind, .danger)
        XCTAssertNotEqual(OverviewStore.eventLabel("cc_upgraded").label, "cc_upgraded")
    }

    func testProdDbEventsHaveHumanLabels() {
        for type in ["prod_db_access", "prod_write_proposed", "prod_write_executed", "prod_write_rejected"] {
            XCTAssertNotEqual(OverviewStore.eventLabel(type).label, type)
        }
        XCTAssertEqual(OverviewStore.eventLabel("prod_write_proposed").kind, .warn)
        XCTAssertEqual(OverviewStore.eventLabel("prod_write_executed").kind, .ok)
    }

    /// Task 8 fix: `ssh_key_requested/approved/denied/bypass/ssh_grant_revoked` used to have no
    /// label (they fell through to the `.info` fallback with the raw type) — so a break-glass bypass looked
    /// like a neutral row in Overview/Log. Must match `dashboard/src/eventLabels.ts`.
    func testSshEventsHaveHumanLabelsAndSeverityMatchingWeb() {
        for type in ["ssh_key_requested", "ssh_key_approved", "ssh_key_denied", "ssh_key_access", "ssh_key_bypass", "ssh_grant_revoked"] {
            XCTAssertNotEqual(OverviewStore.eventLabel(type).label, type)
        }
        XCTAssertEqual(OverviewStore.eventLabel("ssh_key_requested").kind, .warn)
        XCTAssertEqual(OverviewStore.eventLabel("ssh_key_approved").kind, .ok)
        // Denial and bypass MUST NOT come out as .info — bypass is break-glass (protection off),
        // denial is a security rejection; both are a signal, not neutral.
        XCTAssertEqual(OverviewStore.eventLabel("ssh_key_denied").kind, .danger)
        XCTAssertEqual(OverviewStore.eventLabel("ssh_key_bypass").kind, .danger)
        XCTAssertEqual(OverviewStore.eventLabel("ssh_grant_revoked").kind, .info)
        // Rewrite of the original "SSH key access" — the new wording matches the web, not the outdated one.
        XCTAssertEqual(OverviewStore.eventLabel("ssh_key_access").label, "SSH key handed to ssh-agent")
        XCTAssertEqual(OverviewStore.eventLabel("ssh_key_access").kind, .ok)
    }

    // MARK: - eventDetail

    func testEventDetailPullsOutKnownKeys() {
        XCTAssertTrue(OverviewStore.eventDetail(#"{"schedule":"Nightly bump","branch":"auto/x-1"}"#).contains("Nightly bump"))
        XCTAssertTrue(OverviewStore.eventDetail(#"{"kind":"permission"}"#).contains("permission"))
        XCTAssertEqual(OverviewStore.eventDetail(nil), "")
        XCTAssertEqual(OverviewStore.eventDetail("invalid{"), "")
    }

    func testEventDetailFromTo() {
        XCTAssertEqual(OverviewStore.eventDetail(#"{"from":"claude-openrouter","to":"claude"}"#), "claude-openrouter · claude")
    }

    func testEventDetailShowsVersionsAndCountsFromCcUpgraded() {
        let detail = OverviewStore.eventDetail(#"{"from":"2.1.207","to":"2.1.220","restarted":2,"stuck":0}"#)
        XCTAssertTrue(detail.contains("2.1.207"))
        XCTAssertTrue(detail.contains("2.1.220"))
    }

    // MARK: - sessionShort

    func testSessionShortDevPrefixToProjectRepo() {
        XCTAssertEqual(OverviewStore.sessionShort("dev-shop-cms"), "shop/cms")
        XCTAssertEqual(OverviewStore.sessionShort(nil), "system")
        XCTAssertEqual(OverviewStore.sessionShort(""), "system")
        XCTAssertEqual(OverviewStore.sessionShort("no-dev-prefix"), "no-dev-prefix")
        // Only the FIRST dash after the prefix becomes a slash — the rest stays unchanged.
        XCTAssertEqual(OverviewStore.sessionShort("dev-status-daily-game_agents"), "status/daily-game_agents")
    }

    // MARK: - loaded (review: "Recent activity" must not briefly flash "Nothing yet." before load() finishes)

    func testLoadedIsFalseBeforeFirstLoad() {
        let store = makeStore { _ in .init(statusCode: 200) }
        XCTAssertFalse(store.loaded)
    }

    /// Key regression test: 0 events is a valid, SUCCESSFUL result — `loaded` must flip so that
    /// `OverviewScreen` shows "Nothing yet." instead of a forever-spinning `ProgressView`.
    func testLoadedBecomesTrueAfterSuccessfulLoadWithZeroEvents() async {
        let store = makeStore { req in
            switch req.url?.path {
            case "/api/stats/totals":
                return .init(statusCode: 200, data: #"{"hoursToday":0,"tokensToday":0,"costToday":0,"costMonth":0,"commitsToday":0,"unpushed":0}"#.data(using: .utf8)!)
            case "/api/stats/disk":
                return .init(statusCode: 200, data: #"{"usedBytes":0,"totalBytes":100,"growthPerDay":0,"daysLeft":null}"#.data(using: .utf8)!)
            default:
                return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
            }
        }

        await store.load()

        XCTAssertTrue(store.loaded)
        XCTAssertTrue(store.events.isEmpty)
        XCTAssertNil(store.lastError)
    }

    func testLoadedBecomesTrueEvenWhenLoadFails() async {
        let store = makeStore { _ in .init(statusCode: 500) }

        await store.load()

        XCTAssertTrue(store.loaded)
        XCTAssertNotNil(store.lastError)
    }
}
