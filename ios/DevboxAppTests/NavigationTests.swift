import XCTest
@testable import DevboxApp

/// Tab order and the "More" groups as on the web (`dashboard/src/nav.ts` `NAV`/`NAV_GROUPS`) + where
/// a deep link from a push notification / Live Activity leads. `SessionsContainer` reads `AppTab.allCases`
/// and `AppTab.route(for:)` directly, so the test guards the real behavior, not a copy.
final class NavigationTests: XCTestCase {
    /// Inbox first (step 5); Hardware left the bar for it, as on the web (it lives in More → System).
    func testTabOrderInboxFirst() {
        XCTAssertEqual(AppTab.allCases, [.inbox, .overview, .sessions, .stats, .more])
        XCTAssertEqual(AppTab.allCases.map(\.title), ["Inbox", "Overview", "Sessions", "Statistics", "More"])
        XCTAssertEqual(AppTab.inbox.systemImage, "tray")
        XCTAssertEqual(AppTab.overview.systemImage, "gauge")
        XCTAssertEqual(AppTab.stats.systemImage, "chart.bar")
    }

    func testAppStartsOnTheInbox() {
        XCTAssertEqual(AppTab.initial, .inbox)
    }

    /// A chat session's notification or `devbox://thread/<id>` opens its thread on the Inbox tab's stack.
    func testThreadDeepLinkOpensTheChatInTheInboxTab() {
        let route = AppTab.route(for: .thread(id: "dev-shop-cms"))
        XCTAssertEqual(route, .inbox(path: ["dev-shop-cms"]))
        XCTAssertEqual(route.tab, .inbox)
    }

    func testDeepLinkSwitchesToSessionsTabAndOpensSession() {
        let route = AppTab.route(for: .session(id: "dev-shop-cms", terminal: true))
        XCTAssertEqual(route, .sessions(path: ["dev-shop-cms"]))
        XCTAssertEqual(route.tab, .sessions)
    }

    func testMoreDeepLinkSwitchesToMoreTabWithPath() {
        let route = AppTab.route(for: .more(.prodWrites))
        XCTAssertEqual(route, .more(path: [.prodWrites]))
        XCTAssertEqual(route.tab, .more)
    }

    /// The vault has no tab of its own — unlocking is a sheet over the current tab.
    func testVaultDeepLinkRoutesToVaultUnlock() {
        let route = AppTab.route(for: .vault)
        XCTAssertEqual(route, .vault)
        XCTAssertNil(route.tab)
    }

    func testMoreGroupsMatchWeb() {
        XCTAssertEqual(MoreMenu.sections.map(\.title), ["Workspace", "Operations", "System"])
        XCTAssertEqual(MoreMenu.sections.map { $0.items.map(\.title) }, [
            ["Folders", "AI limits & accounts", "Unpushed"],
            ["Schedules", "Agent upkeep", "Production writes", "Operations", "SSH keys"],
            ["Hardware", "Activity", "Notifications", "Settings"],
        ])
    }
}
