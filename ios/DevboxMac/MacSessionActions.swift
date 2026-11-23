import SwiftUI

/// The terminal's F9 menu (cli/src/manager-view.ts `exitMenuOptions`, run by `handleExit` in cli/src/main.ts) in the
/// sidebar row's context menu: Rename, Change Agent and Change Account (End is the row's settle). "Back to session" and "Just detach" are
/// about the terminal tab and have no place here. What the menu offers is decided here, apart from the views, so the
/// rules are tested on their own.
enum MacSessionMenu {
    struct Choice: Equatable {
        let id: String
        let label: String
        let current: Bool
        /// Codex: picking it finishes an unfinished switch to this account.
        var finishing = false
    }

    enum Pool: Equatable {
        case claude, codex
    }

    /// The accounts the menu can offer, as loaded from devd.
    enum Accounts: Equatable {
        case loading
        case failed(String)
        /// Nothing can be picked, and why (said as it is).
        case unavailable(String)
        case loaded([Choice])
    }

    struct AccountMenu: Equatable {
        let pool: Pool
        let title: String
        /// "Automatic" (devd picks a fresher account): only the Anthropic pool has it; a Codex switch names its account
        /// (devd/src/codexSessionAccounts.ts `switch`).
        let automatic: Bool
        let accounts: [Choice]
        /// Why no accounts are listed (loading, a failed load, none usable).
        let note: String?
    }

    struct Menu: Equatable {
        /// False until the session is in the live list (its current name is needed to prefill the field).
        let canRename: Bool
        /// Empty = no Change Agent submenu.
        let agents: [Choice]
        /// nil = no Change Account submenu.
        let account: AccountMenu?
    }

    /// What the live session list knows of the session.
    struct Facts: Equatable {
        let accountId: String?
    }

    /// `runtime` and `agent` come from the inbox item; `facts` from the live list (nil while it does not have the
    /// session).
    static func menu(sessionId: String, runtime: InboxItem.Runtime, agent: String, facts: Facts?,
                     claude: Accounts, codex: Accounts) -> Menu {
        // devd refuses an agent or account switch on a chat session (409), as the F9 menu knows. A runtime this app
        // does not know is treated the same: devd may refuse it too.
        let switches = runtime == .tmux
        let current = AgentProfiles.normalize(AgentName(rawValue: agent))
        let agents = switches ? AgentProfiles.ids.map {
            Choice(id: $0.rawValue, label: AgentProfiles.profile(for: $0).label, current: $0 == current)
        } : []
        return Menu(canRename: facts != nil, agents: agents,
                    account: switches ? accountMenu(agent: agent, accountId: facts?.accountId, claude: claude, codex: codex) : nil)
    }

    /// Only native Claude Code (the Anthropic pool) and Codex switch accounts (F9: `specFor(agent).anthropicAccount`
    /// or codex); the proxy profiles and the ACP agents have no account pool. An agent this app does not know gets none.
    private static func accountMenu(agent: String, accountId: String?, claude: Accounts, codex: Accounts) -> AccountMenu? {
        let pool: Pool
        switch agent {
        case AgentName.claude.rawValue: pool = .claude
        case AgentName.codex.rawValue: pool = .codex
        default: return nil
        }
        var accounts: [Choice] = []
        var note: String?
        switch pool == .claude ? claude : codex {
        case .loading: note = "Loading accounts…"
        case .failed(let why): note = "Couldn't load accounts: \(why)"
        case .unavailable(let why): note = why
        case .loaded(let list):
            // The Anthropic account a session runs on is its lease in the live list; the Codex list is the session's
            // own and comes marked (codexChoices).
            accounts = pool == .claude ? list.map { Choice(id: $0.id, label: $0.label, current: $0.id == accountId) } : list
            if list.isEmpty { note = "No usable account" }
        }
        return AccountMenu(pool: pool, title: pool == .claude ? "Change Account (Claude Code)" : "Change Account (Codex)",
                           automatic: pool == .claude, accounts: accounts, note: note)
    }

