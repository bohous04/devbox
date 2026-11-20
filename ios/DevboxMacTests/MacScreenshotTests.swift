#if DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import DevboxApp

/// Screenshots of the Mac window on the DEBUG fixture set (`demo`), rendered offscreen, so they work with a locked
/// screen and without Screen Recording. The window's content (sidebar and detail) is hosted in an offscreen titled
/// window at 1440×900 and drawn from its frame view, title bar and toolbar included. Written as PNGs to
/// `MAC_SHOTS_DIR` (pass `TEST_RUNNER_MAC_SHOTS_DIR=<dir>` to xcodebuild); skipped without it.
@MainActor
final class MacScreenshotTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MAC_SHOTS_DIR"], !path.isEmpty else {
            throw XCTSkip("Mac screenshots off — set TEST_RUNNER_MAC_SHOTS_DIR to write them")
        }
        dir = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        FixtureMode.requested = "demo"
        MacInboxRow.flatStyles = true // the render has no vibrancy for the rows' hierarchical styles
    }

    override func tearDown() {
        FixtureMode.requested = nil
        MacInboxRow.flatStyles = false
        MacSidebarLayout.debugOpen = nil
    }

    /// The sidebar as a new window shows it (shelves shut), then with Working opened.
    func testSidebarShelves() throws {
        for look in ["light", "dark"] { try shoot(name: "sidebar-\(look)", look: look, thread: nil) }
        MacSidebarLayout.debugOpen = MacSidebarLayout.openByDefault.union(["Working"])
        try shoot(name: "sidebar-working-open-dark", look: "dark", thread: nil)
    }

    /// Dashboard mode on a few of its native screens.
    func testDashboard() throws {
        for (page, look) in [(MacDashboardPage.sessions, "dark"), (.folders, "light"), (.schedules, "dark")] {
            try shoot(name: "dashboard-\(page.rawValue)-\(look)", look: look, thread: nil, page: page)
        }
    }

    func testInbox() throws {
        for look in ["light", "dark"] { try shoot(name: "inbox-\(look)", look: look, thread: nil) }
    }

    func testThread() throws {
        for look in ["light", "dark"] { try shoot(name: "thread-\(look)", look: look, thread: "dev-orchard-sync") }
        // The composer with text in it: send enabled.
        try shoot(name: "thread-typed-light", look: "light", thread: "dev-orchard-sync", draft: "Pin Node 22 in the Dockerfile too")
    }

    private func shoot(name: String, look: String, thread: String?, page: MacDashboardPage? = nil, draft: String? = nil) throws {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let root = MacWindowContent(thread: .constant(thread), page: .constant(page), newSession: .constant(false), findRequest: 0)
            .environmentObject(state)
            .environmentObject(state.appModel)
        let size = NSSize(width: 1440, height: 900)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua)
        window.contentView = NSHostingView(rootView: root)
        window.setContentSize(size)
        // Ordered in far off any screen: AppKit then lays out and draws the list's rows, which it skips for a window
        // that is not visible. Nothing shows on a display, and it works with the screen locked.
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        // Key, as the window someone is using: the title and toolbar draw in their active colours.
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        // Let the stores load the fixtures and the thread render; .task and the inbox stream run on the main loop.
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            if state.inbox?.items != nil, thread == nil || state.windows.store(for: thread!, client: state.appModel.client!).thread != nil {
                break
            }
        }
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        XCTAssertNotNil(state.inbox?.items, "the fixture inbox did not load")
        if let draft {
            // Typed as a user would: the field's editor takes the text and SwiftUI's binding follows.
            let field = try XCTUnwrap(Self.allViews(window.contentView!).first { ($0 as? NSTextField)?.placeholderString == "Ask anything" || ($0 is NSTextView && $0.frame.width > 300) },
                                      "no composer field")
            window.makeFirstResponder(field)
            let editor = try XCTUnwrap(window.firstResponder as? NSTextView, "the composer has no editor")
            editor.insertText(draft, replacementRange: NSRange(location: NSNotFound, length: 0))
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        }

        let frame = try XCTUnwrap(window.contentView?.superview, "the window has no frame view")
        // The sidebar list makes its rows when it is drawn on a screen; offscreen they are made here.
        for case let table as NSTableView in Self.views(in: frame, named: "SwiftUIOutlineListView") {
            for row in 0..<table.numberOfRows { _ = table.rowView(atRow: row, makeIfNecessary: true) }
            // The selected row's highlight is a material too: drawn as the plain selection colour of a list that does
            // not have the focus (the thread does, after a click on a row).
            for row in Self.views(in: table, named: "ListTableRowView") {
                for effect in row.subviews where effect is NSVisualEffectView {
                    effect.layer?.sublayers?.forEach { $0.isHidden = true }
                    window.effectiveAppearance.performAsCurrentDrawingAppearance {
                        effect.layer?.backgroundColor = NSColor.unemphasizedSelectedContentBackgroundColor.cgColor
                    }
                    effect.layer?.cornerRadius = 6
                }
            }
        }
        frame.layoutSubtreeIfNeeded()
        frame.displayIfNeeded()
        // cacheDisplay leaves the sidebar list blank (its rows draw straight into layers), so the layer tree is
        // rendered instead. Materials (sidebar, title bar) are composited by the window server and come out plain.
        let layer = try XCTUnwrap(frame.layer, "the frame view has no layer")
        let scale = window.backingScaleFactor
        let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale),
                                                 pixelsHigh: Int(frame.bounds.height * scale), bitsPerSample: 8,
                                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let previous = NSAppearance.current
        NSAppearance.current = window.effectiveAppearance
        defer { NSAppearance.current = previous }
        let graphics = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: rep))
        NSGraphicsContext.current = graphics
        defer { NSGraphicsContext.current = nil }
        let context = graphics.cgContext
        context.setFillColor((window.appearance?.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.12, alpha: 1) : .white).cgColor)
        context.fill(CGRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh))
        context.scaleBy(x: scale, y: scale)
        Self.dropCompositing(layer)
        // The segmented control knocks its selection out of the labels with a black layer the window server
        // composites away; drawn plainly it is a black pill over "Chat", so it is left out.
        func all(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap(all) }
        for segmented in all(frame) where String(describing: type(of: segmented)).contains("AppKitSegmentedControl") {
            func knockouts(_ l: CALayer) -> [CALayer] {
                (l.backgroundColor.flatMap { NSColor(cgColor: $0) }.map { $0.alphaComponent == 1 && $0.brightnessComponent == 0 } == true ? [l] : [])
                    + (l.sublayers ?? []).flatMap(knockouts)
            }
            segmented.layer.map(knockouts)?.forEach { $0.isHidden = true }
        }
        layer.render(in: context)
        // The title bar's blur is a window-server backdrop too: without it the thread scrolls visibly under the
        // title, so the bar gets the window background and its items are drawn again on top.
        if let bar = Self.views(in: frame, named: "NSTitlebarContainerView").first, let barLayer = bar.layer {
            let rect = bar.convert(bar.bounds, to: frame)
            context.saveGState()
            context.setFillColor(NSColor.windowBackgroundColor.cgColor)
            context.fill(rect)
            context.translateBy(x: rect.minX, y: rect.minY)
            barLayer.render(in: context)
            context.restoreGState()
        }
        // Liquid Glass panes (the sidebar, toolbar platters) draw their content through the window server, so it is
        // missing from the layer render: each one is filled with the window background and its content drawn on top.
        for glass in Self.views(in: frame, named: "NSGlassEffectView") {
            guard let content = glass.subviews.first?.subviews.first else { continue }
            let rect = content.convert(content.bounds, to: frame)
            context.saveGState()
            if glass.bounds.width > 100 {
                context.setFillColor(NSColor.windowBackgroundColor.cgColor)
                context.fill(rect)
            }
            // Sidebar text is vibrant: a compositing filter the window server applies, which a layer render drops
            // along with the text. Plain compositing draws it at its own colour.
            if let contentLayer = content.layer {
                Self.dropCompositing(contentLayer)
                context.translateBy(x: rect.minX, y: rect.minY)
                contentLayer.render(in: context)
            }
            context.restoreGState()
        }
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: dir.appending(path: "mac-\(name).png"))
        state.inbox?.stop()
        state.live?.stop()
    }

    private static func dropCompositing(_ layer: CALayer) {
        layer.compositingFilter = nil
        layer.filters = nil
        layer.backgroundFilters = nil
        layer.sublayers?.forEach(dropCompositing)
    }

    private static func allViews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap(allViews) }

    private static func views(in view: NSView, named name: String) -> [NSView] {
        (String(describing: type(of: view)) == name ? [view] : []) + view.subviews.flatMap { views(in: $0, named: name) }
    }
}
#endif
