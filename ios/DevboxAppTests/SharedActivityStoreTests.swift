import XCTest
@testable import DevboxApp

/// State for the Home Screen widget: round-trip through a (test) UserDefaults suite instead of the App Group,
/// and row selection for the medium/large widget (shared with the B2 Live Activity layout).
final class SharedActivityStoreTests: XCTestCase {
    typealias Attrs = DevboxAgentActivityAttributes
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "SharedActivityStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    // MARK: - Storage

    func testWriteThenReadReturnsSameStateAndTime() throws {
        let state = Attrs.previewB2
        let savedAt = Date(timeIntervalSince1970: 1_792_400_000.25)
        SharedActivityStore.write(state, at: savedAt, defaults: defaults)

        let stored = try XCTUnwrap(SharedActivityStore.read(defaults: defaults))
        XCTAssertEqual(stored.state, state)
        XCTAssertEqual(stored.savedAt, savedAt)
    }

    func testNewerWriteReplacesOlder() throws {
        SharedActivityStore.write(Attrs.previewB2, at: Date(timeIntervalSince1970: 100), defaults: defaults)
        SharedActivityStore.write(Attrs.previewWorking, at: Date(timeIntervalSince1970: 200), defaults: defaults)
        let stored = try XCTUnwrap(SharedActivityStore.read(defaults: defaults))
        XCTAssertEqual(stored.state, Attrs.previewWorking)
        XCTAssertEqual(stored.savedAt, Date(timeIntervalSince1970: 200))
    }

    func testReadWithoutDataIsNil() {
        XCTAssertNil(SharedActivityStore.read(defaults: defaults))
        XCTAssertNil(SharedActivityStore.read(defaults: nil))
    }

    func testAppGroupMatchesEntitlement() {
        XCTAssertEqual(SharedActivityStore.appGroup, "group.com.example.devbox")
        XCTAssertEqual(SharedActivityStore.widgetKind, "DevboxStatusWidget")
    }

    func testDataOlderThanFifteenMinutesIsStale() {
        let saved = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(SharedActivityStore.isStale(savedAt: saved, now: saved.addingTimeInterval(15 * 60)))
        XCTAssertTrue(SharedActivityStore.isStale(savedAt: saved, now: saved.addingTimeInterval(15 * 60 + 1)))
    }

    func testUnchangedContentSkipsWriteAndReloadButRefreshesSavedAtAfterAMinute() throws {
        var reloads = 0
        let t0 = Date(timeIntervalSince1970: 10_000)
        var state = Attrs.previewB2
        XCTAssertTrue(SharedActivityStore.write(state, at: t0, defaults: defaults, reload: { reloads += 1 }))
        state.updatedAt = t0.addingTimeInterval(30)
        XCTAssertFalse(SharedActivityStore.write(state, at: t0.addingTimeInterval(30), defaults: defaults, reload: { reloads += 1 }))
        XCTAssertEqual(reloads, 1)
        XCTAssertEqual(SharedActivityStore.read(defaults: defaults)?.savedAt, t0)

        state.updatedAt = t0.addingTimeInterval(61)
        XCTAssertTrue(SharedActivityStore.write(state, at: t0.addingTimeInterval(61), defaults: defaults, reload: { reloads += 1 }))
        XCTAssertEqual(reloads, 2)
        XCTAssertEqual(SharedActivityStore.read(defaults: defaults)?.savedAt, t0.addingTimeInterval(61))

        // A content change is written right away.
        XCTAssertTrue(SharedActivityStore.write(Attrs.previewWorking, at: t0.addingTimeInterval(62), defaults: defaults, reload: { reloads += 1 }))
        XCTAssertEqual(reloads, 3)
    }