    /// devd/src/agents.ts `conversationCarries`: only a swap within Claude Code keeps the conversation.
    static func conversationCarries(from: AgentName, to: AgentName) -> Bool {
        let a = ChatSwitch.profile(from.rawValue).runtime, b = ChatSwitch.profile(to.rawValue).runtime
        return a == b && b == "claude"
    }

    /// The accounts F9 lets you pick: not disabled or quarantined (cli main.ts `pickAndSwitchAccount`).
    static func claudeChoices(_ accounts: [AccountView]) -> [Choice] {
        accounts.filter { !$0.disabled && !$0.quarantined }.map { Choice(id: $0.id, label: $0.label, current: false) }
    }

    /// The Codex accounts this session can switch to, by cli/src/main.ts `pickAndSwitchAccount`: only those available
    /// in the session, the current one marked; while a switch is unfinished, only finishing it on its account.
    static func codexChoices(_ view: CodexSessionAccounts) -> Accounts {
        let pendingTargets = view.panes.compactMap(\.pending?.accountId).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        if pendingTargets.count > 1 {
            return .unavailable("This session has unfinished switches to different Codex accounts. Resolve the pending conversations before selecting another account.")
        }
        if view.panes.isEmpty { return .unavailable("No running Codex pane found — start Codex in Terminal first.") }
        let finishing = pendingTargets.first
        let available = view.accounts.filter { !$0.disabled && $0.available && (finishing == nil || $0.id == finishing) }
        if available.isEmpty { return .unavailable("No selectable Codex account is available in this session.") }
        return .loaded(available.map {
            finishing != nil ? Choice(id: $0.id, label: "\($0.label) (finish switching)", current: false, finishing: true)
                : Choice(id: $0.id, label: $0.label, current: $0.id == view.currentAccountId)
        })
    }
}

/// The row actions' state for one sidebar: the loaded account lists, the open sheet, and the work it runs. Every action
/// ends in a sheet that says its result or its error.
@MainActor
final class MacSessionActions: ObservableObject {
    enum Tone: Equatable {
        case success, warning, failure
    }

    struct Outcome: Equatable {
        let text: String
        let tone: Tone
    }

    enum Phase {
        case confirm
        case running(String)
        case done(Outcome)
    }

