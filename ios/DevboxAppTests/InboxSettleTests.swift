import XCTest
@testable import DevboxApp

/// The inbox as one list, shared by the iPhone and the Mac sidebar: which rows it holds and in what order, the mark a
/// row shows, settling with undo, and when a tmux session is marked seen.
@MainActor
final class InboxSettleTests: XCTestCase {
    private func item(_ id: String, _ section: String, reason: String?, since: Int = 0, until: Int? = nil, runtime: String = "chat",
                      branch: String? = nil) throws -> InboxItem {
        var attention: [String: Any] = ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()]
        if let until { attention["until"] = until }
        var json: [String: Any] = ["sessionId": id, "runtime": runtime, "title": "Title of \(id)", "project": "p", "repo": "r",
                                   "agent": "claude", "attention": attention]
        if let branch { json["branch"] = branch }
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// Requests and failures stay pinned on top, the longest wait first; under them the finished and the idle rows
    /// together, newest first, with no cap. Working, snoozed and settled rows are on the shelves, not in the list.
    func testOneListPinsWhatNeedsActionThenNewestFirst() throws {
        let items = [
            try item("answer-new", "needs_you", reason: "request", since: 50),
            try item("failed-old", "needs_you", reason: "failed", since: 10),
            try item("done-mid", "needs_you", reason: "completed", since: 40),
            try item("idle-new", "idle", reason: nil, since: 60),
            try item("idle-old", "idle", reason: nil, since: 5),
            try item("later-devd", "unknown", reason: nil, since: 30),
            try item("working", "working", reason: "running", since: 70),
            try item("snoozed", "snoozed", reason: "completed", since: 70),
            try item("settled", "settled", reason: "completed", since: 70),
        ]
        XCTAssertEqual(InboxView.list(InboxView.group(items)).map(\.sessionId),
                       ["failed-old", "answer-new", "idle-new", "done-mid", "later-devd", "idle-old"])
        XCTAssertTrue(InboxView.list(InboxView.group([try item("w", "working", reason: "running")])).isEmpty)
        let many = try (0..<12).map { try item("done-\($0)", "needs_you", reason: "completed", since: $0) }
        XCTAssertEqual(InboxView.list(InboxView.group(many)).count, 12, "no cap on the finished rows")
    }

    /// The shelves under the list: Working, Snoozed, Settled in that order, the empty ones left out.
    func testShelvesAreTheNonEmptyShelvesInOrder() throws {
        let g = InboxView.group([try item("w", "working", reason: "running"), try item("s", "settled", reason: "completed"),
                                 try item("i", "idle", reason: nil)])
        let shelves = InboxView.shelves(g)
        XCTAssertEqual(shelves.map(\.label), ["Working", "Settled"])
        XCTAssertEqual(shelves.map(\.preview), [true, false])
        XCTAssertEqual(shelves.map(\.items.count), [1, 1])
        XCTAssertTrue(InboxView.shelves(InboxView.group([try item("i", "idle", reason: nil)])).isEmpty)
    }

    /// The list's rows show a chip only when they have something to say; an idle or seen row shows its time. Done is the
    /// quiet one. (InboxRowTests holds every reason.)
    func testChipOnlyWhenThereIsSomethingToSay() throws {
        XCTAssertEqual(InboxView.rowStatus(try item("a", "needs_you", reason: "request"))?.tone, .action)
        XCTAssertEqual(InboxView.rowStatus(try item("a", "needs_you", reason: "failed"))?.tone, .danger)
        XCTAssertEqual(InboxView.rowStatus(try item("a", "needs_you", reason: "completed"))?.tone, .done)
        XCTAssertNil(InboxView.rowStatus(try item("a", "idle", reason: nil)), "idle: the time")
        XCTAssertNil(InboxView.rowStatus(try item("a", "idle", reason: "completed")), "a seen run: the time")
        XCTAssertNil(InboxView.rowStatus(try item("a", "working", reason: "running")))
    }

