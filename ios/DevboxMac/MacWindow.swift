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
    /// Bumped by ⌘F: the sidebar focuses its search field.
    @State private var findRequest = 0

    var body: some View {
        content
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
            // ⌘N and ⌘F (DevboxMacApp's commands) act on the key window.
            .focusedSceneValue(\.macWindowActions, MacWindowActions(newSession: { newSession = true }, find: { findRequest += 1 }))
            .onDisappear { state.windows.close(window: windowId) }
    }

    @ViewBuilder
    private var content: some View {
        if let client = appModel.client, let inbox = state.inbox, let live = state.live {
            NavigationSplitView {
                MacInboxSidebar(store: inbox, selection: $thread, findRequest: findRequest, newSession: { newSession = true })
                    .navigationSplitViewColumnWidth(min: 260, ideal: 320)
            } detail: {
                if let id = thread {
                    MacThreadDetail(threadId: id, client: client, inbox: inbox)
                        .id("\(id)|\(appModel.clientIdentity)")
                } else {
                    ContentUnavailableView("No thread selected", systemImage: "bubble.left.and.bubble.right",
                                           description: Text("Pick a session in the inbox."))
                }
            }
            .environmentObject(live)
            .sheet(isPresented: $newSession) {
                // The same New session flow as the iPhone's; a chat session opens in this window.
                NewSessionSheet(actions: SessionActions(client: client), onStarted: { await live.refreshNow() },
                                onOpenChat: { id in thread = id })
                    .environmentObject(live)
                    .frame(minWidth: 480, minHeight: 520)
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

/// The inbox as the sidebar, by the same rules as the web and iPhone (InboxView): needs you, finished (five, then
/// "N more"), idle, then the working, snoozed and settled shelves (collapsed). Every group is a disclosure group with
/// its count aligned at the right. Rows are the iPhone's InboxRow, with the preview line only in Needs you, Working
/// and Snoozed, and their times tick every 15 s. Above them: the search field (⌘F) and New session (⌘N). ↑/↓ move
/// the selection (List); the context menu has the row actions and "Open in New Window".
struct MacInboxSidebar: View {
    @ObservedObject var store: InboxStore
    @Binding var selection: String?
    /// Changes when ⌘F was pressed in this window.
    let findRequest: Int
    let newSession: () -> Void
    @Environment(\.openWindow) private var openWindow
    @State private var expanded: Set<String> = ["Needs you", "Finished", "Idle"]
    @State private var showAll: Set<String> = []
    @State private var actionsFor: InboxItem?
    @State private var query = ""
    @FocusState private var searching: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            List(selection: $selection) {
                if store.paused || store.badFrame != nil {
                    Text(store.paused ? "Live updates paused — refreshing every 5 s\(store.loadError.map { " (last refresh failed: \($0))" } ?? "")"
                         : "Live update dropped: \(store.badFrame ?? "")")
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.warnText)
                        .listRowSeparator(.hidden)
                }
                if let items = store.items {
                    let shown = items.filter { InboxView.matches($0, query) }
                    if shown.isEmpty, !query.isEmpty {
                        Text("No session matches “\(query)”").font(.callout).foregroundStyle(Theme.C.mutedForeground)
                    } else {
                        groups(InboxView.group(shown), now: InboxView.ms(context.date))
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
            // An opaque sidebar, one tone with the window, instead of the translucent material.
            .scrollContentBackground(.hidden)
            .background(MacTone.sidebar)
            .safeAreaInset(edge: .top, spacing: 0) { tools }
        }
        .navigationTitle("Inbox")
        .onChange(of: findRequest) { _, _ in searching = true }
        .sheet(item: $actionsFor) { item in
            InboxRowActions(item: item, store: store).frame(minWidth: 360, minHeight: 320)
        }
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
                Image(systemName: "square.and.pencil").font(.system(size: 14, weight: .medium)).frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .help("New session (⌘N)")
            .accessibilityLabel("New session")
        }
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
        .background(MacTone.sidebar)
    }

    @ViewBuilder
    private func groups(_ g: InboxView.Groups, now: Int) -> some View {
        let split = InboxView.splitNeedsYou(g.needsYou)
        if split.action.isEmpty, query.isEmpty {
            Label { Text("Nothing waiting for you") } icon: { Image(systemName: "checkmark.circle").foregroundStyle(InboxTone.doneIcon) }
                .font(.callout)
                .foregroundStyle(Theme.C.mutedForeground)
                .padding(.vertical, 4)
        }
        group("Needs you", split.action, now: now, preview: true)
        group("Finished", split.finished, now: now, preview: false, cap: 5)
        group("Idle", g.idle, now: now, preview: false)
        group("Working", g.working, now: now, preview: true)
        group("Snoozed", g.snoozed, now: now, preview: true)
        group("Settled", g.settled, now: now, preview: false)
    }

    /// A disclosure group, not shown while empty; open while searching, so every match shows. With `cap`, rows past it
    /// hide behind "N more".
    @ViewBuilder
    private func group(_ label: String, _ items: [InboxItem], now: Int, preview: Bool, cap: Int? = nil) -> some View {
        if !items.isEmpty {
            let open = expanded.contains(label) || !query.isEmpty
            let all = showAll.contains(label)
            Section {
                if open {
                    rows(cap.map { all ? items : Array(items.prefix($0)) } ?? items, now: now, preview: preview)
                    if let cap, items.count > cap {
                        Button(all ? "Show fewer" : "\(items.count - cap) more") { flip(label, in: &showAll) }
                            .buttonStyle(.plain)
                            .font(.callout)
                            .foregroundStyle(Theme.C.mutedForeground)
                            .accessibilityValue(all ? "expanded" : "collapsed")
                    }
                }
            } header: {
                MacGroupHead(label: label, count: items.count, open: open) { flip(label, in: &expanded) }
            }
        }
    }

    private func flip(_ label: String, in set: inout Set<String>) {
        if set.contains(label) { set.remove(label) } else { set.insert(label) }
    }

    private func rows(_ items: [InboxItem], now: Int, preview: Bool) -> some View {
        ForEach(items) { item in
            InboxRow(item: item, now: now, preview: preview)
                .padding(.leading, -12) // InboxRow's own leading inset; the list row has its own
                .tag(item.sessionId as String?)
                .contextMenu {
                    Button("Open in New Window") { openWindow(value: item.sessionId) }
                    Button("Settle or Snooze…") { actionsFor = item }
                }
        }
    }
}

/// A group heading as a disclosure button: chevron, name, and the count aligned at the sidebar's right edge.
private struct MacGroupHead: View {
    let label: String
    let count: Int
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Theme.C.mutedForeground)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 10)
                Text(label).foregroundStyle(Theme.C.foreground.opacity(0.85))
                Spacer(minLength: 8)
                Text("\(count)").monospacedDigit().foregroundStyle(Theme.C.mutedForeground)
            }
            .font(.system(size: 12, weight: .semibold))
            // A section header runs wider than the rows; the inset ends the count where the rows' text ends.
            .padding(.trailing, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label), \(count)")
        .accessibilityValue(open ? "expanded" : "collapsed")
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