    /// An agent or account switch, or End: always asked first, then run, then its outcome.
    struct Job: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        let confirmLabel: String
        let destructive: Bool
        let progress: String
        var phase: Phase = .confirm
        let work: (_ progress: @escaping @MainActor (String) -> Void) async throws -> Outcome
    }

    struct Rename: Identifiable {
        let sessionId: String
        let name: String
        var id: String { sessionId }
    }

    enum Sheet: Identifiable {
        case rename(Rename)
        case job(Job)
        var id: String {
            switch self {
            case .rename(let r): return "rename-\(r.sessionId)"
            case .job(let t): return t.id.uuidString
            }
        }
    }

    @Published var sheet: Sheet?
    @Published private(set) var claude: MacSessionMenu.Accounts = .loading
    /// Each Codex session's own account list (`GET /api/sessions/:id/codex-account`); a session not loaded yet is
    /// loading.
    @Published private(set) var codex: [String: MacSessionMenu.Accounts] = [:]
    private(set) var actions: SessionActions?
    private weak var live: LiveStore?
    /// The confirmed job's work, cancelled when its sheet goes away (devd carries on with it).
    private var running: Task<Void, Never>?
    /// How often a Codex switch that went on in the background is asked about (the dashboard asks every 3 s), and how
    /// long it is followed before the sheet says its outcome is unknown.
    var codexPollInterval: Duration = .seconds(3)
    var codexMaxWait: Duration = .seconds(20 * 60)

    func attach(client: DevdClient?, live: LiveStore?) {
        self.live = live
        actions = client.map { SessionActions(client: $0) }
    }

    /// The Anthropic pool, shared by every Claude Code session.
    func loadClaudeAccounts() async {
        guard let actions else { return }
        do { claude = .loaded(MacSessionMenu.claudeChoices(try await actions.accounts().accounts)) }
        catch { claude = .failed(errorText(error)) }
    }

    func loadCodexAccounts(_ sessionId: String) async {
        guard let actions else { return }
        do { codex[sessionId] = MacSessionMenu.codexChoices(try await actions.codexAccounts(sessionId)) }
        catch {
            // A load cancelled with its task (the host's task id changed) leaves the entry unset, so the next run loads it.
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            codex[sessionId] = .failed(errorText(error))
        }
    }

    // MARK: - Requests from the menu

    func requestRename(_ item: InboxItem, name: String?) {
        sheet = .rename(Rename(sessionId: item.sessionId, name: name ?? ""))
    }

    /// The server sanitizes the name; an empty one clears it. Throws for the sheet to show. The live list refreshes
    /// after the sheet has closed (the row itself updates over the inbox stream).
    func rename(_ sessionId: String, to name: String) async throws {
        guard let actions else { throw DevdClientError(description: "Not connected to devd") }
        try await actions.setName(sessionId, name.trimmingCharacters(in: .whitespacesAndNewlines))
        Task { [live] in await live?.refreshNow() }
    }

    func requestAgent(_ item: InboxItem, to target: AgentName) {
        let from = AgentProfiles.normalize(AgentName(rawValue: item.agent))
        let label = AgentProfiles.profile(for: target).label
        let carries = MacSessionMenu.conversationCarries(from: from, to: target)
        open(Job(title: "Switch \(item.title) to \(label)?",
                  message: carries
                    ? "Every agent pane restarts on \(label) and resumes its conversation; a turn in progress is lost."
                    : "The conversation will NOT carry over (different CLI) — only the workspace stays. A turn in progress is lost.",
                  confirmLabel: "Switch Agent", destructive: !carries, progress: "Switching to \(label)…") { [weak self] _ in
            guard let actions = self?.actions else { throw DevdClientError(description: "Not connected to devd") }
            return Self.agentOutcome(try await actions.switchAgent(item.sessionId, target), label: label)
        })
    }

    /// `account` nil = Automatic.
    func requestClaudeAccount(_ item: InboxItem, account: MacSessionMenu.Choice?) {
        let resumeNote = "Each Claude pane restarts and resumes its exact current conversation. Unfinished turns may be interrupted; if the conversation cannot be resumed, switching stops without starting a new one."
        open(Job(title: account.map { "Switch Claude Code to \($0.label)?" } ?? "Automatically choose a fresher Anthropic account for Claude Code?",
                  message: resumeNote, confirmLabel: "Switch Account", destructive: false,
                  progress: account.map { "Switching Claude Code to \($0.label)…" } ?? "Switching Claude Code account automatically…") { [weak self] _ in
            guard let actions = self?.actions else { throw DevdClientError(description: "Not connected to devd") }
            return Self.claudeAccountOutcome(try await actions.switchAccount(item.sessionId, accountId: account?.id), picked: account != nil)
        })
    }

    func requestCodexAccount(_ item: InboxItem, account: MacSessionMenu.Choice) {
        let verb = account.finishing ? "Finish switching" : "Switch"
        open(Job(title: "\(verb) Codex to \(account.label)?",
                  message: "Each Codex pane resumes its exact current conversation on this account. Unfinished turns may be interrupted; if the conversation cannot be resumed, switching stops without starting a new one.",
                  confirmLabel: account.finishing ? "Finish Switching" : "Switch Account", destructive: false,
                  progress: "Switching Codex to \(account.label)…") { [weak self] progress in
            guard let self, let actions = self.actions else { throw DevdClientError(description: "Not connected to devd") }
            defer { Task { await self.loadCodexAccounts(item.sessionId) } }
            return try await Self.codexSwitch(actions: actions, sessionId: item.sessionId, account: account,
                                              pollEvery: self.codexPollInterval, maxWait: self.codexMaxWait, progress: progress)
        })
    }

    private func open(_ task: Job) {
        sheet = .job(task)
    }

    /// Starts the open job after its confirmation; its outcome replaces the question in the sheet. Awaiting the result
    /// is for tests; the sheet does not wait.
    @discardableResult
    func confirm() -> Task<Void, Never>? {
        guard case .job(var job) = sheet, case .confirm = job.phase else { return nil }
        job.phase = .running(job.progress)
        sheet = .job(job)
        let id = job.id
        let progress: @MainActor (String) -> Void = { [weak self] text in
            guard let self, case .job(var t) = self.sheet, t.id == id else { return }
            t.phase = .running(text)
            self.sheet = .job(t)
        }
        let task = Task { [weak self] in
            let outcome: Outcome
            do { outcome = try await job.work(progress) } catch {
                // Closing the sheet cancels only the waiting here: the request already reached devd.
                outcome = Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled
                    ? Self.unknownOutcome : Outcome(text: errorText(error), tone: .failure)
            }
            guard let self else { return }
            if case .job(var t) = self.sheet, t.id == id {
                t.phase = .done(outcome)
                self.sheet = .job(t)
            }
            if outcome.tone != .failure { await self.live?.refreshNow() }
        }
        running = task
        return task
    }

    /// The sheet went away (Close while running, or the window): stop waiting for the job. devd carries on with it.
    func cancelRunning() {
        running?.cancel()
        running = nil
    }

    static let unknownOutcome = Outcome(text: "Closed before devd answered: the action goes on in devd. Check the session for its result.",
                                        tone: .warning)

    // MARK: - Outcomes (the CLI's sentences)

    /// cli/src/manager-view.ts `agentSwitchSummary`.
    static func agentOutcome(_ r: SwitchAgentResponse, label: String) -> Outcome {
        if let problem = SessionActions.agentSwitchError(r, label: label) { return Outcome(text: problem, tone: r.ok ? .warning : .failure) }
        return r.status == .unchanged ? Outcome(text: "Already on \(label) — nothing to do.", tone: .success)
            : Outcome(text: "Switched to \(label).", tone: .success)
    }

    /// cli/src/main.ts `pickAndSwitchAccount`, the Anthropic branch.
    static func claudeAccountOutcome(_ r: SwitchAccountResponse, picked: Bool) -> Outcome {
        guard r.accountId != nil else { return Outcome(text: "No usable Anthropic account — check the dashboard (Login page).", tone: .failure) }
        let label = r.label ?? r.accountId!
        guard r.ok else {
            let detail = r.panes.map { "\($0.target) (\($0.outcome.rawValue))" }.joined(separator: ", ")
            return Outcome(text: "Account switch failed for \(label): \(detail.isEmpty ? "no Claude pane found" : detail).", tone: .failure)
        }
        if r.unchanged { return Outcome(text: "Already on \(label) — nothing to do.", tone: .success) }
        let stuck = r.panes.filter { $0.outcome != .restarted && $0.outcome != .alreadyOnAccount }
        if !stuck.isEmpty {
            return Outcome(text: "Only some Claude panes switched to \(label). Check these panes: \(stuck.map { "\($0.target) (\($0.outcome.rawValue))" }.joined(separator: ", ")).",
                           tone: .warning)
        }
        let done = "Switched Claude Code to \(label); the same conversations are resumed."
        return r.exhausted ? Outcome(text: "\(done) \(label) is over the usage threshold\(picked ? "" : " too").", tone: .warning)
            : Outcome(text: done, tone: .success)
    }

    /// A Codex switch, followed while devd runs it in the background (202), then said as the CLI says it. The switch
    /// goes on in devd whatever happens here, so lost polls or a switch that outlasts `maxWait` are reported as
    /// unknown, never as failed.
    static func codexSwitch(actions: SessionActions, sessionId: String, account: MacSessionMenu.Choice, pollEvery: Duration,
                            maxWait: Duration, progress: @escaping @MainActor (String) -> Void) async throws -> Outcome {
        let unknown = "The switch is still running on devd, or its result was lost: check the session's Codex account in the dashboard."
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: maxWait)
        var r = try await actions.switchCodexAccount(sessionId, accountId: account.id)
        var failures = 0
        while r.running == true {
            guard clock.now < deadline else { return Outcome(text: unknown, tone: .warning) }
            progress("Switching… Large conversations with many agents can take several minutes.")
            try await Task.sleep(for: pollEvery)
            let poll: CodexSessionAccounts
            do {
                poll = try await actions.codexAccounts(sessionId)
                failures = 0
            } catch {
                try Task.checkCancellation()
                failures += 1
                if failures >= 3 { return Outcome(text: "\(unknown) (\(errorText(error)))", tone: .warning) }
                continue
            }
            if poll.switching == true { continue }
            guard let last = poll.lastSwitch else {
                return Outcome(text: "devd finished the switch but no longer has its result: check the session's Codex account in the dashboard.", tone: .warning)
            }
            r = last
        }
        let failed = (r.panes ?? []).filter { $0.outcome != "restarted" && $0.outcome != "already-on-account" }
        let detail = failed.map { "\($0.target) (\($0.outcome))" }.joined(separator: ", ")
        guard r.ok == true else {
            return Outcome(text: "Codex account switch failed: \(r.error ?? "the account change could not be confirmed")\(detail.isEmpty ? "" : " — \(detail)").",
                           tone: .failure)
        }
        if !failed.isEmpty { return Outcome(text: "Codex account switch is incomplete. Check these panes: \(detail).", tone: .warning) }
        let label = r.label ?? account.label
        if r.unchanged == true { return Outcome(text: "Already on \(label) — nothing to do.", tone: .success) }
        return Outcome(text: "Switched Codex to \(label); the same conversations are resumed.", tone: .success)
    }
}