    /// The second line, after the project's badge: what a row that needs you asks, else where the row runs.
    func testSecondLine() throws {
        XCTAssertEqual(InboxView.secondLine(try item("a", "idle", reason: nil, branch: "retry-queue"), detail: "msg"), "r  ·  retry-queue")
        XCTAssertEqual(InboxView.secondLine(try item("a", "idle", reason: nil), detail: ""), "r")
        XCTAssertEqual(InboxView.secondLine(try item("a", "needs_you", reason: "request", branch: "b"), detail: "May I run it?"), "r  ·  May I run it?")
    }

    /// A marked row says its mark once: first, not again as the state.
    func testSpokenLabelSaysTheMarkOnce() throws {
        let answer = try item("dev-p-r-1", "needs_you", reason: "request", since: 1_000)
        let label = InboxRow.spoken(answer, now: 1_000 + 60_000, title: "Pick a library", detail: "date-fns or Temporal?", showAgent: false)
        XCTAssertTrue(label.hasPrefix("Answer, Pick a library, "), label)
        XCTAssertFalse(label.contains("waiting for your answer"), label)
        XCTAssertTrue(label.hasSuffix("date-fns or Temporal?"), label)
        let failed = try item("dev-p-r-2", "needs_you", reason: "failed")
        XCTAssertEqual(InboxRow.spoken(failed, now: 0, title: "Fix", detail: InboxView.reasonLabel(.failed), showAgent: false), "Failed, Fix, p/r")
        XCTAssertTrue(InboxRow.spoken(try item("a", "idle", reason: nil), now: 0, title: "Idle", detail: "", showAgent: false).hasPrefix("Idle"))
        let queued = try item("dev-p-r-3", "working", reason: "queued")
        XCTAssertEqual(InboxRow.spoken(queued, now: 0, title: "Index", detail: "", showAgent: false), "Queued, Index, p/r")
        let snoozed = try item("dev-p-r-4", "snoozed", reason: "completed", until: 60_000)
        let later = InboxRow.spoken(snoozed, now: 0, title: "Bump", detail: "", showAgent: false)
        XCTAssertTrue(later.hasPrefix("Snoozed, Bump, until "), later)
    }

    /// Settling ends the session: one waiting on an answer or still working asks first; the others settle at once.
    /// Every row in the list and in Working can be settled.
    func testSettleAsksFirstForAWaitingOrWorkingSession() throws {
        XCTAssertEqual(InboxView.settleQuestion(try item("a", "needs_you", reason: "request")), "The agent is waiting for your answer. End it?")
        XCTAssertEqual(InboxView.settleQuestion(try item("a", "working", reason: "running")), "The agent is still working. End it?")
        XCTAssertNil(InboxView.settleQuestion(try item("a", "needs_you", reason: "failed")))
        XCTAssertNil(InboxView.settleQuestion(try item("a", "needs_you", reason: "completed")))
        XCTAssertNil(InboxView.settleQuestion(try item("a", "idle", reason: nil)))
        XCTAssertFalse(InboxSettler.canSettle(try item("a", "settled", reason: "completed")), "already settled")
        XCTAssertFalse(InboxSettler.canSettle(try item("a", "snoozed", reason: "completed")), "snoozed: unsnooze first")
        XCTAssertTrue(InboxSettler.canSettle(try item("a", "idle", reason: nil)))
        XCTAssertTrue(InboxSettler.canSettle(try item("a", "working", reason: "running")))
    }

