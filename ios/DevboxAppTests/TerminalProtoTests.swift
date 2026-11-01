import XCTest
@testable import DevboxApp

/// Exact JSON strings — must match `dashboard/src/terminalProto.ts` bit for bit, otherwise the
/// server (`devd/src/terminal.ts`) would reject/ignore the message.
final class TerminalProtoTests: XCTestCase {
    func testEncodeInputPlainCharacter() {
        XCTAssertEqual(TerminalProto.encodeInput("a"), "{\"t\":\"i\",\"d\":\"a\"}")
    }

    func testEncodeInputEscapesQuote() {
        XCTAssertEqual(TerminalProto.encodeInput("\""), "{\"t\":\"i\",\"d\":\"\\\"\"}")
    }

    func testEncodeInputEscapesBackslash() {
        XCTAssertEqual(TerminalProto.encodeInput("\\"), "{\"t\":\"i\",\"d\":\"\\\\\"}")
    }

    func testEncodeInputEscapesNewline() {
        XCTAssertEqual(TerminalProto.encodeInput("\n"), "{\"t\":\"i\",\"d\":\"\\n\"}")
    }

    func testEncodeInputEscapesCarriageReturn() {
        XCTAssertEqual(TerminalProto.encodeInput("\r"), "{\"t\":\"i\",\"d\":\"\\r\"}")
    }

    func testEncodeInputEmptyString() {
        XCTAssertEqual(TerminalProto.encodeInput(""), "{\"t\":\"i\",\"d\":\"\"}")
    }

    func testEncodeInputEscapeSequence() {
        // Up arrow — exactly what the app sends via the key bar (`keySeq["Up"]`).
        XCTAssertEqual(TerminalProto.encodeInput("\u{1b}[A"), "{\"t\":\"i\",\"d\":\"\\u001b[A\"}")
    }

    func testEncodeInputDoesNotEscapeForwardSlash() {
        // `JSON.stringify` on the web does not escape `/` — the app must match bit for bit.
        XCTAssertEqual(TerminalProto.encodeInput("a/b"), "{\"t\":\"i\",\"d\":\"a/b\"}")
    }

    func testEncodeInputMultibyteUnicodePassesThroughUnescaped() {
        // Non-ASCII (paste, IME) — `JSON.stringify` leaves UTF-8 characters raw, not `\uXXXX`.
        XCTAssertEqual(TerminalProto.encodeInput("café"), "{\"t\":\"i\",\"d\":\"café\"}")
    }

    func testEncodeResize() {
        XCTAssertEqual(TerminalProto.encodeResize(cols: 80, rows: 24), "{\"t\":\"r\",\"cols\":80,\"rows\":24}")
    }

    func testEncodeUnlock() {
        XCTAssertEqual(TerminalProto.encodeUnlock(), "{\"t\":\"unlock\"}")
    }

    func testEncodeScroll() {
        XCTAssertEqual(TerminalProto.encodeScroll(.up, n: 3), "{\"t\":\"s\",\"d\":\"up\",\"n\":3}")
        XCTAssertEqual(TerminalProto.encodeScroll(.down, n: 1), "{\"t\":\"s\",\"d\":\"down\",\"n\":1}")
    }

    func testEncodeScrollClampsLikeServer() {
        XCTAssertEqual(TerminalProto.encodeScroll(.down, n: 99), "{\"t\":\"s\",\"d\":\"down\",\"n\":20}")
        XCTAssertEqual(TerminalProto.encodeScroll(.up, n: 0), "{\"t\":\"s\",\"d\":\"up\",\"n\":1}")
    }

    func testEncodeBottom() {
        XCTAssertEqual(TerminalProto.encodeBottom(), "{\"t\":\"b\"}")
    }

    // MARK: - KEY_SEQ / KEY_BAR

    func testKeySeqMatchesWeb() {
        XCTAssertEqual(TerminalProto.keySeq["Esc"], "\u{1b}")
        XCTAssertEqual(TerminalProto.keySeq["Tab"], "\t")
        XCTAssertEqual(TerminalProto.keySeq["Up"], "\u{1b}[A")
        XCTAssertEqual(TerminalProto.keySeq["Down"], "\u{1b}[B")
        XCTAssertEqual(TerminalProto.keySeq["Right"], "\u{1b}[C")
        XCTAssertEqual(TerminalProto.keySeq["Left"], "\u{1b}[D")
        XCTAssertEqual(TerminalProto.keySeq["⇧←"], "\u{1b}[1;2D")
        XCTAssertEqual(TerminalProto.keySeq["Ctrl-C"], "\u{03}")
        XCTAssertEqual(TerminalProto.keySeq["Ctrl-D"], "\u{04}")
        XCTAssertEqual(TerminalProto.keySeq["Enter"], "\r")
    }

    func testKeyBarOrderMatchesWeb() {
        XCTAssertEqual(TerminalProto.keyBar, ["Esc", "Tab", "Ctrl-C", "Up", "Down", "Left", "⇧←", "Right", "Enter"])
    }

    func testKeyBarEntriesAllHaveASequence() {
        for key in TerminalProto.keyBar {
            XCTAssertNotNil(TerminalProto.keySeq[key], "keyBar '\(key)' has no matching keySeq")
        }
    }
}