/// The thread as chat or terminal. A tmux session has no chat, so it starts on its terminal.
struct MacThreadDetail: View {
    private enum Tab { case chat, terminal }

    let threadId: String
    let client: DevdClient
    @ObservedObject var inbox: InboxStore
    @EnvironmentObject private var state: MacAppState
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var tab: Tab?

    private var item: InboxItem? { inbox.items?.first { $0.sessionId == threadId } }

    var body: some View {
        let shown = tab ?? (item?.runtime == .tmux ? .terminal : .chat)
        Group {
            switch shown {
            case .chat:
                let store = state.windows.store(for: threadId, client: client)
                ChatScreen(store: store, client: client, openTerminal: { tab = .terminal },
                           closeWindow: { dismissWindow(id: MacWindow.sceneId, value: threadId) })
                    .id(ObjectIdentifier(store))
                    .onReceive(store.$ended) { if $0 { state.windows.ended(threadId) } }
            case .terminal:
                TerminalScreen(sessionId: threadId, title: item?.title ?? threadId, client: client, closable: false)
            }
        }
        // The window names its thread, as the inbox row does, and where it runs.
        .navigationTitle(item.map { InboxView.rowTitle($0).text } ?? threadId)
        .navigationSubtitle(item.map { "\($0.project) / \($0.repo)" } ?? "")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("View", selection: Binding(get: { shown }, set: { tab = $0 })) {
                    Text("Chat").tag(Tab.chat)
                    Text("Terminal").tag(Tab.terminal)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
        }
    }
}

/// What ⌘N and ⌘F do in the key window (DevboxMacApp's commands read it).
struct MacWindowActions {
    let newSession: () -> Void
    let find: () -> Void
}

private struct MacWindowActionsKey: FocusedValueKey { typealias Value = MacWindowActions }

extension FocusedValues {
    var macWindowActions: MacWindowActions? {
        get { self[MacWindowActionsKey.self] }
        set { self[MacWindowActionsKey.self] = newValue }
    }
}