/// The F9 items of a sidebar row's context menu, under the row's own items.
struct MacSessionMenuItems: View {
    let item: InboxItem
    @ObservedObject var actions: MacSessionActions
    @EnvironmentObject private var live: LiveStore

    var body: some View {
        let session = live.live?.sessions.first { $0.id == item.sessionId }
        let menu = MacSessionMenu.menu(sessionId: item.sessionId, runtime: item.runtime, agent: item.agent,
                                       facts: session.map { .init(accountId: $0.accountId) },
                                       claude: actions.claude, codex: actions.codex[item.sessionId] ?? .loading)
        Divider()
        Button("Rename Session…") { actions.requestRename(item, name: session?.name) }
            .disabled(!menu.canRename)
        if !menu.agents.isEmpty {
            Menu("Change Agent") {
                ForEach(menu.agents, id: \.id) { agent in
                    Toggle(agent.label, isOn: Binding(get: { agent.current }, set: { _ in
                        if let target = AgentName(rawValue: agent.id) { actions.requestAgent(item, to: target) }
                    }))
                    .disabled(agent.current)
                }
            }
        }
        if let account = menu.account {
            Menu(account.title) {
                if account.automatic {
                    Button("Automatic") { actions.requestClaudeAccount(item, account: nil) }
                    Divider()
                }
                ForEach(account.accounts, id: \.id) { choice in
                    Toggle(choice.label, isOn: Binding(get: { choice.current }, set: { _ in
                        if account.pool == .claude { actions.requestClaudeAccount(item, account: choice) }
                        else { actions.requestCodexAccount(item, account: choice) }
                    }))
                    .disabled(choice.current)
                }
                if let note = account.note { Text(note) }
                Divider()
                Button("Refresh Accounts") {
                    Task {
                        if account.pool == .claude { await actions.loadClaudeAccounts() } else { await actions.loadCodexAccounts(item.sessionId) }
                    }
                }
            }
        }
        // No End here: settling ends a session (the owner's one action for it), from the row's ✓, ⌘⇧S or its menu.
    }
}

