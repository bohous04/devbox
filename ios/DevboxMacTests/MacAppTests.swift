import Combine
import XCTest
@testable import DevboxApp

/// The test bundle is hosted by the app: its startup must not touch the real app's state.
@MainActor
final class MacAppTests: XCTestCase {
    func testHostedTestRunSkipsTheAppsStartup() throws {
        let delegate = try XCTUnwrap(MacAppDelegate.current)
        XCTAssertTrue(delegate.state.isTestRun)
        XCTAssertFalse(delegate.state.startedLoginItem, "a test run must not register the login item or set its flag")
        XCTAssertNil(delegate.state.inbox, "a test run does not connect to devd")
    }

    /// A fixture run (screenshots) keeps a throwaway window list and never registers the login item.
    func testFixtureRunLeavesTheRealAppStateAlone() {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.startLoginItem()
        XCTAssertFalse(state.startedLoginItem)
        XCTAssertEqual(state.windows.restorePlan(current: nil).open, [], "a fixture run restores no threads of the real app")
    }

    private func item(_ section: String, reason: String?, since: Int = 0, branch: String? = nil) throws -> InboxItem {
        var json: [String: Any] = ["sessionId": "dev-p-r-7", "runtime": "chat", "title": "t", "project": "p", "repo": "r", "agent": "claude",
                                   "attention": ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()],
                                   "lastText": NSNull()]
        if let branch { json["branch"] = branch }
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// A sidebar row that needs you says why in one word; every other row shows its age.
    func testSidebarRowStateIsOneWordOrTheAge() throws {
        XCTAssertEqual(MacInboxRow.word(try item("needs_you", reason: "request"))?.text, "Answer")
        XCTAssertEqual(MacInboxRow.word(try item("needs_you", reason: "failed"))?.text, "Failed")
        XCTAssertNil(MacInboxRow.word(try item("needs_you", reason: "completed")), "a finished run shows its age")
        XCTAssertNil(MacInboxRow.word(try item("idle", reason: "failed")), "only Needs you rows get the word")
        XCTAssertEqual(MacInboxRow.when(try item("idle", reason: nil, since: 1_000), now: 1_000 + 3 * 60_000), "3m")
    }

    /// Columns that fit keep their width and the last takes the rest; a narrow column keeps its width when the
    /// others have to share.
    func testTableColumnsShareByContent() {
        XCTAssertEqual(TableColumns.widths(natural: [100, 50], available: 300), [100, 200])
        XCTAssertEqual(TableColumns.widths(natural: [400, 80], available: 300), [220, 80])
        XCTAssertEqual(TableColumns.widths(natural: [400, 400], available: 300), [150, 150])
    }

    /// A row cut by the top edge with a sliver showing, and quiet notices under it, get room under the end; a tall part stays.
    func testThreadEdgeLiftsOnlyASliver() {
        let top: CGFloat = 52
        func row(_ y: CGFloat, _ h: CGFloat, quiet: Bool = false) -> ThreadEdge.Row { .init(rect: CGRect(x: 0, y: y, width: 10, height: h), quiet: quiet) }
        XCTAssertEqual(ThreadEdge.pad([row(-200, 270)], top: top), 18)
        XCTAssertNil(ThreadEdge.pad([row(-200, 600)], top: top), "most of the row shows: it stays")
        XCTAssertNil(ThreadEdge.pad([row(60, 100)], top: top), "nothing cut")
        XCTAssertEqual(ThreadEdge.pad([row(-200, 270), row(86, 20, quiet: true), row(122, 300)], top: top), 54,
                       "a quiet notice under the sliver goes with it")
        XCTAssertEqual(ThreadEdge.pad([row(60, 20, quiet: true), row(96, 300)], top: top), 28, "a notice first in view goes")
    }

    /// The second line: what a needs-you row asks; for the others the branch when devd recorded one, else the message.
    func testSidebarRowPlacePrefersTheBranch() throws {
        XCTAssertEqual(MacInboxRow.secondLine(try item("idle", reason: nil, branch: "retry-queue"), detail: "msg"), "p/r  ·  retry-queue")
        XCTAssertEqual(MacInboxRow.secondLine(try item("idle", reason: nil), detail: "msg"), "p/r  ·  msg")
        XCTAssertEqual(MacInboxRow.secondLine(try item("idle", reason: nil), detail: ""), "p/r")
        XCTAssertEqual(MacInboxRow.secondLine(try item("needs_you", reason: "request", branch: "b"), detail: "May I run it?"), "r  ·  May I run it?",
                       "a row that needs you names its repo and says what it asks")
        // devd's own branch repeats the repo: only its number distinguishes the row.
        XCTAssertEqual(MacInboxRow.secondLine(try item("idle", reason: nil, branch: "session/r-7"), detail: "msg"), "p/r  ·  #7")
    }

