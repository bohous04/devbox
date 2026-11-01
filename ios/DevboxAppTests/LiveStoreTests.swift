import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here, not duplicated.
@MainActor
final class LiveStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    private static let liveJSON = """
    {"sessions":[],"disk":{"usedBytes":1,"totalBytes":2}}
    """.data(using: .utf8)!

    private static let usageJSON = """
    [{"id":"s1","cost":1.5,"tokens":100},{"id":"s2","cost":2.5,"tokens":200}]
    """.data(using: .utf8)!

    private static let ccJSON = """
    {"latest":"1.2.3","image":"1.2.0","sessions":[]}
    """.data(using: .utf8)!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeClient(session: URLSession) -> DevdClient {
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return DevdClient(endpoints: endpoints, session: session)
    }

    /// Responds by request path — a single stub for the live/usage/cc happy-path handler.
    private static func successHandler(_ request: URLRequest) -> MockURLProtocol.Stub {
        switch request.url?.path {
        case "/api/stats/live": return .init(statusCode: 200, data: liveJSON)
        case "/api/stats/sessions": return .init(statusCode: 200, data: usageJSON)
        case "/api/cc-upkeep": return .init(statusCode: 200, data: ccJSON)
        default: return .init(statusCode: 404)
        }
    }

    // MARK: - Pure logic

    func testUsageByIdKeysRowsByIdAndLastRowWinsOnDuplicate() {
        let rows = [
            SessionUsage(id: "a", cost: 1, tokens: 10),
            SessionUsage(id: "b", cost: 2, tokens: 20),
            SessionUsage(id: "a", cost: 3, tokens: 30),
        ]

        let result = LiveStore.usageById(rows)

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result["a"]?.cost, 3)
        XCTAssertEqual(result["a"]?.tokens, 30)
        XCTAssertEqual(result["b"]?.tokens, 20)
    }

    func testUsageByIdOnEmptyRowsIsEmptyDict() {
        XCTAssertTrue(LiveStore.usageById([]).isEmpty)
    }

    // MARK: - Polling

    func testStartPopulatesLiveUsageAndCcWithinShortTime() async throws {
        MockURLProtocol.handler = Self.successHandler
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(20))

        store.start()
        try await Task.sleep(for: .milliseconds(100))
        store.stop()

        XCTAssertNotNil(store.live)
        XCTAssertEqual(store.usage["s1"]?.cost, 1.5)
        XCTAssertEqual(store.usage["s2"]?.tokens, 200)
        XCTAssertEqual(store.cc?.latest, "1.2.3")
        XCTAssertNil(store.lastError)
    }

    func testCcIsFetchedOnlyOnceAcrossMultipleTicks() async throws {
        MockURLProtocol.handler = Self.successHandler
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(15))

        store.start()
        try await Task.sleep(for: .milliseconds(150)) // several ticks at a 15ms interval
        store.stop()

        let ccRequests = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/cc-upkeep" }.count
        XCTAssertEqual(ccRequests, 1)
    }

    func testFailingTickSetsLastErrorButKeepsPreviousData() async throws {
        var failing = false
        MockURLProtocol.handler = { request in
            failing ? .init(statusCode: 0, error: URLError(.notConnectedToInternet)) : Self.successHandler(request)
        }
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(25))

        store.start()
        try await Task.sleep(for: .milliseconds(60)) // at least one successful tick
        XCTAssertNotNil(store.live)
        XCTAssertFalse(store.usage.isEmpty)
        XCTAssertNil(store.lastError)

        failing = true
        try await Task.sleep(for: .milliseconds(80)) // at least one failed tick

        XCTAssertNotNil(store.lastError)
        XCTAssertNotNil(store.live, "the last known data stays after an error")
        XCTAssertFalse(store.usage.isEmpty, "the last known data stays after an error")

        // Recovery: the next successful tick clears the error.
        failing = false
        try await Task.sleep(for: .milliseconds(60))
        store.stop()

        XCTAssertNil(store.lastError)
    }

    func testStopHaltsFurtherPolling() async throws {
        MockURLProtocol.handler = Self.successHandler
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(20))

        store.start()
        try await Task.sleep(for: .milliseconds(70))
        store.stop()
        let countAfterStop = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/stats/live" }.count
        XCTAssertGreaterThan(countAfterStop, 0)

        try await Task.sleep(for: .milliseconds(120)) // longer than a few more ticks would take
        let countLater = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/stats/live" }.count

        XCTAssertEqual(countAfterStop, countLater, "no more requests may arrive after stop()")
    }

    func testStartCalledTwiceDoesNotDoublePolling() async throws {
        MockURLProtocol.handler = Self.successHandler
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(20))

        store.start()
        store.start() // the second call must be a no-op, not a second concurrent loop
        try await Task.sleep(for: .milliseconds(70))
        store.stop()

        let liveRequests = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/stats/live" }.count
        // At a 20ms interval and a 70ms wait we expect roughly 3-4 ticks from ONE loop;
        // doubled polling would show up as about twice that.
        XCTAssertLessThan(liveRequests, 8)
    }

    func testStopIsIdempotentAndSafeBeforeStart() {
        let store = LiveStore(client: makeClient(session: makeSession()))
        store.stop()
        store.stop()
        // It did not crash — that is all this checks.
    }

    // MARK: - rebuild(client:) — non-destructive client swap (review Critical, stage G task 30 fix)

    /// Replaces the former `.id(appModel.clientIdentity)` on the whole `SessionsContainer` (that also tore
    /// down tabs/navigation/an open Settings) — `rebuild` must: (1) switch polling to the NEW base
    /// URL, (2) stop polling the OLD one, (3) drop the old data (it belonged to the old server).
    func testRebuildSwitchesPollingToNewClientAndResetsData() async throws {
        var hostsSeen: Set<String> = []
        MockURLProtocol.handler = { request in
            hostsSeen.insert(request.url?.host ?? "")
            return Self.successHandler(request)
        }
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(20))
        store.start()
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertNotNil(store.live)
        XCTAssertTrue(hostsSeen.contains("100.100.100.100"))

        let newTailnet = URL(string: "http://100.100.100.200:4300")!
        let newEndpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: newTailnet)
        let newClient = DevdClient(endpoints: newEndpoints, session: makeSession())
        hostsSeen = []

        store.rebuild(client: newClient)
        // `rebuild` is synchronous and resets the data BEFORE the first new tick can finish
        // (that runs in a separate Task) — right after the call the old data must be gone.
        XCTAssertNil(store.live, "rebuild must drop the old client's data immediately, not after the first tick")

        try await Task.sleep(for: .milliseconds(60))
        store.stop()

        XCTAssertTrue(hostsSeen.contains("100.100.100.200"), "polling after rebuild must go to the new client")
        XCTAssertFalse(hostsSeen.contains("100.100.100.100"), "polling after rebuild must not keep hitting the old client")
        XCTAssertNotNil(store.live, "after rebuild it should refill with fresh data")
    }

    func testRebuildIsSafeWhenPollingWasNotRunning() {
        let store = LiveStore(client: makeClient(session: makeSession()))
        let newClient = makeClient(session: makeSession())
        store.rebuild(client: newClient)
        // It did not crash; `stop()`/`start()` inside `rebuild` also handled the "never ran" state.
    }

    // MARK: - Offline states (fix round: double-mutation review)

    // `CancellationError`/`URLError(.cancelled)` means "we killed the request ourselves" (stop() outside
    // the regular interval), not that the app is offline — no error banner may appear.
    func testCancellationDuringTickDoesNotSetLastError() async {
        MockURLProtocol.handler = { _ in .init(statusCode: 0, error: URLError(.cancelled)) }
        let store = LiveStore(client: makeClient(session: makeSession()))

        await store.refreshNow()

        XCTAssertNil(store.lastError, "URLError(.cancelled) must not show up as an offline error")
    }

    // `errorText` must turn `URLError(.notConnectedToInternet)` into the app's own short message, not
    // `String(describing:)` (raw NSError description with Domain/Code) nor the system `localizedDescription`.
    func testFailingTickUsesCzechTextForURLError() async {
        MockURLProtocol.handler = { _ in .init(statusCode: 0, error: URLError(.notConnectedToInternet)) }
        let store = LiveStore(client: makeClient(session: makeSession()))

        await store.refreshNow()

        XCTAssertEqual(store.lastError, "You're not connected to the internet")
    }

    // Both network paths (cf + tailnet) fail with an offline error → `DevdClient` wraps it in
    // `DevdClientError(underlying:)` and `errorText` picks the offline text from it (highest priority),
    // not a concatenated technical description of both attempts.
    func testFailingTickWithBothPathsOfflineUsesOfflineText() async {
        let cfBase = URL(string: "https://cf.example.com")!
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())
        MockURLProtocol.handler = { _ in .init(statusCode: 0, error: URLError(.notConnectedToInternet)) }
        let store = LiveStore(client: client)

        await store.refreshNow()

        XCTAssertEqual(store.lastError, "You're not connected to the internet")
    }

    // MARK: - refreshNow() re-polls cc (fix round: misleading comment in SessionDetailView)

    func testRefreshNowRepollsCc() async throws {
        MockURLProtocol.handler = Self.successHandler
        let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .seconds(5))

        store.start()
        try await Task.sleep(for: .milliseconds(100)) // initial tick + one-off cc load (see start())
        store.stop()
        let afterStart = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/cc-upkeep" }.count
        XCTAssertEqual(afterStart, 1)

        await store.refreshNow()

        let afterRefresh = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/cc-upkeep" }.count
        XCTAssertEqual(afterRefresh, 2, "refreshNow() must re-poll cc-upkeep, not just once at start")
    }

    // MARK: - Retain cyklus (fix round 1)

    /// Regression for a review Critical: `pollTask` used to hold `self` strongly for the whole loop
    /// (`guard let self else { return }` before `while`), so Task↔store was a cycle and `deinit`
    /// never ran without an explicit `stop()`. After the fix (`while let self, ...`) the loop holds
    /// `self` strongly only for one iteration — once the last OUTER strong reference is gone,
    /// the store releases itself at the end of the current iteration, even WITHOUT `stop()`.
    func testStartWithoutStopDoesNotLeakStoreThroughRetainCycle() async throws {
        MockURLProtocol.handler = Self.successHandler
        weak var weakStore: LiveStore?

        do {
            let store = LiveStore(client: makeClient(session: makeSession()), pollInterval: .milliseconds(15))
            weakStore = store
            store.start()
            // Deliberately WITHOUT store.stop() — the only strong reference (`store`) goes away at the end
            // tohohle bloku.
        }

        try await Task.sleep(for: .milliseconds(150)) // ~10 intervals at 15ms; more than 2 is plenty

        XCTAssertNil(weakStore, "the poll Task must not keep the store alive via a retain cycle after the last strong reference is dropped")
    }
}