    func testClearRemovesStateAndReloads() {
        var reloads = 0
        SharedActivityStore.write(Attrs.previewB2, at: Date(timeIntervalSince1970: 1), defaults: defaults, reload: {})
        SharedActivityStore.clear(defaults: defaults, reload: { reloads += 1 })
        XCTAssertNil(SharedActivityStore.read(defaults: defaults))
        XCTAssertEqual(reloads, 1)
    }

    func testTimelineBuiltBeforeStaleContainsEntryWhenDataBecomesStale() throws {
        let saved = Date(timeIntervalSince1970: 50_000)
        let now = saved.addingTimeInterval(14 * 60)
        let dates = SharedActivityStore.timelineDates(now: now, savedAt: saved)
        XCTAssertEqual(dates.first, now)
        let staleAt = try XCTUnwrap(dates.last)
        XCTAssertEqual(staleAt, saved.addingTimeInterval(15 * 60 + 1))
        XCTAssertFalse(SharedActivityStore.isStale(savedAt: saved, now: now))
        XCTAssertTrue(SharedActivityStore.isStale(savedAt: saved, now: staleAt))
        // Already stale data / nothing stored: just the current entry.
        XCTAssertEqual(SharedActivityStore.timelineDates(now: saved.addingTimeInterval(20 * 60), savedAt: saved).count, 1)
        XCTAssertEqual(SharedActivityStore.timelineDates(now: now, savedAt: nil), [now])
    }

    // MARK: - Widget rows

    func testMediumShowsTwoWaitingWithReasonRows() {
        let rows = B2Layout.rows(Attrs.previewB2, maxRows: B2Layout.mediumWidgetRows)
        XCTAssertEqual(rows.map(\.title), ["Notes", "game_web"])
        XCTAssertEqual(rows.map(\.status), [.waiting, .waiting])
    }

    func testMediumFallsBackToTwoWorkingWhenNothingWaits() {
        let rows = B2Layout.rows(Attrs.previewWorking, maxRows: B2Layout.mediumWidgetRows)
        XCTAssertEqual(rows.map(\.title), ["Crafting", "Phd_discord"])
        XCTAssertEqual(rows.map(\.status), [.working, .working])
    }

    func testLargeListsSessionsInServerOrderUpToEight() {
        let statuses: [Attrs.Status] = [.waiting, .stalled, .working, .working, .working, .working, .done, .done]
        var sessions = statuses.enumerated().map { index, status in
            Attrs.Session(id: "s\(index)", title: "S\(index)", agent: "claude", project: "p",
                          status: status, since: Date(timeIntervalSince1970: 0))
        }
        sessions.append(.init(id: "s8", title: "S8", agent: "claude", project: "p", status: .unknown,
                              since: Date(timeIntervalSince1970: 0)))
        let state = Attrs.ContentState(counts: .init(waiting: 1, working: 6, done: 3, stalled: 1, unknown: 1),
                                       dot: .waiting, sessions: sessions, overflow: 3,
                                       changedAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))

        let rows = B2Layout.listRows(state, maxRows: B2Layout.largeWidgetRows)
        XCTAssertEqual(rows.map(\.title), ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"])
        XCTAssertEqual(B2Layout.total(state), 12)
        XCTAssertEqual(B2Layout.moreCount(state, shown: rows.count), 4)
    }

    func testLargeWithEverythingVisibleHasNoMore() {
        let state = Attrs.preview
        let rows = B2Layout.listRows(state, maxRows: B2Layout.largeWidgetRows)
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(B2Layout.total(state), 4)
        XCTAssertEqual(B2Layout.moreCount(state, shown: rows.count), 0)
    }

    func testLargeOnMockupStateShowsFiveAndEightMore() {
        let state = Attrs.previewB2
        let rows = B2Layout.listRows(state, maxRows: B2Layout.largeWidgetRows)
        XCTAssertEqual(rows.count, 5)
        XCTAssertEqual(B2Layout.total(state), 13)
        XCTAssertEqual(B2Layout.moreCount(state, shown: rows.count), 8)
    }
}
