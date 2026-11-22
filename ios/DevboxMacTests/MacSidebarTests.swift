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
}
