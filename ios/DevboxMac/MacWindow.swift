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
        MacWindowContent(thread: $thread, newSession: $newSession, findRequest: findRequest)
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
                               : MacWindowActions(newSession: { newSession = true }, find: { findRequest += 1 }))
            .onDisappear { state.windows.close(window: windowId) }
    }
}

/// The window's sidebar and detail, apart from the window's own bookkeeping (MacWindow), so the offscreen screenshot
/// test can host it without opening or restoring windows.
struct MacWindowContent: View {
    @Binding var thread: String?
    @Binding var newSession: Bool
    let findRequest: Int
    @EnvironmentObject private var state: MacAppState
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        if let client = appModel.client, let inbox = state.inbox, let live = state.live {
            NavigationSplitView {
                MacInboxSidebar(store: inbox, selection: $thread, findRequest: findRequest, newSession: { newSession = true })
                    .navigationSplitViewColumnWidth(min: 260, ideal: 300)
            } detail: {
                if let id = thread {
                    MacThreadDetail(threadId: id, client: client, inbox: inbox)
                        .id("\(id)|\(appModel.clientIdentity)")
                } else {
                    ContentUnavailableView("No thread selected", systemImage: "bubble.left.and.bubble.right",
                                           description: Text("Pick a session in the inbox."))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.C.background)
                        .toolbarBackground(Theme.C.background, for: .windowToolbar)
                        .toolbarBackground(.visible, for: .windowToolbar)
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

/// The inbox as the sidebar, by the same rules as the web and iPhone (InboxView), but with what runs right under what
/// needs you: needs you, working, finished (five, then "N more"), idle, then the snoozed and settled shelves
/// (collapsed). Every group is a disclosure group with
/// its count aligned at the right. Rows are MacInboxRow, with the latest message only in Needs you, Working and
/// Snoozed, and their times tick every 15 s. Above them: the search field (⌘F) and New session (⌘N). ↑/↓ move
/// the selection (List); the context menu has the row actions and "Open in New Window".
struct MacInboxSidebar: View {
    @ObservedObject var store: InboxStore
    @Binding var selection: String?
    /// Changes when ⌘F was pressed in this window.
    let findRequest: Int
    let newSession: () -> Void
    @Environment(\.openWindow) private var openWindow
    @State private var expanded: Set<String> = ["Needs you", "Working", "Finished", "Idle"]
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
            .safeAreaInset(edge: .bottom, spacing: 0) { footer }
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

    /// The inbox's connection and Settings (⌘,), anchored under the groups.
    private var footer: some View {
        let link = MacInboxSidebar.connection(paused: store.paused, loadError: store.loadError, loaded: store.items != nil)
        return HStack(spacing: 8) {
            Circle().fill(link.color).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(link.text).font(.system(size: 11.5)).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
            Spacer(minLength: 0)
            SettingsLink {
                Image(systemName: "gearshape").font(.system(size: 13)).frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("Settings (⌘,)")
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(MacTone.sidebar)
        .overlay(alignment: .top) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3) }
    }

    /// What the footer says about the inbox's link to devd.
    static func connection(paused: Bool, loadError: String?, loaded: Bool) -> (text: String, color: Color) {
        if paused { return ("Reconnecting — refreshing every 5 s", InboxTone.action) }
        if !loaded, loadError != nil { return ("Can't reach devd", InboxTone.danger) }
        if !loaded { return ("Connecting…", Theme.C.mutedForeground) }
        return ("Connected", InboxTone.doneIcon)
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
        group("Working", g.working, now: now, preview: true)
        group("Finished", split.finished, now: now, preview: false, cap: 5)
        group("Idle", g.idle, now: now, preview: false)
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
            MacInboxRow(item: item, now: now, preview: preview)
                .tag(item.sessionId as String?)
                .contextMenu {
                    Button("Open in New Window") { openWindow(value: item.sessionId) }
                    Button("Settle or Snooze…") { actionsFor = item }
                }
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

/// A sidebar row: the title with its state on the right (one coloured word when the row needs you, otherwise how long
/// ago, after a live dot while it works) and one muted line (`secondLine`) ending in the agent's glyph. Every title is
/// regular: a row that needs you stands out by its coloured word. The agent's name, "tmux" and the message are also
/// in the tooltip and the spoken label.
struct MacInboxRow: View {
    let item: InboxItem
    let now: Int
    let preview: Bool

    /// The word for a row that needs you, by its reason; nil for every other row (it shows its age).
    static func word(_ i: InboxItem) -> (text: String, tone: InboxView.Tone)? {
        guard i.attention.section == .needsYou else { return nil }
        switch i.attention.reason {
        case .request?: return ("Answer", .action)
        case .failed?: return ("Failed", .danger)
        case .rateLimited?: return ("Limit", .danger)
        case .disconnected?: return ("Offline", .danger)
        case .bridgeBehind?: return ("Behind", .danger)
        case .ciFailed?: return ("CI failed", .danger)
        default: return nil
        }
    }

    /// The agent's glyph, the dashboard's shapes (Switchers.tsx AgentGlyph) as SF Symbols: Claude's asterisk,
    /// Codex's hexagon, Grok's bolt, Antigravity's orbit, Vibe's wind. Drawn monochrome: metadata, not status.
    static func agentGlyph(_ agent: String) -> String {
        switch AgentName(rawValue: agent) ?? .unknown {
        case .claude, .claudeGemini, .claudeOpenrouter: return "asterisk"
        case .codex: return "hexagon"
        case .grok: return "bolt"
        case .antigravity: return "atom"
        case .vibe, .unknown: return "wind"
        }
    }

    /// The second line. A row that needs you says what it asks (the message, or the reason without one): that is
    /// the point of the row. Any other row says where it runs: the repo and the branch devd recorded, else the
    /// latest message in the groups about it.
    static func secondLine(_ i: InboxItem, detail: String) -> String {
        if word(i) != nil, !detail.isEmpty { return "\(i.repo)  ·  \(detail)" }
        let place = "\(i.project)/\(i.repo)"
        if let branch = i.branch, !branch.isEmpty { return "\(place)  ·  \(branch)" }
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

    #if DEBUG
    nonisolated(unsafe) static var flatStyles = false
    #endif

    /// Age, or for a snoozed row when it comes back.
    static func when(_ i: InboxItem, now: Int) -> String {
        if let until = i.attention.until { return InboxRow.untilLabel(until) }
        return i.attention.since > 0 ? InboxView.shortAgo(now - i.attention.since) : ""
    }

    var body: some View {
        let title = InboxView.rowTitle(item)
        let message = item.lastText.flatMap { title.fromMessage ? nil : InboxView.plainPreview($0) } ?? ""
        let detail = preview ? (message.isEmpty ? InboxView.reasonLabel(item.attention.reason) : message) : ""
        let spoken = InboxRow.spokenLabel(item, now: now, title: title.text, detail: detail)
            + (item.branch.map { $0.isEmpty ? "" : ", branch \($0)" } ?? "")
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // Hierarchical styles: on the focused list's accent selection they turn light, as the system's rows do.
                Text(title.text)
                    .font(.system(size: 13))
                    .foregroundStyle(Self.style(.primary))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let word = Self.word(item) {
                    Text(word.text).font(.system(size: 11, weight: .semibold)).foregroundStyle(InboxTone.text(word.tone))
                } else {
                    HStack(spacing: 5) {
                        if item.attention.section == .working { LiveDot() }
                        Text(Self.when(item, now: now)).font(.system(size: 11)).monospacedDigit()
                            .foregroundStyle(item.attention.section == .working ? AnyShapeStyle(InboxTone.busy) : Self.style(.secondary))
                    }
                }
            }
            HStack(spacing: 6) {
                Text(Self.secondLine(item, detail: detail))
                    .font(.system(size: 11.5))
                    .foregroundStyle(Self.style(.secondary))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: Self.agentGlyph(item.agent)).font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Self.style(.tertiary))
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .help(spoken)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}

/// A working row's mark: a dot that breathes while the agent runs; still with Reduce Motion.
private struct LiveDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle().fill(InboxTone.busy).frame(width: 6, height: 6)
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

/// The thread as chat or terminal. A tmux session has no chat, so it starts on its terminal.
struct MacThreadDetail: View {
    private enum Tab { case chat, terminal }

    let threadId: String
    let client: DevdClient
    @ObservedObject var inbox: InboxStore
    @EnvironmentObject private var state: MacAppState
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var tab: Tab?
    @State private var revealChanges = 0

    private var item: InboxItem? { inbox.items?.first { $0.sessionId == threadId } }

    var body: some View {
        let shown = tab ?? (item?.runtime == .tmux ? .terminal : .chat)
        Group {
            switch shown {
            case .chat:
                let store = state.windows.store(for: threadId, client: client)
                ChatScreen(store: store, client: client, openTerminal: { tab = .terminal },
                           closeWindow: { dismissWindow(id: MacWindow.sceneId, value: threadId) },
                           revealChanges: revealChanges)
                    .id(ObjectIdentifier(store))
                    .onReceive(store.$ended) { if $0 { state.windows.ended(threadId) } }
            case .terminal:
                TerminalScreen(sessionId: threadId, title: item?.title ?? threadId, client: client, closable: false)
            }
        }
        // The window names its thread, as the inbox row does, and where it runs.
        .navigationTitle(item.map { InboxView.rowTitle($0).text } ?? threadId)
        .navigationSubtitle(item.map(Self.place) ?? "")
        .modifier(MacThreadHeading(title: item.map { InboxView.rowTitle($0).text } ?? threadId, place: item.map(Self.place)))
        // Opaque, as the thread fades out under it (ChatScreen).
        .toolbarBackground(Theme.C.background, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .toolbar {
            // With the title and breadcrumb on the left, the changes and the view switch sit on the right; without
            // the system title (MacThreadHeading) nothing else pushes them there.
            if #available(macOS 26, *) { ToolbarSpacer(.flexible, placement: .primaryAction) }
            ToolbarItem(placement: .primaryAction) {
                MacChangesChip(store: state.windows.store(for: threadId, client: client), client: client) {
                    tab = .chat
                    revealChanges += 1
                }
            }
            ToolbarItem(placement: .primaryAction) {
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
        if #available(macOS 15, *) {
            content
                .toolbar(removing: .title)
                .toolbar {
                    ToolbarItem(placement: .navigation) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.C.foreground)
                            if let place {
                                Text(place).font(.system(size: 12)).foregroundStyle(Theme.C.mutedForeground)
                            }
                        }
                        .lineLimit(1)
                        .padding(.leading, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
        } else {
            content
        }
    }
}

/// The header's changes: the worktree's +/− against its base, when it has any; a click shows the changes card. Loads
/// with the thread and again when a run ends, as the card does.
private struct MacChangesChip: View {
    @ObservedObject var thread: ThreadStore
    @StateObject private var changes: ChangesStore
    let show: () -> Void
    @State private var hover = false

    init(store: ThreadStore, client: DevdClient, show: @escaping () -> Void) {
        thread = store
        _changes = StateObject(wrappedValue: ChangesStore(sessionId: store.sessionId, client: client))
        self.show = show
    }

    var body: some View {
        Group {
            if thread.changesAnchor != nil, case .loaded(let c) = changes.state {
                Button(action: show) {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.badge.plus").foregroundStyle(Theme.C.mutedForeground)
                        Text("+\(c.totals.added)").foregroundStyle(InboxTone.doneIcon)
                        Text("−\(c.totals.removed)").foregroundStyle(c.totals.removed > 0 ? InboxTone.danger : Theme.C.mutedForeground)
                    }
                    .font(.system(size: 12, weight: .medium)).monospacedDigit()
                    .padding(.horizontal, 8).frame(height: 26)
                    // A button, not a label: an outline, filled on hover.
                    .background(Theme.C.foreground.opacity(hover ? 0.08 : 0.03), in: RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.C.border))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hover = $0 }
                .help("\(ChangesView.title(c)) — show the changes")
                .accessibilityLabel("\(ChangesView.title(c)), \(c.totals.added) lines added, \(c.totals.removed) removed")
            } else {
                // Not empty: an empty view never appears, so its task (the fetch) would never run.
                Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
        // A run that starts takes the anchor away: the chip goes, without a fetch, until the run ends.
        .task(id: thread.changesAnchor) {
            guard thread.changesAnchor != nil else { return changes.reset() }
            await changes.load()
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
