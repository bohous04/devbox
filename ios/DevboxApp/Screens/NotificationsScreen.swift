import SwiftUI

/// Notifications screen — mirrors `dashboard/src/pages/Notifications.tsx` (see
/// `NotificationsStore` for pure helpers/fetch/mutations). Fetch-on-appear (the filter recomputes the query on the
/// server, same as the web) + pull-to-refresh, no polling.
struct NotificationsScreen: View {
    @StateObject private var store: NotificationsStore
    @State private var filter: NotificationsStore.Filter = .all
    @State private var notes: [Int: String] = [:]
    @State private var actionError: String?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: NotificationsStore(client: client))
    }

    var body: some View {
        List {
            Section {
                Picker("Filter", selection: $filter) {
                    Text("All").tag(NotificationsStore.Filter.all)
                    Text("Only sent").tag(NotificationsStore.Filter.sent)
                    Text("Only flagged").tag(NotificationsStore.Filter.flagged)
                }
                .pickerStyle(.segmented)
                if let error = store.error {
                    Text("Error: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText)
                }
                if let actionError {
                    Text(actionError).font(.caption).foregroundStyle(Theme.C.dangerText)
                }
            }

            if let rows = store.rows {
                if rows.isEmpty {
                    Section {
                        Text("Nothing logged yet — decisions show up here as soon as an agent runs.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.C.mutedForeground)
                    }
                } else {
                    ForEach(NotificationsStore.groupByTurn(rows), id: \.key) { group in
                        Section {
                            ForEach(group.rows + (group.header.map { [$0] } ?? []), id: \.id) { row in
                                rowView(row)
                            }
                        } header: {
                            Text(sectionHeader(group)).lineLimit(1)
                        }
                    }
                }
            } else {
                Section { ProgressView() }
            }
        }
        .themedListBackground()
        .navigationTitle("Notifications")
        .task { await store.load(filter: filter) }
        .refreshable { await store.load(filter: filter) }
        .onChange(of: filter) { Task { await store.load(filter: filter) } }
    }

    /// Mirrors `{g.header ? (promptExcerpt(g.header) ?? "(prompt not recorded)") : "No prompt in view"}`.
    private func sectionHeader(_ group: NotificationsStore.TurnGroup) -> String {
        guard let header = group.header else { return "No prompt in view" }
        return NotificationsStore.promptExcerpt(header) ?? "(prompt not recorded)"
    }

    @ViewBuilder
    private func rowView(_ r: NotifyLogRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(r.decision.rawValue).font(.caption.weight(.semibold)).foregroundStyle(tone(r.decision))
                Text(NotificationsStore.eventLabel(r.event)).font(.caption)
                Text(OverviewStore.sessionShort(r.session_id)).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Text(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(r.ts)))
                    .font(.caption2)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
            if let reason = r.reason {
                Text("· \(reason)").font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            }
            Text("subagents in flight: \(r.inflight) · teammate tasks: \(r.teammates)\(r.detail.map { " · \($0)" } ?? "")")
                .font(.caption2)
                .foregroundStyle(Theme.C.mutedForeground)

            if let verdict = r.verdict {
                Text((NotificationsStore.verdictLabels[verdict] ?? verdict.rawValue) + (r.verdict_note.map { " — \($0)" } ?? ""))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.C.warnText)
                Button("Clear flag") { mark(r, nil) }
                    .font(.caption)
            } else {
                TextField("Optional note", text: Binding(
                    get: { notes[r.id] ?? "" },
                    set: { notes[r.id] = $0 }
                ))
                .font(.caption)
                HStack {
                    if r.decision == .sent {
                        Button("Wrong") { mark(r, .falsePositive) }
                    }
                    if r.decision == .deferred {
                        Button("Should have fired") { mark(r, .missing) }
                    }
                    Button("Correct") { mark(r, .ok) }
                }
                .buttonStyle(DevboxButtonStyle(variant: .outline))
            }
        }
        .padding(.vertical, 2)
    }

    private func tone(_ decision: NotifyDecision) -> Color {
        switch decision {
        case .sent: return Theme.C.okText
        case .armed: return .blue
        case .deferred: return Theme.C.warnText
        case .suppressed, .none: return Theme.C.mutedForeground
        }
    }

    private func mark(_ row: NotifyLogRow, _ verdict: NotifyVerdict?) {
        Task {
            do {
                try await store.setVerdict(row.id, verdict: verdict, note: verdict != nil ? nonEmpty(notes[row.id]) : nil)
                notes[row.id] = nil
                await store.load(filter: filter)
                actionError = nil
            } catch {
                actionError = errorText(error)
            }
        }
    }

    private func nonEmpty(_ s: String?) -> String? {
        let trimmed = s?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty ?? true) ? nil : trimmed
    }
}
