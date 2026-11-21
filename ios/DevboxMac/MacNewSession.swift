import SwiftUI

/// The Mac New Session sheet's rules, apart from the view so they are tested on their own. Progress is devd's own:
/// `GET /api/open-progress`, polled while `POST /api/sessions` runs, exactly as the CLI's spinner does
/// (cli/src/main.ts, cli/src/format.ts `openProgressPercent`/`formatOpenProgress`). Nothing advances on a timer.
enum MacNewSession {
    enum Mode: Hashable {
        /// devd starts or rejoins the repo's existing session (`fresh` unset).
        case openExisting
        /// Another session beside the existing ones (`fresh: true`).
        case create
    }

    struct Action: Equatable {
        let label: String
        let fresh: Bool?
        /// Whether a session is made (for the progress title); Open Existing may only rejoin one.
        let creates: Bool
    }

    /// Without a session on the repo there is nothing to open: devd creates one either way.
    static func action(hasExisting: Bool, mode: Mode) -> Action {
        guard hasExisting else { return Action(label: "Create", fresh: nil, creates: true) }
        return mode == .create ? Action(label: "Create", fresh: true, creates: true)
            : Action(label: "Open Existing", fresh: nil, creates: false)
    }

    /// The stages devd reports (devd/src/sessions.ts `OpenProgress.step`), then Ready when its answer comes.
    enum Stage: Int, CaseIterable, Comparable {
        case repo, checkout, pull, container, ready
        static func < (a: Stage, b: Stage) -> Bool { a.rawValue < b.rawValue }
    }

    static func stage(for step: String) -> Stage? {
        switch step {
        case "clone", "fetch": return .repo
        case "worktree": return .checkout
        case "pull": return .pull
        case "container": return .container
        default: return nil
        }
    }

    private static let bands: [String: (Double, Double)] = ["fetch": (0, 5), "worktree": (5, 75), "pull": (75, 85), "container": (85, 100)]
    private static let clonePhases: [String: (Double, Double)] = [
        "Receiving objects": (2, 30), "Resolving deltas": (30, 40), "Checking out files": (40, 45), "Updating files": (40, 45),
    ]
    private static let containerSteps: [String: Int] = [
        "setting file ownership": 86, "waiting for the docker sidecar": 90, "starting the container": 96,
    ]

    /// Overall 0–100 for the whole open (cli/src/format.ts `openProgressPercent`).
    static func percent(_ p: OpenProgress) -> Int {
        if p.step == "clone" {
            let (lo, hi) = p.clone.flatMap { clonePhases[$0.phase] } ?? (0, 2)
            return Int((lo + (hi - lo) * (p.clone?.percent ?? 0) / 100).rounded())
        }
        if p.step == "container" { return containerSteps[p.detail ?? ""] ?? 85 }
        guard let (lo, hi) = bands[p.step] else { return 0 }
        return Int((lo + (hi - lo) * (p.git?.percent ?? 0) / 100).rounded())
    }

    private static let stepNames = ["clone": "Cloning", "fetch": "Fetching", "worktree": "Checking out", "pull": "Pulling",
                                    "container": "Starting container"]
    private static let containerLabels = ["setting file ownership": "file ownership", "waiting for the docker sidecar": "docker sidecar",
                                          "starting the container": "starting"]

