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
        CaretField.debugWithoutSelection = name.contains("WithoutTheSystemsCaret")
        state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        // A tmux session's Chat view (the mirror) for the tests that name it.
        let session = name.contains("TerminalSession") ? MirrorFixtures.claudeId : ThreadFixtures.sessionId
        // A tmux window opens on Terminal until Chat was chosen for it.
        TmuxTabMemory.shared.remember(.chat, for: TmuxTabMemory.key(MirrorFixtures.claudeId, createdAt: MirrorFixtures.createdAt))
        let root = MacWindowContent(thread: .constant(session), page: .constant(nil), newSession: .constant(false),
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
        while Date() < deadline, state.windows.store(for: session, client: state.appModel.client!).thread == nil { spin(0.1) }
        spin(1)
    }

    override func tearDown() {
        window?.close()
        state?.inbox?.stop()
        state?.live?.stop()
        FixtureMode.requested = nil
        CaretField.debugWithoutSelection = false
    }

    private func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    /// The composer's editor, focused, holding `text` typed in.
    private func type(_ text: String) throws -> NSTextView {
        let field = try XCTUnwrap(Self.allViews(window.contentView!).first {
            ($0 as? NSTextField).map { ($0.placeholderAttributedString?.string ?? $0.placeholderString)?.hasPrefix("Ask anything") == true
                || ($0.placeholderAttributedString?.string ?? $0.placeholderString)?.hasPrefix(MirrorView.placeholder) == true } == true
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

    /// ⌘V with an image on the clipboard attaches it and types nothing: Edit > Paste alone would paste nothing, the
    /// field editor taking only text.
    func testCommandVAttachesAClipboardImage() throws { try commandVAttaches() }

    /// The same in a tmux session's Chat view: its images go to the terminal's agent as files (ThreadStore.sendToPane).
    func testCommandVAttachesAClipboardImageInATerminalSession() throws { try commandVAttaches() }

    private func commandVAttaches() throws {
        let attached = try pressCommandV(clipboard: { $0.setData(try Self.png(), forType: .png) }, typed: "look")
        XCTAssertEqual(attached.count, 1, "the image is attached")
        XCTAssertEqual(attached.editor.string, "look")
    }

    /// Text with an image (cells from Numbers, a rich selection) is the field's paste, as is text alone. (Whether the
    /// field then pastes it is the system's: its editor reads the user's own clipboard, which tests leave alone.)
    func testCommandVWithTextIsTheFieldsPaste() throws {
        let both = try pressCommandV(clipboard: { pb in
            pb.declareTypes([.string, .png], owner: nil)
            pb.setString("A1\tB1", forType: .string)
            pb.setData(try Self.png(), forType: .png)
        }, typed: "look")
        XCTAssertEqual(both.count, 0, "text and an image: nothing attached")
        let text = try pressCommandV(clipboard: { $0.setString("hello", forType: .string) }, typed: "")
        XCTAssertEqual(text.count, 0, "text alone: nothing attached")
    }

    /// ⌘V in another window, its own text field focused, is not the composer's.
    func testCommandVInAnotherWindowIsNotCaught() throws {
        _ = try type("look")
        let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
        other.isReleasedWhenClosed = false
        defer { other.close() }
        let field = NSTextField(frame: NSRect(x: 10, y: 10, width: 200, height: 24))
        other.contentView!.addSubview(field)
        other.setFrameOrigin(NSPoint(x: -21_000, y: -20_000))
        other.makeKeyAndOrderFront(nil)
        other.makeFirstResponder(field)
        spin(0.3)
        let attached = try pressCommandV(clipboard: { $0.setData(try Self.png(), forType: .png) }, in: other)
        XCTAssertEqual(attached.count, 0)
    }

    /// macOS 14's caret (CaretField): a selection change counts only from the focused editor in the field's own
    /// window. Two windows whose composers hold the same text no longer take each other's caret.
    func testCaretComesOnlyFromTheFieldsOwnWindow() throws {
        func window(_ text: String) -> (NSWindow, NSTextView) {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false
            let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
            editor.string = text
            w.contentView!.addSubview(editor)
            XCTAssertTrue(w.makeFirstResponder(editor))
            return (w, editor)
        }
        let (a, editorA) = window("see @sy")
        let (b, editorB) = window("see @sy")
        defer { a.close(); b.close() }
        XCTAssertTrue(CaretField.isOwnEditor(editorA, window: a, text: "see @sy"))
        XCTAssertFalse(CaretField.isOwnEditor(editorB, window: a, text: "see @sy"), "the other window's editor, same text")
        XCTAssertFalse(CaretField.isOwnEditor(editorA, window: nil, text: "see @sy"), "before the field is in a window")
        XCTAssertFalse(CaretField.isOwnEditor(editorA, window: a, text: "other"), "another field in the same window")
    }

    private static func png() throws -> Data {
        let ctx = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        return try XCTUnwrap(NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:]))
    }

    /// ⌘V through the app (menus included) with `clipboard` on a private pasteboard; the images it attached and the
    /// composer's editor (`typed` into it first, unless the key goes to `target`, another window).
    private func pressCommandV(clipboard: (NSPasteboard) throws -> Void, typed: String = "", in target: NSWindow? = nil)
        throws -> (count: Int, editor: NSTextView) {
        let pb = NSPasteboard(name: NSPasteboard.Name("devbox-tests-\(UUID().uuidString)"))
        ImagePasteboard.pasteboard = pb
        defer { ImagePasteboard.pasteboard = .general; pb.releaseGlobally() }
        pb.clearContents()
        try clipboard(pb)
        let editor = target == nil ? try type(typed) : NSTextView()
        var attached = 0
        ComposerView.debugAttached = { attached = $0 }
        defer { ComposerView.debugAttached = nil }
        let v = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                               windowNumber: (target ?? window).windowNumber, context: nil, characters: "v",
                                               charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9))
        NSApp.sendEvent(v)
        spin(1)
        return (attached, editor)
    }

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

    /// macOS 14's path (no TextField selection; setUp picks it by the name): typed at the end the menu works; a click
    /// elsewhere in the text closes it, so Tab is the field's again.
    func testWithoutTheSystemsCaretAClickElsewhereClosesTheMenu() throws {
        let editor = try type("see @sync")
        spin(0.5)
        try press("\t", 48)
        XCTAssertEqual(editor.string, "see @src/sync/manifest.ts ", "typed at the end, Tab picks")
        editor.insertText("@mer", replacementRange: NSRange(location: NSNotFound, length: 0))
        spin(0.6)
        editor.setSelectedRange(NSRange(location: 2, length: 0))
        spin(0.3)
        let field = try XCTUnwrap(editor.delegate as? NSTextField)
        try press("\t", 48)
        XCTAssertEqual(field.stringValue, "see @src/sync/manifest.ts @mer", "the caret left the word: Tab picks nothing")
    }
}
#endif
