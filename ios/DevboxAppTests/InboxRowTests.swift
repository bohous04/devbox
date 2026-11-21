import XCTest
@testable import DevboxApp

/// The inbox row's presentation rules, ported from dashboard/src/inboxView.ts with the same cases as its tests.
final class InboxRowTests: XCTestCase {
    private func item(_ id: String, _ section: String, reason: String?, since: Int, until: Int? = nil,
                      title: String? = nil, repo: String = "r", lastText: String? = nil, topic: String? = nil) throws -> InboxItem {
        var attention: [String: Any] = ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()]
        if let until { attention["until"] = until }
        var json: [String: Any] = ["sessionId": id, "runtime": "chat", "title": title ?? id, "project": "p", "repo": repo,
                                   "agent": "claude", "attention": attention, "lastText": lastText.map { $0 as Any } ?? NSNull()]
        if let topic { json["topic"] = topic }
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

    /// inboxView.test.ts rowTitle: name, else topic, else repo #n; never the newest message.
    func testRowTitle() throws {
        XCTAssertEqual(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "Boosting", topic: "Add a retry queue")), "Boosting")
        XCTAssertEqual(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "p/r", lastText: "OK", topic: "Add a retry queue")), "Add a retry queue")
        // The newest message changes with every reply: it is the preview, never the title.
        XCTAssertEqual(try InboxView.rowTitle(item("dev-p-r-14", "idle", reason: nil, since: 1, title: "p/r", lastText: "Fixed the `test`")), "r #14")
        XCTAssertEqual(try InboxView.rowTitle(item("dev-p-r", "idle", reason: nil, since: 1, title: "p/r")), "r")
        XCTAssertEqual(try InboxView.rowTitle(item("dev-p-notes-13", "idle", reason: nil, since: 1, title: "p/notes-13", repo: "notes-13")), "notes-13")
        XCTAssertEqual(try InboxView.rowTitle(item("dev-p-r", "needs_you", reason: "failed", since: 1, title: "p/r", lastText: "Error: **build** failed")), "r")
    }

    /// The iPhone thread header names the thread by the same chain, with the topic from the thread's first message.
    func testSessionTitleIsTheRowTitleChain() {
        XCTAssertEqual(InboxView.sessionTitle(sessionId: "dev-p-r-14", name: nil, project: "p", repo: "r", topic: "Add a retry queue"), "Add a retry queue")
        XCTAssertEqual(InboxView.sessionTitle(sessionId: "dev-p-r-14", name: " Boosting ", project: "p", repo: "r", topic: "Add a retry queue"), "Boosting")
        XCTAssertEqual(InboxView.sessionTitle(sessionId: "dev-p-r-14", name: "  ", project: "p", repo: "r", topic: nil), "r #14")
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
        XCTAssertEqual(InboxView.metaTail(tmux, showAgent: true), ["Claude", "tmux"])
        XCTAssertEqual(InboxView.metaTail(try item("a", "idle", reason: nil, since: 1), showAgent: true), ["Claude"])
        // One agent on every visible row says nothing: left out.
        XCTAssertEqual(InboxView.metaTail(tmux, showAgent: false), ["tmux"])
    }

    /// inboxView.test.ts mixedAgents: the agent is shown only while the visible rows use more than one.
    func testAgentShownOnlyWhenTheVisibleRowsMixAgents() throws {
        let claude = try item("a", "idle", reason: nil, since: 1)
        XCTAssertFalse(InboxView.mixedAgents([claude, try item("b", "idle", reason: nil, since: 1)]))
        XCTAssertFalse(InboxView.mixedAgents([]))
        let json: [String: Any] = ["sessionId": "c", "runtime": "chat", "title": "p/r", "project": "p", "repo": "r", "agent": "codex",
                                   "attention": ["section": "idle", "since": 1, "reason": NSNull()], "lastText": NSNull()]
        let codex = try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertTrue(InboxView.mixedAgents([claude, codex]))
    }

    /// devd's own branch (`session/<repo>-<n>`) says only its number; nothing when the title already ends in it.
    func testBranchLabelKeepsWhatDistinguishes() throws {
        func branched(_ branch: String?, title: String = "p/r", id: String = "dev-p-r-14", repo: String = "r", topic: String? = nil) throws -> InboxItem {
            var json: [String: Any] = ["sessionId": id, "runtime": "tmux", "title": title, "project": "p", "repo": repo, "agent": "claude",
                                       "attention": ["section": "idle", "since": 1, "reason": NSNull()], "lastText": NSNull()]
            if let branch { json["branch"] = branch }
            if let topic { json["topic"] = topic }
            return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
        }
        XCTAssertEqual(InboxView.branchLabel(try branched("session/r-14", title: "Boosting")), "#14")
        XCTAssertEqual(InboxView.branchLabel(try branched("session/r-14")), nil, "the title is already “r #14”")
        XCTAssertEqual(InboxView.branchLabel(try branched("retry-queue")), "retry-queue")
        XCTAssertEqual(InboxView.branchLabel(try branched("main", title: "Boosting")), "main")
        XCTAssertEqual(InboxView.branchLabel(try branched("session/other-3", title: "Boosting")), "session/other-3")
        XCTAssertEqual(InboxView.branchLabel(try branched("feature/x-12", title: "Boosting")), "feature/x-12")
        XCTAssertEqual(InboxView.branchLabel(try branched("session/r-14", title: "Fix bug #14")), "#14", "a name that only ends like it")
        XCTAssertEqual(InboxView.branchLabel(try branched("session/r-014")), "#014", "the title says r #14, not r #014")
        XCTAssertNil(InboxView.branchLabel(try branched("session/my-app-3", title: "p/my-app", id: "dev-p-my-app-3", repo: "my-app")))
        XCTAssertNil(InboxView.branchLabel(try branched("session/r-0", id: "dev-p-r-0")))
        XCTAssertEqual(InboxView.branchLabel(try branched("session/r-14", title: "R #14")), "#14", "a name in other case")
        XCTAssertEqual(InboxView.branchLabel(try branched("session/R-14", title: "Boosting")), "session/R-14")
        XCTAssertEqual(InboxView.branchLabel(try branched("session/r-")), "session/r-")
        XCTAssertNil(InboxView.branchLabel(try branched(nil)))
        XCTAssertNil(InboxView.branchLabel(try branched("")))
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
