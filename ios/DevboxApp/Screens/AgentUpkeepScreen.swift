import SwiftUI

/// Agent upkeep, mirrors `dashboard/src/pages/AgentUpkeep.tsx` (see `AgentUpkeepStore`): pick an agent runtime, see
/// its latest release and every running session's version, and update one session or all of them. The web runs an
/// update on the click, and so does this screen. Antigravity has no update: its binary changes only with an image
/// build.
struct AgentUpkeepScreen: View {
    @StateObject private var store: AgentUpkeepStore
    @State private var search = ""
    @State private var repo = ""

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: AgentUpkeepStore(client: client))
    }

    var body: some View {
        List {
            Section {
                Picker("Agent runtime", selection: Binding(get: { store.provider }, set: { p in
                    repo = ""
                    Task { await store.select(p) }
                })) {
                    ForEach(UpkeepProvider.allCases, id: \.self) { Text(AgentUpkeepStore.title($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(store.busy)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: Theme.S.gridGap)], spacing: Theme.S.gridGap) {
                    StatCard(label: "Latest stable", value: store.status.map { $0.latest ?? "Unknown" } ?? "—",
                             caption: "\(AgentUpkeepStore.title(store.provider)) release")
                    StatCard(label: "Base image", value: store.status.map { $0.image ?? "Unknown" } ?? "—", caption: "Version in new containers")
                    StatCard(label: "Running sessions", value: store.status.map { "\($0.sessions.count)" } ?? "—",
                             caption: AgentUpkeepStore.cadence(store.provider))
                }
                Label { Text(AgentUpkeepStore.note(store.provider)) } icon: { Image(systemName: "checkmark.shield") }
                    .font(.caption).foregroundStyle(Theme.C.mutedForeground)
            }
            if let error = store.error {
                Section { Text(error).font(.caption).foregroundStyle(Theme.C.dangerText) }
            }
            if let result = store.result {
                Section { Text(result).font(.caption) }
            }
            sessions
        }
        .insetGroupedList()
        .themedListBackground()
        .navigationTitle("Agent upkeep")
        .searchable(text: $search, prompt: "Search session or repository")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await store.load() } } label: { Label("Refresh versions", systemImage: "arrow.clockwise") }
                    .disabled(store.busy)
                    .help("Refresh versions")
            }
        }
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    @ViewBuilder
    private var sessions: some View {
        let all = store.status?.sessions ?? []
        let repositories = AgentUpkeepStore.repositories(all)
        let latest = store.status?.latest
        Section {
            if store.status == nil {
                Text(store.error == nil ? "Loading versions…" : "Versions unavailable").font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
            } else if all.isEmpty {
                EmptyState("No running sessions. Installed versions appear when a session is running.", systemImage: "terminal")
            } else {
                HStack(spacing: 14) {
                    ForEach(AgentUpkeepStore.SessionState.allCases, id: \.self) { state in
                        HStack(spacing: 4) {
                            Image(systemName: icon(state)).foregroundStyle(tone(state))
                            Text("\(all.filter { AgentUpkeepStore.state($0, latest: latest) == state }.count)").fontWeight(.semibold).monospacedDigit()
                            Text(AgentUpkeepStore.label(state, provider: store.provider)).foregroundStyle(Theme.C.mutedForeground)
                        }
                    }
                }
                .font(.caption)
                if repositories.count > 1 {
                    Picker("Repository", selection: $repo) {
                        Text("All repositories").tag("")
                        ForEach(repositories, id: \.self) { Text($0).tag($0) }
                    }
                }
                let shown = AgentUpkeepStore.filter(all, search: search, repo: repo)
                if shown.isEmpty {
                    Text("No matching sessions. Try a different search or clear the repository filter.")
                        .font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
                }
                ForEach(shown, id: \.id) { row($0, latest: latest) }
            }
        } header: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Session versions")
                    if store.status != nil {
                        Text("\(all.count) sessions across \(repositories.count) repositories").font(.caption2).textCase(nil)
                    }
                }
                Spacer()
                if AgentUpkeepStore.canUpdate(store.provider) {
                    Button("Update all sessions") { Task { await store.run() } }
                        .buttonStyle(.borderedProminent).controlSize(.small).textCase(nil)
                        .disabled(store.busy || all.isEmpty)
                }
            }
        }
    }

    private func row(_ s: AgentUpkeepSession, latest: String?) -> some View {
        let state = AgentUpkeepStore.state(s, latest: latest)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.repo).font(.subheadline.weight(.semibold))
                Text("\(s.project) · \(s.id)").font(.caption).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(s.version ?? "Unknown").font(.system(.subheadline, design: .monospaced))
                Text(s.running.map { "\($0) running \($0 == 1 ? "process" : "processes")" } ?? "Processes unknown")
                    .font(.caption).foregroundStyle(Theme.C.mutedForeground)
            }
            Label(AgentUpkeepStore.label(state, provider: store.provider), systemImage: icon(state))
                .font(.caption.weight(.medium)).foregroundStyle(tone(state)).lineLimit(1)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(tone(state).opacity(0.12), in: Capsule())
            if AgentUpkeepStore.canUpdate(store.provider) {
                Button("Update") { Task { await store.run(session: s.id) } }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(store.busy)
                    .accessibilityLabel("Update \(s.project)/\(s.repo) session \(s.id)")
            }
        }
    }

    private func icon(_ state: AgentUpkeepStore.SessionState) -> String {
        switch state {
        case .current: return "checkmark.circle"
        case .update: return "arrow.up.circle"
        case .reopen: return "clock"
        case .unknown: return "questionmark.circle"
        }
    }

    private func tone(_ state: AgentUpkeepStore.SessionState) -> Color {
        switch state {
        case .current: return Theme.C.okText
        case .update: return Theme.C.warnText
        case .reopen: return Theme.C.link
        case .unknown: return Theme.C.mutedForeground
        }
    }
}
