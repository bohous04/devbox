import AppKit
import XCTest
@testable import DevboxApp

/// The sidebar as one list: which rows it holds and in what order, the mark a row shows, settling with undo, and
/// when a tmux session is marked seen.
@MainActor
final class MacSidebarTests: XCTestCase {
    private func item(_ id: String, _ section: String, reason: String?, since: Int = 0, runtime: String = "chat") throws -> InboxItem {
        let json: [String: Any] = ["sessionId": id, "runtime": runtime, "title": "Title of \(id)", "project": "p", "repo": "r",
                                   "agent": "claude", "attention": ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()]]
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// Requests and failures stay pinned on top, the longest wait first; under them the finished and the idle rows
    /// together, newest first. Working, snoozed and settled rows are on the shelves, not in the list.
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
        XCTAssertEqual(MacSidebarLayout.list(InboxView.group(items)).map(\.sessionId),
                       ["failed-old", "answer-new", "idle-new", "done-mid", "later-devd", "idle-old"])
        XCTAssertTrue(MacSidebarLayout.list(InboxView.group([try item("w", "working", reason: "running")])).isEmpty)
    }

    /// A row shows a mark only when it has something to say; an idle or seen row shows its time.
    func testMarkOnlyWhenThereIsSomethingToSay() throws {
        let cases: [(String?, String?)] = [("request", "Answer"), ("failed", "Failed"), ("rate-limited", "Limit"),
                                           ("disconnected", "Offline"), ("bridge-behind", "Behind"), ("ci-failed", "CI failed"),
                                           ("completed", "Done")]
        for (reason, word) in cases {
            XCTAssertEqual(MacInboxRow.word(try item("a", "needs_you", reason: reason))?.text, word, reason ?? "nil")
        }
        XCTAssertEqual(MacInboxRow.word(try item("a", "needs_you", reason: "completed"))?.tone, .done)
        XCTAssertNil(MacInboxRow.word(try item("a", "idle", reason: nil)), "idle: the time")
        XCTAssertNil(MacInboxRow.word(try item("a", "idle", reason: "completed")), "a seen run: the time")
        XCTAssertNil(MacInboxRow.word(try item("a", "settled", reason: "failed")), "the shelves keep their time")
    }

    /// The settle button and ⌘⇧S: every row in the list, except one waiting on an answer, which says why.
    func testSettleIsBlockedOnlyByAnOpenRequest() throws {
        XCTAssertEqual(MacSettler.block(try item("a", "needs_you", reason: "request")), "Answer the open request first")
        XCTAssertNil(MacSettler.block(try item("a", "needs_you", reason: "failed")))
        XCTAssertNil(MacSettler.block(try item("a", "needs_you", reason: "completed")))
        XCTAssertNil(MacSettler.block(try item("a", "idle", reason: nil)))
        XCTAssertFalse(MacSettler.canSettle(try item("a", "settled", reason: "completed")), "already settled")
        XCTAssertFalse(MacSettler.canSettle(try item("a", "snoozed", reason: "completed")), "snoozed: unsnooze first")
        XCTAssertTrue(MacSettler.canSettle(try item("a", "idle", reason: nil)))
    }

    /// ⌘Z undoes a settle while the key window's sidebar shows its notice and the keyboard is not in a text field
    /// being edited or the terminal; anything else keeps its own ⌘Z.
    func testUndoClaimsCommandZOnlyWhileTheNoticeShows() {
        XCTAssertTrue(MacSettler.claimsUndo(flags: [.command], key: "z", noticeShown: true, focusOwnsUndo: false))
        XCTAssertFalse(MacSettler.claimsUndo(flags: [.command], key: "z", noticeShown: false, focusOwnsUndo: false), "no notice here")
        XCTAssertFalse(MacSettler.claimsUndo(flags: [.command], key: "z", noticeShown: true, focusOwnsUndo: true), "the field's undo")
        XCTAssertFalse(MacSettler.claimsUndo(flags: [.command, .shift], key: "z", noticeShown: true, focusOwnsUndo: false), "redo")
        XCTAssertFalse(MacSettler.claimsUndo(flags: [.command], key: "x", noticeShown: true, focusOwnsUndo: false))
        XCTAssertTrue(MacSettler.claimsUndo(flags: [.command, .capsLock], key: "Z", noticeShown: true, focusOwnsUndo: false), "caps lock")
    }

    /// The selected row is marked seen only where it stays put: a failure would drop out of the pinned top.
    func testSeenOfTheSelectedRowNeverMovesIt() throws {
        XCTAssertTrue(MacSettler.seenMoves(try item("a", "needs_you", reason: "failed", runtime: "tmux")))
        XCTAssertFalse(MacSettler.seenMoves(try item("a", "needs_you", reason: "completed", runtime: "tmux")))
    }

    /// A marked row says its mark once: not again as the state.
    func testSpokenLabelSaysTheMarkOnce() throws {
        let answer = try item("dev-p-r-1", "needs_you", reason: "request", since: 1_000)
        let label = MacInboxRow.spoken(answer, now: 1_000 + 60_000, title: "Pick a library", detail: "date-fns or Temporal?", showAgent: false)
        XCTAssertTrue(label.hasPrefix("Answer, Pick a library, "), label)
        XCTAssertFalse(label.contains("waiting for your answer"), label)
        XCTAssertTrue(label.hasSuffix("date-fns or Temporal?"), label)
        let failed = try item("dev-p-r-2", "needs_you", reason: "failed")
        XCTAssertEqual(MacInboxRow.spoken(failed, now: 0, title: "Fix", detail: InboxView.reasonLabel(.failed), showAgent: false), "Failed, Fix, p/r")
        XCTAssertTrue(MacInboxRow.spoken(try item("a", "idle", reason: nil), now: 0, title: "Idle", detail: "", showAgent: false).hasPrefix("Idle"))
    }

    /// A tmux session is marked seen while it shows a finish or a failure; not while it waits on an answer, works or
    /// is idle, and never a chat session (its thread marks itself seen).
    func testSeenOnlyForAFinishedOrFailedTmuxSession() throws {
        XCTAssertTrue(MacSettler.wantsSeen(try item("a", "needs_you", reason: "completed", runtime: "tmux")))
        XCTAssertTrue(MacSettler.wantsSeen(try item("a", "needs_you", reason: "failed", runtime: "tmux")))
        XCTAssertFalse(MacSettler.wantsSeen(try item("a", "needs_you", reason: "request", runtime: "tmux")))
        XCTAssertFalse(MacSettler.wantsSeen(try item("a", "idle", reason: nil, runtime: "tmux")))
        XCTAssertFalse(MacSettler.wantsSeen(try item("a", "working", reason: "running", runtime: "tmux")))
        XCTAssertFalse(MacSettler.wantsSeen(try item("a", "needs_you", reason: "completed", runtime: "chat")))
        XCTAssertFalse(MacSettler.wantsSeen(nil))
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

    /// Settle moves the row to the shelf and shows the notice; undo brings it back and clears the notice; the notice
    /// also goes on its own after its lifetime.
    func testSettleThenUndo() async throws {
        let store = try await fixtureStore()
        let settler = MacSettler(lifetime: .seconds(60), voiceOver: { false })
        await settler.settle(try row(store, "dev-orchard-sync"), in: store)
        XCTAssertNil(settler.problem)
        XCTAssertEqual(settler.notice?.sessionId, "dev-orchard-sync")
        XCTAssertEqual(try row(store, "dev-orchard-sync").attention.section, .settled)
        let undone = await settler.undo(in: store)
        XCTAssertTrue(undone)
        XCTAssertNil(settler.notice)
        XCTAssertNil(settler.problem)
        XCTAssertEqual(try row(store, "dev-orchard-sync").attention.section, .needsYou)
        let again = await settler.undo(in: store)
        XCTAssertFalse(again, "nothing left to undo")

        let brief = MacSettler(lifetime: .milliseconds(100), voiceOver: { false })
        await brief.settle(try row(store, "dev-lumen-docs"), in: store)
        XCTAssertNotNil(brief.notice)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNil(brief.notice, "the notice goes after its lifetime")
        let late = await brief.undo(in: store)
        XCTAssertFalse(late, "⌘Z after the notice went does nothing")
    }

    /// With VoiceOver the notice stays until the next action, not for a few seconds.
    func testWithVoiceOverTheNoticeStaysUntilTheNextAction() async throws {
        let store = try await fixtureStore()
        let spoken = MacSettler(lifetime: .milliseconds(100), voiceOver: { true })
        await spoken.settle(try row(store, "dev-orchard-sync"), in: store)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNotNil(spoken.notice, "kept past its lifetime")
        spoken.actionTaken()
        XCTAssertNil(spoken.notice, "gone with the next action")

        let seen = MacSettler(lifetime: .seconds(60), voiceOver: { false })
        await seen.settle(try row(store, "dev-lumen-docs"), in: store)
        seen.actionTaken()
        XCTAssertNotNil(seen.notice, "without VoiceOver a click elsewhere leaves it to its time")
    }

    /// devd's refusal is said, not swallowed; the row stays and no undo is offered.
    func testARefusedSettleIsShown() async throws {
        let store = try await fixtureStore()
        let settler = MacSettler()
        // Past the client's own check (the button is disabled for it): devd refuses with 409 request-open.
        await settler.settle(try row(store, "dev-acme-billing"), in: store, checked: false)
        XCTAssertNil(settler.notice)
        XCTAssertEqual(settler.problem?.hasPrefix("Couldn't settle “Run the invoice table migration”"), true, settler.problem ?? "nil")
        XCTAssertEqual(try row(store, "dev-acme-billing").attention.section, .needsYou)
    }

    /// Seen posts once per finish of a tmux session. A failed post is shown and tried once more; a failure the owner
    /// dismissed is not raised again.
    func testSeenPostsOncePerFinishAndRetriesOnce() async throws {
        let store = try await fixtureStore()
        let settler = MacSettler()
        let tmux = try item("dev-orchard-api-3", "needs_you", reason: "completed", since: 7, runtime: "tmux")
        let first = await settler.seen(tmux, in: store)
        XCTAssertEqual(first, .posted)
        XCTAssertNil(settler.problem)
        let repeated = await settler.seen(tmux, in: store)
        XCTAssertEqual(repeated, .skipped, "the same finish is not posted twice")

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
}
