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
                // Segments where all four names fit (Mac), a menu otherwise (iPhone).
                ViewThatFits(in: .horizontal) {
                    providerPicker.pickerStyle(.segmented).labelsHidden().fixedSize()
                    providerPicker.pickerStyle(.menu)
                }
                .disabled(store.busy)
                StatCardRow(items: [
                    ("Latest stable", store.status.map { $0.latest ?? "Unknown" } ?? "—", "\(AgentUpkeepStore.title(store.provider)) release"),
                    ("Base image", store.status.map { $0.image ?? "Unknown" } ?? "—", "Version in new containers"),
                    ("Running sessions", store.status.map { "\($0.sessions.count)" } ?? "—", AgentUpkeepStore.cadence(store.provider)),
                ])
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

    private var providerPicker: some View {
        Picker("Agent runtime", selection: Binding(get: { store.provider }, set: { p in
            repo = ""
            Task { await store.select(p) }
        })) {
            ForEach(UpkeepProvider.allCases, id: \.self) { Text(AgentUpkeepStore.title($0)).tag($0) }
        }
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
                WrapLayout(spacing: 14) {
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
                        .buttonStyle(.bordered).controlSize(.small).textCase(nil)
                        .disabled(store.busy || all.isEmpty)
                }
            }
        }
    }

    private func row(_ s: AgentUpkeepSession, latest: String?) -> some View {
        let state = AgentUpkeepStore.state(s, latest: latest)
        let name = VStack(alignment: .leading, spacing: 2) {
            Text(s.repo).font(.subheadline.weight(.semibold))
            Text("\(s.project) · \(s.id)").font(.caption).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
        }
        let version = { (alignment: HorizontalAlignment) in
            VStack(alignment: alignment, spacing: 2) {
                Text(s.version ?? "Unknown").font(.system(.subheadline, design: .monospaced))
                Text(s.running.map { "\($0) running \($0 == 1 ? "process" : "processes")" } ?? "Processes unknown")
                    .font(.caption).foregroundStyle(Theme.C.mutedForeground)
            }
        }
        let chip = Label(AgentUpkeepStore.label(state, provider: store.provider), systemImage: icon(state))
            .font(.caption.weight(.medium)).foregroundStyle(tone(state))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tone(state).opacity(0.12), in: Capsule())
        let update = Group {
            if AgentUpkeepStore.canUpdate(store.provider) {
                Button("Update") { Task { await store.run(session: s.id) } }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(store.busy)
                    .accessibilityLabel("Update \(s.project)/\(s.repo) session \(s.id)")
            }
        }
        // One line where it fits (Mac); on an iPhone the state and the version go under the name.
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { name; Spacer(minLength: 8); version(.trailing); chip.lineLimit(1); update }
            VStack(alignment: .leading, spacing: 6) {
                name
                chip
                HStack { version(.leading); Spacer(minLength: 8); update }
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
