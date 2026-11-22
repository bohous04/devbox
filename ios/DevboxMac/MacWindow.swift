import SwiftUI

/// One Mac window: the inbox as the sidebar, the selected thread as the detail. The selected thread is the window's
/// scene value, so `openWindow(value:)` focuses the window that shows it. Every window reports its thread to
/// `ThreadWindows`, and the first window of a launch reopens the threads the last run had open.
struct MacWindow: View {
    static let sceneId = "thread"

    @Binding var thread: String?
    @EnvironmentObject private var state: MacAppState
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.openWindow) private var openWindow
    /// Identifies this window to `ThreadWindows` while it is open (the restore list holds threads, not windows).
    @State private var windowId = UUID().uuidString
    @State private var newSession = false
    /// Set by ⌘F; the sessions sidebar focuses its search field and clears it, also when ⌘F first had to leave the
    /// dashboard (the sidebar then appears with it already set).
    @State private var findPending = false
    /// The dashboard page this window shows; nil while it shows the sessions (the inbox and a thread).
    @State private var page: MacDashboardPage?

    var body: some View {
        MacWindowContent(thread: $thread, page: $page, newSession: $newSession, findPending: $findPending)
            .safeAreaInset(edge: .top) {
                if let problem = state.restoreNotice {
                    HStack {
                        Label(problem, systemImage: "exclamationmark.triangle").font(Theme.F.meta)
                        Spacer()
                        Button("Dismiss") { state.restoreNotice = nil }
                    }
                    .padding(8)
                    .background(Theme.C.warn.opacity(0.18))
                }
            }
            // The app restores its windows itself (ThreadWindows); macOS restoring them too would double them.
            .background(WindowConfigurator { window in
                window.isRestorable = false
                #if DEBUG
                if let size = FixtureMode.windowSize {
                    window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                    // A screenshot run shows the window as the user sees it in use: key, not dimmed as inactive.
                    NSApp.activate(ignoringOtherApps: true)
                    window.makeKeyAndOrderFront(nil)
                }
                #endif
            })
            .onAppear {
                state.setOpenWindow(openWindow)
                state.windows.show(window: windowId, thread: thread)
                let plan = state.windows.restorePlan(current: thread)
                if let adopt = plan.adopt { thread = adopt }
                for id in plan.open { openWindow(value: id) }
            }
            .onChange(of: thread) { _, id in state.windows.show(window: windowId, thread: id) }
            // ⌘N and ⌘F (DevboxMacApp's commands) act on the key window; without a configured devd they are disabled.
            .focusedSceneValue(\.macWindowActions, appModel.client == nil ? nil
                               : MacWindowActions(newSession: { newSession = true },
                                                  find: { page = nil; findPending = true },
                                                  toggleDashboard: { page = page == nil ? .initial : nil },
                                                  inDashboard: page != nil))
            // A thread brought forward (a notification, a link, Open in New Window) shows the thread, not the dashboard.
            .onReceive(state.focusedThread) { page = MacWindow.page(page, afterFocusOn: $0, showing: thread) }
            .onDisappear { state.windows.close(window: windowId) }
    }
}

/// The window's sidebar and detail, apart from the window's own bookkeeping (MacWindow), so the offscreen screenshot
/// test can host it without opening or restoring windows.
struct MacWindowContent: View {
    @Binding var thread: String?
    @Binding var page: MacDashboardPage?
    @Binding var newSession: Bool
    @Binding var findPending: Bool
    @EnvironmentObject private var state: MacAppState
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        if let client = appModel.client, let inbox = state.inbox, let live = state.live {
            NavigationSplitView {
                Group {
                    if page != nil {
                        MacDashboardSidebar(store: inbox, page: $page, back: { page = nil })
                    } else {
                        MacInboxSidebar(store: inbox, selection: $thread, findPending: $findPending, newSession: { newSession = true },
                                        openDashboard: { page = .initial })
                    }
                }
                .navigationSplitViewColumnWidth(min: 260, ideal: 300)
            } detail: {
                if let page {
                    MacDashboardDetail(page: page, client: client, openChat: { id in
                        thread = id
                        self.page = nil
                    })
                } else if let id = thread {
                    MacThreadDetail(threadId: id, client: client, inbox: inbox)
                        .id("\(id)|\(appModel.clientIdentity)")
                } else {
                    ContentUnavailableView {
                        Label("No thread open", systemImage: "bubble.left.and.bubble.right").symbolRenderingMode(.hierarchical)
                    } description: {
                        Text("Pick a thread on the left, or start one with ⌘N.")
                    } actions: {
                        Button("New Session") { newSession = true }
                    }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.C.background)
                        .toolbarBackground(Theme.C.background, for: .windowToolbar)
                        .toolbarBackground(.visible, for: .windowToolbar)
                }
            }
            .environmentObject(live)
            .sheet(isPresented: $newSession) {
                // The iPhone's cascade with the Mac's own layout and devd's progress; the new session opens in this window.
                MacNewSessionSheet(actions: SessionActions(client: client), onStarted: { await live.refreshNow() },
                                   onOpen: { id in
                                       thread = id
                                       page = nil
                                   })
                    .environmentObject(live)
            }
        } else {
            switch appModel.configState {
            case .notConfigured:
                NavigationStack { SettingsScreen() }
            case .unknown:
                ContentUnavailableView {
                    Label("Couldn't load the saved sign-in", systemImage: "key.slash")
                } actions: {
                    Button("Try again") { appModel.reloadConfiguration() }
                    SettingsLink { Text("Open Settings") }
                }
            case .configured:
                ProgressView()
            }
        }
    }
}

