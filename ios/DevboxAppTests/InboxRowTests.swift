import XCTest
@testable import DevboxApp

/// The inbox row's presentation rules, ported from dashboard/src/inboxView.ts with the same cases as its tests.
final class InboxRowTests: XCTestCase {
    private func item(_ id: String, _ section: String, reason: String?, since: Int, until: Int? = nil,
                      title: String? = nil, repo: String = "r", lastText: String? = nil) throws -> InboxItem {
        var attention: [String: Any] = ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()]
        if let until { attention["until"] = until }
        let json: [String: Any] = ["sessionId": id, "runtime": "chat", "title": title ?? id, "project": "p", "repo": repo,
                                   "agent": "claude", "attention": attention, "lastText": lastText.map { $0 as Any } ?? NSNull()]
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testSplitNeedsYouFinishedNewestFirstActionKeepsOrder() throws {
        let req = try item("req", "needs_you", reason: "request", since: 1)
        let fail = try item("fail", "needs_you", reason: "failed", since: 2)
        let done = try item("done", "needs_you", reason: "completed", since: 3)
        let doneNew = try item("done-new", "needs_you", reason: "completed", since: 9)
        let s = InboxView.splitNeedsYou([req, done, fail, doneNew])
        XCTAssertEqual(s.action.map(\.sessionId), ["req", "fail"])
        XCTAssertEqual(s.finished.map(\.sessionId), ["done-new", "done"])
    }

    func testRowStatus() throws {
        XCTAssertEqual(InboxView.rowStatus(try item("a", "needs_you", reason: "request", since: 1)), .init(label: "Needs answer", tone: .action))
        XCTAssertEqual(InboxView.rowStatus(try item("a", "needs_you", reason: "completed", since: 1)), .init(label: "Done", tone: .done))
        XCTAssertEqual(InboxView.rowStatus(try item("a", "needs_you", reason: "ci-failed", since: 1))?.tone, .danger)
        XCTAssertNil(InboxView.rowStatus(try item("a", "settled", reason: "completed", since: 1)))
        XCTAssertNil(InboxView.rowStatus(try item("a", "idle", reason: nil, since: 1)))
        XCTAssertEqual(InboxView.rowStatus(try item("a", "snoozed", reason: "completed", since: 1)), .init(label: "Snoozed", tone: .quiet))
        XCTAssertNil(InboxView.reasonStatus(.unknown))
    }

    func testShortAgo() {
        XCTAssertEqual(InboxView.shortAgo(30_000), "now")
        XCTAssertEqual(InboxView.shortAgo(-5), "now")
        XCTAssertEqual(InboxView.shortAgo(7 * 60_000), "7m")
        XCTAssertEqual(InboxView.shortAgo(3 * 3_600_000 + 59 * 60_000), "3h")
        XCTAssertEqual(InboxView.shortAgo(50 * 3_600_000), "2d")
    }

    func testProjectBadge() {
        XCTAssertEqual(InboxView.projectBadge("games/harbor_api").letters, "GH")
        XCTAssertEqual(InboxView.projectBadge("acme").letters, "AC")
        XCTAssertEqual(InboxView.projectBadge("Údržba města").letters, "ÚM")
        XCTAssertEqual(InboxView.projectBadge("").letters, "?")
        // The same slot as the dashboard's hash ((h * 31 + codePoint) >>> 0) % 6.
        XCTAssertEqual(InboxView.projectBadge("acme").slot, 4)
        XCTAssertEqual(InboxView.projectBadge("lumen").slot, 5)
    }

    func testPlainPreview() {
        XCTAssertEqual(InboxView.plainPreview("Ve `scratch/` jsem **hotovo**\n\n# Done"), "Ve scratch/ jsem hotovo # Done")
        XCTAssertEqual(InboxView.plainPreview("## Summary: all `green`"), "Summary: all green")
        XCTAssertEqual(InboxView.plainPreview("edit __init__.py and my__var"), "edit __init__.py and my__var")
        XCTAssertEqual(InboxView.plainPreview("a __bold__ word"), "a bold word")
    }

    func testRowTitle() throws {
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "Boosting")) == ("Boosting", false))
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "p/r", lastText: "Fixed the `test`")) == ("Fixed the test", true))
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "p/r")) == ("r #14", false))
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-r", "idle", reason: nil, since: 1, title: "p/r")) == ("r", false))
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-notes-13", "idle", reason: nil, since: 1, title: "p/notes-13", repo: "notes-13")) == ("notes-13", false))
        // A message of only whitespace names nothing: the repo and session number instead.
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "p/r", lastText: "  \n ")) == ("r #14", false))
        // A failed session named after its path takes the error message as a stand-in title.
        XCTAssertTrue(try InboxView.rowTitle(item("dev-p-r", "needs_you", reason: "failed", since: 1, title: "p/r", lastText: "Error: **build** failed")) == ("Error: build failed", true))
    }

    /// One rule set with the dashboard (inboxView.ts statusParts): a compact row shows its reason's mark whatever its
    /// group. devd sends idle without a reason, so an Idle row has none in practice.
    func testCompactRowShowsItsReasonMarkAsOnTheWeb() throws {
        let p = InboxView.statusParts(try item("a", "idle", reason: "completed", since: 60_000), now: 180_000, compact: true)
        XCTAssertEqual(p, .init(mark: .init(label: "Done", tone: .done), showLabel: false, until: nil, ago: "2m"))
        XCTAssertNil(InboxView.statusParts(try item("a", "idle", reason: nil, since: 60_000), now: 180_000, compact: true)?.mark)
    }

    func testMetaTailSeparatesAgentAndTmux() throws {
        let json: [String: Any] = ["sessionId": "dev-p-r-3", "runtime": "tmux", "title": "p/r", "project": "p", "repo": "r", "agent": "claude",
                                   "attention": ["section": "idle", "since": 1, "reason": NSNull()], "lastText": NSNull()]
        let tmux = try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(InboxView.metaTail(tmux).count, 2)
        XCTAssertEqual(InboxView.metaTail(tmux).last, "tmux")
        XCTAssertEqual(InboxView.metaTail(try item("a", "idle", reason: nil, since: 1)).count, 1)
    }

    func testStatusParts() throws {
        let now = 10 * 60_000
        XCTAssertNil(InboxView.statusParts(try item("a", "idle", reason: nil, since: 0), now: now, compact: true))
        XCTAssertEqual(InboxView.statusParts(try item("a", "snoozed", reason: "completed", since: 0, until: 99), now: now, compact: false),
                       .init(mark: .init(label: "Snoozed", tone: .quiet), showLabel: true, until: 99, ago: ""))
        XCTAssertEqual(InboxView.statusParts(try item("a", "needs_you", reason: "completed", since: now - 3 * 60_000), now: now, compact: true),
                       .init(mark: .init(label: "Done", tone: .done), showLabel: false, until: nil, ago: "3m"))
        XCTAssertEqual(InboxView.statusParts(try item("a", "settled", reason: "ci-failed", since: 1), now: now, compact: true)?.showLabel, true)
        XCTAssertEqual(InboxView.statusParts(try item("a", "idle", reason: nil, since: now - 120_000), now: now, compact: true),
                       .init(mark: nil, showLabel: false, until: nil, ago: "2m"))
    }
}
