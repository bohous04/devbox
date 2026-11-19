import Foundation

/// App tabs: the web bottom bar's items (`dashboard/src/nav.ts`, `primary: true` + "More") with the Inbox first,
/// as the step 5 plan asks (the web keeps Overview first). Five tabs is the cap — above five the iPhone hides the rest
/// in the system "More → More" overflow, which is why Hardware (it left the web bar for the Inbox too), AI limits,
/// Folders, Activity and others live in `MoreScreen` (`MoreMenu`).
enum AppTab: Hashable, CaseIterable {
    case inbox
    case overview
    case sessions
    case stats
    case more

    /// The app starts on the first tab.
    static let initial: AppTab = .inbox

    var title: String {
        switch self {
        case .inbox: return "Inbox"
        case .overview: return "Overview"
        case .sessions: return "Sessions"
        case .stats: return "Statistics"
        case .more: return "More"
        }
    }

    var systemImage: String {
        switch self {
        case .inbox: return "tray"
        case .overview: return "gauge"
        case .sessions: return "terminal"
        case .stats: return "chart.bar"
        case .more: return "ellipsis.circle"
        }
    }

    /// Where a deep link from a push notification / Live Activity leads: session → Sessions tab and straight to
    /// the detail (`NavigationStack` path in the Sessions tab; the terminal is then opened by `SessionDetailView`
    /// itself from `AppModel.pendingDeepLink`), a target in More → More tab with the screen on the stack, vault →
    /// unlock sheet over the current tab.
    static func route(for link: PushManager.PushDeepLink) -> AppRoute {
        switch link {
        case .thread(let id): return .inbox(path: [id])
        case .session(let id, _): return .sessions(path: [id])
        case .more(let destination): return .more(path: [destination])
        case .vault: return .vault
        }
    }
}

/// Result of `AppTab.route(for:)` — what `SessionsContainer` should do with the tabs and stacks.
enum AppRoute: Equatable {
    /// A chat thread on the Inbox tab's stack.
    case inbox(path: [String])
    case sessions(path: [String])
    case more(path: [MoreMenu.Destination])
    case vault

    /// Tab to switch to; `nil` = stay where the user is (vault sheet).
    var tab: AppTab? {
        switch self {
        case .inbox: return .inbox
        case .sessions: return .sessions
        case .more: return .more
        case .vault: return nil
        }
    }
}

/// Contents of the "More" tab grouped like the web sidebar (`NAV_GROUPS`: Workspace / Operations /
/// System) — only items that are not a tab of their own. Names 1:1 with the web (`nav.ts` `label`), except
/// "AI limits & accounts" is the page title (`Subscriptions.tsx`), not the shortened sidebar label.
enum MoreMenu {
    enum Destination: String, Hashable {
        case hardware
        case folders
        case subscriptions
        case schedules
        case prodWrites
        case sshKeys
        case activity
        case notifications
        case settings

        /// Target from devd (`NotifyTarget.kind`) or from `devbox://more/<target>`. devd calls SSH keys
        /// "sshApprovals" (after the web path `/ssh-approvals`); the other names match 1:1.
        init?(target: String) {
            if target == "sshApprovals" { self = .sshKeys; return }
            self.init(rawValue: target)
        }
    }

    struct Item: Hashable {
        let title: String
        let systemImage: String
        let destination: Destination
    }

    struct Section: Hashable {
        let title: String
        let items: [Item]
    }

    static let sections: [Section] = [
        Section(title: "Workspace", items: [
            Item(title: "Folders", systemImage: "folder", destination: .folders),
            Item(title: "AI limits & accounts", systemImage: "gauge.with.dots.needle.33percent", destination: .subscriptions),
        ]),
        Section(title: "Operations", items: [
            Item(title: "Schedules", systemImage: "calendar.badge.clock", destination: .schedules),
            Item(title: "Production writes", systemImage: "checklist", destination: .prodWrites),
            Item(title: "SSH keys", systemImage: "key", destination: .sshKeys),
        ]),
        Section(title: "System", items: [
            Item(title: "Hardware", systemImage: "cpu", destination: .hardware),
            Item(title: "Activity", systemImage: "list.bullet", destination: .activity),
            Item(title: "Notifications", systemImage: "bell", destination: .notifications),
            Item(title: "Settings", systemImage: "gearshape", destination: .settings),
        ]),
    ]
}
