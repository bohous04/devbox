import Foundation

/// Session actions (stop/restart/end/rename/account/agent switch) — a thin wrapper over
/// `DevdClient`. Paths and body shapes are 1:1 per `dashboard/src/api.ts`. No state of its own (unlike
/// `LiveStore`) — screens call `LiveStore.refreshNow()` themselves after every action.
@MainActor
struct SessionActions {
    private let client: DevdClient

    init(client: DevdClient) {
        self.client = client
    }

    /// `soloAction` for `end` — mirrors `"keep" | "delete"` from api.ts.
    enum SoloAction: String, Encodable {
        case keep, delete
    }

    func stop(_ id: String) async throws {
        // The web sends `{ method: "POST" }` without a body (see api.ts `stop`) — postVoid(body: nil)
        // does not even build a Content-Type header, no body.
        try await client.postVoid("/api/sessions/\(id)/stop", body: nil)
    }

    func restart(_ id: String) async throws {
        try await client.postVoid("/api/sessions/\(id)/restart", body: nil)
    }

    private struct EndBody: Encodable { let soloAction: SoloAction? }

    /// `soloAction` is absent for a non-solo session (the server ignores it) — Swift `Optional` with an auto-
    /// synthesized `Encodable` omits the key for `nil`, just as `JSON.stringify` drops
    /// `undefined` (`post({ soloAction })` on the web).
    func end(_ id: String, soloAction: SoloAction? = nil) async throws {
        try await client.postVoid("/api/sessions/\(id)/end", body: EndBody(soloAction: soloAction))
    }

    private struct ImportantBody: Encodable { let important: Bool }

    func setImportant(_ id: String, _ important: Bool) async throws {
        try await client.postVoid("/api/sessions/\(id)/important", body: ImportantBody(important: important))
    }

    private struct CriticBody: Encodable { let critic: Bool }

    func setCritic(_ id: String, _ critic: Bool) async throws {
        try await client.postVoid("/api/sessions/\(id)/critic", body: CriticBody(critic: critic))
    }

    private struct NameBody: Encodable { let name: String }

    /// Session nickname (an empty string clears it) — the server sanitizes the input itself.
    func setName(_ id: String, _ name: String) async throws {
        try await client.postVoid("/api/sessions/\(id)/name", body: NameBody(name: name))
    }

    private struct EmptyBody: Encodable {}

    func switchAccount(_ id: String) async throws -> SwitchAccountResponse {
        try await client.post("/api/sessions/\(id)/switch-account", body: EmptyBody())
    }

    private struct AgentBody: Encodable { let agent: String }

    /// Live swap of the agent (harness) of a running session — claude→claude* keeps the conversation (best-effort
    /// `--resume`), switching to a different CLI loses it (see devd/src/agentSwitch.ts).
    func switchAgent(_ id: String, _ agent: AgentName) async throws -> SwitchAgentResponse {
        try await client.post("/api/sessions/\(id)/agent", body: AgentBody(agent: agent.rawValue))
    }

    func reviews(_ id: String) async throws -> [CriticReview] {
        try await client.get("/api/sessions/\(id)/reviews?limit=5")
    }

    private struct CcUpkeepRunBody: Encodable { let session: String }

    /// Update of one session to `CcStatus.latest` — mirrors `api.ccUpkeepRun(s.id)` from
    /// `dashboard/src/pages/Sessions.tsx` (the "Claude Code" row). The web can also do a fleet-wide run without
    /// `session` (button on `CcPanel`), the app does not need that yet — only the per-session variant.
    /// The caller does not consume the response (`CcRunResult`) (just as the web only awaits it), hence
    /// `postVoid`, not `post`.
    func ccUpkeepRun(_ id: String) async throws {
        try await client.postVoid("/api/cc-upkeep/run", body: CcUpkeepRunBody(session: id))
    }

    // MARK: - New session (dashboard/src/pages/Sessions.tsx `NewSession`)

    func tree() async throws -> [TreeProject] {
        try await client.get("/api/tree")
    }

    /// `cloneUrl`/`agent`/`fresh` are absent when `nil` — a Swift Optional on a stored field with a synthesized
    /// `Encodable` encodes via `encodeIfPresent`, so the key is omitted just as `JSON.stringify`
    /// drops `undefined` (`post(t)` in api.ts, see `EndBody` above for the same trick).
    private struct OpenSessionBody: Encodable {
        let folder: String
        let project: String
        let repo: String
        let cloneUrl: String?
        let agent: String?
        let fresh: Bool?
    }