/// The inbox as the sidebar: one list of what is not on a shelf (MacSidebarLayout.list), each row with a mark only
/// when it has something to say, and the working, snoozed and settled shelves pinned to the bottom over the footer,
/// collapsed until opened (each window remembers which). Rows are MacInboxRow, with the latest message only for a row
/// that asks something and in Working and Snoozed, and their times tick every 15 s. A row settles in one gesture:
/// its ✓ on hover, or ⌘⇧S on the selection; the notice under the list then offers ⌘Z (MacSettler). Above them: the
/// search field (⌘F) and New session (⌘N). ↑/↓ move the selection (List); the context menu has the row actions and
/// "Open in New Window". A tmux session's finish clears when it is looked at (`markSeen`).
struct MacInboxSidebar: View {
    @ObservedObject var store: InboxStore
    @Binding var selection: String?
    /// ⌘F was pressed in this window: focus the search field, then clear it.
    @Binding var findPending: Bool
    let newSession: () -> Void
    let openDashboard: () -> Void
    @EnvironmentObject private var state: MacAppState
    /// The shelves' open state, kept per window; they start shut.
    @SceneStorage("macShelfWorkingOpen") private var workingOpen = MacSidebarLayout.startsOpen("Working")
    @SceneStorage("macShelfSnoozedOpen") private var snoozedOpen = MacSidebarLayout.startsOpen("Snoozed")
    @SceneStorage("macShelfSettledOpen") private var settledOpen = MacSidebarLayout.startsOpen("Settled")
    @State private var actionsFor: InboxItem?
    /// The terminal's F9 actions in the row menu (MacSessionActions.swift).
    @StateObject private var sessionActions = MacSessionActions()
    @State private var query = ""
    @FocusState private var searching: Bool
    @State private var sidebarHeight: CGFloat = 0
    /// The tools' and the footer's heights: the shelves leave the scrolling groups room under the one and over the other.
    @State private var toolsHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    /// The pinned shelves' list height with all its rows, once it has measured itself (macOS 15+).
    @State private var shelfContent: CGFloat?
    /// Which of the two lists has the keyboard, so ↑/↓ can carry it across their seam.
    @FocusState private var focusedList: MacSidebarLayout.Part?
    /// Key, active or inactive: a tmux session in a window that becomes key again is being looked at.
    @Environment(\.controlActiveState) private var activeState

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let now = InboxView.ms(context.date)
            let shown = store.items?.filter { InboxView.matches($0, query) }
            let g = shown.map(InboxView.group)
            let list = g.map(MacSidebarLayout.list) ?? []
            let pinned = g.map(MacSidebarLayout.pinnedShelves) ?? []
            let seam = (groups: list.map(\.sessionId), shelves: pinned.flatMap(visibleRows).map(\.sessionId))
            ScrollViewReader { proxy in List(selection: $selection) {
                if store.paused || store.badFrame != nil {
                    Text(store.paused ? "Live updates paused — refreshing every 5 s\(store.loadError.map { " (last refresh failed: \($0))" } ?? "")"
                         : "Live update dropped: \(store.badFrame ?? "")")
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.warnText)
                        .listRowSeparator(.hidden)
                }
                if let shown {
                    if shown.isEmpty, !query.isEmpty {
                        Text("No session matches “\(query)”").font(.callout).foregroundStyle(Theme.C.mutedForeground)
                    } else if list.isEmpty, query.isEmpty {
                        Label { Text("Nothing waiting for you") } icon: { Image(systemName: "checkmark.circle").foregroundStyle(InboxTone.doneIcon) }
                            .font(.callout)
                            .foregroundStyle(Theme.C.mutedForeground)
                            .padding(.vertical, 4)
                    } else {
                        rows(list, now: now, inList: true)
                    }
                } else if let error = store.loadError {
                    Label { Text("Can't load the inbox: \(error)") } icon: { Image(systemName: "exclamationmark.triangle") }
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.dangerText)
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading the inbox…").foregroundStyle(Theme.C.mutedForeground)
                    }
                    .font(.callout)
                    .padding(.vertical, 6)
                }
            }
            .listStyle(.sidebar)
            .focused($focusedList, equals: .groups)
            .onKeyPress(.downArrow) { cross(down: true, seam) }
            .onChange(of: focusedList) { _, part in reveal(in: part, .groups, proxy) }
            } // ScrollViewReader
            // An opaque sidebar, one tone with the window, instead of the translucent material.
            .scrollContentBackground(.hidden)
            .background(MacTone.sidebar)
            .safeAreaInset(edge: .top, spacing: 0) {
                tools.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { toolsHeight = $0 }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    shelves(pinned, now: now, seam: seam)
                    VStack(spacing: 0) {
                        MacSettleNotice(settler: state.settler) { Task { await state.settler.undo(in: store) } }
                        footer
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
                }
            }
            .environment(\.inboxShowsAgent, store.items.map(InboxView.mixedAgents) ?? false)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { sidebarHeight = $0 }
        .navigationTitle("Inbox")
        .onChange(of: findPending, initial: true) { _, pending in
            guard pending else { return }
            searching = true
            findPending = false
        }
        .sheet(item: $actionsFor) { item in
            InboxRowActions(item: item, store: store).frame(minWidth: 360, minHeight: 320)
        }
        .macSessionActions(sessionActions, inbox: store)
        .focusedSceneValue(\.macSettle, settleAction)
        .onChange(of: selection) { old, new in
            // Leaving a session marks it seen too: a finish that came in while it was open is no longer news.
            markSeen(old)
            if activeState == .key { markSeen(new) }
        }
        .onChange(of: selectedItem) { _, item in if activeState == .key, let item { markSeen(item.sessionId) } }
        .onChange(of: activeState) { _, active in if active == .key { markSeen(selection) } }
        .onAppear { markSeen(selection) }
    }

    private var selectedItem: InboxItem? { selection.flatMap { id in store.items?.first { $0.sessionId == id } } }

    /// ⌘⇧S for the selected row; nil when nothing selected can be settled.
    private var settleAction: MacSettleAction? {
        guard let item = selectedItem, MacSettler.canSettle(item) else { return nil }
        return MacSettleAction(block: MacSettler.block(item)) { settle(item) }
    }

    private func settle(_ item: InboxItem) {
        Task { await state.settler.settle(item, in: store) }
    }

    private func markSeen(_ id: String?) {
        guard let item = id.flatMap({ id in store.items?.first { $0.sessionId == id } }), MacSettler.wantsSeen(item) else { return }
        Task { await state.settler.seen(item, in: store) }
    }

    /// Search and New session, above the groups.
    private var tools: some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.C.mutedForeground).accessibilityHidden(true)
                TextField("Search", text: $query)
                    .textFieldStyle(.plain)
                    .focused($searching)
                    .onExitCommand { query = ""; searching = false }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(Theme.C.mutedForeground)
                        .accessibilityLabel("Clear search")
                }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 8).frame(height: 28)
            .background(Theme.C.foreground.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(searching ? Theme.C.link.opacity(0.6) : .clear))
            .help("Search sessions (⌘F)")
            Button(action: newSession) {
                // The field's twin: same height and fill, so the two read as one row of tools.
                Image(systemName: "square.and.pencil").font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.foreground.opacity(0.8))
                    .frame(width: 28, height: 28)
                    .background(Theme.C.foreground.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("New session (⌘N)")
            .accessibilityLabel("New session")
        }
        .padding(.horizontal, 12).padding(.bottom, 8)
        .background(MacTone.sidebar)
    }

    /// The Dashboard button and Settings (⌘,), anchored under the groups; the connection only when it has a problem.
    private var footer: some View {
        MacSidebarFooter(store: store, showsConnection: false) { MacDashboardButton(action: openDashboard) }
    }

    /// What the footer says about the inbox's link to devd.
    static func connection(paused: Bool, loadError: String?, loaded: Bool) -> (text: String, color: Color) {
        if paused { return ("Reconnecting — refreshing every 5 s", InboxTone.action) }
        if !loaded, loadError != nil { return ("Can't reach devd", InboxTone.danger) }
        if !loaded { return ("Connecting…", Theme.C.mutedForeground) }
        return ("Connected", InboxTone.doneIcon)
    }

    /// The shelves, pinned under the scrolling groups and over the footer, under a rule: what runs on its own, and
    /// what was put aside. A list of their own, sharing the selection, as tall as its rows up to `shelfShare` of the
    /// sidebar and scrolling inside beyond that. Nothing, rule included, while every shelf is empty.
    @ViewBuilder
    private func shelves(_ pinned: [MacSidebarLayout.Group], now: Int, seam: (groups: [String], shelves: [String])) -> some View {
        if !pinned.isEmpty {
            let estimate = MacSidebarLayout.estimatedContent(headers: pinned.count, rows: seam.shelves.count)
            ScrollViewReader { proxy in
                List(selection: $selection) {
                    ForEach(pinned, id: \.label) { group($0, now: now) }
                }
                .listStyle(.sidebar)
                .focused($focusedList, equals: .shelves)
                .onKeyPress(.upArrow) { cross(down: false, seam) }
                .onChange(of: focusedList) { _, part in reveal(in: part, .shelves, proxy) }
            }
            .scrollContentBackground(.hidden)
            .modifier(MacListContentHeight(height: $shelfContent))
            // Measured afresh when shelves come back, not sized by the rows they had before.
            .onDisappear { shelfContent = nil }
            .frame(height: MacSidebarLayout.shelfHeight(content: shelfContent ?? estimate, sidebar: sidebarHeight,
                                                        chrome: toolsHeight + footerHeight))
            .background(MacTone.sidebar)
            .overlay(alignment: .top) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3).accessibilityHidden(true) }
        }
    }

    /// Moves the selection and the keyboard to the other list when ↑/↓ reaches the seam; elsewhere the list moves it.
    private func cross(down: Bool, _ seam: (groups: [String], shelves: [String])) -> KeyPress.Result {
        guard let next = MacSidebarLayout.crossing(from: selection, down: down, groups: seam.groups, shelves: seam.shelves) else {
            return .ignored
        }
        selection = next
        focusedList = down ? .shelves : .groups
        return .handled
    }

    /// Scrolls the selected row into view in the list that just took the keyboard (after ↑/↓ crossed into it); a row
    /// of the other list is not in this one, and scrolling to it does nothing.
    private func reveal(in part: MacSidebarLayout.Part?, _ list: MacSidebarLayout.Part, _ proxy: ScrollViewProxy) {
        guard part == list, let selection else { return }
        proxy.scrollTo(selection)
    }

    /// The rows a shelf shows: none while shut (it is open while searching, so every match shows).
    private func visibleRows(_ group: MacSidebarLayout.Group) -> [InboxItem] {
        isOpen(group.label) || !query.isEmpty ? group.items : []
    }

    /// A shelf as a disclosure group (MacSidebarLayout leaves out the empty ones); open while searching.
    private func group(_ group: MacSidebarLayout.Group, now: Int) -> some View {
        Section {
            rows(visibleRows(group), now: now, preview: group.preview)
        } header: {
            MacGroupHead(label: group.label, count: group.items.count, open: isOpen(group.label) || !query.isEmpty) { toggle(group.label) }
        }
    }

    private func isOpen(_ shelf: String) -> Bool {
        switch shelf {
        case "Working": return workingOpen
        case "Snoozed": return snoozedOpen
        default: return settledOpen
        }
    }

    private func toggle(_ shelf: String) {
        switch shelf {
        case "Working": workingOpen.toggle()
        case "Snoozed": snoozedOpen.toggle()
        default: settledOpen.toggle()
        }
    }

    /// `inList`: a row of the one list, which settles from its ✓ and says what it asks; `preview` for a shelf's rows.
    private func rows(_ items: [InboxItem], now: Int, preview: Bool = false, inList: Bool = false) -> some View {
        ForEach(items) { item in
            MacInboxRow(item: item, now: now, preview: inList ? MacSidebarLayout.asks(item) : preview,
                        settle: inList ? { settle(item) } : nil)
                .tag(item.sessionId as String?)
                .contextMenu {
                    Button("Open in New Window") { state.openThread(item.sessionId) }
                    Divider()
                    if MacSettler.canSettle(item) {
                        let block = MacSettler.block(item)
                        Button(block.map { "Settle (\($0.prefix(1).lowercased() + $0.dropFirst()))" } ?? "Settle") { settle(item) }
                            .keyboardShortcut("s", modifiers: [.command, .shift])
                            .disabled(block != nil)
                        Button("Snooze…") { actionsFor = item }
                    } else {
                        Button("Back to the Inbox") {
                            Task {
                                do { try await store.unsettle(item.sessionId) } catch {
                                    state.settler.problem = "Couldn't bring back “\(InboxView.rowTitle(item))”: \(chatErrorText(error))"
                                }
                            }
                        }
                    }
                    Divider()
                    MacSessionMenuItems(item: item, actions: sessionActions)
                }
        }
    }
}

