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
    }

    override func tearDown() {
        FixtureMode.requested = nil
    }

    func testInbox() throws {
        for look in ["light", "dark"] { try shoot(name: "inbox-\(look)", look: look, thread: nil) }
    }

    func testThread() throws {
        for look in ["light", "dark"] { try shoot(name: "thread-\(look)", look: look, thread: "dev-orchard-sync") }
    }

    private func shoot(name: String, look: String, thread: String?) throws {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let root = MacWindowContent(thread: .constant(thread), newSession: .constant(false), findRequest: 0)
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
        window.orderFront(nil)
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

        let frame = try XCTUnwrap(window.contentView?.superview, "the window has no frame view")
        // The sidebar list makes its rows when it is drawn on a screen; offscreen they are made here.
        for case let table as NSTableView in Self.views(in: frame, named: "SwiftUIOutlineListView") {
            for row in 0..<table.numberOfRows { _ = table.rowView(atRow: row, makeIfNecessary: true) }
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
        try png.write(to: dir.appending(path: "mac-r2-\(name).png"))
        state.inbox?.stop()
        state.live?.stop()
    }

    private static func dropCompositing(_ layer: CALayer) {
        layer.compositingFilter = nil
        layer.filters = nil
        layer.sublayers?.forEach(dropCompositing)
    }

    private static func views(in view: NSView, named name: String) -> [NSView] {
        (String(describing: type(of: view)) == name ? [view] : []) + view.subviews.flatMap { views(in: $0, named: name) }
    }
}
#endif