extension View {
    /// The sheets of the rows' F9 actions, and the account lists the menus offer.
    func macSessionActions(_ actions: MacSessionActions, inbox: InboxStore) -> some View {
        modifier(MacSessionActionsHost(actions: actions, inbox: inbox))
    }
}

private struct MacSessionActionsHost: ViewModifier {
    @ObservedObject var actions: MacSessionActions
    @ObservedObject var inbox: InboxStore
    @EnvironmentObject private var state: MacAppState
    @EnvironmentObject private var appModel: AppModel

    /// The terminal Codex sessions: each has its own account list (which accounts it can use, which it runs on).
    private var codexSessions: [String] {
        (inbox.items ?? []).filter { $0.runtime == .tmux && $0.agent == AgentName.codex.rawValue }.map(\.sessionId)
    }

    func body(content: Content) -> some View {
        content
            // Again when a Codex session appears: its list loads once, then after each switch and on Refresh Accounts.
            .task(id: "\(appModel.clientIdentity)|\(codexSessions)") {
                actions.attach(client: appModel.client, live: state.live)
                await actions.loadClaudeAccounts()
                for id in codexSessions where actions.codex[id] == nil { await actions.loadCodexAccounts(id) }
            }
            .sheet(item: $actions.sheet, onDismiss: actions.cancelRunning) { sheet in
                switch sheet {
                case .rename(let r): MacRenameSheet(rename: r, actions: actions)
                case .job: MacSessionTaskSheet(actions: actions)
                }
            }
            .onDisappear(perform: actions.cancelRunning)
    }
}

