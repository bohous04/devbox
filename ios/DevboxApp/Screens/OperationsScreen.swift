import SwiftUI

/// Operations, mirrors the deployments part of `dashboard/src/pages/Operations.tsx` (see `OperationsStore`): what
/// agents proposed, pending first, with Approve and Reject on pending proposals. Unlike the web, both ask first (like
/// Production writes): approving starts a deployment, and one mis-tap on a phone must not.
/// The page's database requests (`DbRequests`, a multi-step setup form) stay on the web; a `db-onboard` proposal
/// points there.
struct OperationsScreen: View {
    @StateObject private var store: OperationsStore
    @State private var busy: Int?
    @State private var actionError: String?
    @State private var confirmApprove: OperationRow?
    @State private var confirmReject: OperationRow?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: OperationsStore(client: client))
    }

    var body: some View {
        List {
            // Both at once: a failed decision must not hide that loading fails too, or the other way round.
            if actionError != nil || store.error != nil {
                Section {
                    if let actionError { Text(actionError).font(.caption).foregroundStyle(Theme.C.dangerText) }
                    if let error = store.error { Text("Failed to load: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText) }
                }
            }
            Section {
                let counts = store.rows.map(OperationsStore.counts)
                StatCardRow(items: [
                    ("Awaiting approval", counts.map { "\($0.pending)" } ?? "—", nil),
                    ("In progress", counts.map { "\($0.inProgress)" } ?? "—", nil),
                    ("Completed", counts.map { "\($0.completed)" } ?? "—", nil),
                ])
            } footer: {
                Text("Database requests are reviewed on the web dashboard.")
            }
            Section("Deployments & operations") {
                if let rows = store.rows {
                    if rows.isEmpty {
                        EmptyState("Nothing proposed. Agents can propose operations from a session.", systemImage: "paperplane")
                    }
                    ForEach(OperationsStore.pendingFirst(rows), id: \.id) { card($0) }
                } else {
                    ProgressView()
                }
            }
        }
        .insetGroupedList()
        .themedListBackground()
        .navigationTitle("Operations")
        .task { store.start() }
        .onDisappear { store.stop() }
        .confirmationDialog(
            confirmApprove.map { "Approve \(OperationsStore.title($0))?" } ?? "Approve?",
            isPresented: Binding(get: { confirmApprove != nil }, set: { if !$0 { confirmApprove = nil } }),
            titleVisibility: .visible,
            presenting: confirmApprove
        ) { r in
            Button("Approve operation") { act(r.id) { try await store.approve(r.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { r in
            Text("Approving lets operation #\(r.id) (\(r.op)) run. Nothing runs without this confirmation.")
        }
        .confirmationDialog(
            confirmReject.map { "Reject \(OperationsStore.title($0))?" } ?? "Reject?",
            isPresented: Binding(get: { confirmReject != nil }, set: { if !$0 { confirmReject = nil } }),
            titleVisibility: .visible,
            presenting: confirmReject
        ) { r in
            Button("Reject", role: .destructive) { act(r.id) { try await store.reject(r.id) } }
            Button("Cancel", role: .cancel) {}
        }
        .refreshable { await store.load() }
    }

    private func card(_ r: OperationRow) -> some View {
        let review = OperationsStore.review(r)
        let tone = tone(r.status)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "paperplane").foregroundStyle(tone)
                    .frame(width: 30, height: 30).background(tone.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.R.md))
                VStack(alignment: .leading, spacing: 2) {
                    Text(OperationsStore.title(r)).font(.subheadline.weight(.semibold))
                    Text("\(r.op.capitalized) · #\(r.id) · \(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(r.ts)))")
                        .font(.caption).foregroundStyle(Theme.C.mutedForeground)
                }
                Spacer(minLength: 8)
                Text(OperationsStore.statusLabel(r)).font(.caption.weight(.medium)).foregroundStyle(tone)
                    .padding(.horizontal, 8).padding(.vertical, 3).background(tone.opacity(0.12), in: Capsule())
            }
            FlowFields(fields: OperationsStore.fields(r), session: r.session_id ?? "Unknown session")
            if let result = r.result { Text(result).font(.caption).foregroundStyle(Theme.C.okText) }
            if let error = r.error { Text(error).font(.caption).foregroundStyle(Theme.C.dangerText) }
            if !review.changes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(review.changes.enumerated()), id: \.offset) { i, change in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(i + 1).").monospacedDigit().foregroundStyle(Theme.C.mutedForeground)
                            Text(change)
                        }
                    }
                }
                .font(.subheadline)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.C.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.R.md))
                .accessibilityLabel("Prepared operation changes")
            }
            if let sql = review.afterWrite {
                Text("This deployment can start only after SQL proposal #\(sql) succeeds. Access approval alone cannot release it.")
                    .font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
            }
            if let problem = review.problem { Text(problem).font(.subheadline).foregroundStyle(Theme.C.dangerText) }
            if r.op == "db-onboard", let request = review.requestId {
                Text("Review database request #\(request) on the web dashboard.").font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
            }
            if OperationsStore.canDecide(r) {
                HStack {
                    Spacer()
                    // The app's port of the web buttons: the system's prominent style draws light text on the
                    // near-white primary in dark mode.
                    let approvable = busy == nil && review.problem == nil
                    Button("Reject") { confirmReject = r }
                        .buttonStyle(DevboxButtonStyle(variant: .outline))
                        .disabled(busy != nil)
                        .opacity(busy == nil ? 1 : 0.5)
                    Button("Approve operation") { confirmApprove = r }
                        .buttonStyle(DevboxButtonStyle())
                        .disabled(!approvable)
                        .opacity(approvable ? 1 : 0.5)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func tone(_ status: String) -> Color {
        switch status {
        case "pending": return Theme.C.warnText
        case "executed": return Theme.C.okText
        case "failed": return Theme.C.dangerText
        default: return Theme.C.link
        }
    }

    private func act(_ id: Int, _ operation: @escaping () async throws -> Void) {
        guard busy == nil else { return }
        busy = id
        actionError = nil
        Task {
            do { try await operation() } catch { actionError = writeErrorText(error) }
            busy = nil
        }
    }
}

/// The proposal's parameters as key-value chips that wrap, then the session that proposed it.
private struct FlowFields: View {
    let fields: [(key: String, value: String)]
    let session: String

    var body: some View {
        WrapLayout(spacing: 6) {
            ForEach(fields, id: \.key) { field in
                (Text(field.key.prefix(1).uppercased() + field.key.dropFirst() + "  ").foregroundStyle(Theme.C.mutedForeground) + Text(field.value))
                    .font(.caption)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Theme.C.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.R.sm))
                    .overlay(RoundedRectangle(cornerRadius: Theme.R.sm).strokeBorder(Theme.C.border))
            }
            Text(session).font(.caption).foregroundStyle(Theme.C.mutedForeground).padding(.vertical, 3)
        }
    }
}