/// One list of what is not on a shelf scrolls; the shelves under it stay shut until opened and are pinned to the
/// bottom of the sidebar, over the footer.
enum MacSidebarLayout {
    struct Group {
        let label: String
        let items: [InboxItem]
        /// Whether the rows show the latest message.
        let preview: Bool
    }

    /// The sidebar's two lists.
    enum Part { case groups, shelves }

    /// The one list: what asks for action (a request or a failure) pinned on top, the longest wait first, as devd
    /// orders it; then the finished and the idle rows together, newest first. The owner chose this over T3 Code's
    /// pure recency, so a question never sinks under newer finishes.
    static func list(_ g: InboxView.Groups) -> [InboxItem] {
        let split = InboxView.splitNeedsYou(g.needsYou)
        return split.action + (split.finished + g.idle).sorted { $0.attention.since > $1.attention.since }
    }

    /// A row that asks something (a request or a failure) says what in its second line; the others say where they run.
    static func asks(_ i: InboxItem) -> Bool { i.attention.section == .needsYou && i.attention.reason != .completed }

    /// The share of the sidebar's height the pinned shelves may take before they scroll inside.
    static let shelfShare: CGFloat = 0.45
    /// The height the scrolling list keeps at least, so what needs you stays in reach in a short window.
    static let groupsMinimum: CGFloat = 120
    /// A sidebar list's group header, its two-line row and its own padding, as macOS draws them at the default
    /// sidebar size (measured on the screenshot test's render).
    static let headerHeight: CGFloat = 24, rowHeight: CGFloat = 50, listPadding: CGFloat = 36

