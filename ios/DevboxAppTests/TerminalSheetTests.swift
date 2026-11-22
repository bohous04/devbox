import XCTest
@testable import DevboxApp

/// The iPhone chat's full-screen terminal (ChatScreen): the user's open and close are remembered for the inbox row;
/// the one automatic opening, for a Chat that cannot be shown, never is.
final class TerminalSheetTests: XCTestCase {
    func testTheUsersOpenAndCloseAreRemembered() {
        var sheet = TerminalSheet()
        XCTAssertEqual(sheet.userOpens(), .terminal)
        XCTAssertTrue(sheet.shown)
        XCTAssertEqual(sheet.closed(), .chat, "back to Chat")
        XCTAssertFalse(sheet.shown)
    }

    func testTheAutomaticOpeningHappensOnceAndIsNeverRemembered() {
        var sheet = TerminalSheet()
        sheet.chatUnavailable("Chat view isn't supported for Grok Build yet.")
        XCTAssertTrue(sheet.shown)
        XCTAssertNil(sheet.closed(), "closing the automatic terminal stores nothing")
        sheet.chatUnavailable("Chat view isn't supported for Grok Build yet.")
        XCTAssertFalse(sheet.shown, "once")
        XCTAssertEqual(sheet.userOpens(), .terminal, "the user's own open after it is remembered")
        XCTAssertEqual(sheet.closed(), .chat)
    }

    func testAReasonArrivingWhileTheUsersTerminalIsOpenKeepsItTheirs() {
        var sheet = TerminalSheet()
        XCTAssertEqual(sheet.userOpens(), .terminal)
        sheet.chatUnavailable("Could not load the terminal's conversation: timed out")
        XCTAssertTrue(sheet.shown)
        XCTAssertEqual(sheet.closed(), .chat, "closing the user's terminal still goes back to Chat")
        sheet.chatUnavailable("Could not load the terminal's conversation: timed out")
        XCTAssertFalse(sheet.shown, "the automatic opening was spent")
    }

    func testNoReasonOpensNothing() {
        var sheet = TerminalSheet()
        sheet.chatUnavailable(nil)
        XCTAssertFalse(sheet.shown)
        XCTAssertNil(sheet.closed())
    }
}
