import SwiftUI

/// Agent, model and account menus of a chat session (dashboard/src/components/chat/Switchers.tsx). devd applies a
/// switch between turns and records it in the thread as a notice. The menus show the target devd plans the next
/// switch from (GET thread/target), re-read when the thread announces a new native thread, a run ends or a notice
/// arrives. Disabled options show their reason under the name (touch has no hover).
struct ChatSwitchers: View {
    let sessionId: String
    let thread: ThreadSnapshot
    let client: DevdClient

    private enum Which: String { case harness, model, account }

    @State private var target: ChatTarget?
    @State private var targetError: String?
    @State private var accounts: [ChatSwitch.Option]?
    @State private var accountsError: String?
    @State private var busy: Which?
    @State private var error: String?
    @State private var note: String?

    private var base: String { "/api/sessions/\(pathSegment(sessionId))/thread" }

    /// What re-reads the target (the dashboard's effect dependencies).
    private var targetKey: String {
        let n = thread.native
        return [n?.harness, n?.nativeThreadId, n?.model, n?.account].map { $0 ?? "-" }.joined(separator: "|")
            + "|\(thread.runs.filter { $0.endedSeq != nil }.count)|\(thread.runs.count)|\(thread.items.filter { $0.kind == .notice }.count)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let target {
                let blocked = ChatSwitch.blocked(runs: thread.runs, target: target)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        menu(.harness, title: "Agent", label: AgentProfiles.profile(for: AgentName(rawValue: target.agent)).short,
                             blocked: blocked, options: ChatSwitch.harnessOptions(target), loadError: nil)
                        menu(.model, title: "Model", label: target.model ?? "default model",
                             blocked: blocked ?? ChatSwitch.modelMenuBlocked(target), options: ChatSwitch.modelOptions(target), loadError: nil)
                        menu(.account, title: target.harness == "codex" ? "Codex account" : "Claude account",
                             label: accounts?.first(where: \.current)?.label ?? target.account ?? "no account",
                             blocked: blocked ?? ChatSwitch.accountMenuBlocked(target), options: accounts, loadError: accountsError)
                    }
                }
                if let blocked { line(blocked, Theme.C.mutedForeground) }
                if let awaiting = ChatSwitch.awaitingTargetText(target) { line(awaiting, Theme.C.mutedForeground) }
                if let note { line(note, Theme.C.warnText) }
                if let error { line(error, Theme.C.dangerText) }
            }
            if let targetError {
                HStack {
                    line(targetError, Theme.C.dangerText)
                    Button("Retry") { Task { await loadTarget() } }.font(Theme.F.meta)
                }
            }
        }
        .task(id: targetKey) { await loadTarget() }
        .task(id: target.map { "\($0.harness):\($0.account ?? "-")" }) {
            if let target, ChatSwitch.accountMenuBlocked(target) == nil { await loadAccounts(target) }
        }
        // A result note belongs to the last switch; the next message is a new action.
        .onChange(of: thread.runs.count) { _, _ in note = nil }
    }

    private func line(_ text: String, _ color: Color) -> some View {
        Text(text).font(Theme.F.meta).foregroundStyle(color)
    }

    private func menu(_ which: Which, title: String, label: String, blocked: String?, options: [ChatSwitch.Option]?, loadError: String?) -> some View {
        Menu {
            Section(title) {
                if let loadError {
                    Text(loadError)
                } else if let options {
                    if options.isEmpty { Text("Nothing to switch to") }
                    ForEach(options) { o in
                        Button {
                            if !o.current { pick(which, o) }
                        } label: {
                            if o.current { Label(o.label, systemImage: "checkmark") } else { Text(o.label) }
                            // The second line: why not, a warning, or the usage.
                            if let why = o.disabled { Text(why) } else if let w = o.warning { Text(w) } else if let d = o.detail { Text(d) }
                        }
                        .disabled(o.disabled != nil)
                    }
                } else {
                    Text("Loading…")
                }
            }
        } label: {
            HStack(spacing: 4) {
                if busy == which { ProgressView().controlSize(.mini) }
                Text(label).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .font(Theme.F.meta)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(Theme.C.border))
        }
        .disabled(blocked != nil || busy != nil)
        .accessibilityLabel("\(title): \(label)")
    }

    private func loadTarget() async {
        do {
            target = try await client.get("\(base)/target")
            targetError = nil
        } catch {
            targetError = "Could not read the current agent: \(ChatSwitch.errorText(error))"
        }
    }

    private func loadAccounts(_ t: ChatTarget) async {
        accounts = nil
        accountsError = nil
        let now = InboxView.ms(Date())
        do {
            if t.harness == "codex" {
                let r: CodexAccountsResponse = try await client.get("/api/codex-accounts")
                accounts = ChatSwitch.codexAccountOptions(r.accounts, now: now, target: t)
            } else {
                let r: AccountsResponse = try await client.get("/api/accounts")
                accounts = ChatSwitch.claudeAccountOptions(r.accounts, thresholdPct: r.pool.thresholdPct, now: now, target: t)
            }
        } catch {
            accountsError = ChatSwitch.errorText(error)
        }
    }

    private struct ModelBody: Encodable { let model: String }
    private struct AccountBody: Encodable { let accountId: String }
    private struct HarnessBody: Encodable { let agent: String }

    private func pick(_ which: Which, _ o: ChatSwitch.Option) {
        busy = which
        error = nil
        note = nil
        Task {
            do {
                let r: ChatSwitchResult
                switch which {
                case .model: r = try await client.post("\(base)/model", body: ModelBody(model: o.value))
                case .account: r = try await client.post("\(base)/account", body: AccountBody(accountId: o.value))
                case .harness: r = try await client.post("\(base)/harness", body: HarnessBody(agent: o.value))
                }
                note = ChatSwitch.resultText(r)
            } catch {
                let what = which == .harness ? "Agent" : which == .model ? "Model" : "Account"
                self.error = "\(what) switch to \(o.label) failed: \(ChatSwitch.errorText(error))"
            }
            // Also after a timeout: the bridge may have switched, and the menus should say where it is.
            await loadTarget()
            busy = nil
        }
    }
}