    /// The shelves pinned to the bottom, in order, the empty ones left out.
    static func pinnedShelves(_ g: InboxView.Groups) -> [Group] {
        [Group(label: "Working", items: g.working, preview: true),
         Group(label: "Snoozed", items: g.snoozed, preview: true),
         Group(label: "Settled", items: g.settled, preview: false)].filter { !$0.items.isEmpty }
    }

    /// Where ↑/↓ goes across the seam between the lists' visible rows: from the last scrolling row down to the first
    /// shelf row, and back up. Nil elsewhere, where the list itself moves the selection.
    static func crossing(from id: String?, down: Bool, groups: [String], shelves: [String]) -> String? {
        guard let id else { return nil }
        if down, id == groups.last { return shelves.first }
        if !down, id == shelves.first { return groups.last }
        return nil
    }

    /// The shelves' list height from its headers and visible rows, for before it has measured itself (its first
    /// layout) and for macOS 14, which cannot measure a list. Off only at a non-default sidebar size.
    static func estimatedContent(headers: Int, rows: Int) -> CGFloat {
        CGFloat(headers) * headerHeight + CGFloat(rows) * rowHeight + listPadding
    }

    /// The pinned shelves' height: their content, up to `shelfShare` of the sidebar and never into the room the
    /// scrolling groups keep between the tools and the footer (`chrome`).
    static func shelfHeight(content: CGFloat, sidebar: CGFloat, chrome: CGFloat) -> CGFloat {
        let cap = min(sidebar * shelfShare, sidebar - chrome - groupsMinimum)
        return max(0, min(content, cap)).rounded()
    }

