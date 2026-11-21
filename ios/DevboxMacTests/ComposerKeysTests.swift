#if DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import DevboxApp

/// The composer's `/` and `@` menu driven by real key events in the Mac window, on the DEBUG fixture thread: the field
/// editor must hand Return, Tab, the arrows and Escape to the menu (ComposerTriggers.keyAction) while it is open.
@MainActor
final class ComposerKeysTests: XCTestCase {
    private var window: NSWindow!
    private var state: MacAppState!

    override func setUpWithError() throws {
        FixtureMode.requested = "demo"
        state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let root = MacWindowContent(thread: .constant(ThreadFixtures.sessionId), page: .constant(nil), newSession: .constant(false),
                                    findPending: .constant(false))
            .environmentObject(state)
            .environmentObject(state.appModel)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: root)
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, state.windows.store(for: ThreadFixtures.sessionId, client: state.appModel.client!).thread == nil { spin(0.1) }
        spin(1)
    }

    override func tearDown() {
        window?.close()
        state?.inbox?.stop()
        state?.live?.stop()
        FixtureMode.requested = nil
    }

    private func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    /// The composer's editor, focused, holding `text` typed in.
    private func type(_ text: String) throws -> NSTextView {
        let field = try XCTUnwrap(Self.allViews(window.contentView!).first {
            ($0 as? NSTextField).map { ($0.placeholderAttributedString?.string ?? $0.placeholderString)?.hasPrefix("Ask anything") == true } == true
                || ($0 is NSTextView && $0.frame.width > 300)
        }, "no composer field")
        window.makeFirstResponder(field)
        let editor = try XCTUnwrap(window.firstResponder as? NSTextView, "the composer has no editor")
        editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
        spin(0.5)
        return editor
    }

    private func press(_ chars: String, _ keyCode: UInt16, flags: NSEvent.ModifierFlags = []) throws {
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                                   windowNumber: window.windowNumber, context: nil, characters: chars,
                                                   charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode))
        window.sendEvent(event)
        spin(0.4)
    }

    private static func allViews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap(allViews) }

    func testReturnPicksTheHighlightedCommand() throws {
        let editor = try type("/rev")
        try press("\r", 36)
        XCTAssertEqual(editor.string, "/review ")
    }

    func testArrowThenTabPicksTheNextFile() throws {
        let editor = try type("@sync")
        spin(0.5) // the search's debounce and answer
        try press(String(UnicodeScalar(NSDownArrowFunctionKey)!), 125, flags: [.numericPad, .function])
        try press("\t", 48)
        XCTAssertEqual(editor.string, "@src/sync/merge.ts ")
    }

    func testEscapeClosesTheMenuForThatWord() throws {
        let editor = try type("@sync")
        spin(0.5)
        try press("\u{1b}", 53)
        XCTAssertEqual(editor.string, "@sync")
        // Tab now leaves the field (its own behaviour), picking nothing: the field keeps the text.
        let field = try XCTUnwrap(editor.delegate as? NSTextField, "the editor edits no text field")
        try press("\t", 48)
        XCTAssertEqual(field.stringValue, "@sync", "Tab after Escape picks nothing")
    }
}
#endif
