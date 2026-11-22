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

    /// inboxView.test.ts rowStatus: a chip only when there is something to say; a settled row only for danger.
    func testRowStatus() throws {
        func chip(_ section: String, _ reason: String?) throws -> InboxView.Mark? {
            InboxView.rowStatus(try item("x", section, reason: reason, since: 1, until: section == "snoozed" ? 9 : nil))
        }
        XCTAssertEqual(try chip("needs_you", "request"), .init(label: "Answer", tone: .action))
        XCTAssertEqual(try chip("needs_you", "failed"), .init(label: "Failed", tone: .danger))
        XCTAssertEqual(try chip("needs_you", "rate-limited"), .init(label: "Rate limited", tone: .danger))
        XCTAssertEqual(try chip("needs_you", "disconnected"), .init(label: "Disconnected", tone: .danger))
        XCTAssertEqual(try chip("needs_you", "bridge-behind"), .init(label: "Bridge behind", tone: .danger))
        XCTAssertEqual(try chip("needs_you", "ci-failed"), .init(label: "CI failed", tone: .danger))
        XCTAssertEqual(try chip("needs_you", "completed"), .init(label: "Done", tone: .done))
        XCTAssertEqual(try chip("working", "queued"), .init(label: "Queued", tone: .busy))
        XCTAssertEqual(try chip("working", "background"), .init(label: "Background", tone: .busy))
        XCTAssertEqual(try chip("working", "pr-checks"), .init(label: "CI running", tone: .busy))
        XCTAssertNil(try chip("working", "running"), "the live dot and the time say it")
        XCTAssertNil(try chip("idle", nil))
        XCTAssertNil(try chip("idle", "failed"))
        XCTAssertEqual(try chip("snoozed", "failed"), .init(label: "Snoozed", tone: .quiet))
        XCTAssertNil(try chip("settled", "completed"))
        XCTAssertNil(try chip("settled", "queued"))
        XCTAssertNil(try chip("settled", nil))
        XCTAssertEqual(try chip("settled", "ci-failed"), .init(label: "CI failed", tone: .danger))
        XCTAssertEqual(try chip("settled", "failed"), .init(label: "Failed", tone: .danger))
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
        XCTAssertEqual(InboxView.projectBadge("games/harbor_api"), "GH")
        XCTAssertEqual(InboxView.projectBadge("acme"), "AC")
        XCTAssertEqual(InboxView.projectBadge("Údržba města"), "ÚM")
        XCTAssertEqual(InboxView.projectBadge(""), "?")
    }

    /// inboxView.test.ts badgeSlots: a project's place in devd's project list in code-point order, mod 8.
    func testBadgeSlots() {
        XCTAssertEqual(InboxView.badgeSlots(["orchard", "acme", "lumen", "acme", "Zeta", "údržba"]),
                       ["Zeta": 0, "acme": 1, "lumen": 2, "orchard": 3, "údržba": 4])
        let nine = InboxView.badgeSlots("abcdefghi".map(String.init))
        XCTAssertEqual(Set("abcdefgh".map { nine[String($0)]! }).count, 8, "up to eight projects never share a colour")
        XCTAssertEqual(nine["i"], 0)
        XCTAssertEqual(InboxTone.badge.count, InboxView.badgeSlotCount)
    }

    /// The colours come from devd's project list, not the inbox: ending a project's only session moves no other badge.
    func testEndingAProjectsOnlySessionLeavesTheOtherColours() throws {
        func at(_ id: String, _ project: String) throws -> InboxItem {
            let json: [String: Any] = ["sessionId": id, "runtime": "chat", "title": id, "project": project, "repo": "r", "agent": "claude",
                                       "attention": ["section": "idle", "since": 1, "reason": NSNull()], "lastText": NSNull()]
            return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let slots = InboxView.badgeSlots(["acme", "lumen", "orchard"])
        let before = try [at("a", "acme"), at("l", "lumen"), at("o", "orchard")]
        let after = before.filter { $0.sessionId != "a" }
        func colour(_ items: [InboxItem]) -> [String: Int] {
            Dictionary(uniqueKeysWithValues: items.map { ($0.sessionId, slots[$0.project]!) })
        }
        XCTAssertEqual(colour(before), ["a": 0, "l": 1, "o": 2])
        XCTAssertEqual(colour(after), ["l": 1, "o": 2])
    }

    /// inboxView.test.ts snoozeEnd: the time on the same day, the short weekday before it on another.
    func testSnoozeChipSaysTheDayWhenNotToday() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        func ms(_ day: Int, _ h: Int, _ m: Int) -> Int {
            InboxView.ms(cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: h, minute: m))!)
        }
        let mark = InboxView.Mark(label: "Snoozed", tone: .quiet)
        let gb = Locale(identifier: "en_GB")
        XCTAssertEqual(InboxRow.chipLabel(mark, until: ms(24, 21, 36), now: ms(24, 9, 0), locale: gb), "Snoozed until 21:36")
        XCTAssertEqual(InboxRow.chipLabel(mark, until: ms(25, 8, 0), now: ms(24, 9, 0), locale: gb), "Snoozed until Wed 08:00")
        XCTAssertEqual(InboxRow.chipLabel(InboxView.Mark(label: "Done", tone: .done), until: nil, now: 0, locale: gb), "Done")
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

    func testMetaTailSeparatesAgentAndTmux() throws {
        let json: [String: Any] = ["sessionId": "dev-p-r-3", "runtime": "tmux", "title": "p/r", "project": "p", "repo": "r", "agent": "claude",
                                   "attention": ["section": "idle", "since": 1, "reason": NSNull()], "lastText": NSNull()]
        let tmux = try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(InboxView.metaTail(tmux, showAgent: true), ["Claude", "tmux"])
        XCTAssertEqual(InboxView.metaTail(try item("a", "idle", reason: nil, since: 1), showAgent: true), ["Claude"])
        // One agent on every visible row says nothing: left out.
        XCTAssertEqual(InboxView.metaTail(tmux, showAgent: false), ["tmux"])
        XCTAssertEqual(InboxView.metaTail(try item("a", "idle", reason: nil, since: 1), showAgent: false), [])
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

    /// inboxView.test.ts statusParts: the chip, the snooze end and the age; nothing for an untouched idle row.
    func testStatusParts() throws {
        let now = 10 * 60_000
        XCTAssertNil(InboxView.statusParts(try item("a", "idle", reason: nil, since: 0), now: now))
        XCTAssertEqual(InboxView.statusParts(try item("a", "snoozed", reason: "completed", since: 0, until: 99), now: now),
                       .init(mark: .init(label: "Snoozed", tone: .quiet), until: 99, ago: ""))
        XCTAssertEqual(InboxView.statusParts(try item("a", "needs_you", reason: "completed", since: now - 3 * 60_000), now: now),
                       .init(mark: .init(label: "Done", tone: .done), until: nil, ago: "3m"))
        XCTAssertEqual(InboxView.statusParts(try item("a", "settled", reason: "completed", since: now - 120_000), now: now),
                       .init(mark: nil, until: nil, ago: "2m"))
        XCTAssertEqual(InboxView.statusParts(try item("a", "working", reason: "running", since: now - 120_000), now: now),
                       .init(mark: nil, until: nil, ago: "2m"))
    }
}