    /// devd's step in words (cli/src/format.ts `formatOpenProgress` with the bar drawn apart). A step this app does
    /// not know shows by its raw name.
    static func status(_ p: OpenProgress) -> String {
        var parts = [stepNames[p.step] ?? p.step]
        if p.step == "clone", let clone = p.clone { parts += [clone.phase, clone.detail].compactMap { $0 } }
        if let detail = p.detail { parts.append(containerLabels[detail] ?? detail) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// What the sheet shows while devd works. The bar and the stage never move back (a first clone reports after its
    /// fetch, in an overlapping band); the text is always devd's latest.
    struct Tracker: Equatable {
        private(set) var percent = 0
        /// nil until devd reports a step (an open that has none to do, or an older devd).
        private(set) var stage: Stage?
        private(set) var status: String?
        /// The repo is being cloned (its first open), not fetched.
        private(set) var cloning = false

        mutating func apply(_ p: OpenProgress) {
            percent = max(percent, MacNewSession.percent(p))
            if let s = MacNewSession.stage(for: p.step) { stage = max(stage ?? s, s) }
            if p.step == "clone" { cloning = true }
            status = MacNewSession.status(p)
        }

        mutating func finish() {
            percent = 100
            stage = .ready
            status = nil
        }

        func title(_ s: Stage) -> String {
            switch s {
            case .repo: return cloning ? "Clone the repo" : "Fetch the repo"
            case .checkout: return "Check out the worktree"
            case .pull: return "Pull the latest changes"
            case .container: return "Start the container"
            case .ready: return "Ready"
            }
        }
    }

    enum Phase {
        case form
        case working(Tracker, creates: Bool)
        /// devd's message; the form stays editable. `retry`: false when devd may have got the request and still be
        /// creating the session (a second one could make another): both Retry and the primary button stay off.
        case failed(String, retry: Bool)
        /// devd answered with something to read first (a runtime notice, a pull conflict).
        case done(String, sessionId: String)
    }

    /// The request may have reached devd: a timeout, a dropped connection, or a gateway giving up on a slow answer
    /// (Cloudflare cuts at ~100 s while a first clone runs for minutes).
    static func outcomeUnknown(_ error: Error) -> Bool {
        if let h = error as? DevdHTTPError { return [502, 504, 524].contains(h.statusCode) }
        let last = (error as? DevdClientError)?.underlying.last ?? error
        guard let code = (last as? URLError)?.code else { return false }
        return code == .timedOut || code == .networkConnectionLost
    }
}

/// New Session on the Mac: a header, the Folder/Project/Repo/Agent form in aligned rows, and a footer with Cancel and
/// one default button (Return). Once started, the form gives way to devd's progress, stage by stage, and the session
/// opens when devd answers. The iPhone keeps its own sheet (NewSessionSheet); the cascade rules are shared
/// (NewSessionLogic).
struct MacNewSessionSheet: View {
    @EnvironmentObject private var live: LiveStore
    @Environment(\.dismiss) private var dismiss
    let actions: SessionActions
    let onStarted: () async -> Void
    /// Opens the session in this window; the sheet has closed first.
    let onOpen: (String) -> Void

    @State private var tree: [TreeProject]?
    @State private var treeError: String?
    @State private var folder = ""
    @State private var project = ""
    @State private var repo = ""
    @State private var agent: AgentName = .claude
    @State private var mode: MacNewSession.Mode = .openExisting
    @State private var phase: MacNewSession.Phase
    @State private var work: Task<Void, Never>?
    @State private var confirmClose = false

    /// `tree`, `selection` and `phase` preset the sheet for the screenshot test; the app passes none.
    init(actions: SessionActions, onStarted: @escaping () async -> Void, onOpen: @escaping (String) -> Void,
         tree: [TreeProject]? = nil, selection: (folder: String, project: String, repo: String, agent: AgentName)? = nil,
         phase: MacNewSession.Phase = .form) {
        self.actions = actions
        self.onStarted = onStarted
        self.onOpen = onOpen
        _tree = State(initialValue: tree)
        if let selection {
            _folder = State(initialValue: selection.folder)
            _project = State(initialValue: selection.project)
            _repo = State(initialValue: selection.repo)
            _agent = State(initialValue: selection.agent)
        }
        _phase = State(initialValue: phase)
    }

    private var repos: [NewSessionLogic.RepoChoice] {
        guard let tree, !folder.isEmpty, !project.isEmpty else { return [] }
        return NewSessionLogic.repoChoices(tree, folder: folder, project: project)
    }

    /// Solo has no repo of its own and devd takes no `fresh` for it, so it never offers Open Existing.
    private var existing: [SessionLive] {
        guard !repo.isEmpty, repo != NewSessionLogic.SOLO else { return [] }
        return NewSessionLogic.sessionsFor(live.live?.sessions ?? [], project: project, repo: repo)
    }

    private var action: MacNewSession.Action { MacNewSession.action(hasExisting: !existing.isEmpty, mode: mode) }

    private var working: Bool { workingCreates != nil }

    /// While devd works: whether the request makes a session, fixed when it started (the labels must not follow the
    /// form behind them).
    private var workingCreates: Bool? {
        if case .working(_, let creates) = phase { return creates }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            Group {
                switch phase {
                case .working(let tracker, let creates): progress(tracker, creates: creates)
                case .done(let message, let id): done(message, id: id)
                case .form, .failed: form
                }
            }
            .padding(20)
            Divider()
            footer
        }
        .frame(width: 500)
        .background(Theme.C.background)
        .task { await loadTree() }
        .onDisappear { work?.cancel() }
        .confirmationDialog("Stop waiting for this session?", isPresented: $confirmClose) {
            Button("Close") { work?.cancel(); dismiss() }
            Button("Keep Waiting", role: .cancel) {}
        } message: {
            Text("devd can't abort a session it has started. It finishes in the background and appears in the sidebar; end it from its row menu if you don't want it.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(workingCreates.map { $0 ? "Creating Session" : "Opening Session" } ?? "New Session").font(.title3.weight(.semibold))
            Text(working ? "\(project)/\(repo == NewSessionLogic.SOLO ? "scratch workspace" : repo) · \(AgentProfiles.profile(for: agent).label)"
                 : "Pick a repo and an agent. devd clones the repo if needed and starts the session in its own container.")
                .font(.callout)
                .foregroundStyle(Theme.C.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    // MARK: - Form

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 10) {
                row("Folder") {
                    Picker("Folder", selection: $folder) {
                        if folder.isEmpty { Text("Choose…").tag("") }
                        ForEach(tree.map(NewSessionLogic.folderChoices) ?? [], id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(tree == nil)
                    .onChange(of: folder) { _, newFolder in
                        project = tree.flatMap { NewSessionLogic.soleProject($0, folder: newFolder) } ?? ""
                        repo = ""
                    }
                }
                row("Project") {
                    Picker("Project", selection: $project) {
                        if project.isEmpty { Text("Choose…").tag("") }
                        ForEach(tree.map { NewSessionLogic.projectChoices($0, folder: folder) } ?? [], id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(folder.isEmpty)
                    .onChange(of: project) { _, _ in repo = "" }
                }
                row("Repo") {
                    Picker("Repo", selection: $repo) {
                        if repo.isEmpty { Text("Choose…").tag("") }
                        ForEach(repos, id: \.value) { choice in
                            Text(choice.value == NewSessionLogic.SOLO ? "Scratch workspace (no repo)" : choice.label).tag(choice.value)
                        }
                    }
                    .disabled(project.isEmpty)
                    .onChange(of: repo) { _, newRepo in
                        agent = NewSessionLogic.defaultAgentFor(tree ?? [], folder: folder, project: project, repo: newRepo)
                        mode = .openExisting
                    }
                }
                row("Agent") {
                    Picker("Agent", selection: $agent) {
                        ForEach(AgentProfiles.ids, id: \.self) { id in
                            let profile = AgentProfiles.profile(for: id)
                            Text(profile.label + (profile.yolo ? " (yolo)" : "")).tag(id)
                        }
                    }
                    .disabled(repo.isEmpty)
                }
                if !existing.isEmpty {
                    row("Session") {
                        Picker("Session", selection: $mode) {
                            Text("Open the existing session").tag(MacNewSession.Mode.openExisting)
                            Text("Create another session").tag(MacNewSession.Mode.create)
                        }
                        .pickerStyle(.radioGroup)
                    }
                }
            }
            if let note = modeNote {
                Text(note).font(.callout).foregroundStyle(Theme.C.mutedForeground).fixedSize(horizontal: false, vertical: true)
            }
            if let message = treeError ?? failure {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.C.dangerText)
                    Text(message).foregroundStyle(Theme.C.dangerText).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if treeError != nil {
                        Button("Retry") { treeError = nil; Task { await loadTree() } }
                    } else if case .failed(_, true) = phase {
                        Button("Retry") { start() }.disabled(repo.isEmpty)
                    }
                }
                .font(.callout)
            }
        }
    }

    private func row(_ label: String, @ViewBuilder _ control: () -> some View) -> some View {
        GridRow {
            Text("\(label):").gridColumnAlignment(.trailing).foregroundStyle(Theme.C.foreground)
            control().labelsHidden().frame(maxWidth: 300, alignment: .leading)
        }
    }

    private var isUnsure: Bool {
        if case .failed(_, false) = phase { return true }
        return false
    }

    private var failure: String? {
        if case .failed(let message, _) = phase { return message }
        return nil
    }

    private var modeNote: String? {
        guard !existing.isEmpty else { return nil }
        let count = existing.count == 1 ? "This repo has a session (\(existing[0].id))." : "This repo has \(existing.count) sessions."
        if mode == .openExisting { return "\(count) Open Existing starts or rejoins it as it is; it keeps its own agent." }
        // A repo in the old layout (shared working directory) gives another session its own container only.
        if let choice = repos.first(where: { $0.value == repo }), choice.cloned, choice.bare != true {
            return "\(count) Another session shares this repo's working directory and branch (own container, same files)."
        }
        return "\(count) Create starts another one beside it, with its own worktree and branch."
    }

    // MARK: - Progress

    private func progress(_ t: MacNewSession.Tracker, creates: Bool) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if t.stage == nil {
                ProgressView().progressViewStyle(.linear)
            } else {
                ProgressView(value: Double(t.percent), total: 100)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(t.status ?? (t.stage == .ready ? "Opening the session…" : "Waiting for devd…"))
                Spacer()
                if t.stage != nil { Text("\(t.percent)%") }
            }
            .font(.callout.monospacedDigit())
            .foregroundStyle(Theme.C.mutedForeground)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(MacNewSession.Stage.allCases, id: \.self) { s in
                    let state: Int = t.stage.map { s < $0 ? 0 : s == $0 ? 1 : 2 } ?? 2
                    HStack(spacing: 8) {
                        Group {
                            if state == 0 || (state == 1 && s == .ready) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(InboxTone.doneIcon)
                            } else if state == 1 {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "circle").foregroundStyle(Theme.C.mutedForeground.opacity(0.6))
                            }
                        }
                        .frame(width: 18)
                        Text(t.title(s)).foregroundStyle(state == 2 ? Theme.C.mutedForeground : Theme.C.foreground)
                    }
                }
            }
            Text(creates ? "devd skips the steps a session does not need." : "A session that is already running skips straight to Ready.")
                .font(.caption)
                .foregroundStyle(Theme.C.mutedForeground)
        }
    }

    private func done(_ message: String, id: String) -> some View {
        Label {
            Text(message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(InboxTone.doneIcon)
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Spacer()
            switch phase {
            case .working(_, let creates):
                Button("Cancel") { confirmClose = true }.keyboardShortcut(.cancelAction)
                Button(creates ? "Creating…" : "Opening…") {}.disabled(true)
            case .done(_, let id):
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Open Session") { open(id) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            case .form, .failed:
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(action.label, action: start)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(folder.isEmpty || project.isEmpty || repo.isEmpty || isUnsure)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    // MARK: - Work

    private func loadTree() async {
        guard tree == nil else { return }
        do { tree = try await actions.tree() } catch { treeError = "Can't load the repos: \(errorText(error))" }
    }

    private func open(_ id: String) {
        dismiss()
        onOpen(id)
    }

    private func start() {
        guard !folder.isEmpty, !project.isEmpty, !repo.isEmpty, !working else { return }
        let f = folder, p = project, r = repo, a = agent, act = action
        let choice = repos.first { $0.value == r }
        phase = .working(MacNewSession.Tracker(), creates: act.creates)
        work = Task {
            // devd reports the repo's open while the request runs; solo clones nothing and has no progress key.
            let poll = r == NewSessionLogic.SOLO ? nil : Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(500))
                    guard !Task.isCancelled, case .working(var t, let creates) = phase else { return }
                    // A failed poll leaves the last stage showing; the request's own answer still decides.
                    guard let report = try? await actions.openProgress(folder: f, project: p, repo: r) else { continue }
                    guard !Task.isCancelled, case .working = phase else { return }
                    t.apply(report)
                    phase = .working(t, creates: creates)
                }
            }
            defer { poll?.cancel() }
            do {
                let result = r == NewSessionLogic.SOLO
                    ? try await actions.openSolo(folder: f, project: p, agent: a)
                    // The first clone of a large repo runs for minutes before devd answers.
                    : try await actions.openSession(folder: f, project: p, repo: r, cloneUrl: choice?.cloneUrl, agent: a,
                                                    fresh: act.fresh, timeout: 900)
                poll?.cancel()
                if case .working(var t, let creates) = phase {
                    t.finish()
                    phase = .working(t, creates: creates)
                }
                await onStarted()
                // Closed meanwhile: the session is in the sidebar; the window stays where the user left it.
                guard !Task.isCancelled else { return }
                // Something to read first (a runtime notice, a pull conflict) waits for Open Session; otherwise the session
                // opens right away.
                if result.runtimeNotice == nil, result.pull?.status != "conflict" { open(result.session.id); return }
                switch NewSessionLogic.afterOpen(result) {
                case .openChat(let id): open(id)
                case .show(let text, let chatId): phase = .done(text, sessionId: chatId ?? result.session.id)
                }
            } catch {
                guard !Task.isCancelled else { return }
                if MacNewSession.outcomeUnknown(error) {
                    phase = .failed("devd did not answer (\(errorText(error))). It may still be creating the session: it appears in the sidebar when ready. Check there before trying again.",
                                    retry: false)
                } else {
                    phase = .failed(errorText(error), retry: true)
                }
            }
        }
    }
}
