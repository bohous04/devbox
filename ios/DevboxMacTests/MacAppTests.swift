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
        var json: [String: Any] = ["sessionId": "s", "runtime": "chat", "title": "t", "project": "p", "repo": "r", "agent": "claude",
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
    }

    func testCutLinksNameTheFullAddress() {
        let long = "https://example.com/docs/guides/offline-sync/retry-queue/configuration-reference-page"
        XCTAssertEqual(ChatInline.cutLinks("See \(long) for more."), long)
        XCTAssertNil(ChatInline.cutLinks("See https://example.com/a for more."), "a link shown whole needs no tooltip")
        XCTAssertNil(ChatInline.cutLinks("No links here."))
    }

    func testSidebarAgentGlyphAndConnection() {
        XCTAssertEqual(AgentProfiles.glyph("claude"), "asterisk")
        XCTAssertEqual(AgentProfiles.glyph("codex"), "hexagon")
        XCTAssertEqual(AgentProfiles.glyph("grok"), "bolt")
        XCTAssertEqual(AgentProfiles.glyph("something-new"), "wind")
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