    func openSession(
        folder: String, project: String, repo: String,
        cloneUrl: String?, agent: AgentName?, fresh: Bool?
    ) async throws -> OpenResult {
        try await client.post("/api/sessions", body: OpenSessionBody(
            folder: folder, project: project, repo: repo,
            cloneUrl: cloneUrl, agent: agent?.rawValue, fresh: fresh
        ))
    }

    /// `solo: true` is always present (unlike `agent`) — mirrors `post({ ...t, solo: true })`
    /// in api.ts. The server does not know `fresh` for solo (see the newSession.ts comment), so the body lacks it.
    private struct OpenSoloBody: Encodable {
        let folder: String
        let project: String
        let agent: String?
        let solo: Bool
    }

    func openSolo(folder: String, project: String, agent: AgentName?) async throws -> OpenResult {
        try await client.post("/api/sessions", body: OpenSoloBody(
            folder: folder, project: project, agent: agent?.rawValue, solo: true
        ))
    }
}

/// An agent swap returns failure as HTTP 200 too (same as switch-account) — the caller reports
/// errors only via `throw`, so the response is translated into a sentence. `nil` = full success, nothing
/// to throw. A partial success (some panes stayed on the old profile) is reported too — silence
/// would look like "everything switched". 1:1 port of `dashboard/src/sessionsView.ts` `agentSwitchError`.
extension SessionActions {
    static func agentSwitchError(_ r: SwitchAgentResponse, label: String) -> String? {
        let stragglers = r.panes.filter { $0.outcome != .restarted }
        let detail = stragglers.map { "\($0.target) (\($0.outcome.rawValue))" }.joined(separator: ", ")
        switch r.status {
        case .unchanged:
            return nil
        case .noAgent:
            return "No running agent found in the session — nothing switched."
        case .failed:
            return "Couldn't switch any panel onto \(label)\(detail.isEmpty ? " — check the container" : ": \(detail)")."
        case .switched:
            return detail.isEmpty ? nil : "Switched to \(label), but some panes stayed behind: \(detail)."
        }
    }
}

/// Description of one agent profile for the select/picker and badge — mirrors `AgentProfile`/
/// `AGENT_PROFILES` from `dashboard/src/newSession.ts` (the dashboard is deliberately separate from devd, hence
/// a manual copy, not an import). `yolo` marks the label on the option in "New session" (web: " (yolo)" suffix
/// after the label) — all profiles have it `true` today; we keep the field per profile like the web.
struct AgentProfile {
    let label: String
    let short: String
    let yolo: Bool
}

enum AgentProfiles {
    static let all: [AgentName: AgentProfile] = [
        .claude: AgentProfile(label: "Claude Code", short: "Claude", yolo: true),
        .claudeGpt: AgentProfile(label: "Claude Code + GPT", short: "Claude+GPT", yolo: true),
        .claudeGrok: AgentProfile(label: "Claude Code + Grok", short: "Claude+Grok", yolo: true),
        .claudeGemini: AgentProfile(label: "Claude Code + Gemini", short: "Claude+Gemini", yolo: true),
        .claudeOpenrouter: AgentProfile(label: "Claude Code + OpenRouter", short: "Claude+OR", yolo: true),
        .codex: AgentProfile(label: "Codex", short: "Codex", yolo: true),
        .grok: AgentProfile(label: "Grok Build", short: "Grok", yolo: true),
        .antigravity: AgentProfile(label: "Antigravity", short: "Antigravity", yolo: true),
    ]

    /// Order of options in the picker — same as `AGENT_IDS` on the web (default first, then proxy
    /// variants, then standalone CLIs). `.unknown` (tolerant decoding fallback) is not offered —
    /// it is not a real profile one could switch to.
    static let ids: [AgentName] = [.claude, .claudeGpt, .claudeGrok, .claudeGemini, .claudeOpenrouter, .codex, .grok, .antigravity]

    /// Profile for a value that may be nil/unknown — mirrors `agentNameFor`/`profileFor`
    /// (fallback to claude, an unknown profile must not crash the UI).
    static func profile(for agent: AgentName?) -> AgentProfile {
        profile(for: normalize(agent))
    }

    static func profile(for agent: AgentName) -> AgentProfile {
        all[agent] ?? all[.claude]!
    }

    /// Mirrors `agentNameFor` from `dashboard/src/newSession.ts`: `nil` AND the tolerant `.unknown`
    /// (an unknown value from the server, see `AgentName.init(from:)` in Models.swift) are normalized
    /// to `.claude` — this is the ONLY place that does it, so the picker/badge/comparison
    /// "current == target" never diverge over an unknown value separately.
    static func normalize(_ agent: AgentName?) -> AgentName {
        guard let agent, agent != .unknown, all[agent] != nil else { return .claude }
        return agent
    }
}
