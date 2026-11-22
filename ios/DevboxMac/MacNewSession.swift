import SwiftUI

/// The Mac New Session sheet's rules, apart from the view so they are tested on their own. Progress is devd's own:
/// `GET /api/open-progress`, polled while `POST /api/sessions` runs, exactly as the CLI's spinner does
/// (cli/src/main.ts, cli/src/format.ts `openProgressPercent`/`formatOpenProgress`). Nothing advances on a timer.
enum MacNewSession {
    /// The sheet's pages, one choice each. Project is skipped when the folder has one (a flat folder is one project
    /// named after it): `NewSessionLogic.soleProject`, the rule the web and the iPhone use to fill it in.
    enum Page: Int, Comparable {
        case folder, project, repo, agent
        static func < (a: Page, b: Page) -> Bool { a.rawValue < b.rawValue }
    }

    /// What has been picked so far and the page showing. Back keeps the picks, so the page shows its row highlighted
    /// again; another folder or project forgets what was picked under the old one.
    struct Picks: Equatable {
        private(set) var page: Page = .folder
        private(set) var folder = ""
        private(set) var project = ""
        private(set) var repo = ""
        var agent: AgentName = .claude

        init() {}

        /// A sheet already on `page` (the screenshot test).
        init(folder: String, project: String, repo: String = "", agent: AgentName = .claude, page: Page) {
            (self.folder, self.project, self.repo, self.agent, self.page) = (folder, project, repo, agent, page)
        }

        /// Picks `value` on a Folder, Project or Repo page and goes on to the next page. The agent is picked in place.
        mutating func pick(_ value: String, tree: [TreeProject]) {
            switch page {
            case .folder:
                if value != folder { (project, repo) = ("", "") }
                folder = value
                if let sole = NewSessionLogic.soleProject(tree, folder: value) {
                    project = sole
                    page = .repo
                } else {
                    page = .project
                }
            case .project:
                if value != project { repo = "" }
                project = value
                page = .repo
            case .repo:
                if value != repo { agent = NewSessionLogic.defaultAgentFor(tree, folder: folder, project: project, repo: value) }
                repo = value
                page = .agent
            case .agent:
                return
            }
        }

        /// One page back, skipping a Project page the folder did not need. false on the first page.
        mutating func back(tree: [TreeProject]) -> Bool {
            switch page {
            case .folder: return false
            case .project: page = .folder
            case .repo: page = NewSessionLogic.soleProject(tree, folder: folder) == nil ? .project : .folder
            case .agent: page = .repo
            }
            return true
        }

        /// The value picked on `p`, highlighted when the page shows again.
        func value(on p: Page) -> String {
            switch p {
            case .folder: return folder
            case .project: return project
            case .repo: return repo
            case .agent: return agent.rawValue
            }
        }
    }

    /// One row of a page: the value it picks, its name, and a line of context.
    struct Choice: Equatable, Identifiable {
        let value: String
        let title: String
        let detail: String?
        var id: String { value }
    }

    private static func count(_ n: Int, _ noun: String) -> String { n == 0 ? "No \(noun)s" : n == 1 ? "1 \(noun)" : "\(n) \(noun)s" }