    /// The undo notice goes after its lifetime, and never after devd ends the session (endsAt): an undo then is too
    /// late. With VoiceOver it stays until the next action, but not past the end either.
    func testTheNoticeNeverOutlivesTheSessionsEnd() {
        let five = Duration.seconds(5)
        XCTAssertEqual(InboxSettler.noticeLifetime(five, endsAt: nil, now: 0, voiceOver: false), five)
        XCTAssertEqual(InboxSettler.noticeLifetime(five, endsAt: 8_000, now: 1_000, voiceOver: false), five)
        XCTAssertEqual(InboxSettler.noticeLifetime(five, endsAt: 4_000, now: 1_000, voiceOver: false), .milliseconds(3_000))
        XCTAssertEqual(InboxSettler.noticeLifetime(five, endsAt: 8_000, now: 1_000, voiceOver: true), .milliseconds(7_000))
        XCTAssertNil(InboxSettler.noticeLifetime(five, endsAt: nil, now: 0, voiceOver: true), "kept until the next action")
        XCTAssertEqual(InboxSettler.noticeLifetime(five, endsAt: 500, now: 1_000, voiceOver: false), .zero)
    }

    /// devd's endsAt and endError decode; an older devd sends neither.
    func testEndFieldsDecode() throws {
        let json = #"{"sessionId":"a","runtime":"chat","title":"t","project":"p","repo":"r","agent":"claude","attention":{"section":"settled","since":1},"endsAt":9000,"endError":null}"#
        let i = try JSONDecoder().decode(InboxItem.self, from: Data(json.utf8))
        XCTAssertEqual(i.endsAt, 9_000)
        XCTAssertNil(i.endError)
        XCTAssertNil(try item("b", "idle", reason: nil).endsAt)
        let failed = try JSONDecoder().decode(InboxItem.self, from: Data(json.replacingOccurrences(of: #""endError":null"#, with: #""endError":"docker is stuck""#).utf8))
        XCTAssertTrue(InboxRow.spoken(failed, now: 0, title: "t", detail: "", showAgent: false).hasSuffix(". Couldn't end the session: docker is stuck"))
    }

    /// A tmux session is marked seen while it shows a finish or a failure; not while it waits on an answer, works or
    /// is idle, and never a chat session (its thread marks itself seen).
    func testSeenOnlyForAFinishedOrFailedTmuxSession() throws {
        XCTAssertTrue(InboxSettler.wantsSeen(try item("a", "needs_you", reason: "completed", runtime: "tmux")))
        XCTAssertTrue(InboxSettler.wantsSeen(try item("a", "needs_you", reason: "failed", runtime: "tmux")))
        XCTAssertFalse(InboxSettler.wantsSeen(try item("a", "needs_you", reason: "request", runtime: "tmux")))
        XCTAssertFalse(InboxSettler.wantsSeen(try item("a", "needs_you", reason: "ci-failed", runtime: "chat")))
        XCTAssertFalse(InboxSettler.wantsSeen(try item("a", "idle", reason: nil, runtime: "tmux")))
        XCTAssertFalse(InboxSettler.wantsSeen(try item("a", "working", reason: "running", runtime: "tmux")))
        XCTAssertFalse(InboxSettler.wantsSeen(try item("a", "needs_you", reason: "completed", runtime: "chat")))
        XCTAssertFalse(InboxSettler.wantsSeen(nil))
    }

    /// The selected row is marked seen only where it stays put: a failure would drop out of the pinned top.
    func testSeenOfTheSelectedRowNeverMovesIt() throws {
        XCTAssertTrue(InboxSettler.seenMoves(try item("a", "needs_you", reason: "failed", runtime: "tmux")))
        XCTAssertFalse(InboxSettler.seenMoves(try item("a", "needs_you", reason: "completed", runtime: "tmux")))
    }

    /// The iPhone's moments: a finish is marked when it is opened, on leaving and back in the foreground; a failure
    /// only on leaving, so it does not drop out of the pinned top during the push.
    func testWhenTheIPhoneMarksSeen() throws {
        let done = try item("a", "needs_you", reason: "completed", runtime: "tmux")
        let failed = try item("a", "needs_you", reason: "failed", runtime: "tmux")
        for moment in [InboxSettler.Moment.opened, .left, .foreground] {
            XCTAssertTrue(InboxSettler.marksSeen(done, on: moment), "\(moment)")
            XCTAssertFalse(InboxSettler.marksSeen(try item("a", "needs_you", reason: "completed"), on: moment), "chat \(moment)")
            XCTAssertFalse(InboxSettler.marksSeen(nil, on: moment))
        }
        XCTAssertFalse(InboxSettler.marksSeen(failed, on: .opened))
        XCTAssertFalse(InboxSettler.marksSeen(failed, on: .foreground))
        XCTAssertTrue(InboxSettler.marksSeen(failed, on: .left))
    }

    /// Opening an idle tmux session or coming back to it is a look devd records (it restarts the auto-settle clock);
    /// leaving is not, and a finish, a failure or a chat session goes its own way.
    func testALookAtAnIdleTmuxSession() throws {
        let idle = try item("a", "idle", reason: nil, runtime: "tmux")
        XCTAssertTrue(InboxSettler.looks(idle, on: .opened))
        XCTAssertTrue(InboxSettler.looks(idle, on: .foreground))
        XCTAssertFalse(InboxSettler.looks(idle, on: .left))
        for other in [try item("a", "idle", reason: nil), try item("a", "needs_you", reason: "completed", runtime: "tmux"),
                      try item("a", "needs_you", reason: "failed", runtime: "tmux"), try item("a", "working", reason: "running", runtime: "tmux")] {
            XCTAssertFalse(InboxSettler.looks(other, on: .foreground), "\(other.attention)")
        }
        XCTAssertFalse(InboxSettler.looks(nil, on: .opened))
    }

    /// Seen goes only to the session on screen: the top of the Inbox stack, and nothing while another tab shows.
    func testOpenedIsTheTopOfTheInboxStackOnTheInboxTab() {
        let path: [InboxRoute] = [.thread("dev-a"), .session("dev-b")]
        XCTAssertEqual(InboxRoute.opened(path: path, onInboxTab: true), "dev-b", "a deep link pushes several: the last shows")
        XCTAssertNil(InboxRoute.opened(path: path, onInboxTab: false), "another tab is selected")
        XCTAssertNil(InboxRoute.opened(path: [], onInboxTab: true))
    }

    // MARK: - Against the fixture devd

    private func fixtureStore() async throws -> InboxStore {
        FixtureMode.requested = "demo"
        let store = InboxStore(client: FixtureMode.client())
        await store.load()
        XCTAssertNotNil(store.items, "the fixture inbox did not load")
        return store
    }

    override func tearDown() { FixtureMode.requested = nil }

    private func row(_ store: InboxStore, _ id: String) throws -> InboxItem { try XCTUnwrap(store.items?.first { $0.sessionId == id }) }

    /// The badge colours come from devd's project list; nil (neutral badges) until it has answered.
    func testBadgeSlotsLoadFromTheProjectList() async throws {
        let store = try await fixtureStore()
        XCTAssertNil(store.badgeSlots)
        await store.loadBadgeSlots()
        XCTAssertEqual(store.badgeSlots, ["acme": 0, "lumen": 1, "orchard": 2])
    }

    /// Settle moves the row to the shelf and shows the notice; undo brings it back and clears the notice; the notice
    /// also goes on its own after its lifetime.
    func testSettleThenUndo() async throws {
        let store = try await fixtureStore()
        let settler = InboxSettler(lifetime: .seconds(60), voiceOver: { false })
        await settler.settle(try row(store, "dev-orchard-sync"), in: store)
        XCTAssertNil(settler.problem)
        XCTAssertEqual(settler.notice?.sessionId, "dev-orchard-sync")
        XCTAssertEqual(settler.notice?.title, "Add a retry queue to the offline sync")
        XCTAssertEqual(try row(store, "dev-orchard-sync").attention.section, .settled)
        let undone = await settler.undo(in: store)
        XCTAssertTrue(undone)
        XCTAssertNil(settler.notice)
        XCTAssertNil(settler.problem)
        XCTAssertEqual(try row(store, "dev-orchard-sync").attention.section, .needsYou)
        let again = await settler.undo(in: store)
        XCTAssertFalse(again, "nothing left to undo")

        let brief = InboxSettler(lifetime: .milliseconds(100), voiceOver: { false })
        await brief.settle(try row(store, "dev-lumen-docs"), in: store)
        XCTAssertNotNil(brief.notice)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNil(brief.notice, "the notice goes after its lifetime")
        let late = await brief.undo(in: store)
        XCTAssertFalse(late, "undo after the notice went does nothing")
    }

    /// A second settle replaces the notice: undo brings back the latest one, and the first notice's timer does not
    /// take the second one down early.
    func testASecondSettleReplacesTheNotice() async throws {
        let store = try await fixtureStore()
        let settler = InboxSettler(lifetime: .milliseconds(300), voiceOver: { false })
        await settler.settle(try row(store, "dev-orchard-sync"), in: store)
        try await Task.sleep(for: .milliseconds(200))
        await settler.settle(try row(store, "dev-lumen-docs"), in: store)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(settler.notice?.sessionId, "dev-lumen-docs", "the first timer left the second notice alone")
        let undone = await settler.undo(in: store)
        XCTAssertTrue(undone)
        XCTAssertEqual(try row(store, "dev-lumen-docs").attention.section, .needsYou)
        XCTAssertEqual(try row(store, "dev-orchard-sync").attention.section, .settled)
    }

    /// With VoiceOver the notice stays until the next action, not for a few seconds.
    func testWithVoiceOverTheNoticeStaysUntilTheNextAction() async throws {
        let store = try await fixtureStore()
        let spoken = InboxSettler(lifetime: .milliseconds(100), voiceOver: { true })
        await spoken.settle(try row(store, "dev-orchard-sync"), in: store)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNotNil(spoken.notice, "kept past its lifetime")
        spoken.actionTaken()
        XCTAssertNil(spoken.notice, "gone with the next action")

        let seen = InboxSettler(lifetime: .seconds(60), voiceOver: { false })
        await seen.settle(try row(store, "dev-lumen-docs"), in: store)
        seen.actionTaken()
        XCTAssertNotNil(seen.notice, "without VoiceOver another action leaves it to its time")
    }

    /// devd's refusal is said, not swallowed; no undo is offered.
    func testARefusedSettleIsShown() async throws {
        let store = try await fixtureStore()
        let settler = InboxSettler()
        await settler.settle(try item("dev-gone", "idle", reason: nil), in: store)
        XCTAssertNil(settler.notice)
        XCTAssertEqual(settler.problem?.hasPrefix("Couldn't settle “Title of dev-gone”"), true, settler.problem ?? "nil")
    }

    /// A session waiting on an answer is settled (and so ended) only once the owner confirms: first the question, then
    /// devd's settle with {confirm: true}. Cancelling leaves the row as it was.
    func testSettlingAWaitingSessionAsksFirst() async throws {
        let store = try await fixtureStore()
        let settler = InboxSettler(lifetime: .seconds(60), voiceOver: { false })
        let waiting = try row(store, "dev-acme-billing")
        await settler.settle(waiting, in: store)
        XCTAssertEqual(settler.confirming?.question, "The agent is waiting for your answer. End it?")
        XCTAssertNil(settler.notice)
        XCTAssertEqual(try row(store, "dev-acme-billing").attention.section, .needsYou)
        settler.cancelConfirm()
        XCTAssertNil(settler.confirming)

        await settler.settle(waiting, in: store)
        await settler.confirm(try XCTUnwrap(settler.confirming), in: store)
        XCTAssertNil(settler.confirming)
        XCTAssertNil(settler.problem)
        XCTAssertEqual(settler.notice?.sessionId, "dev-acme-billing")
        XCTAssertEqual(try row(store, "dev-acme-billing").attention.section, .settled)
    }

    /// Seen posts once per finish of a tmux session. A failed post is shown and tried once more; a failure the owner
    /// dismissed is not raised again.
    func testSeenPostsOncePerFinishAndRetriesOnce() async throws {
        let store = try await fixtureStore()
        let settler = InboxSettler()
        let tmux = try item("dev-orchard-api-3", "needs_you", reason: "completed", since: 7, runtime: "tmux")
        let first = await settler.seen(tmux, in: store)
        XCTAssertEqual(first, .posted)
        XCTAssertNil(settler.problem)
        let repeated = await settler.seen(tmux, in: store)
        XCTAssertEqual(repeated, .skipped, "the same finish is not posted twice")
        let later = try item("dev-orchard-api-3", "needs_you", reason: "completed", since: 8, runtime: "tmux")
        let next = await settler.seen(later, in: store)
        XCTAssertEqual(next, .posted, "a new finish of the same session is posted again")

        let unknown = try item("dev-gone", "needs_you", reason: "completed", since: 7, runtime: "tmux")
        let failed = await settler.seen(unknown, in: store)
        XCTAssertEqual(failed, .failed)
        XCTAssertEqual(settler.problem?.hasPrefix("Couldn't mark “Title of dev-gone” seen"), true, settler.problem ?? "nil")
        settler.dismissProblem()
        let retried = await settler.seen(unknown, in: store)
        XCTAssertEqual(retried, .failed, "tried once more")
        XCTAssertNil(settler.problem, "a dismissed failure is not raised again")
        let third = await settler.seen(unknown, in: store)
        XCTAssertEqual(third, .skipped, "no third try for the same finish")
    }

    /// Each look posts once: triggers firing together are one look, a later look posts again; a failed one is shown.
    func testLookPostsSeenForAnIdleTmuxSessionOncePerLook() async throws {
        let store = try await fixtureStore()
        let idle = try item("dev-orchard-api-3", "idle", reason: nil, since: 7, runtime: "tmux")
        let together = InboxSettler()
        let first = await together.look(idle, in: store)
        let same = await together.look(idle, in: store)
        XCTAssertEqual([first, same], [.posted, .skipped], "two triggers of one look post once")
        let settler = InboxSettler(lookGap: .zero)
        let a = await settler.look(idle, in: store)
        let b = await settler.look(idle, in: store)
        XCTAssertEqual([a, b], [.posted, .posted], "a later look posts again")
        let chat = await settler.look(try item("dev-orchard-sync", "idle", reason: nil), in: store)
        XCTAssertEqual(chat, .skipped)
        let gone = await settler.look(try item("dev-gone", "idle", reason: nil, runtime: "tmux"), in: store)
        XCTAssertEqual(gone, .failed)
        XCTAssertEqual(settler.problem?.hasPrefix("Couldn't mark “Title of dev-gone” seen"), true, settler.problem ?? "nil")
    }

    /// Two triggers firing together post once; a skipped call does not use up the retry.
    func testSimultaneousSeenPostsOnce() async throws {
        let store = try await fixtureStore()
        let settler = InboxSettler()
        let tmux = try item("dev-lumen-sketch", "needs_you", reason: "failed", since: 9, runtime: "tmux")
        async let a = settler.seen(tmux, in: store)
        async let b = settler.seen(tmux, in: store)
        let results = await [a, b]
        XCTAssertEqual(results.filter { $0 == .posted }.count, 1, "\(results)")
        XCTAssertEqual(results.filter { $0 == .skipped }.count, 1, "\(results)")

        let gone = try item("dev-gone", "needs_you", reason: "failed", since: 9, runtime: "tmux")
        async let c = settler.seen(gone, in: store)
        async let d = settler.seen(gone, in: store)
        let failed = await [c, d]
        XCTAssertEqual(failed.filter { $0 == .failed }.count, 1, "a skipped call does not use up the retry: \(failed)")
        let retry = await settler.seen(gone, in: store)
        XCTAssertEqual(retry, .failed, "the one retry is still there")
    }
}
