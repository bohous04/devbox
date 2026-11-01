import ActivityKit
import Foundation

/// Server-driven Live Activity — shared by the app, the widget extension and the devd APNs contract.
/// The type name MUST stay `DevboxAgentActivityAttributes`: devd sends it as `attributes-type`
/// in push-to-start (devd/src/apns.ts). ContentState is v2, exactly matching the fixture
/// `DevboxAppTests/Fixtures/agent-live-activity-v2.json` (devd/src/liveActivityState.ts).
struct DevboxAgentActivityAttributes: ActivityAttributes {
    /// Opaque hash of the server path (see `AgentLiveActivityManager.serverID(for:)`).
    var serverID: String

    /// State of one session. An unknown value from a newer server decodes as `unknown` —
    /// otherwise a single new state would break decoding of the whole activity (ActivityKit would drop the push).
    enum Status: String, Codable, Hashable, CaseIterable {
        case waiting, working, done, stalled, unknown

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .unknown
        }

        var label: String {
            switch self {
            case .waiting: return "waiting"
            case .working: return "working"
            case .done: return "done"
            case .stalled: return "stalled"
            case .unknown: return "?"
            }
        }
    }

    /// Summary dot (compact Dynamic Island). Unknown value → `idle`.
    enum Dot: String, Codable, Hashable {
        case waiting, stalled, working, idle

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Dot(rawValue: raw) ?? .idle
        }
    }

    struct Counts: Codable, Hashable {
        var waiting: Int
        var working: Int
        var done: Int
        var stalled: Int
        var unknown: Int

        init(waiting: Int = 0, working: Int = 0, done: Int = 0, stalled: Int = 0, unknown: Int = 0) {
            self.waiting = waiting
            self.working = working
            self.done = done
            self.stalled = stalled
            self.unknown = unknown
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
            working = try c.decodeIfPresent(Int.self, forKey: .working) ?? 0
            done = try c.decodeIfPresent(Int.self, forKey: .done) ?? 0
            stalled = try c.decodeIfPresent(Int.self, forKey: .stalled) ?? 0
            unknown = try c.decodeIfPresent(Int.self, forKey: .unknown) ?? 0
        }

        /// The activity is meaningful while some session is waiting, working or stalled (spec §1).
        /// Neither `done` nor `unknown` keeps it alive on its own.
        var hasActiveWork: Bool { waiting > 0 || working > 0 || stalled > 0 }
    }

    struct Session: Codable, Hashable, Identifiable {
        var id: String
        var title: String
        var agent: String
        var project: String
        var status: Status
        var reason: String?
        var since: Date

        private enum CodingKeys: String, CodingKey { case id, title, agent, project, status, reason, since }

        init(id: String, title: String, agent: String, project: String, status: Status,
             reason: String? = nil, since: Date) {
            self.id = id
            self.title = title
            self.agent = agent
            self.project = project
            self.status = status
            self.reason = reason
            self.since = since
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            agent = try c.decodeIfPresent(String.self, forKey: .agent) ?? ""
            project = try c.decodeIfPresent(String.self, forKey: .project) ?? ""
            status = try c.decodeIfPresent(Status.self, forKey: .status) ?? .unknown
            reason = try c.decodeIfPresent(String.self, forKey: .reason)
            since = try DevboxAgentActivityAttributes.decodeDate(c, .since)
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(title, forKey: .title)
            try c.encode(agent, forKey: .agent)
            try c.encode(project, forKey: .project)
            try c.encode(status, forKey: .status)
            try c.encode(reason, forKey: .reason)
            try c.encode(DevboxAgentActivityAttributes.isoString(since), forKey: .since)
        }

        var deepLink: URL? { DevboxAgentActivityAttributes.sessionURL(id) }

        var agentLabel: String {
            if agent.hasPrefix("codex") { return "Codex" }
            if agent.hasPrefix("claude") { return "Claude" }
            if agent.hasPrefix("grok") { return "Grok" }
            return agent.isEmpty ? "Agent" : String(agent.prefix(24))
        }
    }

    struct ContentState: Codable, Hashable {
        var version: Int
        var counts: Counts
        var dot: Dot
        var sessions: [Session]
        var overflow: Int
        var changedAt: Date
        var updatedAt: Date

        private enum CodingKeys: String, CodingKey { case version, counts, dot, sessions, overflow, changedAt, updatedAt }

        init(version: Int = 2, counts: Counts, dot: Dot, sessions: [Session], overflow: Int = 0,
             changedAt: Date, updatedAt: Date) {
            self.version = version
            self.counts = counts
            self.dot = dot
            self.sessions = sessions
            self.overflow = overflow
            self.changedAt = changedAt
            self.updatedAt = updatedAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = try c.decode(Int.self, forKey: .version)
            counts = try c.decodeIfPresent(Counts.self, forKey: .counts) ?? Counts()
            dot = try c.decodeIfPresent(Dot.self, forKey: .dot) ?? .idle
            sessions = try c.decodeIfPresent([Session].self, forKey: .sessions) ?? []
            overflow = try c.decodeIfPresent(Int.self, forKey: .overflow) ?? 0
            changedAt = try DevboxAgentActivityAttributes.decodeDate(c, .changedAt)
            updatedAt = try DevboxAgentActivityAttributes.decodeDate(c, .updatedAt)
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version)
            try c.encode(counts, forKey: .counts)
            try c.encode(dot, forKey: .dot)
            try c.encode(sessions, forKey: .sessions)
            try c.encode(overflow, forKey: .overflow)
            try c.encode(DevboxAgentActivityAttributes.isoString(changedAt), forKey: .changedAt)
            try c.encode(DevboxAgentActivityAttributes.isoString(updatedAt), forKey: .updatedAt)
        }

        var hasActiveWork: Bool { counts.hasActiveWork }
        /// Tapping the activity opens the most important session (the server orders them waiting → stalled → working).
        var deepLink: URL? { sessions.first?.deepLink }
    }

    // MARK: - Data

    // Dates travel over the wire as ISO 8601 with fractional seconds ("2026-10-19T09:51:00.000Z",
    // `Date.toISOString()` in devd). But ActivityKit also decodes them with its own `JSONDecoder` (push
    // content-state), whose default strategy expects a number — hence the custom Codable: it accepts an ISO
    // string (with or without fractions) as well as a number (seconds since 2001, the default Foundation format), and encodes
    // back to an ISO string, so nothing is lost in any decoder.
    static func decodeDate<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws -> Date {
        if let text = try? c.decode(String.self, forKey: key) {
            guard let date = date(text) else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "Invalid ISO 8601 date")
            }
            return date
        }
        return Date(timeIntervalSinceReferenceDate: try c.decode(Double.self, forKey: key))
    }

    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// `devbox://session/<id>` only for a safe id — no arbitrary URL or path from the payload.
    static func sessionURL(_ id: String) -> URL? {
        guard !id.isEmpty, id.count <= 255,
              id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._")).contains($0) })
        else { return nil }
        var parts = URLComponents()
        parts.scheme = "devbox"
        parts.host = "session"
        parts.path = "/" + id
        return parts.url
    }

    /// Test/sample data (DEBUG sample, previews, tests) — never sent to the server.
    static var preview: ContentState {
        // Whole seconds: ISO over the wire carries milliseconds, so the round-trip stays `==`.
        let now = Date(timeIntervalSince1970: Date().timeIntervalSince1970.rounded(.down))
        return ContentState(
            counts: Counts(waiting: 1, working: 2, done: 1),
            dot: .waiting,
            sessions: [
                Session(id: "dev-portal-banka", title: "Billing", agent: "codex", project: "portal/games",
                        status: .waiting, reason: "Command approval", since: now.addingTimeInterval(-247)),
                Session(id: "dev-portal-inventory", title: "Inventory", agent: "claude", project: "portal/games",
                        status: .working, since: now.addingTimeInterval(-600)),
                Session(id: "dev-portal-hud", title: "HUD", agent: "grok", project: "portal/games",
                        status: .working, since: now.addingTimeInterval(-120)),
                Session(id: "dev-portal-web", title: "Web", agent: "claude", project: "portal/web",
                        status: .done, since: now.addingTimeInterval(-60)),
            ],
            changedAt: now.addingTimeInterval(-60),
            updatedAt: now
        )
    }
}