    static func choices<T: RepoKeyed>(_ p: Picks, tree: [TreeProject], sessions: [T]) -> [Choice] {
        func repoCount(_ folder: String, _ project: String) -> Int {
            tree.first { $0.folder == folder && $0.project == project }?.repos.count ?? 0
        }
        switch p.page {
        case .folder:
            return NewSessionLogic.folderChoices(tree).map { f in
                let detail = NewSessionLogic.soleProject(tree, folder: f).map { count(repoCount(f, $0), "repo") }
                    ?? count(NewSessionLogic.projectChoices(tree, folder: f).count, "project")
                return Choice(value: f, title: f, detail: detail)
            }
        case .project:
            return NewSessionLogic.projectChoices(tree, folder: p.folder).map {
                Choice(value: $0, title: $0, detail: count(repoCount(p.folder, $0), "repo"))
            }
        case .repo:
            return NewSessionLogic.repoChoices(tree, folder: p.folder, project: p.project).map { r in
                guard r.value != NewSessionLogic.SOLO else {
                    return Choice(value: r.value, title: "Scratch workspace", detail: "No repo, an empty workspace")
                }
                let n = NewSessionLogic.sessionsFor(sessions, project: p.project, repo: r.value).count
                var parts = [r.cloned ? "Cloned" : "Not cloned yet: devd clones it first"]
                if n > 0 { parts.append(count(n, "session")) }
                // The old layout (one working directory, no bare clone) gives another session its own container only.
                if n > 0, r.cloned, r.bare != true { parts.append("shares its working directory") }
                return Choice(value: r.value, title: r.value, detail: parts.joined(separator: " · "))
            }
        case .agent:
            // Only an agent the tree remembers is "last used"; without one Claude is preselected as the default.
            let proj = tree.first { $0.folder == p.folder && $0.project == p.project }
            let remembered = p.repo == NewSessionLogic.SOLO ? proj?.soloAgent : proj?.repos.first { $0.name == p.repo }?.agent
            return AgentProfiles.ids.map { id in
                Choice(value: id.rawValue, title: AgentProfiles.profile(for: id).label,
                       detail: id == remembered ? "Last used here" : nil)
            }
        }
    }

    /// Lists this long take typed text as a filter.
    static func filters(_ choices: [Choice]) -> Bool { choices.count >= 8 }

    /// The highlighted row and the typed filter of the page showing.
    struct Cursor: Equatable {
        var filter = ""
        var highlight: String?

        func visible(_ choices: [Choice]) -> [Choice] {
            filter.isEmpty ? choices : choices.filter { $0.title.localizedCaseInsensitiveContains(filter) }
        }

        /// The highlighted row if it is showing, else the first that is.
        func current(_ choices: [Choice]) -> Choice? {
            let v = visible(choices)
            return v.first { $0.value == highlight } ?? v.first
        }

        mutating func move(_ by: Int, in choices: [Choice]) {
            let v = visible(choices)
            guard !v.isEmpty else { return }
            let i = v.firstIndex { $0.value == current(choices)?.value } ?? 0
            highlight = v[min(max(i + by, 0), v.count - 1)].value
        }
    }

    /// What Create sends.
    struct Request: Equatable {
        let folder: String
        let project: String
        let repo: String
        let cloneUrl: String?
        let agent: AgentName
    }

    /// nil until the Agent page.
    static func request(_ p: Picks, tree: [TreeProject]) -> Request? {
        guard p.page == .agent, !p.folder.isEmpty, !p.project.isEmpty, !p.repo.isEmpty else { return nil }
        let cloneUrl = NewSessionLogic.repoChoices(tree, folder: p.folder, project: p.project).first { $0.value == p.repo }?.cloneUrl
        return Request(folder: p.folder, project: p.project, repo: p.repo, cloneUrl: cloneUrl, agent: p.agent)
    }

