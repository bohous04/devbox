import AppKit
import XCTest
@testable import DevboxApp

@MainActor
final class ComposerLinksTests: XCTestCase {
    func testDecoratingColoursTheAddressWithoutTouchingTheText() {
        let s = "see https://youtu.be/abc?t=21. ok"
        let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
        editor.string = s
        let storage = editor.textStorage!
        let before = storage.attribute(.foregroundColor, at: 6, effectiveRange: nil) as? NSColor
        ComposerLinks.decorate(editor)
        XCTAssertEqual(editor.string, s)
        // Nothing is written into the text itself, so what is sent is what was typed.
        XCTAssertNil(storage.attribute(.link, at: 6, effectiveRange: nil))
        XCTAssertEqual(storage.attribute(.foregroundColor, at: 6, effectiveRange: nil) as? NSColor, before)
    }

    func testCharacterIndexFindsTheAddressOnly() {
        let s = "see https://x.y/z?a=1. ok"
        XCTAssertNil(ComposerLinks.link(atCharacter: 1, in: s))
        XCTAssertEqual(ComposerLinks.link(atCharacter: 10, in: s), URL(string: "https://x.y/z?a=1"))
        XCTAssertNil(ComposerLinks.link(atCharacter: 22, in: s))
    }
}
