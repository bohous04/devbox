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

    func testMenuBarCountSaysWhenItIsStale() {
        XCTAssertEqual(NeedsYouBadge.text(count: 2, stale: false), "2")
        XCTAssertEqual(NeedsYouBadge.text(count: 2, stale: true), "2?")
        XCTAssertEqual(NeedsYouBadge.text(count: 0, stale: true), "?")
        XCTAssertNil(NeedsYouBadge.text(count: 0, stale: false))
    }
}
