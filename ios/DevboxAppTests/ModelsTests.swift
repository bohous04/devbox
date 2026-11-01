import XCTest
@testable import DevboxApp

/// Verifies that the models in `Models.swift` decode raw responses captured from a live devd
/// (see `Fixtures/`) without losing key fields.
final class ModelsTests: XCTestCase {
    /// Loads a fixture from the test bundle and decodes it into the given type.
    private func decodeFixture<T: Decodable>(_ name: String, as type: T.Type = T.self, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        let bundle = Bundle(for: Self.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            XCTFail("fixture \(name).json nenalezena v test bundlu", file: file, line: line)
            throw CocoaError(.fileNoSuchFile)
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func testLiveStats() throws {
        let live = try decodeFixture("live", as: LiveStats.self)
        XCTAssertFalse(live.sessions.isEmpty)
        let first = try XCTUnwrap(live.sessions.first)
        XCTAssertFalse(first.id.isEmpty)
        XCTAssertFalse(first.status.rawValue.isEmpty)
        // claudeState must decode to one of the three valid enum values.
        _ = first.claudeState
        XCTAssertGreaterThan(live.disk.totalBytes, 0)
    }

    func testTotals() throws {
        let totals = try decodeFixture("totals", as: Totals.self)
        XCTAssertGreaterThanOrEqual(totals.costToday, 0)
        XCTAssertGreaterThanOrEqual(totals.hoursToday, 0)
    }

    func testRangeStats() throws {
        let range = try decodeFixture("range", as: RangeStats.self)
        XCTAssertFalse(range.daily.isEmpty)
        XCTAssertFalse(range.hourly.isEmpty)
        XCTAssertFalse(range.hosts.isEmpty)
        XCTAssertGreaterThanOrEqual(range.totals.cost, 0)
    }

    func testSessionUsage() throws {
        let usage = try decodeFixture("sessionUsage", as: [SessionUsage].self)
        XCTAssertFalse(usage.isEmpty)
        XCTAssertFalse(usage[0].id.isEmpty)
    }

    func testSessionUsageMissingTokensDecodesAsZero() throws {
        let json = #"[{"id":"a","cost":1.5},{"id":"b","cost":2,"tokens":12.5}]"#
        let usage = try JSONDecoder().decode([SessionUsage].self, from: Data(json.utf8))
        XCTAssertEqual(usage.map(\.tokens), [0, 12.5])
        XCTAssertEqual(usage[0].cost, 1.5)
    }

    func testAccounts() throws {
        let resp = try decodeFixture("accounts", as: AccountsResponse.self)
        XCTAssertFalse(resp.accounts.isEmpty)
        XCTAssertGreaterThan(resp.pool.thresholdPct, 0)
    }

    func testCodexSubscription() throws {
        let resp = try decodeFixture("codex", as: CodexSubscriptionResponse.self)
        let codex = try XCTUnwrap(resp.codex)
        XCTAssertEqual(codex.state, .ok)
    }

    func testGrokSubscription() throws {
        let resp = try decodeFixture("grok", as: GrokSubscriptionResponse.self)
        let grok = try XCTUnwrap(resp.grok)
        XCTAssertEqual(grok.state, .ok)
    }

    func testHardware() throws {
        let hw = try decodeFixture("hardware", as: HardwareSnapshot.self)
        XCTAssertFalse(hw.machines.isEmpty)
        XCTAssertFalse(hw.monitors.isEmpty)
    }

    func testWorkHours() throws {
        let work = try decodeFixture("workHours", as: WorkHours.self)
        XCTAssertGreaterThan(work.totalHours, 0)
        XCTAssertFalse(work.byProject.isEmpty)
        XCTAssertFalse(work.daily.isEmpty)
    }

    func testHardwareSeries() throws {
        let samples = try decodeFixture("hardwareSeries", as: [MachineSample].self)
        XCTAssertFalse(samples.isEmpty)
        let first = try XCTUnwrap(samples.first)
        XCTAssertGreaterThan(first.at, 0)
        XCTAssertGreaterThanOrEqual(first.cpu, 0)
    }

    func testTree() throws {
        let tree = try decodeFixture("tree", as: [TreeProject].self)
        XCTAssertFalse(tree.isEmpty)
        XCTAssertFalse(tree[0].repos.isEmpty)
    }

    func testSchedules() throws {
        let schedules = try decodeFixture("schedules", as: [Schedule].self)
        XCTAssertFalse(schedules.isEmpty)
        XCTAssertFalse(schedules[0].cron.isEmpty)
    }

    func testNotifyLog() throws {
        let rows = try decodeFixture("notifyLog", as: [NotifyLogRow].self)
        XCTAssertFalse(rows.isEmpty)
        XCTAssertFalse(rows[0].session_id.isEmpty)
    }

    func testConfig() throws {
        let config = try decodeFixture("config", as: DevdConfig.self)
        XCTAssertEqual(config.version, 1)
    }

    func testAuth() throws {
        let auth = try decodeFixture("auth", as: AuthStatus.self)
        XCTAssertTrue(auth.claude.loggedIn)
    }

    func testCcUpkeep() throws {
        let cc = try decodeFixture("ccUpkeep", as: CcStatus.self)
        XCTAssertFalse(cc.sessions.isEmpty)
    }

    func testDiskStats() throws {
        let disk = try decodeFixture("disk", as: DiskStats.self)
        XCTAssertGreaterThan(disk.totalBytes, 0)
        XCTAssertGreaterThan(disk.usedBytes, 0)
        XCTAssertNotNil(disk.daysLeft)
    }

    func testActivityEvents() throws {
        let events = try decodeFixture("events", as: [ActivityEvent].self)
        XCTAssertFalse(events.isEmpty)
        let first = try XCTUnwrap(events.first)
        XCTAssertFalse(first.type.isEmpty)
        XCTAssertNotNil(first.session_id)
        XCTAssertNotNil(first.data)
    }

    func testEventPage() throws {
        let page = try decodeFixture("eventsPage", as: EventPage.self)
        XCTAssertFalse(page.items.isEmpty)
        XCTAssertGreaterThan(page.total, page.items.count, "live fixture: more events in history than one limit=5 request returned")
        XCTAssertFalse(page.types.isEmpty)
    }

    /// `prodWrites.json` is a live capture with an empty array (no prod write has happened on the
    /// devbox yet) — the fields are checked with hand-built JSON, same pattern as the `decodeRaw` tests below.
    func testProdWritesFixtureDecodesAsEmptyArray() throws {
        let rows = try decodeFixture("prodWrites", as: [ProdWrite].self)
        XCTAssertTrue(rows.isEmpty)
    }

    func testProdWriteFieldsDecode() throws {
        let json = """
        {"id":9,"ts":1787700000000,"session_id":"dev-x-y","db":"prod","sql":"UPDATE x SET y=1",
         "status":"pending","decided_at":null,"result":null,"error":null}
        """
        let write = try decodeRaw(json, as: ProdWrite.self)
        XCTAssertEqual(write.status, .pending)
        XCTAssertEqual(write.db, "prod")
        XCTAssertNil(write.result)
    }

    func testOpenrouterView() throws {
        let view = try decodeFixture("openrouter", as: OpenrouterView.self)
        XCTAssertTrue(view.hasKey)
        XCTAssertEqual(view.model, "stealth/ox-alpha")
    }

    // MARK: - Tolerant enum decoding (a new value from devd must not break the whole decode)

    /// Decodes a raw JSON literal (not a fixture file) — used where we want an unknown
    /// enum value that no captured fixture contains.
    private func decodeRaw<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testAgentNameKnownValueDecodes() throws {
        XCTAssertEqual(try decodeRaw("\"codex\"", as: AgentName.self), .codex)
        XCTAssertEqual(try decodeRaw("\"claude-grok\"", as: AgentName.self), .claudeGrok)
    }

    func testAgentNameUnknownRawValueDecodesToUnknown() throws {
        let agent = try decodeRaw("\"claude-future-agent\"", as: AgentName.self)
        XCTAssertEqual(agent, .unknown)
    }

    func testClaudeStateKnownValueDecodes() throws {
        XCTAssertEqual(try decodeRaw("\"working\"", as: ClaudeState.self), .working)
    }

    func testClaudeStateUnknownRawValueDecodesToUnknown() throws {
        let state = try decodeRaw("\"blocked\"", as: ClaudeState.self)
        XCTAssertEqual(state, .unknown)
    }

    func testSubscriptionStateKnownValueDecodes() throws {
        XCTAssertEqual(try decodeRaw("\"stale-login\"", as: SubscriptionState.self), .staleLogin)
    }

    func testSubscriptionStateUnknownRawValueDecodesToUnknown() throws {
        let state = try decodeRaw("\"rate-limited\"", as: SubscriptionState.self)
        XCTAssertEqual(state, .unknown)
    }

    /// `memBytes`/`cpuPct` in a live `/api/stats/live` are not reliably integers nor always
    /// present — devd can send a fractional value (`memBytes: 618974003.2`) and an older/outlying
    /// payload may omit them entirely. One such session must not break decoding of the whole array.
    func testLiveDecodesFractionalAndMissingMetrics() throws {
        let live = try decodeFixture("live", as: LiveStats.self)
        let fractional = try XCTUnwrap(live.sessions.first { $0.id == "dev-fractional-membytes-test" })
        XCTAssertEqual(fractional.memBytes, 618974003.2)
        let missing = try XCTUnwrap(live.sessions.first { $0.id == "dev-missing-metrics-test" })
        XCTAssertEqual(missing.cpuPct, 0)
        XCTAssertEqual(missing.memBytes, 0)
    }

    /// An unknown `agent` value inside `SessionLive` (in the `/api/stats/live` array) must not break
    /// decoding of the whole response — the exact scenario that forced this follow-up.
    /// `server`/`grant_permanent` are newer fields (see Task 9) — verifies decoding with
    /// filled-in values (not just `nil`, as the rest of the tests in `SshApprovalsStoreTests` decode).
    func testSshApprovalDecodesServerAndGrantPermanent() throws {
        let json = """
        {"id":"a1","session_id":"dev-web-app","title":"shop","why":"restart","target":"root@192.0.2.11:22",
         "cwd":"/workspace","project":"web","repo":"app","status":"activated","decided_by":"mac",
         "created_at":0,"decided_at":1000,"expires_at":90000,"grant_until":0,
         "server":"shop","grant_permanent":1}
        """
        let approval = try decodeRaw(json, as: SshApproval.self)
        XCTAssertEqual(approval.server, "shop")
        XCTAssertEqual(approval.grant_permanent, 1)
    }

    func testLiveStatsWithUnknownAgentValueStillDecodes() throws {
        let json = """
        {
          "sessions": [{
            "id": "s1", "folder": "f", "project": "p", "repo": "r", "container": "c",
            "port_base": 1, "status": "running", "solo": 0, "created_at": 0, "last_active_at": 0,
            "ports": [], "claudeState": "working", "cpuPct": 0, "memBytes": 0, "workspace": "w",
            "important": 0, "accountId": null, "name": null, "critic": null, "agent": "claude-future-agent"
          }],
          "disk": { "usedBytes": 0, "totalBytes": 1 }
        }
        """
        let live = try decodeRaw(json, as: LiveStats.self)
        XCTAssertEqual(live.sessions.first?.agent, .unknown)
    }
}
