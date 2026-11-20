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
    static var hasImages: Bool {
        #if os(iOS)
        UIPasteboard.general.hasImages
        #else
        !providers().isEmpty
        #endif
    }

    /// The pasteboard's images: on the Mac also image files copied in Finder.
    static func providers() -> [NSItemProvider] {
        #if os(iOS)
        UIPasteboard.general.itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        #else
        let pb = NSPasteboard.general
        let files = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
            .filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }
            .compactMap { NSItemProvider(contentsOf: $0) }
        if !files.isEmpty { return files }
        return (pb.pasteboardItems ?? []).compactMap { item in
            guard let type = item.types.first(where: { UTType($0.rawValue)?.conforms(to: .image) == true }),
                  let data = item.data(forType: type) else { return nil }
            return NSItemProvider(item: data as NSData, typeIdentifier: type.rawValue)
        }
        #endif
    }
}

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
        menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
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
