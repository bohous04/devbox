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

    /// A row cut by the top edge with a sliver showing gets that much room under the end; a tall part stays.
    func testThreadEdgeLiftsOnlyASliver() {
        let top: CGFloat = 52
        XCTAssertEqual(ThreadEdge.pad([CGRect(x: 0, y: -200, width: 10, height: 270)], top: top), 18)
        XCTAssertNil(ThreadEdge.pad([CGRect(x: 0, y: -200, width: 10, height: 600)], top: top), "most of the row shows: it stays")
        XCTAssertNil(ThreadEdge.pad([CGRect(x: 0, y: 60, width: 10, height: 100)], top: top), "nothing cut")
    }

    /// The second line names the branch when devd recorded one, else the message.
    func testSidebarRowPlacePrefersTheBranch() throws {
        XCTAssertEqual(MacInboxRow.place(try item("idle", reason: nil, branch: "retry-queue"), detail: "msg"), "p/r  ·  retry-queue")
        XCTAssertEqual(MacInboxRow.place(try item("idle", reason: nil), detail: "msg"), "p/r  ·  msg")
        XCTAssertEqual(MacInboxRow.place(try item("idle", reason: nil), detail: ""), "p/r")
    }

    func testSidebarAgentGlyphAndConnection() {
        XCTAssertEqual(MacInboxRow.agentGlyph("claude").symbol, "asterisk")
        XCTAssertEqual(MacInboxRow.agentGlyph("codex").symbol, "hexagon")
        XCTAssertEqual(MacInboxRow.agentGlyph("grok").symbol, "bolt")
        XCTAssertEqual(MacInboxRow.agentGlyph("something-new").symbol, "wind")
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
}
