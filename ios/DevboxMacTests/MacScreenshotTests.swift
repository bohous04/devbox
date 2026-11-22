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
        MacInboxRow.debugHovered = nil
        MacInboxRow.debugEmphasized = nil
        MacSidebarLayout.debugOpenShelves = []
    }

    /// The sidebar alone as one list (T3 Code's model): marks only where there is something to say, a hovered row's ✓
    /// in place of its time, and the undo notice after a real settle against the fixture devd.
    func testSidebarOneList() throws {
        for look in ["light", "dark"] {
            try shoot(name: "sidebar-list-\(look)", look: look, thread: nil, width: 1100, height: 820, sidebarOnly: true)
        }
        // Selected in the list that has the keyboard: the system accent selection, the row's text and mark light on it
        // (#122's contrast). Offscreen the window is never key, so the row is told it is on the accent selection.
        MacInboxRow.debugEmphasized = "dev-acme-billing"
        for look in ["light", "dark"] {
            try shoot(name: "sidebar-selected-accent-\(look)", look: look, thread: "dev-acme-billing", width: 1100, height: 820,
                      sidebarOnly: true, focusList: true)
        }
        MacInboxRow.debugEmphasized = nil
        MacInboxRow.debugHovered = "dev-orchard-sync"
        for look in ["light", "dark"] {
            try shoot(name: "sidebar-hover-settle-\(look)", look: look, thread: nil, width: 1100, height: 820, sidebarOnly: true)
        }
        MacInboxRow.debugHovered = nil
        for look in ["light", "dark"] {
            try shoot(name: "sidebar-undo-notice-\(look)", look: look, thread: nil, width: 1100, height: 820, sidebarOnly: true) { state in
                guard let inbox = state.inbox, let item = inbox.items?.first(where: { $0.sessionId == "dev-lumen-docs" }) else {
                    return XCTFail("the fixture row to settle is missing")
                }
                await state.settler.settle(item, in: inbox)
                XCTAssertNil(state.settler.problem)
                XCTAssertNotNil(state.settler.notice)
            }
        }
    }

    /// The sidebar as a new window shows it (shelves shut), then with Working opened and its row selected. The inbox is
    /// short, so the shelves must still sit at the bottom, right over the footer, not under the list's last row. Then a short window
    /// with every shelf open: the shelves stop short of the list's room and scroll inside.
    func testSidebarShelves() throws {
        for look in ["light", "dark"] { try shoot(name: "sidebar-\(look)", look: look, thread: nil, inspect: Self.shelvesPinned()) }
        MacSidebarLayout.debugOpenShelves = ["Working"]
        for look in ["light", "dark"] {
            try shoot(name: "sidebar-working-open-\(look)", look: look, thread: "dev-lumen-app", inspect: Self.shelvesPinned())
        }
        MacSidebarLayout.debugOpenShelves = ["Working", "Snoozed", "Settled"]
        try shoot(name: "sidebar-short-window-light", look: "light", thread: nil, height: 420, inspect: Self.shelvesPinned(capped: true))
    }

    /// ↓ on the last row of the list goes on into the open Working shelf, and ↑ comes back, scrolled into view: real key
    /// events into the lists of a short window, where the list's last row is out of sight.
    func testArrowsCrossIntoThePinnedShelves() throws {
        MacSidebarLayout.debugOpenShelves = ["Working"]
        var selected: String? = "dev-lumen-onboarding" // the list's last row in the fixtures (the oldest idle one)
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
        XCTAssertEqual(selected, "dev-lumen-app", "↓ goes on from the list into Working")
        XCTAssertTrue(window.firstResponder === lists[1], "the keyboard follows into the shelves")
        // The selected row lies in its list's room: inside the scroll view, clear of the insets over it.
        func inSight(_ table: NSTableView) -> Bool {
            guard table.selectedRow >= 0, let scroll = table.enclosingScrollView else { return false }
            let row = table.convert(table.rect(ofRow: table.selectedRow), to: nil), frame = scroll.convert(scroll.bounds, to: nil)
            return row.minY >= frame.minY + scroll.contentInsets.bottom - 1 && row.maxY <= frame.maxY - scroll.contentInsets.top + 1
        }
        XCTAssertTrue(inSight(lists[1]), "the Working row is in sight")
        try press(NSUpArrowFunctionKey, in: lists[1])
        XCTAssertEqual(selected, "dev-lumen-onboarding", "↑ comes back to the list's last row")
        XCTAssertTrue(inSight(lists[0]), "the list's last row is scrolled into sight")
    }

    /// The sidebar's two lists, the one that scrolls over the shelves pinned under them, ordered by their scroll views
    /// (which stay put when the lists scroll).
    private static func sidebarLists(in view: NSView) -> [NSTableView] {
        func top(_ list: NSView) -> CGFloat { let v = list.enclosingScrollView ?? list; return v.convert(v.bounds, to: nil).maxY }
        return views(in: view, named: "SwiftUIOutlineListView").compactMap { $0 as? NSTableView }.sorted { top($0) > top($1) }
    }

    /// The main list spans the column under its insets; the shelves' list sits in its bottom inset with only the
    /// footer under it, as tall as its rows (or, `capped`, shorter and scrolling), at most `shelfShare` of the sidebar,
    /// and leaving the list at least `listMinimum` of visible room.
    private static func shelvesPinned(capped: Bool = false) -> (NSView) throws -> Void { { frame in
        let tables = sidebarLists(in: frame)
        XCTAssertEqual(tables.count, 2, "expected the main list and the shelves' list")
        guard tables.count == 2, let list = tables[0].enclosingScrollView, let shelves = tables[1].enclosingScrollView else { return }
        let (g, s) = (list.convert(list.bounds, to: nil), shelves.convert(shelves.bounds, to: nil))
        XCTAssertEqual(s.maxY, g.minY + list.contentInsets.bottom, accuracy: 1, "the shelves sit right under the list's room")
        XCTAssertGreaterThan(s.minY, g.minY + 20, "the footer is under the shelves")
        if capped {
            XCTAssertLessThan(s.height, tables[1].frame.height - 1, "capped: the shelves scroll inside")
        } else {
            XCTAssertEqual(s.height, tables[1].frame.height, accuracy: 1, "the shelves take their rows' height")
        }
        XCTAssertLessThanOrEqual(s.height, g.height * MacSidebarLayout.shelfShare + 1)
        XCTAssertGreaterThanOrEqual(g.height - list.contentInsets.top - list.contentInsets.bottom, MacSidebarLayout.listMinimum - 1,
                                    "the list keeps its room")
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

    /// A tmux session's Chat tab (devd's mirror of its pane): Claude takes messages, a refused one shows its lock with
    /// Open terminal and ×; Codex is read-only, locked with its reason in the field.
    func testMirror() throws {
        for look in ["light", "dark"] {
            try shoot(name: "mirror-claude-\(look)", look: look, thread: nil, chat: MirrorFixtures.claudeId)
            try shoot(name: "mirror-claude-refused-\(look)", look: look, thread: nil, chat: MirrorFixtures.claudeId,
                      draft: "Make it listen first", refuse: true)
            try shoot(name: "mirror-codex-\(look)", look: look, thread: nil, chat: MirrorFixtures.codexId)
        }
        // In the window: the Codex session has no inbox row here, so the window opens it on Chat.
        try shoot(name: "mirror-codex-window-light", look: "light", thread: MirrorFixtures.codexId)
    }

    /// A tmux window opens on Terminal, and on Chat once Chat was the last view chosen for it (TmuxTabMemory).
    func testRememberedTab() throws {
        let id = MirrorFixtures.claudeId
        let key = TmuxTabMemory.key(id, createdAt: MirrorFixtures.createdAt)
        TmuxTabMemory.shared.remember(.terminal, for: key)
        try shoot(name: "remembered-terminal-light", look: "light", thread: id)
        TmuxTabMemory.shared.remember(.chat, for: key)
        try shoot(name: "remembered-chat-light", look: "light", thread: id)
        TmuxTabMemory.shared.remember(.terminal, for: key)
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

    /// New Session (MacNewSession.swift) on synthetic data: each page (a flat folder skips Project), devd's progress
    /// mid-checkout and mid-clone, a refusal from devd on the Agent page, and the folders failing to load.
    func testNewSessionSheet() throws {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let deadline = Date().addingTimeInterval(8)
        while state.live?.live == nil, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
        let live = try XCTUnwrap(state.live, "the fixture live list did not load")
        defer { state.inbox?.stop(); live.stop() }
        let tree = try JSONDecoder().decode([TreeProject].self, from: Data(#"""
            [{"folder":"acme","project":"shop","soloAgent":null,"repos":[
              {"name":"storefront","cloneUrl":"https://git.example/acme/storefront.git","provider":"github","cloned":true,"bare":true,"agent":null}]},
             {"folder":"acme","project":"tools","soloAgent":null,"repos":[]},
             {"folder":"orchard","project":"orchard","soloAgent":null,"repos":[
              {"name":"sync","cloneUrl":"https://git.example/orchard/sync.git","provider":"github","cloned":true,"bare":true,"agent":"codex"},
              {"name":"api","cloneUrl":"https://git.example/orchard/api.git","provider":"github","cloned":true,"bare":true,"agent":null},
              {"name":"web","cloneUrl":"https://git.example/orchard/web.git","provider":"github","cloned":false,"bare":null,"agent":null}]},
             {"folder":"lumen","project":"lumen","soloAgent":null,"repos":[]}]
            """#.utf8))
        let actions = SessionActions(client: try XCTUnwrap(state.appModel.client))
        func sheet(_ picks: MacNewSession.Picks, _ phase: MacNewSession.Phase = .form) -> some View {
            MacNewSessionSheet(actions: actions, onStarted: {}, onOpen: { _ in }, tree: tree, picks: picks, phase: phase)
                .environmentObject(live)
        }
        // devd's step times: the fetch took 1.2 s, the checkout has run 3.4 s; the clone 47.8 s so far.
        var checkout = MacNewSession.Tracker()
        checkout.apply(OpenProgress(step: "fetch"))
        checkout.apply(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 62),
                                    phases: [.init(step: "fetch", startedAt: 0, endedAt: 1_200), .init(step: "worktree", startedAt: 1_200)],
                                    now: 4_600))
        var clone = MacNewSession.Tracker()
        clone.apply(OpenProgress(step: "clone", clone: .init(phase: "Receiving objects", percent: 48, detail: "212.40 MiB | 18.02 MiB/s"),
                                 phases: [.init(step: "clone", startedAt: 0)], now: 47_800))
        // Finished with devd's answer: every step ended, and the total.
        var finished = checkout
        finished.finish(phases: [.init(step: "fetch", startedAt: 0, endedAt: 1_200), .init(step: "worktree", startedAt: 1_200, endedAt: 5_100),
                                 .init(step: "pull", startedAt: 5_100, endedAt: 5_900), .init(step: "container", startedAt: 5_900, endedAt: 14_300)])
        let agent = MacNewSession.Picks(folder: "orchard", project: "orchard", repo: "sync", agent: .codex, page: .agent)
        // The fixture devd refuses every request: the folders fail to load and show Retry.
        let failing = SessionActions(client: DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil,
                                                                                 tailnetBase: URL(string: "http://127.0.0.1:9")!)))
        for look in ["light", "dark"] {
            try shootView(sheet(.init()), name: "new-session-folder-\(look)", look: look)
            try shootView(sheet(.init(folder: "acme", project: "", page: .project)), name: "new-session-project-\(look)", look: look)
            try shootView(sheet(.init(folder: "orchard", project: "orchard", page: .repo)), name: "new-session-repo-\(look)", look: look)
            try shootView(sheet(agent), name: "new-session-agent-\(look)", look: look)
            try shootView(sheet(agent, .working(checkout)), name: "new-session-progress-\(look)", look: look)
            try shootView(sheet(agent, .working(finished)), name: "new-session-finished-\(look)", look: look)
            try shootView(sheet(.init(folder: "orchard", project: "orchard", repo: "web", page: .agent), .working(clone)),
                          name: "new-session-clone-\(look)", look: look)
            try shootView(sheet(.init(folder: "orchard", project: "orchard", repo: "web", page: .agent),
                                .failed("folder orchard is not configured on devd", retry: true)), name: "new-session-error-\(look)", look: look)
            try shootView(MacNewSessionSheet(actions: failing, onStarted: {}, onOpen: { _ in }).environmentObject(live),
                          name: "new-session-load-failed-\(look)", look: look, settle: 3)
        }
    }

    /// `settle`: seconds the view runs in an offscreen window first, so its `.task` work (a load) shows.
    private func shootView(_ view: some View, name: String, look: String, settle: TimeInterval = 0) throws {
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        host.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        var window: NSWindow?
        if settle > 0 {
            let w = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false
            w.contentView = host
            w.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
            w.orderFront(nil)
            RunLoop.main.run(until: Date().addingTimeInterval(settle))
            window = w
        }
        defer { window?.close() }
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: dir.appending(path: "mac-\(name).png"))
    }

    /// `chat`: the Chat tab of that session alone (the window opens a tmux session on its terminal); `refuse` presses
    /// Send on the draft, which the fixture refuses.
    private func shoot(name: String, look: String, thread: String?, chat: String? = nil, page: MacDashboardPage? = nil, draft: String? = nil,
                       refuse: Bool = false, width: CGFloat = 1440, height: CGFloat = 900, sidebarOnly: Bool = false,
                       focusList: Bool = false, inspect: ((NSView) throws -> Void)? = nil, prepare: ((MacAppState) async -> Void)? = nil) throws {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let shown = thread ?? chat
        let root: AnyView
        if let chat, let live = state.live, let client = state.appModel.client {
            root = AnyView(ChatScreen(store: state.windows.store(for: chat, client: client), client: client, openTerminal: {}, closeWindow: nil)
                .environmentObject(live).environmentObject(state).environmentObject(state.appModel))
        } else {
            XCTAssertNil(chat, "the fixture app has no live store or client")
            root = AnyView(MacWindowContent(thread: .constant(thread), page: .constant(page), newSession: .constant(false), findPending: .constant(false))
                .environmentObject(state)
                .environmentObject(state.appModel))
        }
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
            if state.inbox?.items != nil, shown == nil || state.windows.store(for: shown!, client: state.appModel.client!).thread != nil {
                break
            }
        }
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        XCTAssertNotNil(state.inbox?.items, "the fixture inbox did not load")
        if let prepare {
            var done = false
            Task { await prepare(state); done = true }
            while !done { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
            RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        }
        var fieldFrame: NSRect?
        if let draft {
            // Typed as a user would: the field's editor takes the text and SwiftUI's binding follows.
            let field = try XCTUnwrap(Self.allViews(window.contentView!).first {
                // The placeholder is styled (muted), so AppKit holds it as an attributed string.
                ($0 as? NSTextField).map { ($0.placeholderAttributedString?.string ?? $0.placeholderString).map { $0.hasPrefix("Ask anything") || $0.hasPrefix(MirrorView.placeholder) } == true } == true
                    || ($0 is NSTextView && $0.frame.width > 300)
            },
                                      "no composer field")
            window.makeFirstResponder(field)
            let editor = try XCTUnwrap(window.firstResponder as? NSTextView, "the composer has no editor")
            editor.insertText(draft, replacementRange: NSRange(location: NSNotFound, length: 0))
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            fieldFrame = field.convert(field.bounds, to: nil)
        }
        if refuse, let chat, let fieldFrame {
            // The composer's Send button, clicked: offscreen SwiftUI has no accessibility tree to find it by, so it is
            // found where the Mac's two-tier box puts it, at the right end of the controls row under the field
            // (ComposerView: 6 pt padding, 4 pt spacing, a 34 pt button).
            let store = state.windows.store(for: chat, client: state.appModel.client!)
            let send = NSPoint(x: fieldFrame.maxX - 17, y: fieldFrame.minY - 6 - 4 - 17)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: send, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                             windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
                window.sendEvent(event)
            }
            let until = Date().addingTimeInterval(5)
            while store.sendLock == nil, Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
            XCTAssertEqual(store.sendLock?.code, "terminal-has-draft", "the Send button's message is refused by the fixture")
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        }

        let frame = try XCTUnwrap(window.contentView?.superview, "the window has no frame view")
        if focusList {
            let list = try XCTUnwrap(Self.sidebarLists(in: frame).first, "no sidebar list")
            XCTAssertTrue(window.makeFirstResponder(list), "the list takes the keyboard")
            RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        }
        try inspect?(frame)
        // The sidebar list makes its rows when it is drawn on a screen; offscreen they are made here.
        for case let table as NSTableView in Self.views(in: frame, named: "SwiftUIOutlineListView") {
            for row in 0..<table.numberOfRows { _ = table.rowView(atRow: row, makeIfNecessary: true) }
            // The selected row's highlight is a material too: drawn as the plain selection colour of a list that does
            // not have the focus (the thread does, after a click on a row), or with `focusList` the accent colour.
            for row in Self.views(in: table, named: "ListTableRowView") {
                for effect in row.subviews where effect is NSVisualEffectView {
                    effect.layer?.sublayers?.forEach { $0.isHidden = true }
                    window.effectiveAppearance.performAsCurrentDrawingAppearance {
                        effect.layer?.backgroundColor = (focusList ? NSColor.selectedContentBackgroundColor
                                                         : NSColor.unemphasizedSelectedContentBackgroundColor).cgColor
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
        var out = rep
        if sidebarOnly {
            // The sidebar column alone: the split view's first pane, title bar included (its toggle sits over it).
            let split = try XCTUnwrap(Self.allViews(frame).first { $0 is NSSplitView } as? NSSplitView, "no split view")
            let pane = split.arrangedSubviews.first ?? split.subviews[0]
            let r = pane.convert(pane.bounds, to: frame)
            let crop = CGRect(x: 0, y: 0, width: r.maxX * scale, height: frame.bounds.height * scale).integral
            let image = try XCTUnwrap(rep.cgImage?.cropping(to: crop))
            out = NSBitmapImageRep(cgImage: image)
        }
        let png = try XCTUnwrap(out.representation(using: .png, properties: [:]))
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
