import SwiftUI

/// SSH approvals screen — mirrors `dashboard/src/pages/SshApprovals.tsx` (see
/// `SshApprovalsStore` for fetch/poll/actions). An agent in the devbox container requests an SSH key via
/// `srv "<title>" --why "…" [user@host]`; without approval here the key is not loaded into the ssh-agent on
/// the host and never reaches the container at all, only the socket does.
///
/// The layout deliberately separates VERIFIED FACTS from AGENT CLAIMS: `title` is validated by the server
/// against the key list in 1Password and `project`/`repo` are derived from the session id — those are
/// in the card header. `why`, `cwd` and `target` are self-reported by the container and nothing verifies them —
/// they belong together in `GroupBox("Agent claims")`, not among the facts (see `SshApproval` in
/// `Api/Models.swift`).
struct SshApprovalsScreen: View {
    @StateObject private var store: SshApprovalsStore
    @State private var busyId: String?
    @State private var actionError: String?
    /// Request for which the "Custom…" dialog (the "Allow for" menu) is currently open — nil = closed.
    @State private var customMinutesRowId: String?
    @State private var customMinutesText = ""
    /// Live grant whose revocation is being confirmed (see `grantRow`) — same pattern as
    /// `confirmDelete` in `CronScreen`.
    @State private var confirmRevoke: SshApproval?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: SshApprovalsStore(client: client))
    }

    var body: some View {
        List {
            // Break-glass visibility (see spec "Break-glass"): someone holding only the phone must not
            // believe the gate protects them when someone has disabled it on the host (`DEVD_SSH_APPROVAL=off`).
            // 1:1 banner with `dashboard/src/pages/SshApprovals.tsx`, just in the app's idiom
            // (`Label` in a `Section`, same pattern as the offline banner in `OverviewScreen`).
            // Two different banners: `.disabled` is certainty (red), `.unknown` is uncertainty
            // (amber) — it must not look as alarming as a truly disabled gate, but
            // it must not stay silent either, see `SshApprovalsStore.GateState`.
            if store.gate == .disabled {
                Section {
                    Label("The SSH gate is OFF (DEVD_SSH_APPROVAL=off) — keys are handed out without approval.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.C.dangerText)
                }
            }
            if store.gate == .unknown {
                Section {
                    Label("Couldn't verify the SSH gate — we don't know whether it is on or off.", systemImage: "questionmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.C.warnText)
                }
            }
            if let error = store.error {
                Section { Text("Error: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText) }
            }
            if let actionError {
                Section { Text(actionError).font(.caption).foregroundStyle(Theme.C.dangerText) }
            }

            if let rows = store.rows {
                let pending = SshApprovalsStore.pending(rows)
                let past = rows.filter { $0.status != "pending" }

                Section {
                    if pending.isEmpty {
                        Text("Nothing pending — when an agent asks for an SSH key, it will show up here.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.C.mutedForeground)
                    } else {
                        ForEach(pending) { row in pendingRow(row) }
                    }
                } header: {
                    Text("Awaiting decision")
                }

                if !store.grants.isEmpty {
                    Section("Live grants") {
                        ForEach(store.grants) { row in grantRow(row) }
                    }
                }

                if !past.isEmpty {
                    Section("History") {
                        ForEach(past) { row in historyRow(row) }
                    }
                }
            } else {
                Section { ProgressView() }
            }
        }
        .themedListBackground()
        .navigationTitle("SSH keys")
        .task { store.start() }
        .onDisappear { store.stop() }
        .refreshable { await store.load() }
        .alert("Custom number of minutes", isPresented: Binding(
            get: { customMinutesRowId != nil },
            set: { if !$0 { customMinutesRowId = nil } }
        )) {
            TextField("minutes", text: $customMinutesText)
                .keyboardType(.numberPad)
            Button("Approve") {
                if let id = customMinutesRowId {
                    if let minutes = Self.customMinutes(customMinutesText) {
                        performAction(id) { try await store.approve(id: id, choice: .minutes(minutes)) }
                    } else {
                        // The alert always closes after a tap — invalid input must not vanish silently.
                        actionError = Self.invalidMinutesText
                    }
                }
                customMinutesRowId = nil
            }
            Button("Cancel", role: .cancel) { customMinutesRowId = nil }
        }
        .confirmationDialog(
            confirmRevoke.map { "Revoke access for “\($0.title)”?" } ?? "Revoke access?",
            isPresented: Binding(get: { confirmRevoke != nil }, set: { if !$0 { confirmRevoke = nil } }),
            titleVisibility: .visible
        ) {
            if let grant = confirmRevoke {
                Button("Revoke access", role: .destructive) {
                    performAction(grant.id) { try await store.revoke(grantId: grant.id) }
                }
            }
            Button("Back", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func pendingRow(_ row: SshApproval) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(Theme.C.warn).frame(width: 7, height: 7)
                Text(row.title).font(.headline)
                Spacer()
                Text("\(SshApprovalsStore.secondsLeft(row, now: Date().timeIntervalSince1970 * 1000)) s")
                    .font(.caption).foregroundStyle(Theme.C.warnText)
            }
            Text(projectRepoLabel(row))
                .font(.caption).foregroundStyle(Theme.C.mutedForeground)
            Text(SshApprovalsStore.targetLabel(row))
                .font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            // Agent claims kept separate from the verified facts above (title/project/repo) — `why`, `cwd`
            // and `target` are self-reported by the container and nothing verifies them.
            GroupBox("Agent claims") {
                VStack(alignment: .leading, spacing: 4) {
                    if let target = row.target { Text("Target: \(target)").font(.callout) }
                    Text(row.why).font(.callout)
                    if let cwd = row.cwd { Text("from \(cwd)").font(.caption2).foregroundStyle(Theme.C.mutedForeground) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                // Face ID icon on both approval buttons (and on the whole "Allow for" menu): tells
                // in advance that a prompt will follow (see `SshApprovalsStore.approve` — biometrics before
                // the POST). Deny does not have it.
                Button {
                    performAction(row.id) { try await store.approve(id: row.id, choice: .once) }
                } label: {
                    Label("Allow once", systemImage: "faceid")
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.C.primary)

                Menu {
                    ForEach(SshApprovalsStore.grantPresets, id: \.self) { minutes in
                        Button(presetLabel(minutes)) {
                            performAction(row.id) { try await store.approve(id: row.id, choice: .minutes(minutes)) }
                        }
                    }
                    Button("Custom…") {
                        customMinutesText = ""
                        customMinutesRowId = row.id
                    }
                    Button("Permanently") {
                        performAction(row.id) { try await store.approve(id: row.id, choice: .permanent) }
                    }
                } label: {
                    Label("Allow for", systemImage: "faceid")
                }
                .buttonStyle(.bordered)
                .tint(Theme.C.foreground)

                Button("Deny", role: .destructive) {
                    performAction(row.id) { try await store.deny(id: row.id) }
                }
                .buttonStyle(.bordered)
            }
            .font(.caption)
            .disabled(busyId == row.id)
        }
        .padding(.vertical, 4)
    }

    /// "10 min" · "1 h" · "4 h" — presets from `SshApprovalsStore.grantPresets` are always either under
    /// an hour or a whole number of hours, so there is no remainder to handle.
    private func presetLabel(_ minutes: Int) -> String {
        minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes) min"
    }

    @ViewBuilder
    private func grantRow(_ row: SshApproval) -> some View {
        // Stacked, not in one `HStack` — five items side by side broke on the phone into
        // narrow columns split by syllables (screenshot Task 11). Content and actions unchanged.
        VStack(alignment: .leading, spacing: 4) {
            Text(row.title).font(.subheadline.weight(.semibold))
            Text(projectRepoLabel(row)).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            Text(SshApprovalsStore.targetLabel(row)).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            HStack {
                Text(SshApprovalsStore.grantLabel(row, now: Date()))
                    .font(.caption2)
                    .foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Button("Revoke", role: .destructive) { confirmRevoke = row }
                    .font(.caption2)
                    .buttonStyle(.bordered)
                    .disabled(busyId == row.id)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func historyRow(_ row: SshApproval) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle().fill(dotColor(row.status)).frame(width: 7, height: 7)
                Text(row.title).font(.subheadline.weight(.semibold))
                Text(row.status).font(.caption2).foregroundStyle(tone(row.status))
                if let decidedBy = row.decided_by {
                    Text("by \(decidedBy)").font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                }
                Spacer()
                Text(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - row.created_at))
                    .font(.caption2)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
            Text(row.why).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
        }
        .padding(.vertical, 4)
    }

    private func projectRepoLabel(_ row: SshApproval) -> String {
        if let project = row.project, let repo = row.repo { return "\(project)/\(repo)" }
        return row.session_id ?? ""
    }

    /// 1:1 `DOT_KIND` from `dashboard/src/pages/SshApprovals.tsx`. `revoked` is a state the
    /// operator asked for themselves (see `revokeGrant` in `devd/src/sshApprovals.ts`), not an alarming outcome —
    /// hence as muted as `expired`, not red like `denied`.
    private func dotColor(_ status: String) -> Color {
        switch status {
        case "pending", "approved": return Theme.C.warn
        case "activated": return Theme.C.ok
        case "denied": return Theme.C.danger
        default: return Theme.C.idle // expired, revoked
        }
    }

    /// 1:1 `STATUS_TONE` from `dashboard/src/pages/SshApprovals.tsx` — see `dotColor` above.
    private func tone(_ status: String) -> Color {
        switch status {
        case "pending", "approved": return Theme.C.warnText
        case "activated": return Theme.C.okText
        case "denied": return Theme.C.dangerText
        default: return Theme.C.mutedForeground // expired, revoked
        }
    }

    static let invalidMinutesText = "Enter a positive number of minutes."

    /// Custom minute count from the alert: only a positive integer (surrounding spaces are fine), otherwise `nil`.
    static func customMinutes(_ text: String) -> Int? {
        guard let minutes = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)), minutes > 0 else { return nil }
        return minutes
    }

    private func performAction(_ id: String, _ operation: @escaping () async throws -> Void) {
        busyId = id
        actionError = nil
        Task {
            do {
                try await operation()
            } catch {
                // 409 = the mac dialog or the dashboard decided first — a normal lost race, not
                // an error (see `SshApprovalsStore.decide`, which reloads anyway; the next poll shows
                // who decided). A cancelled Face ID prompt is the same: the user changed their mind, no
                // red message. Anything else the app shows as `actionError`.
                let raced = (error as? DevdHTTPError)?.statusCode == 409
                let cancelled = (error as? BiometricError) == .cancelled
                if !raced && !cancelled {
                    actionError = errorText(error)
                }
            }
            busyId = nil
        }
    }
}
