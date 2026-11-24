import AppKit
import Combine
import XCTest
@testable import DevboxApp

/// The Mac sidebar's own rules: ⌘Z for undo. The list, marks, settle and seen rules it shares
/// with the iPhone are in InboxSettleTests.
@MainActor
final class MacSidebarTests: XCTestCase {
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

    /// Settling the selected row moves the selection to the row that takes its place (T3 Code), else the one above,
    /// within its own part; rows that left while the settle was on its way are skipped.
    func testSelectionAfterSettleMovesOn() {
        let rows = ["a", "b", "c"]
        XCTAssertEqual(MacSidebarLayout.afterSettle("a", before: rows, now: rows), "b")
        XCTAssertEqual(MacSidebarLayout.afterSettle("b", before: rows, now: ["a", "c"]), "c", "the row already gone")
        XCTAssertEqual(MacSidebarLayout.afterSettle("c", before: rows, now: rows), "b", "the last row: the one above")
        XCTAssertEqual(MacSidebarLayout.afterSettle("a", before: rows, now: ["a", "c"]), "c", "b left meanwhile")
        XCTAssertNil(MacSidebarLayout.afterSettle("a", before: ["a"], now: []), "the only row")
        XCTAssertNil(MacSidebarLayout.afterSettle("x", before: rows, now: rows), "not shown")
    }

    private func fixtureStore() async throws -> InboxStore {
        FixtureMode.requested = "demo"
        let store = InboxStore(client: FixtureMode.client())
        await store.load()
        XCTAssertNotNil(store.items, "the fixture inbox did not load")
        return store
    }

    override func tearDown() { FixtureMode.requested = nil }

    /// What MacInboxSidebar does on each event: the gesture, the settler's notice and abandoned as they are published
    /// (its onReceive), and the selection's change.
    @MainActor private final class Sidebar {
        let settler: MacSettler
        let store: InboxStore
        var follow = MacSettleFollow()
        var selection: String?
        /// The selection changes the owner made (each takes the action that ends a notice kept for VoiceOver).
        var actions = 0
        private var subscriptions: [AnyCancellable] = []

        init(settler: MacSettler, store: InboxStore) {
            self.settler = settler
            self.store = store
            subscriptions = [
                settler.$notice.sink { [unowned self] notice in
                    let before = selection
                    follow.landed(notice?.sessionId, selection: &selection, parts: Self.parts(store))
                    if selection != before { changed() }
                },
                settler.$abandoned.sink { [unowned self] id in follow.abandoned(id) },
            ]
        }

        func settle(_ id: String) async throws {
            let item = try XCTUnwrap(store.items?.first { $0.sessionId == id })
            follow.settle(id, selection: selection, parts: Self.parts(store))
            await settler.settle(item, in: store)
        }
        func confirm() async throws { await settler.confirm(try XCTUnwrap(settler.confirming), in: store) }
        func cancel() { settler.cancelConfirm(settler.confirming) }
        func pick(_ id: String?) {
            guard id != selection else { return }
            selection = id
            changed()
        }
        private func changed() {
            if follow.byOwner(selection) { actions += 1; settler.actionTaken() }
        }
        /// As MacInboxSidebar.shownParts reads them, with no search and the shelves shut.
        static func parts(_ store: InboxStore) -> MacSettleFollow.Parts {
            .init(list: InboxView.list(InboxView.group(store.items ?? [])).map(\.sessionId), shelves: [])
        }
    }

    /// With VoiceOver, settling the selected row moves the selection on without ending the notice: it and ⌘Z stay
    /// until the owner's own next pick.
    func testTheMoveAfterASettleKeepsTheNoticeForVoiceOver() async throws {
        let store = try await fixtureStore()
        let bar = Sidebar(settler: MacSettler(lifetime: .milliseconds(50), voiceOver: { true }), store: store)
        let list = Sidebar.parts(store).list
        let first = "dev-orchard-sync"
        XCTAssertTrue(list.contains(first))
        bar.pick(first)
        XCTAssertEqual(bar.actions, 1)
        try await bar.settle(first)
        XCTAssertNotNil(bar.selection)
        XCTAssertNotEqual(bar.selection, first, "the selection moved on")
        XCTAssertTrue(list.contains(bar.selection ?? ""), "to a row of the list")
        XCTAssertEqual(bar.actions, 1, "the move was not his action")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(bar.settler.notice?.sessionId, first, "kept past its lifetime for VoiceOver")
        XCTAssertTrue(MacSettler.claimsUndo(flags: [.command], key: "z", noticeShown: bar.settler.notice != nil, focusOwnsUndo: false))
        bar.pick(first == list.last ? list.first : list.last)
        XCTAssertNil(bar.settler.notice, "his own pick ends it")
    }

