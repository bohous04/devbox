import SwiftUI

/// Prod writes screen — mirrors `dashboard/src/pages/ProdWrites.tsx` (see `ProdWritesStore` for
/// fetch/poll/actions). The web has no confirmation dialog for Approve/Reject — the app ADDS one (task
/// brief "approve/reject with confirms"): it is a mutation of a PRODUCTION database and a phone is easier to tap
/// by accident than a mouse on a desktop. Approve/Reject NEVER run automatically — the app only
/// wires them behind an explicit user confirmation.
struct ProdWritesScreen: View {
    @StateObject private var store: ProdWritesStore
    @State private var busyId: Int?
    @State private var actionError: String?
    @State private var confirmApprove: ProdWrite?
    @State private var confirmReject: ProdWrite?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: ProdWritesStore(client: client))
    }

    var body: some View {
        List {
            if let error = store.error {
                Section { Text("Error: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText) }
            }
            if let actionError {
                Section { Text(actionError).font(.caption).foregroundStyle(Theme.C.dangerText) }
            }

            if let rows = store.rows {
                let pending = ProdWritesStore.pending(rows)
                let past = ProdWritesStore.past(rows)

                Section {
                    if pending.isEmpty {
                        Text("No pending writes — when an agent proposes a write to the prod DB, it'll appear here for approval.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.C.mutedForeground)
                    } else {
                        ForEach(pending, id: \.id) { w in pendingRow(w) }
                    }
                } header: {
                    Text("Awaiting approval")
                }

                if !past.isEmpty {
                    Section("History") {
                        ForEach(past, id: \.id) { w in historyRow(w) }
                    }
                }
            } else {
                Section { ProgressView() }
            }
        }
        .themedListBackground()
        .navigationTitle("Production writes")
        .task { store.start() }
        .onDisappear { store.stop() }
        .refreshable { await store.load() }
        .confirmationDialog(
            confirmApprove.map { "Approve and execute this write to \($0.db)?" } ?? "Approve and execute?",
            isPresented: Binding(get: { confirmApprove != nil }, set: { if !$0 { confirmApprove = nil } }),
            titleVisibility: .visible
        ) {
            if let w = confirmApprove {
                Button("Approve and execute", role: .destructive) {
                    performAction(w.id) { try await store.approve(w.id) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This runs the SQL against the live production database. Nothing runs without this confirmation.")
        }
        .confirmationDialog(
            confirmReject.map { "Reject this write to \($0.db)?" } ?? "Reject?",
            isPresented: Binding(get: { confirmReject != nil }, set: { if !$0 { confirmReject = nil } }),
            titleVisibility: .visible
        ) {
            if let w = confirmReject {
                Button("Reject", role: .destructive) {
                    performAction(w.id) { try await store.reject(w.id) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func pendingRow(_ w: ProdWrite) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            header(w)
            // Actions right under the header (like the web, 8313854) — with a long migration you do not scroll past the SQL.
            HStack {
                Button("Approve and execute") { confirmApprove = w }
                    .buttonStyle(.borderedProminent)
                Button("Reject", role: .destructive) { confirmReject = w }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Impact preview") { Task { await store.loadPreview(w.id) } }
                    .buttonStyle(.borderless)
            }
            .font(.caption)
            .disabled(busyId == w.id)
            if let preview = store.previews[w.id] {
                Text(preview)
                    .font(.caption2)
                    .padding(6)
                    .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: Theme.R.sm))
            }
            Text(w.sql)
                .font(.system(.caption2, design: .monospaced))
                .textSelection(.enabled)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func historyRow(_ w: ProdWrite) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            header(w)
            Text(w.sql)
                .font(.system(.caption2, design: .monospaced))
                .lineLimit(3)
            if let result = w.result ?? w.error {
                Text(result).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            }
        }
        .padding(.vertical, 4)
    }

    private func header(_ w: ProdWrite) -> some View {
        HStack {
            Circle().fill(dotColor(w.status)).frame(width: 7, height: 7)
            Text(w.db).font(.caption.weight(.semibold))
            Text(ProdWritesStore.statusLabel(w.status)).font(.caption2).foregroundStyle(tone(w.status))
            if let sessionId = w.session_id { Text(sessionId).font(.caption2).foregroundStyle(Theme.C.mutedForeground) }
            Spacer()
            Text(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(w.ts)))
                .font(.caption2)
                .foregroundStyle(Theme.C.mutedForeground)
        }
    }

    private func dotColor(_ status: ProdWrite.Status) -> Color {
        switch status {
        case .pending, .approved: return Theme.C.warn
        case .executed: return Theme.C.ok
        case .failed: return Theme.C.danger
        case .rejected: return Theme.C.idle
        }
    }

    private func tone(_ status: ProdWrite.Status) -> Color {
        switch status {
        case .pending, .approved: return Theme.C.warnText
        case .executed: return Theme.C.okText
        case .failed: return Theme.C.dangerText
        case .rejected: return Theme.C.mutedForeground
        }
    }

    private func performAction(_ id: Int, _ operation: @escaping () async throws -> Void) {
        busyId = id
        actionError = nil
        Task {
            do { try await operation() } catch { actionError = errorText(error) }
            busyId = nil
        }
    }
}
