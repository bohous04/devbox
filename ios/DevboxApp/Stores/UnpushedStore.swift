import Foundation

/// View-model for `UnpushedScreen`, mirrors `dashboard/src/pages/Unpushed.tsx` and its pure helpers in
/// `dashboard/src/unpushedView.ts`. `GET /api/unpushed` never waits for a scan, so while one runs the store asks
/// again every 3 s, like the web.
@MainActor
final class UnpushedStore: ObservableObject {
    /// What just succeeded. A pushed branch leaves the report, so the confirmation (and the PR link) lives here.
    struct Notice: Equatable {
        let text: String
        let url: URL?
    }

    struct PushedBranch: Equatable {
        let path: String
        let branch: String
        let at: Int
    }

    @Published private(set) var status: UnpushedStatus?
    @Published private(set) var error: String?
    @Published var notice: Notice?
    /// Branches pushed from here, hidden until a report scanned after the push arrives.
    @Published private(set) var pushed: [PushedBranch] = []

    private let client: DevdClient
    private let scanPoll: Duration
    private var pollTask: Task<Void, Never>?

    init(client: DevdClient, scanPoll: Duration = .seconds(3)) {
        self.client = client
        self.scanPoll = scanPoll
    }

    var report: UnpushedReport? {
        status?.report.map { Self.withoutPushed($0, pushed) }
    }

    /// The first load takes the cached report (the page opens at once); Rescan passes `fresh`.
    func load(fresh: Bool = false) async {
        do {
            status = try await client.get(fresh ? "/api/unpushed?fresh=1" : "/api/unpushed")
            error = nil
        } catch {
            self.error = errorText(error)
        }
        pollWhileScanning()
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    deinit { pollTask?.cancel() }

    private func pollWhileScanning() {
        pollTask?.cancel()
        guard status?.scanning == true else { pollTask = nil; return }
        pollTask = Task { [weak self, scanPoll] in
            try? await Task.sleep(for: scanPoll)
            guard !Task.isCancelled else { return }
            await self?.load()
        }
    }

    private struct Body: Encodable {
        let path: String
        let branch: String
        var title: String? = nil
        var body: String? = nil
    }

    private struct PushResult: Decodable { let at: Int }
    private struct PrResult: Decodable { let url: String; let number: Int?; let at: Int }

    func push(_ repo: UnpushedRepo, _ branch: UnpushedBranch) async throws {
        let r: PushResult = try await client.post("/api/unpushed/push", body: Body(path: repo.path, branch: branch.branch))
        await done(Notice(text: "Pushed \(branch.branch) to origin (\(Self.repoTitle(repo))).", url: nil),
                   PushedBranch(path: repo.path, branch: branch.branch, at: r.at))
    }

    /// The server pushes the branch first, then opens the PR against the remote's default branch.
    func createPr(_ repo: UnpushedRepo, _ branch: UnpushedBranch, title: String) async throws {
        let r: PrResult = try await client.post("/api/unpushed/pr", body: Body(path: repo.path, branch: branch.branch,
                                                                              title: title, body: Self.prBody(branch)))
        let number = r.number.map { " #\($0)" } ?? ""
        await done(Notice(text: "Pull request\(number) created for \(branch.branch) (\(Self.repoTitle(repo))).", url: URL(string: r.url)),
                   PushedBranch(path: repo.path, branch: branch.branch, at: r.at))
    }

    /// The server drops its cache after a push, so a plain load already brings a new scan.
    private func done(_ notice: Notice, _ branch: PushedBranch) async {
        self.notice = notice
        pushed.append(branch)
        await load()
    }

    // MARK: - Pure (1:1 with unpushedView.ts)

    nonisolated static func shortHash(_ hash: String) -> String { String(hash.prefix(7)) }

    /// `project/repo`, or just `repo` when the project is the folder (the folder already heads the section).
    nonisolated static func repoTitle(_ r: UnpushedRepo) -> String {
        r.project == r.folder ? r.repo : "\(r.project)/\(r.repo)"
    }

    nonisolated static func repoFlags(_ r: UnpushedRepo) -> [String] {
        (r.bare ? ["bare"] : []) + (r.noRemote ? ["no remote"] : [])
    }

    nonisolated static func branchLabel(_ b: UnpushedBranch) -> String {
        b.upstream.map { "\(b.branch) → \($0)" } ?? "\(b.branch) · no upstream"
    }

    nonisolated static func canPush(_ r: UnpushedRepo) -> Bool { !r.noRemote && r.error == nil }

    nonisolated static func canCreatePr(_ r: UnpushedRepo) -> Bool {
        canPush(r) && (r.remote?.provider == "github" || r.remote?.provider == "gitea")
    }

    nonisolated static func prTitle(_ b: UnpushedBranch) -> String {
        if b.count == 1, let subject = b.commits.first?.subject, !subject.isEmpty { return subject }
        return b.branch
    }

    /// Commit bullets from the oldest; a truncated list says how many it leaves out.
    nonisolated static func prBody(_ b: UnpushedBranch) -> String {
        let lines = b.commits.reversed().map { "- \($0.subject)" }.joined(separator: "\n")
        let hidden = b.count - b.commits.count
        return hidden > 0 ? "\(lines)\n\n…and \(hidden) more \(hidden == 1 ? "commit" : "commits")" : lines
    }

    nonisolated static func commitsLabel(_ count: Int, shown: Int? = nil) -> String {
        let base = "\(count) \(count == 1 ? "commit" : "commits")"
        if let shown, shown < count { return "\(base) · showing \(shown)" }
        return base
    }

    /// The report without branches pushed after it was scanned; counts shrink to match and emptied repos and
    /// folders go.
    nonisolated static func withoutPushed(_ report: UnpushedReport, _ pushed: [PushedBranch]) -> UnpushedReport {
        let hide = pushed.filter { $0.at >= report.at }
        guard !hide.isEmpty else { return report }
        func hidden(_ path: String, _ branch: String) -> Bool { hide.contains { $0.path == path && $0.branch == branch } }
        var out = report
        out.folders = report.folders.compactMap { f in
            var folder = f
            folder.repos = f.repos.map { r in
                let gone = r.branches.filter { hidden(r.path, $0.branch) }.reduce(0) { $0 + $1.count }
                guard gone > 0 else { return r }
                var repo = r
                repo.branches = r.branches.filter { !hidden(r.path, $0.branch) }
                repo.count = r.count - gone
                return repo
            }.filter { $0.count > 0 || $0.error != nil }
            folder.count = folder.repos.reduce(0) { $0 + $1.count }
            return folder.repos.isEmpty ? nil : folder
        }
        out.total = out.folders.reduce(0) { $0 + $1.count }
        return out
    }
}
