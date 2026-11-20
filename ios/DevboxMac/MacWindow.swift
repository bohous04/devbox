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
            .background(WindowConfigurator { $0.isRestorable = false })
            .onAppear {
                state.setOpenWindow(openWindow)
                state.windows.show(window: windowId, thread: thread)
                let plan = state.windows.restorePlan(current: thread)
                if let adopt = plan.adopt { thread = adopt }
                for id in plan.open { openWindow(value: id) }
            }
            .onChange(of: thread) { _, id in state.windows.show(window: windowId, thread: id) }
            .onDisappear { state.windows.close(window: windowId) }
    }

    @ViewBuilder
    private var content: some View {
        if let client = appModel.client, let inbox = state.inbox, let live = state.live {
            NavigationSplitView {
                MacInboxSidebar(store: inbox, selection: $thread)
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

/// The inbox sections as a sidebar list: needs you, working, idle, then the snoozed and settled shelves (collapsed,
/// as on the web and iPhone). The context menu has the row actions and "Open in New Window".
struct MacInboxSidebar: View {
    @ObservedObject var store: InboxStore
    @Binding var selection: String?
    @Environment(\.openWindow) private var openWindow
    @State private var openShelves: Set<String> = []
    @State private var actionsFor: InboxItem?

    var body: some View {
        List(selection: $selection) {
            if store.paused || store.badFrame != nil {
                Text(store.paused ? "Live updates paused — refreshing every 5 s\(store.loadError.map { " (last refresh failed: \($0))" } ?? "")"
                     : "Live update dropped: \(store.badFrame ?? "")")
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.warnText)
            }
            if let items = store.items {
                let g = InboxView.group(items)
                Section("Needs you · \(g.needsYou.count)") { rows(g.needsYou) }
                shelf("Working", g.working)
                Section("Idle · \(g.idle.count)") { rows(g.idle) }
                shelf("Snoozed", g.snoozed)
                shelf("Settled", g.settled)
            } else if let error = store.loadError {
                Text("Can't load the inbox: \(error)").font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
            } else {
                ProgressView()
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Inbox")
        .sheet(item: $actionsFor) { item in
            InboxRowActions(item: item, store: store).frame(minWidth: 360, minHeight: 320)
        }
    }

    private func shelf(_ label: String, _ items: [InboxItem]) -> some View {
        Section(isExpanded: Binding(
            get: { openShelves.contains(label) },
            set: { if $0 { openShelves.insert(label) } else { openShelves.remove(label) } }
        )) {
            rows(items)
        } header: {
            Text("\(label) · \(items.count)")
        }
    }

    private func rows(_ items: [InboxItem]) -> some View {
        ForEach(items) { item in
            InboxRow(item: item, now: InboxView.ms(Date()), preview: true)
                .tag(item.sessionId as String?)
                .contextMenu {
                    Button("Open in New Window") { openWindow(value: item.sessionId) }
                    Button("Settle or Snooze…") { actionsFor = item }
                }
        }
    }
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