    /// New Session always makes a new session: `fresh: true`, as devd otherwise rejoins the repo's existing one. A
    /// scratch workspace takes no `fresh` (devd does not know it for solo).
    static func create(_ r: Request, actions: SessionActions, requestId: String) async throws -> OpenResult {
        guard r.repo != NewSessionLogic.SOLO else { return try await actions.openSolo(folder: r.folder, project: r.project, agent: r.agent) }
        // The first clone of a large repo runs for minutes before devd answers.
        return try await actions.openSession(folder: r.folder, project: r.project, repo: r.repo, cloneUrl: r.cloneUrl, agent: r.agent,
                                             fresh: true, requestId: requestId, timeout: 900)
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

    /// What the sheet shows while devd works. The bar and the stage never move back: a repo's first open clones (up to
    /// 45 %) and then checks out, whose band starts at 5 %. The text is always devd's latest.
    struct Tracker: Equatable {
        private(set) var percent = 0
        /// nil until devd reports a step (an open that has none to do, or an older devd).
        private(set) var stage: Stage?
        private(set) var status: String?
        /// The repo is being cloned (its first open), not fetched.
        private(set) var cloning = false
        /// devd has echoed this open's `requestId`, so it is new enough to send one.
        private(set) var seenOwn = false
        /// devd's own times of the steps it entered (its monotonic clock), from the newest report, then from its answer.
        private(set) var phases: [OpenProgress.Phase] = []
        /// devd's clock at the newest report, and this Mac's uptime when it arrived: the running step counts on from
        /// there. No step is ever timed by when a poll noticed it.
        private var devdNow: Double?
        private var receivedAt: TimeInterval = 0
        private var finished = false

        /// Takes a progress report of the repo. One with another open's `requestId` (the CLI or another window opening the
        /// same repo) moves nothing. A report without one comes from a devd before `requestId` (then every report counts,
        /// as before) or from a client that sent none: once our own id has shown up, it is someone else's.
        mutating func observe(_ p: OpenProgress, requestId: String, at uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
            let own = p.requestId.map { $0 == requestId } ?? !seenOwn
            guard own else {
                status = "Waiting for devd (another open of this repo is running)…"
                return
            }
            if p.requestId != nil { seenOwn = true }
            apply(p, at: uptime)
        }

        mutating func apply(_ p: OpenProgress, at uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
            if let ps = p.phases {
                // The running count never goes back: a report that arrives late (devd's clock read before the last
                // estimate) keeps the estimate already shown.
                let shown = live(uptime)
                phases = ps
                devdNow = p.now.map { max($0, shown ?? $0) }
                receivedAt = uptime
            }
            percent = max(percent, MacNewSession.percent(p))
            if let s = MacNewSession.stage(for: p.step) { stage = max(stage ?? s, s) }
            if p.step == "clone" { cloning = true }
            status = MacNewSession.status(p)
        }

        /// `phases`: devd's answer, every step ended. Without them (an older devd, a rejoined session) a step still
        /// open in the last report shows no time rather than one this Mac made up.
        mutating func finish(phases final: [OpenProgress.Phase]? = nil) {
            if let final, !final.isEmpty { phases = final }
            finished = true
            percent = 100
            stage = .ready
            status = nil
        }

        struct Time: Equatable {
            let seconds: Double
            let running: Bool
            var text: String { MacNewSession.duration(seconds) + (running ? "…" : "") }
        }

        /// How long devd spent on the stage, counting on while it runs; nil for a stage devd skipped or has not reached.
        func time(_ s: Stage, at uptime: TimeInterval) -> Time? {
            let mine = phases.filter { MacNewSession.stage(for: $0.step) == s }
            guard s != .ready, !mine.isEmpty else { return nil }
            var ms = 0.0, running = false
            for p in mine {
                if let end = p.endedAt {
                    ms += end - p.startedAt
                } else {
                    guard let live = live(uptime) else { return nil }
                    ms += max(0, live - p.startedAt)
                    running = true
                }
            }
            return Time(seconds: ms / 1000, running: running)
        }

        /// From devd's first step to its last step's end (or now, while it runs).
        func total(at uptime: TimeInterval) -> Time? {
            guard let first = phases.first, let last = phases.last else { return nil }
            if let end = last.endedAt { return Time(seconds: (end - first.startedAt) / 1000, running: false) }
            return live(uptime).map { Time(seconds: max(0, $0 - first.startedAt) / 1000, running: true) }
        }

        /// devd's clock now: its last reading plus this Mac's monotonic time since. nil once finished without devd's
        /// own end times, or before a report with a clock.
        private func live(_ uptime: TimeInterval) -> Double? {
            guard !finished, let devdNow else { return nil }
            return devdNow + max(0, uptime - receivedAt) * 1000
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

    /// A click this long after the page changed is its own, not the second click of a double click on the page before.
    static func settled(now: TimeInterval, pageChangedAt: TimeInterval, doubleClick: TimeInterval) -> Bool {
        now - pageChangedAt >= doubleClick
    }

    /// "0.4 s", "8.3 s" under ten seconds, then "12 s", "2 min 5 s". Rounded down, so a running count never runs ahead.
    static func duration(_ seconds: Double) -> String {
        let s = max(0, seconds)
        if s < 10 { return String(format: "%.1f s", (s * 10).rounded(.down) / 10) }
        let whole = Int(s.rounded(.down))
        return whole < 60 ? "\(whole) s" : "\(whole / 60) min \(whole % 60) s"
    }

    enum Phase {
        case form
        case working(Tracker)
        /// devd's message, on the Agent page. `retry`: false when devd may have got the request and still be creating
        /// the session (a second one could make another): Create stays off until another folder, project or repo is
        /// picked.
        case failed(String, retry: Bool)
        /// devd answered with something to read first (a runtime notice, a pull conflict).
        case done(String, sessionId: String)
        /// Created with nothing to read: the finished steps and their total stay for `holdSeconds`, then the session
        /// opens; any key or click opens it at once.
        case created(Tracker, sessionId: String)
    }

    /// How long the finished page stays before the session opens.
    static let holdSeconds = 1.5

    enum Finish: Equatable {
        /// Nothing to read: hold the finished page, then open.
        case hold(sessionId: String)
        case then(NewSessionLogic.AfterOpen)
    }

    /// What a successful create does next: something to read first (a runtime notice, a pull conflict) waits for Open
    /// Session; otherwise the finished page holds, then the session opens.
    static func finish(_ r: OpenResult) -> Finish {
        if r.runtimeNotice == nil, r.pull?.status != "conflict" { return .hold(sessionId: r.session.id) }
        return .then(NewSessionLogic.afterOpen(r))
    }

    /// What VoiceOver says when the session is created: the total, when devd timed the steps.
    static func createdAnnouncement(_ t: Tracker) -> String {
        t.total(at: ProcessInfo.processInfo.systemUptime).map { "Created in \($0.text)" } ?? "Created"
    }

    /// The request may have reached devd: a timeout, a dropped connection, or a gateway giving up on a slow answer
    /// (Cloudflare cuts at ~100 s while a first clone runs for minutes).
    /// When both paths failed, the last one (the fallback) decides: it is the attempt that may have reached devd.
    static func outcomeUnknown(_ error: Error) -> Bool {
        let last = (error as? DevdClientError)?.underlying.last ?? error
        if let h = last as? DevdHTTPError { return [502, 504, 520, 524].contains(h.statusCode) }
        guard let code = (last as? URLError)?.code else { return false }
        return code == .timedOut || code == .networkConnectionLost
    }
}


/// New Session on the Mac as pages, one choice each: Folder, Project (only when the folder has several), Repo, Agent;
/// then devd's progress, stage by stage, in the same sheet, and the session opens when devd answers. A click or Return
/// on a row picks it and goes on; on the Agent page a click picks the agent and Create (Return, or a double click)
/// starts. Arrows move the highlight, a long list filters as you type, Esc goes back (Cancel on the first page).
/// The iPhone keeps its own sheet (NewSessionSheet); the cascade rules are shared (NewSessionLogic).
struct MacNewSessionSheet: View {
    @EnvironmentObject private var live: LiveStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let actions: SessionActions
    let onStarted: () async -> Void
    /// Opens the session in this window; the sheet has closed first.
    let onOpen: (String) -> Void
    /// Sees every change of the picks (the key test); the app passes none.
    let onPicks: ((MacNewSession.Picks) -> Void)?
    /// How long the finished page holds; a test of a key or click sets it long, so only that can open the session.
    let holdSeconds: TimeInterval

    @State private var tree: [TreeProject]?
    @State private var treeError: String?
    @State private var picks: MacNewSession.Picks
    @State private var cursor: MacNewSession.Cursor
    /// The last page change went forward: the side the next page slides in from.
    @State private var forward = true
    /// This Mac's uptime at the last page change (see `settled`).
    @State private var pageChangedAt: TimeInterval = 0
    @State private var phase: MacNewSession.Phase
    @State private var work: Task<Void, Never>?
    @State private var confirmClose = false
    @State private var opened = false
    @FocusState private var listFocused: Bool

    /// `tree`, `picks` and `phase` preset the sheet for the screenshot test; the app passes none.
    init(actions: SessionActions, onStarted: @escaping () async -> Void, onOpen: @escaping (String) -> Void,
         tree: [TreeProject]? = nil, picks: MacNewSession.Picks = .init(), phase: MacNewSession.Phase = .form,
         onPicks: ((MacNewSession.Picks) -> Void)? = nil, holdSeconds: TimeInterval = MacNewSession.holdSeconds) {
        self.actions = actions
        self.holdSeconds = holdSeconds
        self.onStarted = onStarted
        self.onOpen = onOpen
        self.onPicks = onPicks
        _tree = State(initialValue: tree)
        _picks = State(initialValue: picks)
        _cursor = State(initialValue: .init(highlight: picks.value(on: picks.page)))
        _phase = State(initialValue: phase)
    }

    private var choices: [MacNewSession.Choice] {
        tree.map { MacNewSession.choices(picks, tree: $0, sessions: live.live?.sessions ?? []) } ?? []
    }

    private var working: Bool {
        if case .working = phase { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            switch phase {
            case .working(let tracker): progress(tracker).padding(20)
            case .created(let tracker, let id): progress(tracker).padding(20).modifier(OpensOnAnyInput { open(id) })
            case .done(let message, let id): done(message, id: id).padding(20)
            case .form, .failed: pages
            }
            Divider()
            footer
        }
        .frame(width: 500)
        .background(Theme.C.background)
        .task { await loadTree() }
        .onDisappear { work?.cancel() }
        .onChange(of: picks) { old, new in
            if old.page != new.page {
                cursor = .init(highlight: new.value(on: new.page))
                announce(prompt)
            }
            onPicks?(new)
        }
        .task(id: heldSession) {
            guard let held = heldSession, case .created(let t, _) = phase else { return }
            announce(MacNewSession.createdAnnouncement(t))
            try? await Task.sleep(for: .seconds(holdSeconds))
            guard !Task.isCancelled else { return }
            open(held)
        }
        .onChange(of: stage) { _, new in
            if let new, case .working(let t) = phase { announce(t.title(new)) }
        }
        .confirmationDialog("Stop waiting for this session?", isPresented: $confirmClose) {
            Button("Close") { work?.cancel(); dismiss() }
            Button("Keep Waiting", role: .cancel) {}
        } message: {
            Text("devd can't abort a session it has started. It finishes in the background and appears in the sidebar; end it from its row menu if you don't want it.")
        }
    }

    private var repoName: String { picks.repo == NewSessionLogic.SOLO ? "Scratch workspace" : picks.repo }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(heldSession != nil ? "Session Created" : working ? "Creating Session" : "New Session").font(.title3.weight(.semibold))
            Group {
                switch phase {
                case .working, .created, .done:
                    Text("\(picks.project)/\(repoName) · \(AgentProfiles.profile(for: picks.agent).label)")
                case .form, .failed:
                    Text(breadcrumb ?? "Pick a folder, a repo and an agent. devd clones the repo if needed and starts a new session in its own container.")
                }
            }
            .font(.callout)
            .foregroundStyle(Theme.C.mutedForeground)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    /// What the earlier pages picked; a flat folder's project is the folder itself, so it shows once.
    private var breadcrumb: String? {
        var parts: [String] = []
        if picks.page > .folder { parts.append(picks.folder) }
        if picks.page > .project, picks.project != picks.folder { parts.append(picks.project) }
        if picks.page > .repo { parts.append(repoName) }
        return parts.isEmpty ? nil : parts.joined(separator: "  ›  ")
    }

    // MARK: - Pages

    private var prompt: String {
        switch picks.page {
        case .folder: return "Choose a folder"
        case .project: return "Choose a project"
        case .repo: return "Choose a repo"
        case .agent: return "Choose an agent"
        }
    }

    private var transition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
                           removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity))
    }

