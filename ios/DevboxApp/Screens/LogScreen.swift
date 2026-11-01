import SwiftUI

/// Log screen — mirrors `dashboard/src/pages/Log.tsx` (see `LogStore` for pure helpers/fetch).
/// Narrowed to a type-group + session filter and "load more" instead of the web's numbered Pager and
/// date range (deliberate narrowing for mobile, see `LogStore`/task report). The rows reuse
/// `OverviewStore`'s 1:1 port of `eventLabel`/`eventDetail`/`sessionShort` (`dashboard/src/eventLabels.ts`)
/// — the app does NOT DUPLICATE them, that task belongs to stage F.
struct LogScreen: View {
    @StateObject private var store: LogStore
    @EnvironmentObject private var liveStore: LiveStore
    @State private var selectedGroups: [String] = []
    @State private var session = ""

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: LogStore(client: client))
    }

    var body: some View {
        List {
            Section("Filters") {
                filterChips
                Picker("Session", selection: $session) {
                    Text("all sessions").tag("")
                    ForEach(liveStore.live?.sessions ?? [], id: \.id) { s in
                        Text(sessionLabel(s)).tag(s.id)
                    }
                }
                if !selectedGroups.isEmpty || !session.isEmpty {
                    Button("Clear filters") {
                        selectedGroups = []
                        session = ""
                    }
                }
            }

            Section {
                if store.items.isEmpty && store.error == nil {
                    if store.loaded {
                        ContentUnavailableView("No events match", systemImage: "clock.arrow.circlepath")
                    } else {
                        ProgressView()
                    }
                } else {
                    ForEach(store.items, id: \.id) { event in eventRow(event) }
                    if store.hasMore {
                        Button {
                            Task { await store.loadMore() }
                        } label: {
                            if store.loadingMore {
                                ProgressView()
                            } else {
                                Text("Load more")
                            }
                        }
                        .disabled(store.loadingMore)
                    }
                }
                if let error = store.error {
                    Text(error).font(.caption).foregroundStyle(Theme.C.dangerText)
                }
            } header: {
                Text("Events")
            } footer: {
                Text(store.items.isEmpty ? "" : "\(store.total) \(store.total == 1 ? "event" : "events")")
            }
        }
        .themedListBackground()
        .navigationTitle("Activity")
        .task { await reload() }
        .refreshable { await reload() }
        .onChange(of: selectedGroups) { Task { await reload() } }
        .onChange(of: session) { Task { await reload() } }
    }

    private func reload() async {
        await store.reload(session: session.isEmpty ? nil : session, selectedGroups: selectedGroups)
    }

    private func sessionLabel(_ s: SessionLive) -> String {
        let nick = s.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (nick?.isEmpty == false ? nick! : nil) ?? "\(s.project)/\(s.repo)"
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(LogStore.groups, id: \.id) { g in
                    chip(label: g.label, active: selectedGroups.contains(g.id)) {
                        selectedGroups = LogStore.toggle(selectedGroups, g.id)
                    }
                }
                if !LogStore.ungroupedTypes(store.allTypes).isEmpty {
                    chip(label: "Other", active: selectedGroups.contains("other")) {
                        selectedGroups = LogStore.toggle(selectedGroups, "other")
                    }
                }
            }
        }
    }

    private func chip(label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .foregroundStyle(active ? Theme.C.primaryForeground : Theme.C.foreground)
                .background(active ? Theme.C.primary : Theme.C.muted, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func eventRow(_ e: ActivityEvent) -> some View {
        let info = OverviewStore.eventLabel(e.type)
        let detail = OverviewStore.eventDetail(e.data)
        return HStack(alignment: .top, spacing: 8) {
            Circle().fill(dotColor(info.kind)).frame(width: 7, height: 7).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(info.label).font(.caption.weight(.semibold))
                    Text(OverviewStore.sessionShort(e.session_id)).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                }
                if !detail.isEmpty {
                    Text(detail).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                }
            }
            Spacer()
            Text(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(e.ts)))
                .font(.caption2)
                .foregroundStyle(Theme.C.mutedForeground)
        }
    }

    private func dotColor(_ kind: OverviewStore.EventKind) -> Color {
        switch kind {
        case .ok: return Theme.C.ok
        case .warn: return Theme.C.warn
        case .danger: return Theme.C.danger
        case .info: return Theme.C.idle
        }
    }
}
