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
        MacSidebarLayout.debugOpenShelves = []
    }

    /// The sidebar as a new window shows it (shelves shut), then with Working opened and its row selected. The inbox is
    /// short, so the shelves must still sit at the bottom, right over the footer, not under Idle. Then a short window
    /// with every shelf open: the shelves stop short of the groups' room and scroll inside.
    func testSidebarShelves() throws {
        for look in ["light", "dark"] { try shoot(name: "sidebar-\(look)", look: look, thread: nil, inspect: Self.shelvesPinned()) }
        MacSidebarLayout.debugOpenShelves = ["Working"]
        for look in ["light", "dark"] {
            try shoot(name: "sidebar-working-open-\(look)", look: look, thread: "dev-lumen-app", inspect: Self.shelvesPinned())
        }
        MacSidebarLayout.debugOpenShelves = ["Working", "Snoozed", "Settled"]
        try shoot(name: "sidebar-short-window-light", look: "light", thread: nil, height: 420, inspect: Self.shelvesPinned(capped: true))
    }

    /// ↓ on the last scrolling row goes on into the open Working shelf, and ↑ comes back, scrolled into view: real key
    /// events into the lists of a short window, where the last Idle row is out of sight.
    func testArrowsCrossIntoThePinnedShelves() throws {
        MacSidebarLayout.debugOpenShelves = ["Working"]
        var selected: String? = "dev-lumen-onboarding" // the last Idle row of the fixtures
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let root = MacWindowContent(thread: Binding(get: { selected }, set: { selected = $0 }), page: .constant(nil),
                                    newSession: .constant(false), findPending: .constant(false))
            .environmentObject(state)
            .environmentObject(state.appModel)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 420), styleMask: [.titled, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: root)
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        defer { window.close(); state.inbox?.stop(); state.live?.stop() }
        func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
        let deadline = Date().addingTimeInterval(8)
        while state.inbox?.items == nil, Date() < deadline { spin(0.1) }
        spin(1)
        // Ordered by their scroll views, which stay put when the lists scroll.
        let lists = Self.sidebarLists(in: window.contentView!)
        XCTAssertEqual(lists.count, 2)
        guard lists.count == 2 else { return }
        func press(_ key: Int, in list: NSView) throws {
            window.makeFirstResponder(list)
            let arrow = String(UnicodeScalar(key)!)
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.numericPad, .function], timestamp: 0,
                                                       windowNumber: window.windowNumber, context: nil, characters: arrow,
                                                       charactersIgnoringModifiers: arrow, isARepeat: false,
                                                       keyCode: key == NSDownArrowFunctionKey ? 125 : 126))
            window.sendEvent(event)
            spin(0.5)
        }
        try press(NSDownArrowFunctionKey, in: lists[0])
        XCTAssertEqual(selected, "dev-lumen-app", "↓ goes on from Idle into Working")
        XCTAssertTrue(window.firstResponder === lists[1], "the keyboard follows into the shelves")
        // The selected row lies in its list's room: inside the scroll view, clear of the insets over it.
        func inSight(_ table: NSTableView) -> Bool {
            guard table.selectedRow >= 0, let scroll = table.enclosingScrollView else { return false }
            let row = table.convert(table.rect(ofRow: table.selectedRow), to: nil), frame = scroll.convert(scroll.bounds, to: nil)
            return row.minY >= frame.minY + scroll.contentInsets.bottom - 1 && row.maxY <= frame.maxY - scroll.contentInsets.top + 1
        }
        XCTAssertTrue(inSight(lists[1]), "the Working row is in sight")
        try press(NSUpArrowFunctionKey, in: lists[1])
        XCTAssertEqual(selected, "dev-lumen-onboarding", "↑ comes back to the last Idle row")
        XCTAssertTrue(inSight(lists[0]), "the last Idle row is scrolled into sight")
    }

    /// The sidebar's two lists, the groups that scroll over the shelves pinned under them, ordered by their scroll views
    /// (which stay put when the lists scroll).
    private static func sidebarLists(in view: NSView) -> [NSTableView] {
        func top(_ list: NSView) -> CGFloat { let v = list.enclosingScrollView ?? list; return v.convert(v.bounds, to: nil).maxY }
        return views(in: view, named: "SwiftUIOutlineListView").compactMap { $0 as? NSTableView }.sorted { top($0) > top($1) }
    }

    /// The groups' list spans the column under its insets; the shelves' list sits in its bottom inset with only the
    /// footer under it, as tall as its rows (or, `capped`, shorter and scrolling), at most `shelfShare` of the sidebar,
    /// and leaving the groups at least `groupsMinimum` of visible room.
    private static func shelvesPinned(capped: Bool = false) -> (NSView) throws -> Void { { frame in
        let tables = sidebarLists(in: frame)
        XCTAssertEqual(tables.count, 2, "expected the groups' list and the shelves' list")
        guard tables.count == 2, let groups = tables[0].enclosingScrollView, let shelves = tables[1].enclosingScrollView else { return }
        let (g, s) = (groups.convert(groups.bounds, to: nil), shelves.convert(shelves.bounds, to: nil))
        XCTAssertEqual(s.maxY, g.minY + groups.contentInsets.bottom, accuracy: 1, "the shelves sit right under the groups' room")
        XCTAssertGreaterThan(s.minY, g.minY + 20, "the footer is under the shelves")
        if capped {
            XCTAssertLessThan(s.height, tables[1].frame.height - 1, "capped: the shelves scroll inside")
        } else {
            XCTAssertEqual(s.height, tables[1].frame.height, accuracy: 1, "the shelves take their rows' height")
        }
        XCTAssertLessThanOrEqual(s.height, g.height * MacSidebarLayout.shelfShare + 1)
        XCTAssertGreaterThanOrEqual(g.height - groups.contentInsets.top - groups.contentInsets.bottom, MacSidebarLayout.groupsMinimum - 1,
                                    "the groups keep their room")
    } }

    /// Dashboard mode on a few of its native screens.
    func testDashboard() throws {
        for (page, look) in [(MacDashboardPage.sessions, "dark"), (.folders, "light"), (.schedules, "dark"),
                             (.unpushed, "light"), (.unpushed, "dark"), (.upkeep, "light"), (.upkeep, "dark"),
                             (.operations, "light"), (.operations, "dark")] {
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

    /// The composer's `/` and `@` menus above it, over the thread.
    func testComposerTriggers() throws {
        for look in ["light", "dark"] {
            try shoot(name: "composer-commands-\(look)", look: look, thread: "dev-orchard-sync", draft: "/")
            try shoot(name: "composer-files-\(look)", look: look, thread: "dev-orchard-sync", draft: "Check @sync")
        }
        try shoot(name: "composer-commands-filtered-light", look: "light", thread: "dev-orchard-sync", draft: "/rev")
    }

    /// The thread's heading (title and place) at a normal and a narrow width. On macOS 26 it is a plain title: a
    /// Liquid Glass capsule (drawn plain here, so checked in the view tree) was too short for its two lines.
    func testThreadHeadingWidths() throws {
        for (width, look) in [(1440.0, "dark"), (900.0, "light"), (900.0, "dark"), (720.0, "light")] {
            try shoot(name: "thread-heading-\(Int(width))-\(look)", look: look, thread: "dev-orchard-sync", width: width) { frame in
                // The heading is the toolbar's only item that is text alone: every control there (sidebar toggle, changes
                // chip, Chat/Terminal) hosts a view of its own. Offscreen SwiftUI exposes no accessibility tree to find it by.
                let items = Self.views(in: frame, prefixed: "ToolbarItemHostingView").filter { $0.subviews.isEmpty }
                XCTAssertEqual(items.count, 1, "expected one text-only toolbar item, the heading")
                let item = try XCTUnwrap(items.first)
                if #available(macOS 26, *) {
                    XCTAssertFalse(Self.ancestors(item).contains { String(describing: type(of: $0)) == "NSGlassEffectView" },
                                   "the heading sits in a glass capsule")
                }
                // Both lines fit the item's height.
                XCTAssertGreaterThanOrEqual(item.bounds.height, 30)
            }
        }
    }

    /// The row menu's Rename and End sheets (MacSessionActions.swift), drawn on their own as the sheet shows them.
    func testSessionActionSheets() throws {
        let actions = MacSessionActions()
        let item = try JSONDecoder().decode(InboxItem.self, from: Data(#"""
            {"sessionId":"dev-acme-billing","runtime":"tmux","title":"Run the invoice table migration","project":"acme","repo":"billing",
             "agent":"claude","attention":{"section":"idle","since":0}}
            """#.utf8))
        let rename = MacRenameSheet(rename: .init(sessionId: item.sessionId, name: "Run the invoice table migration"),
                                    actions: actions)
        actions.requestEnd(item, MacSessionMenu.EndConfirmation(title: "End session dev-acme-billing?",
                                                                message: "Permanent — \(MacSessionMenu.endEffect(worktree: true))."), worktree: true)
        for look in ["light", "dark"] {
            try shootView(rename, name: "rename-sheet-\(look)", look: look)
            try shootView(MacSessionTaskSheet(actions: actions), name: "end-sheet-\(look)", look: look)
        }
    }

    private func shootView(_ view: some View, name: String, look: String) throws {
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        host.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: dir.appending(path: "mac-\(name).png"))
    }

    private func shoot(name: String, look: String, thread: String?, page: MacDashboardPage? = nil, draft: String? = nil, width: CGFloat = 1440, height: CGFloat = 900,
                       inspect: ((NSView) throws -> Void)? = nil) throws {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let root = MacWindowContent(thread: .constant(thread), page: .constant(page), newSession: .constant(false), findPending: .constant(false))
            .environmentObject(state)
            .environmentObject(state.appModel)
        let size = NSSize(width: width, height: height)
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
            let field = try XCTUnwrap(Self.allViews(window.contentView!).first {
                // The placeholder is styled (muted), so AppKit holds it as an attributed string.
                ($0 as? NSTextField).map { ($0.placeholderAttributedString?.string ?? $0.placeholderString)?.hasPrefix("Ask anything") == true } == true
                    || ($0 is NSTextView && $0.frame.width > 300)
            },
                                      "no composer field")
            window.makeFirstResponder(field)
            let editor = try XCTUnwrap(window.firstResponder as? NSTextView, "the composer has no editor")
            editor.insertText(draft, replacementRange: NSRange(location: NSNotFound, length: 0))
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        }

        let frame = try XCTUnwrap(window.contentView?.superview, "the window has no frame view")
        try inspect?(frame)
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

    private static func views(in view: NSView, prefixed prefix: String) -> [NSView] {
        (String(describing: type(of: view)).hasPrefix(prefix) ? [view] : []) + view.subviews.flatMap { views(in: $0, prefixed: prefix) }
    }

    private static func ancestors(_ view: NSView) -> [NSView] {
        sequence(first: view, next: \.superview).map { $0 }
    }

    private static func views(in view: NSView, named name: String) -> [NSView] {
        (String(describing: type(of: view)) == name ? [view] : []) + view.subviews.flatMap { views(in: $0, named: name) }
    }
}
#endif