    func testCutLinksNameTheFullAddress() {
        let long = "https://example.com/docs/guides/offline-sync/retry-queue/configuration-reference-page"
        XCTAssertEqual(ChatInline.cutLinks("See \(long) for more."), long)
        XCTAssertNil(ChatInline.cutLinks("See https://example.com/a for more."), "a link shown whole needs no tooltip")
        XCTAssertNil(ChatInline.cutLinks("No links here."))
    }

    func testSidebarAgentGlyphAndConnection() {
        XCTAssertEqual(MacInboxRow.agentGlyph("claude"), "asterisk")
        XCTAssertEqual(MacInboxRow.agentGlyph("codex"), "hexagon")
        XCTAssertEqual(MacInboxRow.agentGlyph("grok"), "bolt")
        XCTAssertEqual(MacInboxRow.agentGlyph("something-new"), "wind")
        XCTAssertEqual(MacInboxSidebar.connection(paused: false, loadError: nil, loaded: true).text, "Connected")
        XCTAssertEqual(MacInboxSidebar.connection(paused: true, loadError: "x", loaded: true).text, "Reconnecting — refreshing every 5 s")
        XCTAssertEqual(MacInboxSidebar.connection(paused: false, loadError: "x", loaded: false).text, "Can't reach devd")
        XCTAssertEqual(MacInboxSidebar.connection(paused: false, loadError: nil, loaded: false).text, "Connecting…")
    }

    func testMenuBarCountSaysWhenItIsStale() {
        XCTAssertEqual(NeedsYouBadge.text(count: 2, stale: false), "2")
        XCTAssertEqual(NeedsYouBadge.text(count: 2, stale: true), "2?")
        XCTAssertEqual(NeedsYouBadge.text(count: 0, stale: true), "?")
        XCTAssertNil(NeedsYouBadge.text(count: 0, stale: false))
    }

    func testSidebarShelvesStartShut() {
        for shelf in ["Working", "Snoozed", "Settled"] { XCTAssertFalse(MacSidebarLayout.startsOpen(shelf), shelf) }
    }

    /// The shelves pinned under the scrolling groups: Working, Snoozed, Settled in that order, the empty ones left out;
    /// none at all (so no block and no rule) when every shelf is empty.
    func testPinnedShelvesAreTheNonEmptyShelvesInOrder() throws {
        let working = try item("working", reason: "running"), settled = try item("settled", reason: "completed")
        let idle = try item("idle", reason: nil), needs = try item("needs_you", reason: "request")
        let g = InboxView.Groups(needsYou: [needs], working: [working], idle: [idle], snoozed: [], settled: [settled])
        let pinned = MacSidebarLayout.pinnedShelves(g)
        XCTAssertEqual(pinned.map(\.label), ["Working", "Settled"])
        XCTAssertEqual(pinned.map(\.preview), [true, false])
        XCTAssertEqual(pinned.map(\.items.count), [1, 1])
        let none = InboxView.Groups(needsYou: [needs], working: [], idle: [idle], snoozed: [], settled: [])
        XCTAssertTrue(MacSidebarLayout.pinnedShelves(none).isEmpty)
        // What scrolls above them: needs you split from the merely finished runs (capped at five), then idle.
        let finished = try item("needs_you", reason: "completed")
        let all = InboxView.Groups(needsYou: [needs, finished], working: [working], idle: [idle], snoozed: [], settled: [settled])
        XCTAssertEqual(MacSidebarLayout.scrollingGroups(all).map(\.label), ["Needs you", "Finished", "Idle"])
        XCTAssertEqual(MacSidebarLayout.scrollingGroups(all).map(\.cap), [nil, 5, nil])
        XCTAssertEqual(MacSidebarLayout.scrollingGroups(none).map(\.label), ["Needs you", "Idle"])
    }

