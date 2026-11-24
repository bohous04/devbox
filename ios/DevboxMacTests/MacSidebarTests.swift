import AppKit
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

    /// Settling the selected row moves the selection to the row that takes its place (T3 Code), else the one above.
    func testSelectionAfterSettleMovesOn() {
        let rows = ["a", "b", "c"]
        XCTAssertEqual(MacSidebarLayout.afterSettle("a", rows: rows), "b")
        XCTAssertEqual(MacSidebarLayout.afterSettle("b", rows: rows), "c")
        XCTAssertEqual(MacSidebarLayout.afterSettle("c", rows: rows), "b", "the last row: the one above")
        XCTAssertNil(MacSidebarLayout.afterSettle("a", rows: ["a"]), "the only row")
        XCTAssertNil(MacSidebarLayout.afterSettle("x", rows: rows), "not shown")
    }

    /// The Mac's settle announcement names ⌘Z.
    func testMacAnnouncesCommandZ() { XCTAssertEqual(MacSettler(voiceOver: { false }).undoHint, "⌘Z to undo") }
}
