#if os(macOS)
import AppKit
import SwiftUI

/// Web addresses in the Mac composer's field editor: drawn in the link colour and opened with ⌘+click. The colour is
/// a rendering attribute of the layout, not an attribute of the text, so the string that is sent stays as typed; a
/// plain click still places the caret.
@MainActor
final class ComposerLinks {
    /// The composer's current text: only the field editor holding it is the composer's (as CaretField does).
    var text = ""
    private var monitor: Any?
    private var handCursor = false

    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .mouseMoved, .flagsChanged]) { [weak self] event in
            guard let self, let editor = self.editor(of: event) else { return event }
            let overLink = event.modifierFlags.contains(.command) && Self.link(at: event, in: editor) != nil
            if event.type == .leftMouseDown {
                guard overLink, let url = Self.link(at: event, in: editor) else { return event }
                NSWorkspace.shared.open(url)
                return nil
            }
            if overLink {
                self.handCursor = true
                // After the text view's own cursor update.
                DispatchQueue.main.async { NSCursor.pointingHand.set() }
            } else if self.handCursor {
                // ⌘ released (or the pointer left the address) without a mouse move to reset the cursor.
                self.handCursor = false
                DispatchQueue.main.async { NSCursor.iBeam.set() }
            }
            return event
        }
    }

    func remove() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }

    private func editor(of event: NSEvent) -> NSTextView? {
        guard let editor = event.window?.firstResponder as? NSTextView, editor.isFieldEditor, editor.string == text else { return nil }
        return editor
    }

    private static func link(at event: NSEvent, in editor: NSTextView) -> URL? {
        // A flags-changed event carries no position: ask the window where the pointer is.
        let where_ = event.type == .flagsChanged ? (editor.window?.mouseLocationOutsideOfEventStream ?? .zero) : event.locationInWindow
        let p = editor.convert(where_, from: nil)
        guard editor.bounds.contains(p) else { return nil }
        return link(atCharacter: editor.characterIndexForInsertion(at: p), in: editor.string)
    }

    /// The address under a character index (an insertion point at an address's end is past it).
    static func link(atCharacter i: Int, in s: String) -> URL? {
        guard let r = LinkDetector.ranges(in: s).first(where: { NSLocationInRange(i, $0) }),
              let sr = Range(r, in: s) else { return nil }
        return URL(string: String(s[sr]))
    }

    /// Draws the field editor's addresses in the link colour (call again after every change of its text).
    static func decorate(_ editor: NSTextView) {
        let ranges = LinkDetector.ranges(in: editor.string)
        if let layout = editor.textLayoutManager, let content = layout.textContentManager {
            layout.removeRenderingAttribute(.foregroundColor, for: layout.documentRange)
            for r in ranges {
                let start = content.location(content.documentRange.location, offsetBy: r.location)
                let end = start.flatMap { content.location($0, offsetBy: r.length) }
                if let start, let end, let tr = NSTextRange(location: start, end: end) {
                    layout.addRenderingAttribute(.foregroundColor, value: NSColor.linkColor, for: tr)
                }
            }
        } else if let layout = editor.layoutManager {
            let whole = NSRange(location: 0, length: (editor.string as NSString).length)
            layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: whole)
            for r in ranges { layout.addTemporaryAttribute(.foregroundColor, value: NSColor.linkColor, forCharacterRange: r) }
        }
    }

    /// The focused field editor, when it holds this composer's text.
    func decorateFocused() {
        guard let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.isFieldEditor, editor.string == text else { return }
        // Hover (the pointing hand) needs the window's mouse-moved events.
        editor.window?.acceptsMouseMovedEvents = true
        Self.decorate(editor)
    }
}
#endif
