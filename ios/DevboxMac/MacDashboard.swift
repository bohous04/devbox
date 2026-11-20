import SwiftUI

/// The window's dashboard mode (⌘D, or the Dashboard button under the inbox): the sidebar becomes the web dashboard's
/// navigation (`dashboard/src/nav.ts` NAV_GROUPS) and the detail shows the native screen for the picked page.
/// Settings is the app's Settings window (⌘,), and Notifications is left out like in the mockup.
enum MacDashboardPage: String, CaseIterable, Hashable {
    case overview, sessions, folders, stats, subscriptions, unpushed
    case schedules, upkeep, prodWrites, operations, sshKeys
    case hardware, activity

    /// The page the mode opens on.
    static let initial: MacDashboardPage = .overview

    struct Section {
        let title: String
        let pages: [MacDashboardPage]
    }

    /// The web's groups and order, minus the Inbox (the sessions mode), Notifications and Settings.
    static let sections: [Section] = [
        Section(title: "Workspace", pages: [.overview, .sessions, .folders, .stats, .subscriptions, .unpushed]),
        Section(title: "Operations", pages: [.schedules, .upkeep, .prodWrites, .operations, .sshKeys]),
        Section(title: "System", pages: [.hardware, .activity]),
    ]

    /// The web's sidebar labels (nav.ts).
    var title: String {
        switch self {
        case .overview: return "Overview"
        case .sessions: return "Sessions"
        case .folders: return "Folders"
        case .stats: return "Statistics"
        case .subscriptions: return "AI limits"
        case .unpushed: return "Unpushed"
        case .schedules: return "Schedules"
        case .upkeep: return "Agent upkeep"
        case .prodWrites: return "Production writes"
        case .operations: return "Operations"
        case .sshKeys: return "SSH keys"
        case .hardware: return "Hardware"
        case .activity: return "Activity"
        }
    }

    /// The iPhone app's symbols for the same pages (AppTab, MoreMenu).
    var systemImage: String {
        switch self {
        case .overview: return "gauge"
        case .sessions: return "terminal"
        case .folders: return "folder"
        case .stats: return "chart.bar"
        case .subscriptions: return "gauge.with.dots.needle.33percent"
        case .unpushed: return "arrow.up.circle"
        case .schedules: return "calendar.badge.clock"
        case .upkeep: return "arrow.triangle.2.circlepath"
        case .prodWrites: return "checklist"
        case .operations: return "paperplane"
        case .sshKeys: return "key"
        case .hardware: return "cpu"
        case .activity: return "list.bullet"
        }
    }
}

/// The dashboard's sidebar: back to the sessions (with how many need you), then the pages by group, and the
/// connection with Settings at the bottom.
struct MacDashboardSidebar: View {
    @ObservedObject var store: InboxStore
    @Binding var page: MacDashboardPage?
    let back: () -> Void

    var body: some View {
        // A click that would clear the selection (⌘-click on the picked page) keeps the page: nil means sessions mode.
        List(selection: Binding(get: { page }, set: { if let p = $0 { page = p } })) {
            ForEach(MacDashboardPage.sections, id: \.title) { section in
                Section {
                    ForEach(section.pages, id: \.self) { p in
                        Label { Text(p.title).font(.system(size: 13)).foregroundStyle(MacInboxRow.style(.primary)) } icon: {
                            Image(systemName: p.systemImage).foregroundStyle(Theme.C.mutedForeground)
                        }
                        .tag(p as MacDashboardPage?)
                    }
                } header: {
                    Text(section.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(MacTone.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { backRow }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            MacSidebarFooter(store: store, showsConnection: true) { EmptyView() }
        }
        .navigationTitle("Dashboard")
    }

    private var backRow: some View {
        let count = store.items.map(InboxView.needsYouCount) ?? 0
        return Button(action: back) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left").font(.system(size: 11, weight: .semibold))
                Text("Sessions").font(.system(size: 13, weight: .medium))
                Spacer(minLength: 8)
                if count > 0 {
                    Text("\(count) need\(count == 1 ? "s" : "") you").font(.system(size: 11)).foregroundStyle(InboxTone.text(.action))
                }
            }
            .foregroundStyle(Theme.C.foreground)
            .padding(.horizontal, 10).frame(height: 30)
            .background(Theme.C.foreground.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Back to the sessions (⌘D)")
        .accessibilityLabel(count > 0 ? "Back to the sessions, \(count) need you" : "Back to the sessions")
        .padding(.horizontal, 12).padding(.bottom, 8)
        .background(MacTone.sidebar)
    }
}

/// The picked page's native screen, the same views the iPhone app shows, each on its own stack (Sessions pushes a
/// session's detail).
struct MacDashboardDetail: View {
    let page: MacDashboardPage
    let client: DevdClient
    /// A chat session started from Sessions opens in this window.
    let openChat: (String) -> Void

    var body: some View {
        NavigationStack {
            screen
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.C.background)
        }
        .toolbarBackground(Theme.C.background, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .id(page)
    }

    @ViewBuilder
    private var screen: some View {
        switch page {
        case .overview: OverviewScreen(client: client)
        case .sessions: SessionsScreen(actions: SessionActions(client: client), onOpenChat: openChat)
        case .folders: FoldersScreen(client: client)
        case .stats: StatsScreen(client: client)
        case .subscriptions: SubscriptionsScreen(client: client)
        case .unpushed: UnpushedScreen(client: client)
        case .schedules: CronScreen(client: client)
        case .upkeep: AgentUpkeepScreen(client: client)
        case .prodWrites: ProdWritesScreen(client: client)
        case .operations: OperationsScreen(client: client)
        case .sshKeys: SshApprovalsScreen(client: client)
        case .hardware: HardwareScreen(client: client)
        case .activity: LogScreen(client: client)
        }
    }
}

/// The sidebar's bottom bar: in sessions mode the Dashboard button, in dashboard mode the connection; Settings (⌘,)
/// in both. A connection problem shows in either mode, above the bar.
struct MacSidebarFooter<Leading: View>: View {
    @ObservedObject var store: InboxStore
    let showsConnection: Bool
    @ViewBuilder let leading: () -> Leading

    var body: some View {
        let link = MacInboxSidebar.connection(paused: store.paused, loadError: store.loadError, loaded: store.items != nil)
        let healthy = store.items != nil && !store.paused
        let status = HStack(spacing: 8) {
            Circle().fill(link.color).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(link.text).font(.system(size: 11.5)).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
            Spacer(minLength: 0)
        }
        VStack(spacing: 6) {
            if !showsConnection && !healthy { status.padding(.horizontal, 2) }
            HStack(spacing: 6) {
                if showsConnection { status.padding(.leading, 2) } else { leading() }
                SettingsLink {
                    Image(systemName: "gearshape").font(.system(size: 13)).frame(width: 30, height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .help("Settings (⌘,)")
                .accessibilityLabel("Settings")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(MacTone.sidebar)
        .overlay(alignment: .top) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3) }
    }
}

/// The Dashboard button of the sessions sidebar.
struct MacDashboardButton: View {
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "square.grid.2x2").font(.system(size: 13))
                Text("Dashboard").font(.system(size: 13, weight: .medium))
                Spacer(minLength: 8)
                Text("⌘D").font(.system(size: 11)).foregroundStyle(Theme.C.mutedForeground)
            }
            .foregroundStyle(Theme.C.foreground)
            .padding(.horizontal, 10).frame(height: 30)
            .background(Theme.C.foreground.opacity(hover ? 0.1 : 0.06), in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("Dashboard (⌘D)")
        .accessibilityLabel("Dashboard")
    }
}
