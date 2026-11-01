import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here, not duplicated. The pure functions are a 1:1 port of `dashboard/src/logView.ts` (`typesForGroups`/
/// `toggle`/`ungroupedTypes`), same inputs/outputs as the web tests.
@MainActor
final class LogStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> LogStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return LogStore(client: DevdClient(endpoints: endpoints, session: session), perPage: 2)
    }

    // MARK: - ungroupedTypes

    func testUngroupedTypesExcludesKnownGroupTypes() {
        XCTAssertEqual(LogStore.ungroupedTypes(["open", "stop"]), [])
        XCTAssertEqual(LogStore.ungroupedTypes(["open", "mystery_type"]), ["mystery_type"])
    }

    // MARK: - typesForGroups

    func testTypesForGroupsEmptySelectionMeansNoFilter() {
        XCTAssertEqual(LogStore.typesForGroups([], allTypes: ["open", "stop"]), [])
    }

    func testTypesForGroupsExpandsGroupIdsToTypes() {
        let result = Set(LogStore.typesForGroups(["agent"], allTypes: ["agent_done", "agent_blocked", "open"]))
        XCTAssertEqual(result, ["agent_done", "agent_blocked"])
    }

    func testTypesForGroupsOtherCollectsUngroupedTypes() {
        let result = Set(LogStore.typesForGroups(["other"], allTypes: ["open", "mystery_type"]))
        XCTAssertEqual(result, ["mystery_type"])
    }

    func testTypesForGroupsDropsTypesNotPresentInData() {
        // The "agent" group has three types, but only one occurs in the data.
        let result = LogStore.typesForGroups(["agent"], allTypes: ["agent_done"])
        XCTAssertEqual(result, ["agent_done"])
    }

    func testTypesForGroupsSelectedGroupWithNoMatchYieldsNoneSentinel() {
        // A selected group with no match in the data MUST NOT return an empty array (= no filter) — otherwise
        // checking it would show EVERYTHING instead of NOTHING.
        let result = LogStore.typesForGroups(["host"], allTypes: ["open", "stop"])
        XCTAssertEqual(result, ["__none__"])
    }

    // MARK: - toggle

    func testToggleAddsThenRemoves() {
        XCTAssertEqual(LogStore.toggle([], "agent"), ["agent"])
        XCTAssertEqual(LogStore.toggle(["agent"], "agent"), [])
        XCTAssertEqual(LogStore.toggle(["agent"], "cc"), ["agent", "cc"])
    }

    // MARK: - reload / loadMore (fetch + pagination)

    private func page(_ ids: [Int], total: Int, types: [String] = ["open"]) -> Data {
        let items = ids.map { #"{"id":\#($0),"ts":1000,"session_id":"dev-x","type":"open","data":null}"# }.joined(separator: ",")
        let typesJSON = types.map { "\"\($0)\"" }.joined(separator: ",")
        return #"{"items":[\#(items)],"total":\#(total),"types":[\#(typesJSON)]}"#
            .data(using: .utf8)!
    }

    func testReloadSetsOffsetZeroAndLimitFromPerPage() async {
        let store = makeStore { _ in .init(statusCode: 200, data: self.page([1, 2], total: 5)) }

        await store.reload(session: nil, selectedGroups: [])

        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/events")
        let query = req.url?.query ?? ""
        XCTAssertTrue(query.contains("offset=0"))
        XCTAssertTrue(query.contains("limit=2"))
        XCTAssertEqual(store.items.map(\.id), [1, 2])
        XCTAssertEqual(store.total, 5)
        XCTAssertTrue(store.hasMore)
    }

    func testLoadMoreAppendsAndAdvancesOffset() async {
        var call = 0
        let store = makeStore { _ in
            call += 1
            return call == 1 ? .init(statusCode: 200, data: self.page([1, 2], total: 3)) : .init(statusCode: 200, data: self.page([3], total: 3))
        }
        await store.reload(session: nil, selectedGroups: [])

        await store.loadMore()

        XCTAssertEqual(store.items.map(\.id), [1, 2, 3])
        XCTAssertFalse(store.hasMore)
        let secondReq = MockURLProtocol.capturedRequests[1]
        XCTAssertTrue((secondReq.url?.query ?? "").contains("offset=2"))
    }

    func testLoadMoreNoOpWhenNoMorePages() async {
        let store = makeStore { _ in .init(statusCode: 200, data: self.page([1], total: 1)) }
        await store.reload(session: nil, selectedGroups: [])
        XCTAssertFalse(store.hasMore)

        await store.loadMore()

        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1, "hasMore == false must not start another request")
    }

    func testReloadIncludesSessionAndTypesInQuery() async {
        let store = makeStore { _ in .init(statusCode: 200, data: self.page([1], total: 1)) }

        await store.reload(session: "dev-x-y", selectedGroups: ["agent"])

        let req = MockURLProtocol.capturedRequests[0]
        let query = req.url?.query ?? ""
        XCTAssertTrue(query.contains("session=dev-x-y"))
        XCTAssertTrue(query.contains("types="))
    }

    // MARK: - loaded (H0 fix pack: an empty result must not stay a ProgressView forever)

    func testLoadedIsFalseBeforeFirstReload() {
        let store = makeStore { _ in .init(statusCode: 200, data: self.page([], total: 0)) }
        XCTAssertFalse(store.loaded)
    }

    /// Key regression test: 0 rows is a valid, SUCCESSFUL fetch result — `loaded` must flip on,
    /// so `LogScreen` shows "No events match" instead of a `ProgressView` spinning forever.
    func testLoadedBecomesTrueAfterSuccessfulReloadWithZeroItems() async {
        let store = makeStore { _ in .init(statusCode: 200, data: self.page([], total: 0)) }

        await store.reload(session: nil, selectedGroups: [])

        XCTAssertTrue(store.loaded)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertNil(store.error)
    }

    func testLoadedBecomesTrueEvenWhenReloadFails() async {
        let store = makeStore { _ in .init(statusCode: 500) }

        await store.reload(session: nil, selectedGroups: [])

        XCTAssertTrue(store.loaded)
        XCTAssertNotNil(store.error)
    }

    // MARK: - reload keeps data on a refresh with the SAME query, clears it on a CHANGE (review)

    /// `.refreshable` in `LogScreen` calls `reload` again with the SAME filter (pull-to-refresh) —
    /// the app must not clear items just because `reload` was called a second time. Verified via a
    /// failing second fetch: if the app cleared items up front (regardless of whether the query changed),
    /// the arrays would stay empty after the error; instead it keeps the old page in place.
    func testReloadWithSameQueryKeepsItemsOnRefreshEvenIfItFails() async {
        var call = 0
        let store = makeStore { _ in
            call += 1
            return call == 1 ? .init(statusCode: 200, data: self.page([1, 2], total: 2)) : .init(statusCode: 500)
        }
        await store.reload(session: nil, selectedGroups: [])
        XCTAssertEqual(store.items.map(\.id), [1, 2])
        XCTAssertTrue(store.loaded)

        await store.reload(session: nil, selectedGroups: [])

        XCTAssertEqual(store.items.map(\.id), [1, 2], "a refresh with the same query must not clear visible data")
        XCTAssertTrue(store.loaded, "loaded must not flash back to false when the query did not change")
        XCTAssertNotNil(store.error)
    }

    /// Conversely, a REAL query change (a different `session`) must drop the old data RIGHT AWAY — even if
    /// the new fetch fails, rows from the previous filter must not linger under the error message.
    func testReloadWithChangedQueryClearsItemsImmediately() async {
        var call = 0
        let store = makeStore { _ in
            call += 1
            return call == 1 ? .init(statusCode: 200, data: self.page([1, 2], total: 2)) : .init(statusCode: 500)
        }
        await store.reload(session: nil, selectedGroups: [])
        XCTAssertEqual(store.items.map(\.id), [1, 2])

        await store.reload(session: "dev-x-y", selectedGroups: [])

        XCTAssertTrue(store.items.isEmpty, "a filter/session change must clear the old data from the previous query")
    }
}
