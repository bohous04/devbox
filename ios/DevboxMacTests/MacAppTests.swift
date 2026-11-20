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

    private func item(_ section: String, reason: String?, since: Int = 0) throws -> InboxItem {
        let json: [String: Any] = ["sessionId": "s", "runtime": "chat", "title": "t", "project": "p", "repo": "r", "agent": "claude",
                                   "attention": ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()],
                                   "lastText": NSNull()]
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

    func testMenuBarCountSaysWhenItIsStale() {
        XCTAssertEqual(NeedsYouBadge.text(count: 2, stale: false), "2")
        XCTAssertEqual(NeedsYouBadge.text(count: 2, stale: true), "2?")
        XCTAssertEqual(NeedsYouBadge.text(count: 0, stale: true), "?")
        XCTAssertNil(NeedsYouBadge.text(count: 0, stale: false))
    }
}