    /// ↑/↓ cross the seam between the scrolling groups and the pinned shelves; elsewhere each list moves on its own.
    func testArrowsCrossBetweenTheGroupsAndTheShelves() {
        let groups = ["a", "b"], shelves = ["w", "s"]
        XCTAssertEqual(MacSidebarLayout.crossing(from: "b", down: true, groups: groups, shelves: shelves), "w")
        XCTAssertEqual(MacSidebarLayout.crossing(from: "w", down: false, groups: groups, shelves: shelves), "b")
        XCTAssertNil(MacSidebarLayout.crossing(from: "a", down: true, groups: groups, shelves: shelves))
        XCTAssertNil(MacSidebarLayout.crossing(from: "s", down: false, groups: groups, shelves: shelves))
        XCTAssertNil(MacSidebarLayout.crossing(from: "w", down: true, groups: groups, shelves: shelves))
        XCTAssertNil(MacSidebarLayout.crossing(from: "b", down: true, groups: groups, shelves: []), "every shelf shut: nowhere to go")
        XCTAssertNil(MacSidebarLayout.crossing(from: "w", down: false, groups: [], shelves: shelves))
        XCTAssertNil(MacSidebarLayout.crossing(from: nil, down: true, groups: groups, shelves: shelves))
    }

    /// The pinned block is as tall as its content, up to 45 % of the sidebar; it scrolls inside beyond that.
    func testPinnedBlockGrowsUpTo45PercentOfTheSidebar() {
        XCTAssertEqual(MacSidebarLayout.shelfHeight(content: 90, sidebar: 800, chrome: 90), 90)
        XCTAssertEqual(MacSidebarLayout.shelfHeight(content: 500, sidebar: 800, chrome: 90), 360)
        XCTAssertEqual(MacSidebarLayout.shelfHeight(content: 360, sidebar: 800, chrome: 90), 360)
    }

    /// In a short window the scrolling groups keep 120 pt between the tools and the footer, so Needs you stays in reach.
    func testPinnedBlockLeavesTheGroupsRoomInAShortWindow() {
        // 350 − 90 (tools and footer) − 120 = 140, under 45 % (157.5).
        XCTAssertEqual(MacSidebarLayout.shelfHeight(content: 400, sidebar: 350, chrome: 90), 140)
        XCTAssertEqual(MacSidebarLayout.shelfHeight(content: 108, sidebar: 350, chrome: 90), 108)
        XCTAssertEqual(MacSidebarLayout.shelfHeight(content: 400, sidebar: 150, chrome: 90), 0, "no room at all: no block")
    }

    /// Before the list measures itself (and on macOS 14) its height comes from its headers and visible rows.
    func testPinnedBlockEstimateMatchesTheDrawnList() {
        // The screenshot test's render: three shut shelves are 108 pt, with Working's one row open 158 pt.
        XCTAssertEqual(MacSidebarLayout.estimatedContent(headers: 3, rows: 0), 108)
        XCTAssertEqual(MacSidebarLayout.estimatedContent(headers: 3, rows: 1), 158)
    }

    func testFocusingAThreadLeavesTheDashboardOnlyInItsWindow() {
        XCTAssertNil(MacWindow.page(.stats, afterFocusOn: "a", showing: "a"))
        XCTAssertEqual(MacWindow.page(.stats, afterFocusOn: "a", showing: "b"), .stats)
        XCTAssertEqual(MacWindow.page(.stats, afterFocusOn: "a", showing: nil), .stats)
    }

    func testOpenThreadAnnouncesTheFocusedThread() {
        let state = MacAppState(isTestRun: true, isFixtureRun: false)
        var seen: [String] = []
        let watch = state.focusedThread.sink { seen.append($0) }
        state.openThread("dev-x")
        watch.cancel()
        XCTAssertEqual(seen, ["dev-x"])
    }

    func testNeedsYouCountLeavesOutFinishedRuns() {
        func item(_ id: String, _ reason: String) -> InboxItem {
            try! JSONDecoder().decode(InboxItem.self, from: Data("""
            {"sessionId":"\(id)","runtime":"chat","title":"t","project":"p","repo":"r","agent":"claude",
             "attention":{"section":"needs_you","reason":"\(reason)","since":1},"lastText":null}
            """.utf8))
        }
        XCTAssertEqual(InboxView.needsYouCount([item("a", "request"), item("b", "completed"), item("c", "failed")]), 2)
    }

    func testDashboardListsEveryPageOnceInTheWebOrder() {
        let listed = MacDashboardPage.sections.flatMap(\.pages)
        XCTAssertEqual(Set(listed), Set(MacDashboardPage.allCases))
        XCTAssertEqual(listed.count, MacDashboardPage.allCases.count)
        XCTAssertEqual(MacDashboardPage.sections.map(\.title), ["Workspace", "Operations", "System"])
        XCTAssertEqual(listed.map(\.title), ["Overview", "Sessions", "Folders", "Statistics", "AI limits", "Unpushed",
                                             "Schedules", "Agent upkeep", "Production writes", "Operations", "SSH keys",
                                             "Hardware", "Activity"])
    }
}