    /// One page at a time, sliding in the way it was reached. Keys go to this stable container, not to a page that is
    /// sliding out.
    private var pages: some View {
        ZStack(alignment: .topLeading) {
            page.id(picks.page).transition(transition)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: 380)
        .clipped()
        .focusable()
        .focusEffectDisabled()
        .focused($listFocused)
        .onKeyPress(phases: .down, action: key)
        .onAppear { listFocused = true }
    }

    private var page: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(prompt).font(.headline)
            if let treeError {
                problem(treeError) { self.treeError = nil; Task { await loadTree() } }
            } else if tree == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading folders and repos…").foregroundStyle(Theme.C.mutedForeground)
                }
            } else {
                let all = choices
                if MacNewSession.filters(all) { filterLine }
                list(all)
                if picks.page == .agent, let failure { problem(failure, retry: nil) }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var filterLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
            Text(cursor.filter.isEmpty ? "Type to filter" : cursor.filter)
                .foregroundStyle(cursor.filter.isEmpty ? Theme.C.mutedForeground : Theme.C.foreground)
            Spacer(minLength: 0)
        }
        .font(.callout)
        .foregroundStyle(Theme.C.mutedForeground)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.C.mutedForeground.opacity(0.35)))
    }

    private func list(_ all: [MacNewSession.Choice]) -> some View {
        let visible = cursor.visible(all)
        let current = cursor.current(all)?.value
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(visible) { c in row(c, highlighted: c.value == current).id(c.value) }
                }
            }
            .overlay {
                if visible.isEmpty {
                    Text(all.isEmpty ? "devd has no folders configured." : "Nothing matches “\(cursor.filter)”.")
                        .foregroundStyle(Theme.C.mutedForeground)
                }
            }
            .onChange(of: current) { _, id in if let id { proxy.scrollTo(id) } }
        }
    }

    private func row(_ c: MacNewSession.Choice, highlighted: Bool) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.title).foregroundStyle(highlighted ? Color.white : Theme.C.foreground)
                if let detail = c.detail {
                    Text(detail).font(.caption).foregroundStyle(highlighted ? Color.white.opacity(0.85) : Theme.C.mutedForeground)
                }
            }
            Spacer(minLength: 0)
            if picks.page != .agent {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(highlighted ? Color.white.opacity(0.85) : Theme.C.mutedForeground.opacity(0.6))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(highlighted ? Color.accentColor : Color.clear))
        .contentShape(Rectangle())
        // A tap right after the page changed is the second click of a double click on the page before: ignored, or it
        // would pick on this page too. On the Agent page a click picks the agent and a double click also creates; the
        // click count is read from the event, as a double-tap gesture would hold every single click back by the
        // double-click interval.
        .onTapGesture {
            guard settled() else { return }
            activate(c)
            if picks.page == .agent, (NSApp.currentEvent?.clickCount ?? 1) >= 2 { start() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(highlighted ? [.isButton, .isSelected] : .isButton)
    }

    private func problem(_ message: String, retry: (() -> Void)?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.C.dangerText)
            Text(message).foregroundStyle(Theme.C.dangerText).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let retry { Button("Retry", action: retry) }
        }
        .font(.callout)
    }

    private var isUnsure: Bool {
        if case .failed(_, false) = phase { return true }
        return false
    }

    private var failure: String? {
        if case .failed(let message, _) = phase { return message }
        return nil
    }

    // MARK: - Moving between pages

    private func key(_ press: KeyPress) -> KeyPress.Result {
        guard tree != nil, !working else { return .ignored }
        let all = choices
        switch press.key {
        case .upArrow, .downArrow:
            cursor.move(press.key == .upArrow ? -1 : 1, in: all)
            if picks.page == .agent, let c = cursor.current(all), let a = AgentName(rawValue: c.value) { picks.agent = a }
            return .handled
        case .return:
            // The Agent page's Return is its Create button.
            guard picks.page != .agent else { return .ignored }
            if let c = cursor.current(all) { activate(c) }
            return .handled
        case .escape:
            // A typed filter goes first; then Esc is Back or Cancel (their shortcut is off while a filter is typed).
            guard !cursor.filter.isEmpty else { return .ignored }
            cursor.filter = ""
            return .handled
        case .delete:
            guard !cursor.filter.isEmpty else { return .ignored }
            cursor.filter.removeLast()
            return .handled
        default:
            let typed = press.characters.unicodeScalars
            guard MacNewSession.filters(all), press.modifiers.subtracting(.shift).isEmpty, !typed.isEmpty,
                  typed.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return .ignored }
            cursor.filter += press.characters
            return .handled
        }
    }

    private func activate(_ c: MacNewSession.Choice) {
        guard let tree, !working else { return }
        if picks.page == .agent {
            guard let a = AgentName(rawValue: c.value) else { return }
            picks.agent = a
            cursor.highlight = c.value
            return
        }
        go { $0.pick(c.value, tree: tree) }
    }

    /// No double click is still under way from the last page change.
    private func settled() -> Bool {
        MacNewSession.settled(now: ProcessInfo.processInfo.systemUptime, pageChangedAt: pageChangedAt, doubleClick: NSEvent.doubleClickInterval)
    }

    private var heldSession: String? {
        if case .created(_, let id) = phase { return id }
        return nil
    }

    private var stage: MacNewSession.Stage? {
        if case .working(let t) = phase { return t.stage }
        return nil
    }

    private func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }

    private func goBack() {
        guard let tree else { return dismiss() }
        var next = picks
        guard next.back(tree: tree) else { return dismiss() }
        go { $0 = next }
    }

    /// Two steps, so the page sliding out already knows the direction: SwiftUI takes a removed view's transition from
    /// its last render.
    private func go(_ change: (inout MacNewSession.Picks) -> Void) {
        var next = picks
        change(&next)
        // An error, or a "may still be creating", belongs to the repo it was about.
        if (next.folder, next.project, next.repo) != (picks.folder, picks.project, picks.repo) { phase = .form }
        forward = next.page > picks.page
        if next.page != picks.page { pageChangedAt = ProcessInfo.processInfo.systemUptime }
        DispatchQueue.main.async {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { picks = next }
        }
    }

    // MARK: - Progress

    private func progress(_ t: MacNewSession.Tracker) -> some View {
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
            // Ticks only to count the running step on; every number is devd's.
            TimelineView(.periodic(from: .now, by: 0.1)) { _ in stages(t, at: ProcessInfo.processInfo.systemUptime) }
            Text("devd skips the steps a session does not need.")
                .font(.caption)
                .foregroundStyle(Theme.C.mutedForeground)
        }
    }

    private func stages(_ t: MacNewSession.Tracker, at uptime: TimeInterval) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(MacNewSession.Stage.allCases, id: \.self) { s in
                let state: Int = t.stage.map { s < $0 ? 0 : s == $0 ? 1 : 2 } ?? 2
                let done = state == 0 || (state == 1 && s == .ready)
                HStack(spacing: 8) {
                    Group {
                        if done {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(InboxTone.doneIcon)
                        } else if state == 1 {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "circle").foregroundStyle(Theme.C.mutedForeground.opacity(0.6))
                        }
                    }
                    .frame(width: 18)
                    Text(t.title(s)).foregroundStyle(state == 2 ? Theme.C.mutedForeground : Theme.C.foreground)
                    Spacer()
                    if let time = t.time(s, at: uptime) {
                        Text(time.text).monospacedDigit().foregroundStyle(Theme.C.mutedForeground)
                    }
                }
                .accessibilityElement(children: .ignore)
                // The live count stays out: VoiceOver hears a step's time once it has ended.
                .accessibilityLabel("\(t.title(s)), \(done ? "Done" : state == 1 ? "In progress" : "Pending")"
                                    + (t.time(s, at: uptime).flatMap { $0.running ? nil : ", \($0.text)" } ?? ""))
            }
            if let total = t.total(at: uptime) {
                Divider()
                HStack {
                    Text("Total")
                    Spacer()
                    Text(total.text).monospacedDigit()
                }
                .fontWeight(.medium)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(total.running ? "Total, still running" : "Total, \(total.text)")
            }
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
            switch phase {
            case .working:
                Spacer()
                Button("Cancel") { confirmClose = true }.keyboardShortcut(.cancelAction)
                Button("Creating…") {}.disabled(true)
            case .created(_, let id):
                Spacer()
                Button("Open Session") { open(id) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            case .done(_, let id):
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Open Session") { open(id) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            case .form, .failed:
                let first = picks.page == .folder
                if !first {
                    Button(action: goBack) { Label("Back", systemImage: "chevron.left") }
                        .keyboardShortcut(cursor.filter.isEmpty ? .cancelAction : nil)
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(first && cursor.filter.isEmpty ? .cancelAction : nil)
                if picks.page == .agent {
                    // A failed create is retried here.
                    Button("Create", action: start)
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                        .disabled(isUnsure)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    // MARK: - Work

    private func loadTree() async {
        guard tree == nil else { return }
        do { tree = try await actions.tree() } catch { treeError = "Can't load the folders and repos: \(errorText(error))" }
    }

    /// Once: the hold's end and a key or click can both ask.
    private func open(_ id: String) {
        guard !opened else { return }
        opened = true
        dismiss()
        onOpen(id)
    }

    private func start() {
        guard let tree, let request = MacNewSession.request(picks, tree: tree), !working, !isUnsure else { return }
        // Marks this open's progress, so another open of the same repo (the CLI, another window) is not shown as ours.
        let requestId = UUID().uuidString
        phase = .working(MacNewSession.Tracker())
        work = Task {
            // devd reports the repo's open while the request runs; solo clones nothing and has no progress key.
            let poll = request.repo == NewSessionLogic.SOLO ? nil : Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(500))
                    guard !Task.isCancelled, case .working(var t) = phase else { return }
                    // A failed poll leaves the last stage showing; the request's own answer still decides.
                    guard let report = try? await actions.openProgress(folder: request.folder, project: request.project, repo: request.repo)
                    else { continue }
                    guard !Task.isCancelled, case .working = phase else { return }
                    t.observe(report, requestId: requestId)
                    phase = .working(t)
                }
            }
            defer { poll?.cancel() }
            do {
                let result = try await MacNewSession.create(request, actions: actions, requestId: requestId)
                poll?.cancel()
                if case .working(var t) = phase {
                    t.finish(phases: result.phases)
                    phase = .working(t)
                }
                await onStarted()
                // Closed meanwhile: the session is in the sidebar; the window stays where the user left it.
                guard !Task.isCancelled else { return }
                switch MacNewSession.finish(result) {
                case .hold(let id):
                    guard case .working(let t) = phase else { return open(id) }
                    phase = .created(t, sessionId: id)
                case .then(.openChat(let id)): open(id)
                case .then(.show(let text, let chatId)): phase = .done(text, sessionId: chatId ?? result.session.id)
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

/// While the finished page holds, any key or click in the app opens the session at once. An app-wide monitor, as the
/// page has no control to take the key and a click may land anywhere in the window; the event is used up.
private struct OpensOnAnyInput: ViewModifier {
    let open: () -> Void
    @State private var monitor: Any?

    func body(content: Content) -> some View {
        content
            .onAppear {
                monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown]) { _ in
                    open()
                    return nil
                }
            }
            .onDisappear {
                if let monitor { NSEvent.removeMonitor(monitor) }
                monitor = nil
            }
    }
}