    /// Whether a shelf is open in a new window: never, except a shelf the screenshot test opens.
    static func startsOpen(_ shelf: String) -> Bool {
        #if DEBUG
        if debugOpenShelves.contains(shelf) { return true }
        #endif
        return false
    }

    #if DEBUG
    nonisolated(unsafe) static var debugOpenShelves: Set<String> = []
    #endif
}

/// Reports a list's full height (its rows and its insets) on macOS 15+, which can read a scroll view's geometry.
private struct MacListContentHeight: ViewModifier {
    @Binding var height: CGFloat?

    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom }
                action: { _, new in height = new }
        } else {
            content
        }
    }
}

/// A group heading as a disclosure button: small and muted, a step below the row titles, with room above it; the
/// count aligned where the rows end.
private struct MacGroupHead: View {
    let label: String
    let count: Int
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 10)
                Text(label)
                Spacer(minLength: 8)
                Text("\(count)").monospacedDigit()
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.C.mutedForeground)
            .padding(.top, 10)
            // A section header runs wider than the rows; the inset ends the count where the rows' text ends.
            .padding(.trailing, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label), \(count)")
        .accessibilityValue(open ? "expanded" : "collapsed")
    }
}

/// A sidebar row: the title with its state on the right (a coloured mark when the row has something to say, otherwise
/// how long ago, after a live dot while it works) and one muted line (`secondLine`) ending in the agent's glyph while
/// the rows shown mix agents. Every title is regular: a row that needs you stands out by its mark. With `settle`, a ✓
/// takes the state's place while the pointer is over the row, as in T3 Code; it is disabled, with the reason, while a
/// request is open. "tmux", the message and (with mixed agents) the agent's name are also in the tooltip and the
/// spoken label, which starts with the mark.
struct MacInboxRow: View {
    let item: InboxItem
    let now: Int
    let preview: Bool
    var settle: (() -> Void)?
    @Environment(\.inboxShowsAgent) private var showAgent
    @State private var hovering = false

