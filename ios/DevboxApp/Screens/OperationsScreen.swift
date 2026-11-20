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
            if let error = actionError ?? store.error {
                Section { Text(error).font(.caption).foregroundStyle(Theme.C.dangerText) }
            }
            Section {
                let counts = store.rows.map(OperationsStore.counts)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: Theme.S.gridGap)], spacing: Theme.S.gridGap) {
                    StatCard(label: "Awaiting approval", value: counts.map { "\($0.pending)" } ?? "—")
                    StatCard(label: "In progress", value: counts.map { "\($0.inProgress)" } ?? "—")
                    StatCard(label: "Completed", value: counts.map { "\($0.completed)" } ?? "—")
                }
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
                    Button("Reject") { confirmReject = r }
                        .buttonStyle(.bordered)
                        .disabled(busy != nil)
                    Button("Approve operation") { confirmApprove = r }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy != nil || review.problem != nil)
                }
                .controlSize(.small)
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
            do { try await operation() } catch { actionError = errorText(error) }
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

/// Lays children left to right and wraps to a new line when the width runs out.
private struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0; var y: CGFloat = 0 }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows = [Row()]
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if !rows[rows.count - 1].items.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + spacing))
            }
            let gap = rows[rows.count - 1].items.isEmpty ? 0 : spacing
            rows[rows.count - 1].items.append(i)
            rows[rows.count - 1].width += gap + size.width
            rows[rows.count - 1].height = max(rows[rows.count - 1].height, size.height)
        }
        return rows
    }
}
