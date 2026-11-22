import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// The few APIs that differ between the iOS and the Mac app, so the shared screens need no `#if` of their own.

#if os(iOS)
typealias PlatformImage = UIImage
typealias PlatformColor = UIColor
#else
typealias PlatformImage = NSImage
typealias PlatformColor = NSColor
#endif

extension Image {
    init(platformImage: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

enum ImagePasteboard {
    #if os(iOS)
    /// The pasteboard's images.
    static func providers() -> [NSItemProvider] {
        UIPasteboard.general.itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    }
    #else
    /// The clipboard; tests put a private one here, so the user's clipboard is never touched.
    static var pasteboard = NSPasteboard.general

    /// The pasteboard's images, image files copied in Finder included.
    static func providers(in pb: NSPasteboard = pasteboard) -> [NSItemProvider] {
        let files = imageFiles(in: pb)
        return files.isEmpty ? imageData(in: pb) : files
    }

    /// Image files copied in Finder.
    static func imageFiles(in pb: NSPasteboard) -> [NSItemProvider] {
        (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
            .filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }
            .compactMap { NSItemProvider(contentsOf: $0) }
    }

    /// Image data (a screenshot, an image copied from a page).
    static func imageData(in pb: NSPasteboard) -> [NSItemProvider] {
        (pb.pasteboardItems ?? []).compactMap { item in
            guard let type = item.types.first(where: { UTType($0.rawValue)?.conforms(to: .image) == true }),
                  let data = item.data(forType: type) else { return nil }
            return NSItemProvider(item: data as NSData, typeIdentifier: type.rawValue)
        }
    }
    #endif
}

#if os(macOS)
/// ⌘V in the composer: the field editor pastes only text and Edit > Paste takes the key before any SwiftUI handler, so
/// the composer watches for the key itself (ComposerView) and takes it only while the pasteboard holds images.
enum ComposerPaste {
    static func isPasteKey(flags: NSEvent.ModifierFlags, key: String) -> Bool {
        flags.intersection([.command, .shift, .option, .control]) == .command && key == "v"
    }

    /// The images ⌘V attaches. Image files copied in Finder (which also put their names as text); image data only when
    /// no text comes with it: Excel, Numbers, Word and rich browser selections put both, and those paste as text.
    static func images(in pb: NSPasteboard) -> [NSItemProvider] {
        let files = ImagePasteboard.imageFiles(in: pb)
        if !files.isEmpty { return files }
        if pb.availableType(from: [.string, .rtf, .rtfd, .html]) != nil { return [] }
        return ImagePasteboard.imageData(in: pb)
    }

    /// The window's focus is a text editor inside `area` (window coordinates): the composer's field, not the terminal
    /// or the toolbar's search field.
    static func ownsFocus(_ responder: NSResponder?, area: NSRect) -> Bool {
        guard let editor = responder as? NSTextView, editor.window != nil else { return false }
        let frame = editor.convert(editor.bounds, to: nil)
        return area.contains(NSPoint(x: frame.midX, y: frame.midY))
    }
}

/// Calls `onPaste` with the pasteboard's images (ComposerPaste.images) for ⌘V while `active` and the focus is an
/// editor inside this view; other keys, ⌘V elsewhere and ⌘V with no image or with text go on as usual.
struct ImagePasteKey: NSViewRepresentable {
    let active: Bool
    let onPaste: ([NSItemProvider]) -> Void

    final class Coordinator {
        var active = false
        var onPaste: ([NSItemProvider]) -> Void = { _ in }
        var monitor: Any?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let c = context.coordinator
        c.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak c, weak view] event in
            guard let c, let view, c.active, let window = view.window, event.window === window,
                  ComposerPaste.isPasteKey(flags: event.modifierFlags, key: event.charactersIgnoringModifiers ?? ""),
                  ComposerPaste.ownsFocus(window.firstResponder, area: view.convert(view.bounds, to: nil)) else { return event }
            let images = ComposerPaste.images(in: ImagePasteboard.pasteboard)
            guard !images.isEmpty else { return event }
            c.onPaste(images)
            return nil
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.active = active
        context.coordinator.onPaste = onPaste
    }

    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        if let m = coordinator.monitor { NSEvent.removeMonitor(m) }
    }
}
#endif

