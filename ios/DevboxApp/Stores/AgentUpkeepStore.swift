import Foundation

/// View-model for `AgentUpkeepScreen`, mirrors `dashboard/src/pages/AgentUpkeep.tsx`: one agent runtime at a time,
/// its latest release, the base image's version and each running session's installed version.
@MainActor
final class AgentUpkeepStore: ObservableObject {
    enum SessionState: CaseIterable {
        case current, update, reopen, unknown
    }

    @Published private(set) var provider: UpkeepProvider = .claude
    @Published private(set) var status: AgentUpkeepStatus?
    @Published private(set) var error: String?
    @Published private(set) var result: String?
    @Published private(set) var busy = false

    private let client: DevdClient
    /// Drops a reply that arrives after the provider changed (the web's `request` counter).
    private var request = 0

    init(client: DevdClient) {
        self.client = client
    }

    func select(_ provider: UpkeepProvider) async {
        guard provider != self.provider, !busy else { return }
        self.provider = provider
        status = nil
        result = nil
        await load()
    }

    func load() async {
        request += 1
        let id = request
        error = nil
        do {
            // Probing every container takes a while (docker run plus an exec per session, agentUpkeep.ts).
            let data: AgentUpkeepStatus = try await client.get("/api/agent-upkeep?provider=\(provider.rawValue)", timeout: 60)
            if id == request { status = data }
        } catch {
            if id == request { self.error = errorText(error) }
        }
    }

    private struct RunBody: Encodable {
        let provider: UpkeepProvider
        let session: String?
    }

    /// Installs the latest version in one session, or in all of them when `session` is nil.
    func run(session: String? = nil) async {
        guard !busy else { return }
        busy = true
        error = nil
        result = nil
        defer { busy = false }
        do {
            let r: AgentUpkeepResult = try await client.post("/api/agent-upkeep/run", body: RunBody(provider: provider, session: session),
                                                             timeout: 600)
            result = Self.summary(r)
            await load()
        } catch {
            self.error = writeErrorText(error)
        }
    }

    // MARK: - Pure (1:1 with AgentUpkeep.tsx)

    /// Antigravity's binary changes only with an image build, so the page offers no update for it.
    nonisolated static func canUpdate(_ provider: UpkeepProvider) -> Bool { provider != .agy }

    /// `a` is an older version than `b`, comparing major.minor.patch numerically. A part that is not a number
    /// decides nothing, as with the web's `NaN` comparisons.
    nonisolated static func older(_ a: String, _ b: String) -> Bool {
        let x = a.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        let y = b.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        for i in 0..<3 {
            guard i < x.count, i < y.count, let l = x[i], let r = y[i] else { continue }
            if l != r { return l < r }
        }
        return false
    }

    nonisolated static func state(_ s: AgentUpkeepSession, latest: String?) -> SessionState {
        if let version = s.version, let latest, older(version, latest) { return .update }
        if s.restartRequired == true { return .reopen }
        if s.version == nil || latest == nil || s.restartRequired == nil || s.running == nil { return .unknown }
        return .current
    }

    nonisolated static func label(_ state: SessionState, provider: UpkeepProvider) -> String {
        switch state {
        case .current: return "Current"
        case .update: return provider == .agy ? "Newer version available — rebuild the devbox image" : "Update available"
        case .reopen: return "Reopen when finished"
        case .unknown: return "Unknown"
        }
    }

    nonisolated static func summary(_ r: AgentUpkeepResult) -> String {
        let parts: [String?] = [
            r.error,
            r.built ? "Image updated" : nil,
            r.updated.isEmpty ? nil : "Installed in \(r.updated.count) session(s)",
            r.restarted.isEmpty ? nil : "Restarted \(r.restarted.count) session(s)",
            r.deferred.isEmpty ? nil : "Deferred: \(r.deferred.joined(separator: ", ")) (active work or update cooldown)",
            r.failed.isEmpty ? nil : "Failed: \(r.failed.joined(separator: ", "))",
            r.unchanged.isEmpty ? nil : "\(r.unchanged.count) already current",
        ]
        let text = parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return text.isEmpty ? "No changes confirmed. Review the refreshed versions and session history." : text
    }

    nonisolated static func repositories(_ sessions: [AgentUpkeepSession]) -> [String] {
        Array(Set(sessions.map { "\($0.project)/\($0.repo)" })).sorted()
    }

    nonisolated static func filter(_ sessions: [AgentUpkeepSession], search: String, repo: String) -> [AgentUpkeepSession] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return sessions.filter { s in
            let key = "\(s.project)/\(s.repo)"
            return (repo.isEmpty || key == repo) && (needle.isEmpty || "\(key) \(s.id) \(s.version ?? "")".lowercased().contains(needle))
        }
    }

    nonisolated static func title(_ provider: UpkeepProvider) -> String {
        switch provider {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .grok: return "Grok Build"
        case .agy: return "Antigravity"
        }
    }

    nonisolated static func cadence(_ provider: UpkeepProvider) -> String {
        switch provider {
        case .claude: return "Nightly maintenance"
        case .agy: return "Updated with the devbox image"
        case .codex, .grok: return "Automatic checks on launch"
        }
    }

    nonisolated static func note(_ provider: UpkeepProvider) -> String {
        switch provider {
        case .claude: return "Claude Code uses the existing nightly updater and guarded conversation restarts."
        case .agy: return "Antigravity runs from the devbox image. Rebuild the image to update it; this page shows which version each session runs."
        case .codex, .grok: return "Updates are checked on launch, at most once per hour per container. Running conversations keep their current process. Reopen after finishing to use a newly installed version."
        }
    }
}
