import SwiftUI

/// CRON screen — mirrors `dashboard/src/pages/Schedule.tsx` (see `CronStore` for fetch/actions).
/// NARROWED (deliberate narrowing, see task report): the app cannot create or edit a schedule (cron expression +
/// prompt + folder/project/repo pickers) — only view, enable/disable, toggle important/normal,
/// run now and delete. "Run now" additionally gets a confirmation the web does not have — it starts a real
/// agent run on a production repo, and on mobile it is easier to tap by accident than with a mouse on a desktop.
struct CronScreen: View {
    @StateObject private var store: CronStore
    @State private var actionError: String?
    @State private var busyId: String?
    @State private var confirmRun: Schedule?
    @State private var confirmDelete: Schedule?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: CronStore(client: client))
    }

    var body: some View {
        Group {
            if let schedules = store.schedules {
                List {
                    if schedules.isEmpty {
                        Section {
                            Text("No schedules — add one on the dashboard.")
                                .font(.subheadline)
                                .foregroundStyle(Theme.C.mutedForeground)
                        }
                    } else {
                        ForEach(schedules, id: \.id) { s in row(s) }
                    }
                    if let actionError {
                        Section { Text(actionError).font(.caption).foregroundStyle(Theme.C.dangerText) }
                    }
                }
                .listStyle(.insetGrouped)
            } else if let error = store.error {
                ContentUnavailableView(
                    "Couldn't load schedules",
                    systemImage: "clock.badge.exclamationmark",
                    description: Text(error)
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .themedListBackground()
        .navigationTitle("Schedules")
        .task { await store.load() }
        .refreshable { await store.load() }
        .confirmationDialog(
            confirmRun.map { "Run “\($0.name)” now?" } ?? "Run now?",
            isPresented: Binding(get: { confirmRun != nil }, set: { if !$0 { confirmRun = nil } }),
            titleVisibility: .visible
        ) {
            if let s = confirmRun {
                Button("Run now", role: .destructive) { performAction(s) { try await store.run(s) } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            confirmDelete.map { "Delete “\($0.name)”?" } ?? "Delete schedule?",
            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            titleVisibility: .visible
        ) {
            if let s = confirmDelete {
                Button("Delete schedule", role: .destructive) { performAction(s) { try await store.delete(s) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func row(_ s: Schedule) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(s.name).font(.subheadline.weight(.semibold))
            Text("\(s.project)/\(s.repo)").font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            Text(promptExcerpt(s.prompt)).font(.caption2).foregroundStyle(Theme.C.mutedForeground).lineLimit(2)
            HStack {
                Text(s.cron).font(.system(.caption, design: .monospaced))
                Spacer()
                Text(s.last_run_at.map { Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double($0)) } ?? "never")
                    .font(.caption2)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
            HStack(spacing: 12) {
                Button(s.enabled == 1 ? "Enabled" : "Disabled") {
                    performAction(s) { try await store.setEnabled(s) }
                }
                .foregroundStyle(s.enabled == 1 ? Theme.C.okText : Theme.C.mutedForeground)

                Button(s.important == 1 ? "Emergency" : "Normal") {
                    performAction(s) { try await store.setImportant(s) }
                }
                .foregroundStyle(s.important == 1 ? Theme.C.dangerText : Theme.C.mutedForeground)

                Spacer()
            }
            .font(.caption2.weight(.semibold))
            .buttonStyle(.plain)
            .disabled(busyId == s.id)

            HStack {
                Button("Run now") { confirmRun = s }
                Spacer()
                Button("Delete", role: .destructive) { confirmDelete = s }
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .disabled(busyId == s.id)
        }
        .padding(.vertical, 4)
        .opacity(s.enabled == 1 ? 1 : 0.6)
    }

    /// Mirrors the web (`s.prompt.slice(0, 160)}${s.prompt.length > 160 ? "…" : ""}`).
    private func promptExcerpt(_ prompt: String) -> String {
        prompt.count > 160 ? "\(prompt.prefix(160))…" : prompt
    }

    private func performAction(_ s: Schedule, _ operation: @escaping () async throws -> Void) {
        busyId = s.id
        actionError = nil
        Task {
            do { try await operation() } catch { actionError = errorText(error) }
            busyId = nil
        }
    }
}
