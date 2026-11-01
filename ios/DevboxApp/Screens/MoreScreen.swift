import SwiftUI

/// Fifth tab — everything that did not fit into the bottom bar, grouped like the web sidebar
/// (`dashboard/src/nav.ts` `NAV_GROUPS`: Workspace / Operations / System; content and order are held by
/// `MoreMenu`). Settings goes with `prefill: true` so the fields are prefilled from the Keychain (unlike
/// onboarding, see `SettingsScreen`).
///
/// Links are value-based (`NavigationLink(value:)`) and the destination is built by `navigationDestination` —
/// so `SessionsContainer` can set `morePath` directly from a notification deep link.
///
/// Stays a `List` (with the system background hidden) — rows with a chevron and native push are
/// more natural here than custom cards, and the web also has them in the sidebar as a plain list of links.
struct MoreScreen: View {
    let client: DevdClient

    var body: some View {
        List {
            ForEach(MoreMenu.sections, id: \.title) { section in
                Section {
                    ForEach(section.items, id: \.destination) { item in
                        NavigationLink(value: item.destination) {
                            Label {
                                Text(item.title).font(Theme.F.body)
                            } icon: {
                                Image(systemName: item.systemImage)
                                    .foregroundStyle(Theme.C.mutedForeground)
                            }
                        }
                        .listRowBackground(Theme.C.card)
                    }
                } header: {
                    SectionHeader(section.title)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.C.background)
        .navigationTitle("More")
        .navigationDestination(for: MoreMenu.Destination.self) { destination($0) }
    }

    @ViewBuilder
    private func destination(_ destination: MoreMenu.Destination) -> some View {
        switch destination {
        case .folders: FoldersScreen(client: client)
        case .subscriptions: SubscriptionsScreen(client: client)
        case .schedules: CronScreen(client: client)
        case .prodWrites: ProdWritesScreen(client: client)
        case .sshKeys: SshApprovalsScreen(client: client)
        case .activity: LogScreen(client: client)
        case .notifications: NotificationsScreen(client: client)
        case .settings: SettingsScreen(prefill: true)
        }
    }
}