    /// Settling the list's last row selects the list's row above it, never a shelf row.
    func testTheListsLastRowGoesUpNotToAShelf() {
        var follow = MacSettleFollow()
        var selection: String? = "c"
        let parts = MacSettleFollow.Parts(list: ["a", "b", "c"], shelves: ["w1", "w2"])
        follow.settle("c", selection: selection, parts: parts)
        follow.landed("c", selection: &selection, parts: .init(list: ["a", "b"], shelves: ["w1", "w2", "c"]))
        XCTAssertEqual(selection, "b")
        XCTAssertFalse(follow.byOwner("b"), "the move")
        XCTAssertTrue(follow.isUpdate(from: "b", to: "b"), "the moved-to row updated in place")
        XCTAssertFalse(follow.isUpdate(from: nil, to: "b"), "the moved-to row arriving is not seen")
        XCTAssertTrue(follow.isUpdate(from: nil, to: "x"), "another selected row arriving in the inbox is")
        XCTAssertFalse(follow.isUpdate(from: "c", to: "b"), "a new selection is the selection handler's")
        XCTAssertTrue(follow.byOwner("a"), "then his own")
        XCTAssertTrue(follow.isUpdate(from: nil, to: "b"), "after his own pick, b is like any other row")
    }

    /// devd asks before ending a waiting session: the move waits for the answer. Confirmed, the selection moves on;
    /// cancelled, or failed, it stays and a later notice moves nothing.
    func testTheMoveWaitsForDevdsQuestion() async throws {
        let store = try await fixtureStore()
        let bar = Sidebar(settler: MacSettler(lifetime: .seconds(60), voiceOver: { false }), store: store)
        bar.pick("dev-acme-billing")
        try await bar.settle("dev-acme-billing")
        XCTAssertNotNil(bar.settler.confirming)
        XCTAssertEqual(bar.selection, "dev-acme-billing", "nothing moves while devd asks")
        bar.cancel()
        XCTAssertEqual(bar.settler.abandoned, "dev-acme-billing")
        XCTAssertEqual(bar.selection, "dev-acme-billing")

        try await bar.settle("dev-acme-billing")
        try await bar.confirm()
        XCTAssertEqual(bar.settler.notice?.sessionId, "dev-acme-billing")
        XCTAssertNotEqual(bar.selection, "dev-acme-billing", "confirmed: the selection moved on")
        XCTAssertNotNil(bar.selection)

        // A settle devd refuses: the follow is dropped, so nothing moves later.
        var follow = MacSettleFollow()
        var selection: String? = "x"
        follow.settle("x", selection: selection, parts: .init(list: ["x", "y"], shelves: []))
        follow.abandoned("x")
        follow.landed("x", selection: &selection, parts: .init(list: ["y"], shelves: []))
        XCTAssertEqual(selection, "x")
    }

    /// A failed settle is abandoned, so a sidebar waiting to move its selection stops waiting.
    func testAFailedSettleIsAbandoned() async throws {
        let store = try await fixtureStore()
        let settler = MacSettler(lifetime: .seconds(60), voiceOver: { false })
        let gone = try JSONDecoder().decode(InboxItem.self, from: Data("""
            {"sessionId":"dev-gone","runtime":"chat","title":"Gone","project":"p","repo":"r","agent":"claude",
             "attention":{"section":"idle","since":0,"reason":null}}
            """.utf8))
        await settler.settle(gone, in: store)
        XCTAssertNotNil(settler.problem)
        XCTAssertEqual(settler.abandoned, "dev-gone")
    }

    /// The Mac's settle announcement names ⌘Z.
    func testMacAnnouncesCommandZ() { XCTAssertEqual(MacSettler(voiceOver: { false }).undoHint, "⌘Z to undo") }
}