/// Rename: the current name in the field; empty clears it (the row then shows project/repo). Stays open with the
/// error when devd refuses.
struct MacRenameSheet: View {
    let rename: MacSessionActions.Rename
    let actions: MacSessionActions
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var busy = false
    @State private var error: String?

    init(rename: MacSessionActions.Rename, actions: MacSessionActions) {
        self.rename = rename
        self.actions = actions
        _name = State(initialValue: rename.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename Session").font(.headline)
            Text(rename.sessionId).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
            TextField("Name", text: $name, prompt: Text("No name (shows project/repo)"))
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
                .disabled(busy)
            if let error {
                Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
            }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Rename", action: save).keyboardShortcut(.defaultAction).disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 360)
    }

    private func save() {
        busy = true
        error = nil
        Task {
            do {
                try await actions.rename(rename.sessionId, to: name)
                dismiss()
            } catch {
                self.error = errorText(error)
            }
            busy = false
        }
    }
}

/// An agent or account switch, or End: the question with Cancel as the default, then progress, then the outcome.
/// Closing while it runs stops only the waiting (the host cancels it); devd carries on.
struct MacSessionTaskSheet: View {
    @ObservedObject var actions: MacSessionActions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if case .job(let task) = actions.sheet {
            VStack(alignment: .leading, spacing: 12) {
                Text(task.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                switch task.phase {
                case .confirm:
                    Text(task.message).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Spacer()
                        Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                        Button(task.confirmLabel, role: task.destructive ? .destructive : nil) { actions.confirm() }
                    }
                case .running(let text):
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(text).fixedSize(horizontal: false, vertical: true)
                    }
                    HStack {
                        Spacer()
                        Button("Close (continues on devd)") { dismiss() }.keyboardShortcut(.cancelAction)
                    }
                case .done(let outcome):
                    Label {
                        Text(outcome.text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    } icon: {
                        Image(systemName: Self.icon(outcome.tone)).foregroundStyle(Self.color(outcome.tone))
                    }
                    HStack {
                        Spacer()
                        Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                    }
                }
            }
            .padding(20)
            .frame(width: 400)
        }
    }

    private static func icon(_ tone: MacSessionActions.Tone) -> String {
        switch tone {
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .failure: return "xmark.octagon.fill"
        }
    }

    private static func color(_ tone: MacSessionActions.Tone) -> Color {
        switch tone {
        case .success: return InboxTone.doneIcon
        case .warning: return Theme.C.warnText
        case .failure: return Theme.C.dangerText
        }
    }
}