    /// The mark of a row that needs you, by its reason (a run that finished unseen is Done); nil for every other row
    /// (it shows its age).
    static func word(_ i: InboxItem) -> (text: String, tone: InboxView.Tone)? {
        guard i.attention.section == .needsYou else { return nil }
        switch i.attention.reason {
        case .request?: return ("Answer", .action)
        case .completed?: return ("Done", .done)
        case .failed?: return ("Failed", .danger)
        case .rateLimited?: return ("Limit", .danger)
        case .disconnected?: return ("Offline", .danger)
        case .bridgeBehind?: return ("Behind", .danger)
        case .ciFailed?: return ("CI failed", .danger)
        default: return nil
        }
    }

    /// The second line. A row that needs you says what it asks (the message, or the reason without one): that is
    /// the point of the row. Any other row says where it runs: the repo and what distinguishes its branch
    /// (InboxView.branchLabel), else the latest message in the groups about it. The tooltip has the full branch.
    static func secondLine(_ i: InboxItem, detail: String) -> String {
        if word(i) != nil, !detail.isEmpty { return "\(i.repo)  ·  \(detail)" }
        let place = "\(i.project)/\(i.repo)"
        if let branch = InboxView.branchLabel(i) { return "\(place)  ·  \(branch)" }
        return detail.isEmpty ? place : "\(place)  ·  \(detail)"
    }

    /// The text's hierarchical style. The offscreen screenshot test draws without the window server's vibrancy, which
    /// these styles need there, so it sets `flatStyles` for the flat colours they show unselected. The app never does.
    enum Tier { case primary, secondary, tertiary }

    static func style(_ tier: Tier) -> AnyShapeStyle {
        #if DEBUG
        if flatStyles {
            switch tier {
            case .primary: return AnyShapeStyle(Theme.C.foreground)
            case .secondary: return AnyShapeStyle(Theme.C.mutedForeground)
            case .tertiary: return AnyShapeStyle(Theme.C.mutedForeground.opacity(0.75))
            }
        }
        #endif
        switch tier {
        case .primary: return AnyShapeStyle(.primary)
        case .secondary: return AnyShapeStyle(.secondary)
        case .tertiary: return AnyShapeStyle(.tertiary)
        }
    }

    /// A mark's colour: Done in green, as T3 Code's; the rest as the inbox's tones.
    static func color(_ tone: InboxView.Tone) -> Color { tone == .done ? InboxTone.doneIcon : InboxTone.text(tone) }

    #if DEBUG
    nonisolated(unsafe) static var flatStyles = false
    /// The row the screenshot test draws as hovered (offscreen there is no pointer).
    nonisolated(unsafe) static var debugHovered: String?
    #endif

    private var showsSettle: Bool {
        guard settle != nil else { return false }
        #if DEBUG
        if Self.debugHovered == item.sessionId { return true }
        #endif
        return hovering
    }

    /// Age, or for a snoozed row when it comes back.
    static func when(_ i: InboxItem, now: Int) -> String {
        if let until = i.attention.until { return InboxRow.untilLabel(until) }
        return i.attention.since > 0 ? InboxView.shortAgo(now - i.attention.since) : ""
    }