enum Clipboard {
    static func copy(_ string: String) {
        #if os(iOS)
        UIPasteboard.general.string = string
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #endif
    }
}

extension View {
    /// A menu drawn by its own label. The Mac's default menu adds a bezel and its own chevron (a second one beside the
    /// label's) and a dropdown arrow to an icon button; the iPhone draws only the label already.
    func labelOnlyMenu() -> some View {
        #if os(macOS)
        menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        #else
        self
        #endif
    }

    /// A button drawn only by its label. The Mac's default style puts a bezel around a custom label (a square behind
    /// the composer's round send button); the iPhone draws only the label already.
    func labelOnlyButton() -> some View {
        #if os(macOS)
        buttonStyle(.plain)
        #else
        self
        #endif
    }

    /// Inline navigation title on iPhone; the Mac has no title display modes.
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// No soft fade at a scroll view's edges (the system default from iOS 26): a diff or a code line must not look
    /// rounded off where it meets the block's edge.
    @ViewBuilder
    func plainScrollEdges() -> some View {
        if #available(iOS 26, macOS 26, *) {
            scrollEdgeEffectHidden(true, for: .all)
        } else {
            self
        }
    }

    /// At least 44 pt to tap on iPhone (Apple's minimum) while the drawn control may stay smaller. The Mac's pointer
    /// needs no more than the control itself.
    func iPhoneTapTarget() -> some View {
        #if os(iOS)
        frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        #else
        self
        #endif
    }

    /// A pushed screen that needs the full height (the chat thread): no tab bar under it on iPhone; back navigation
    /// brings it back. The Mac has no tab bar there.
    func hidesTabBar() -> some View {
        #if os(iOS)
        toolbar(.hidden, for: .tabBar)
        #else
        self
        #endif
    }

    /// An opaque navigation bar in the screen's background colour, so content scrolls under a solid bar instead of
    /// showing through it (the chat draws the hairline under it). The Mac's window toolbar stays as it is.
    func solidNavigationBar() -> some View {
        #if os(iOS)
        toolbarBackground(Theme.C.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        #else
        self
        #endif
    }

    /// A field for a URL or a token: no autocapitalization or autocorrection, the URL keyboard on iPhone.
    func plainEntry(url: Bool = false) -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(url ? .URL : .default)
        #else
        autocorrectionDisabled()
        #endif
    }

    /// The inset grouped list on iPhone; the Mac has no such style.
    func insetGroupedList() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }

    /// The number pad on iPhone (the Mac has a keyboard).
    func numberPadEntry() -> some View {
        #if os(iOS)
        keyboardType(.numberPad)
        #else
        self
        #endif
    }

    /// Full-screen on iPhone, a sheet on the Mac.
    func fullScreenOrSheet<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
        #if os(iOS)
        fullScreenCover(isPresented: isPresented, content: content)
        #else
        sheet(isPresented: isPresented, content: content)
        #endif
    }
}

extension View {
    /// A decision button (approve, reject): the app's web-styled button on iPhone, where the system's prominent style
    /// draws light text on the near-white primary in dark mode; a compact system button on the Mac, where 44 pt
    /// would tower over the rest of the detail pane.
    @ViewBuilder
    func decisionButtonStyle(prominent: Bool) -> some View {
        #if os(macOS)
        if prominent {
            buttonStyle(.borderedProminent).controlSize(.small)
        } else {
            buttonStyle(.bordered).controlSize(.small)
        }
        #else
        buttonStyle(DevboxButtonStyle(variant: prominent ? .default : .outline))
        #endif
    }
}