    var body: some View {
        let title = InboxView.rowTitle(item)
        let message = item.lastText.map(InboxView.plainPreview) ?? ""
        let detail = preview ? (message.isEmpty ? InboxView.reasonLabel(item.attention.reason) : message) : ""
        let mark = Self.word(item)
        let spoken = (mark.map { "\($0.text), " } ?? "") + InboxRow.spokenLabel(item, now: now, title: title, detail: detail, showAgent: showAgent)
            + (item.branch.map { $0.isEmpty ? "" : ", branch \($0)" } ?? "")
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // Hierarchical styles: on the focused list's accent selection they turn light, as the system's rows do.
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(Self.style(.primary))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if showsSettle, let settle {
                    settleButton(settle)
                } else if let word = mark {
                    HStack(spacing: 3) {
                        Image(systemName: InboxTone.icon(word.tone)).font(.system(size: 10, weight: .semibold))
                        Text(word.text).font(.system(size: 11, weight: .semibold))
                    }
                    .modifier(MacSelectionTone(color: Self.color(word.tone), onSelection: Self.style(.primary)))
                } else {
                    HStack(spacing: 5) {
                        if item.attention.section == .working { LiveDot() }
                        Text(Self.when(item, now: now)).font(.system(size: 11)).monospacedDigit()
                            .modifier(MacSelectionTone(color: item.attention.section == .working ? InboxTone.busy : nil, onSelection: Self.style(.secondary)))
                    }
                }
            }
            HStack(spacing: 6) {
                Text(Self.secondLine(item, detail: detail))
                    .font(.system(size: 11.5))
                    .foregroundStyle(Self.style(.secondary))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if showAgent {
                    AgentLogo(mark: AgentLogo.Mark(agent: item.agent), size: 11)
                        .foregroundStyle(Self.style(.tertiary))
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        // A quiet fill under the pointer, as T3 Code's rows; the selection draws its own over it.
        .background {
            if showsSettle {
                RoundedRectangle(cornerRadius: 6).fill(Theme.C.foreground.opacity(0.05))
                    .padding(.horizontal, -6).padding(.vertical, -1)
            }
        }
        .onHover { hovering = $0 }
        .help(spoken)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .modifier(MacSettleAccessibility(settle: settle, block: MacSettler.block(item)))
    }

    /// The hovered row's ✓, in the state's place; disabled with the reason while a request is open.
    private func settleButton(_ settle: @escaping () -> Void) -> some View {
        let block = MacSettler.block(item)
        return Button(action: settle) {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
                .frame(width: 24, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .modifier(MacSelectionTone(color: block == nil ? Theme.C.foreground.opacity(0.75) : Theme.C.mutedForeground.opacity(0.45),
                                   onSelection: Self.style(block == nil ? .primary : .tertiary)))
        .disabled(block != nil)
        // On the frame, not the button: a disabled button shows no tooltip of its own.
        .frame(height: 14)
        .contentShape(Rectangle())
        .help(block ?? "Settle (⌘⇧S)")
        .accessibilityLabel("Settle")
    }
}

/// The row's Settle as a VoiceOver action (the row is one element, so its ✓ is not reachable on its own).
private struct MacSettleAccessibility: ViewModifier {
    let settle: (() -> Void)?
    let block: String?

    func body(content: Content) -> some View {
        if let settle, block == nil {
            content.accessibilityAction(named: "Settle", settle)
        } else {
            content
        }
    }
}

/// A fixed colour, except on a focused sidebar list's accent selection, where the row's light text style takes over (a
/// fixed colour there, red or blue on blue, would not read). Read where it is drawn: the row's own body does not see
/// the selection's prominence change.
struct MacSelectionTone: ViewModifier {
    let color: Color?
    let onSelection: AnyShapeStyle
    @Environment(\.backgroundProminence) private var prominence

    func body(content: Content) -> some View {
        if let color, prominence != .increased {
            content.foregroundStyle(color)
        } else {
            content.foregroundStyle(onSelection)
        }
    }
}

/// A working row's mark: a dot that breathes while the agent runs; still with Reduce Motion.
private struct LiveDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle().frame(width: 6, height: 6).modifier(MacSelectionTone(color: InboxTone.busy, onSelection: AnyShapeStyle(.primary)))
            .opacity(dim ? 0.35 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

/// The Mac window's own tones.
enum MacTone {
    static let sidebar = Color(light: 0xF6F6F7, dark: 0x111113)
}

/// Turns off AppKit window restoration for the window hosting this view. One path for macOS 14 and 15+
/// (`restorationBehavior(.disabled)` is a macOS 15 scene modifier).
private struct WindowConfigurator: NSViewRepresentable {
    let configure: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView { Probe(configure: configure) }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class Probe: NSView {
        let configure: (NSWindow) -> Void
        init(configure: @escaping (NSWindow) -> Void) {
            self.configure = configure
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { configure(window) }
        }
    }
}

/// The thread as chat or terminal. A tmux session starts on the one last chosen for it (TmuxTabMemory), else its
/// terminal.
struct MacThreadDetail: View {
    private typealias Tab = TmuxTabMemory.Tab

    let threadId: String
    let client: DevdClient
    @ObservedObject var inbox: InboxStore
    @EnvironmentObject private var state: MacAppState
    /// The session's created_at, which keys its remembered tab (TmuxTabMemory).
    @EnvironmentObject private var live: LiveStore
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var tab: Tab?
    @State private var revealChanges = 0

    private var item: InboxItem? { inbox.items?.first { $0.sessionId == threadId } }

    var body: some View {
        let shown = tab ?? opening
        Group {
            switch shown {
            case .chat:
                let store = state.windows.store(for: threadId, client: client)
                ChatScreen(store: store, client: client, openTerminal: { choose(.terminal) },
                           closeWindow: { dismissWindow(id: MacWindow.sceneId, value: threadId) },
                           revealChanges: revealChanges)
                    .id(ObjectIdentifier(store))
                    .onReceive(store.$ended) { if $0 { state.windows.ended(threadId) } }
                    // A remembered Chat for an agent the mirror cannot read opens Terminal, the reason still on the
                    // Chat tab; the choice is kept for when it can. A session no longer on tmux stays on Chat: its
                    // "reopen it" is the one useful thing to show.
                    .onReceive(store.$mirror) { m in if tab == nil, m.flatMap(MirrorView.unsupported) != nil { tab = .terminal } }
            case .terminal:
                TerminalScreen(sessionId: threadId, title: item?.title ?? threadId, client: client, closable: false)
            }
        }
        // The window names its thread, as the inbox row does, and where it runs.
        .navigationTitle(item.map(InboxView.rowTitle) ?? threadId)
        .navigationSubtitle(item.map(Self.place) ?? "")
        .modifier(MacThreadHeading(title: item.map(InboxView.rowTitle) ?? threadId, place: item.map(Self.place)))
        // Opaque, as the thread fades out under it (ChatScreen).
        .toolbarBackground(Theme.C.background, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .toolbar {
            // With the title and breadcrumb on the left, the changes and the view switch sit on the right; without
            // the system title (MacThreadHeading) nothing else pushes them there.
            if #available(macOS 26, *) { ToolbarSpacer(.flexible, placement: .primaryAction) }
            ToolbarItem(placement: .primaryAction) {
                ChangesChip(store: state.windows.store(for: threadId, client: client), client: client) {
                    choose(.chat)
                    revealChanges += 1
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Picker("View", selection: Binding(get: { shown }, set: { choose($0) })) {
                    Text("Chat").tag(Tab.chat)
                    Text("Terminal").tag(Tab.terminal)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
        }
    }

    /// A tmux session's entry in the remembered tabs; nil for a chat session or before the inbox and live list load.
    private var memoryKey: String? {
        guard item?.runtime == .tmux, let s = live.live?.sessions.first(where: { $0.id == threadId }) else { return nil }
        return TmuxTabMemory.key(s.id, createdAt: s.created_at)
    }

    /// Before the user picks one in this window. A chat session has no Terminal default to remember against.
    private var opening: Tab {
        guard item?.runtime == .tmux else { return .chat }
        return memoryKey.flatMap(TmuxTabMemory.shared.tab(for:)) ?? .terminal
    }

    private func choose(_ next: Tab) {
        tab = Self.chosen(next, memoryKey: memoryKey)
    }

    /// The user's own switch, remembered for a tmux session (`memoryKey`). The automatic switch to Terminal above
    /// sets `tab` itself and never comes here: it must not change the stored choice.
    static func chosen(_ next: TmuxTabMemory.Tab, memoryKey: String?, memory: TmuxTabMemory = .shared) -> TmuxTabMemory.Tab {
        if let memoryKey { memory.remember(next, for: memoryKey) }
        return next
    }
}

extension MacThreadDetail {
    /// Where the thread runs: repo, and its branch when devd recorded one.
    static func place(_ i: InboxItem) -> String {
        "\(i.project) / \(i.repo)" + (i.branch.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? "")
    }
}

/// The header's title on macOS 15 and later: the window's own title is capped to a short width, so it is replaced
/// by one that runs up to the controls on the right, the place under it legible. macOS 14 keeps the system title.
private struct MacThreadHeading: ViewModifier {
    let title: String
    let place: String?

    func body(content: Content) -> some View {
        if #available(macOS 26, *) {
            // A plain title, as the system's own: macOS 26 puts a toolbar item in a Liquid Glass capsule sized for one
            // control, too short for two lines, which it clipped.
            content
                .toolbar(removing: .title)
                .toolbar { ToolbarItem(placement: .navigation) { heading }.sharedBackgroundVisibility(.hidden) }
        } else if #available(macOS 15, *) {
            content
                .toolbar(removing: .title)
                .toolbar { ToolbarItem(placement: .navigation) { heading } }
        } else {
            content
        }
    }

    /// One line each, never cut vertically; a narrow window shortens a line at its end (the place, the longer one).
    private var heading: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.C.foreground)
            if let place {
                Text(place).font(.system(size: 12)).foregroundStyle(Theme.C.mutedForeground).truncationMode(.tail)
            }
        }
        .lineLimit(1)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 4)
        .accessibilityElement(children: .combine)
    }
}

/// What ⌘N, ⌘F and ⌘D do in the key window (DevboxMacApp's commands read it).
struct MacWindowActions {
    let newSession: () -> Void
    let find: () -> Void
    let toggleDashboard: () -> Void
    /// The window shows the dashboard: the ⌘D item then reads "Sessions".
    let inDashboard: Bool
}

extension MacWindow {
    /// A window asked to show its thread leaves the dashboard; other windows keep their page.
    static func page(_ page: MacDashboardPage?, afterFocusOn focused: String, showing thread: String?) -> MacDashboardPage? {
        focused == thread ? nil : page
    }
}

private struct MacWindowActionsKey: FocusedValueKey { typealias Value = MacWindowActions }

extension FocusedValues {
    var macWindowActions: MacWindowActions? {
        get { self[MacWindowActionsKey.self] }
        set { self[MacWindowActionsKey.self] = newValue }
    }
}
