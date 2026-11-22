import Foundation
import os

/// Pure inbox rules: a port of `dashboard/src/inboxView.ts`.
enum InboxView {
    struct Groups: Equatable {
        var needsYou: [InboxItem]
        var working: [InboxItem]
        var idle: [InboxItem]
        var snoozed: [InboxItem]
        var settled: [InboxItem]
    }

    /// The sections and the two shelves. Needs-you oldest first (the longest wait on top), the rest newest first,
    /// as devd's `sortInbox`.
    static func group(_ items: [InboxItem]) -> Groups {
        func of(_ s: InboxSection) -> [InboxItem] { items.filter { $0.attention.section == s } }
        let newestFirst: (InboxItem, InboxItem) -> Bool = { $0.attention.since > $1.attention.since }
        return Groups(
            needsYou: of(.needsYou).sorted { $0.attention.since < $1.attention.since },
            working: of(.working).sorted(by: newestFirst),
            idle: items.filter { [.idle, .unknown].contains($0.attention.section) }.sorted(by: newestFirst),
            snoozed: of(.snoozed).sorted(by: newestFirst),
            settled: of(.settled).sorted(by: newestFirst)
        )
    }

    /// An `inbox` frame replaces that session's row (or adds it); a removal drops it.
    static func upsert(_ items: [InboxItem], _ change: InboxChange) -> [InboxItem] {
        switch change {
        case .removed(let id):
            return items.filter { $0.sessionId != id }
        case .item(let next):
            var out = items
            if let idx = out.firstIndex(where: { $0.sessionId == next.sessionId }) { out[idx] = next } else { out.append(next) }
            return out
        }
    }

    struct SnoozeTimes: Equatable {
        /// One hour from now (epoch ms).
        let hour: Int
        /// The next 9:00 local time: today before 9:00, else tomorrow.
        let morningAt: Int
        let morningLabel: String
    }

    static func snoozeTimes(now: Date, calendar: Calendar = .current) -> SnoozeTimes {
        let today = calendar.component(.hour, from: now) < 9
        let day = calendar.startOfDay(for: now)
        let base = today ? day : calendar.date(byAdding: .day, value: 1, to: day)!
        let at = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: base)!
        return SnoozeTimes(hour: ms(now) + 3_600_000, morningAt: ms(at), morningLabel: today ? "9:00" : "Tomorrow 9:00")
    }

    /// Why a row cannot be settled or snoozed (devd refuses it with 409 request-open), or nil.
    static func shelfBlock(_ i: InboxItem) -> String? {
        i.attention.reason == .request ? "Answer the open request first" : nil
    }

    static func reasonLabel(_ r: AttentionReason?) -> String {
        guard let r else { return "" }
        switch r {
        case .request: return "waiting for your answer"
        case .failed: return "run failed"
        case .rateLimited: return "rate limit reached — wait or switch model"
        case .completed: return "finished"
        case .disconnected: return "agent not connected"
        case .bridgeBehind: return "bridge log behind — events may be missing"
        case .running: return "running"
        case .background: return "background work"
        case .queued: return "queued"
        case .prChecks: return "waiting for CI checks"
        case .ciFailed: return "CI failed"
        case .unknown: return "" // a reason of a later devd: the row still shows its section
        }
    }

    /// Reasons shown in red (the dashboard's danger dot).
    static func isProblem(_ r: AttentionReason?) -> Bool {
        [.failed, .rateLimited, .disconnected, .bridgeBehind, .ciFailed].contains(r)
    }

    static func ms(_ d: Date) -> Int { Int((d.timeIntervalSince1970 * 1000).rounded()) }

    // MARK: - Row presentation (inboxView.ts: splitNeedsYou, rowStatus, statusParts, projectBadge, rowTitle)

    /// "Needs you" holds two asks: something to act on, and a run that merely finished unseen (`completed`). The
    /// screen shows them as separate groups; finished reads newest first, the rest keeps devd's order.
    static func splitNeedsYou(_ needsYou: [InboxItem]) -> (action: [InboxItem], finished: [InboxItem]) {
        (needsYou.filter { $0.attention.reason != .completed },
         needsYou.filter { $0.attention.reason == .completed }.sorted { $0.attention.since > $1.attention.since })
    }

    /// How many sessions need you: those asking for action, not the runs that merely finished (the sidebar's
    /// Needs you group, the menu bar count, the dashboard's back row).
    static func needsYouCount(_ items: [InboxItem]) -> Int { splitNeedsYou(group(items).needsYou).action.count }

    enum Tone: Equatable { case action, danger, done, busy, quiet }

    struct Mark: Equatable {
        let label: String
        let tone: Tone
    }

    /// The chip for a reason whatever shelf the row is on (the outcome mark of a finished or settled run).
    static func reasonStatus(_ r: AttentionReason?) -> Mark? {
        switch r {
        case nil, .unknown?: return nil
        case .request?: return Mark(label: "Needs answer", tone: .action)
        case .failed?: return Mark(label: "Failed", tone: .danger)
        case .rateLimited?: return Mark(label: "Rate limited", tone: .danger)
        case .disconnected?: return Mark(label: "Disconnected", tone: .danger)
        case .bridgeBehind?: return Mark(label: "Bridge behind", tone: .danger)
        case .ciFailed?: return Mark(label: "CI failed", tone: .danger)
        case .completed?: return Mark(label: "Done", tone: .done)
        case .running?: return Mark(label: "Working", tone: .busy)
        case .background?: return Mark(label: "Background", tone: .busy)
        case .queued?: return Mark(label: "Queued", tone: .busy)
        case .prChecks?: return Mark(label: "CI running", tone: .busy)
        }
    }

    /// A row's chip: snoozed rows say so, settled and reasonless rows have none.
    static func rowStatus(_ i: InboxItem) -> Mark? {
        if i.attention.section == .snoozed { return Mark(label: "Snoozed", tone: .quiet) }
        if i.attention.section == .settled { return nil }
        return reasonStatus(i.attention.reason)
    }

    struct StatusParts: Equatable {
        let mark: Mark?
        let showLabel: Bool
        let until: Int?
        let ago: String
    }

    /// What a row's meta line says about its state, or nil when there is nothing to say. `compact` rows (groups
    /// whose heading names the state) show only the mark, except a danger mark keeps its label: touch has no tooltip.
    static func statusParts(_ i: InboxItem, now: Int, compact: Bool) -> StatusParts? {
        let a = i.attention
        let mark = compact ? reasonStatus(a.reason) : rowStatus(i)
        let ago = a.since > 0 ? shortAgo(now - a.since) : ""
        if mark == nil && ago.isEmpty && a.until == nil { return nil }
        return StatusParts(mark: mark, showLabel: mark != nil && (!compact || mark?.tone == .danger), until: a.until, ago: ago)
    }

    /// The meta line's trailing parts after the state, each set off by a "·": the agent, and "tmux" for a terminal.
    static func metaTail(_ i: InboxItem, showAgent: Bool) -> [String] {
        (showAgent ? [AgentProfiles.profile(for: AgentName(rawValue: i.agent)).short] : []) + (i.runtime == .tmux ? ["tmux"] : [])
    }

    /// Whether the inbox mixes agents: only then does a row name its agent (inboxView.ts mixedAgents). Taken over the
    /// whole inbox, not the rows a search leaves, so a row's look does not change as the user types. With one agent
    /// everywhere the label or glyph says nothing.
    static func mixedAgents(_ items: [InboxItem]) -> Bool { Set(items.map(\.agent)).count > 1 }

    /// What a row says of its branch: devd's own `session/<repo>-<n>` repeats the repo, so only "#n", and nothing
    /// when the title is the one derived from it ("api #14", no name or topic); any other branch as recorded; nil
    /// without one.
    static func branchLabel(_ i: InboxItem) -> String? {
        guard let branch = i.branch, !branch.isEmpty else { return nil }
        let own = "session/\(i.repo)-"
        guard branch.hasPrefix(own) else { return branch }
        let n = branch.dropFirst(own.count)
        guard !n.isEmpty, n.allSatisfy(\.isASCII), n.allSatisfy(\.isNumber) else { return branch }
        return rowTitle(i) == "\(i.repo) #\(n)" ? nil : "#\(n)"
    }

    /// Compact elapsed time: "now", "7m", "3h", "2d".
    static func shortAgo(_ ms: Int) -> String {
        let min = max(0, ms) / 60_000
        if min < 1 { return "now" }
        if min < 60 { return "\(min)m" }
        let h = min / 60
        return h < 24 ? "\(h)h" : "\(h / 24)d"
    }

    /// A project's badge: up to two letters from its name's words and a stable colour slot (0-5), the same slot as
    /// the dashboard's for the same name.
    static func projectBadge(_ project: String) -> (letters: String, slot: Int) {
        let words = project.split(whereSeparator: { !($0.isLetter || $0.isNumber) }).map(String.init)
        let letters = words.count > 1 ? String(words[0].prefix(1)) + String(words[1].prefix(1)) : String((words.first ?? "?").prefix(2))
        var h: UInt32 = 0
        for c in project.unicodeScalars { h = h &* 31 &+ c.value }
        return (letters.uppercased(), Int(h % 6))
    }

    private static let previewRules: [(NSRegularExpression, String)] = [
        ("`+", ""), (#"\*\*(.+?)\*\*"#, "$1"), (#"(?<=^|\s)__(\S(?:.*?\S)?)__(?=$|\s|[,;:!?)])"#, "$1"), (#"^#+\s+"#, ""), (#"\s+"#, " "),
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    /// The Mac sidebar's search: every word of `query` in the row's title, topic, project, repo, branch or last message, ignoring
    /// case and diacritics. An empty query matches every row.
    static func matches(_ i: InboxItem, _ query: String) -> Bool {
        let words = query.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let hay = [i.title, i.topic ?? "", i.project, i.repo, i.branch ?? "", i.lastText ?? ""].joined(separator: " ")
        return words.allSatisfy { hay.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    /// A message preview as plain text: markdown's code ticks, emphasis and heading marks would show raw in one line.
    /// `__x__` only between spaces or line edges, so names like `__init__.py` stay whole.
    static func plainPreview(_ t: String) -> String {
        previewRules.reduce(t) { s, rule in
            rule.0.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: rule.1)
        }.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What a session is called, in the sidebar, the inbox and the thread headers alike (inboxView.ts rowTitle): a
    /// custom name, else devd's `topic` (from the first message, stable for the thread's life), else the repo and the
    /// session's number from its id ("api #14"). Never `lastText`: it changes with every reply.
    static func rowTitle(_ i: InboxItem) -> String {
        sessionTitle(sessionId: i.sessionId, name: i.title == "\(i.project)/\(i.repo)" ? nil : i.title, project: i.project, repo: i.repo, topic: i.topic)
    }

    /// The chain behind `rowTitle`, for a screen that has the session but not its inbox item (the iPhone thread).
    static func sessionTitle(sessionId: String, name: String?, project: String, repo: String, topic: String?) -> String {
        if let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        if let topic, !topic.isEmpty { return topic }
        if let r = sessionId.range(of: "-\(repo)-", options: .backwards) {
            let n = sessionId[r.upperBound...]
            if !n.isEmpty, n.allSatisfy(\.isASCII), n.allSatisfy(\.isNumber) { return "\(repo) #\(n)" }
        }
        return repo
    }
}

/// The inbox over devd's stream: the list loads when the stream opens, `inbox` frames update it, and while the
/// stream is down it is polled every 5 s (`paused`), as the dashboard's useEventStream does.
@MainActor
final class InboxStore: ObservableObject {
    typealias Connect = (_ path: String, _ lastEventId: String?) async throws -> AsyncThrowingStream<String, Error>

    /// nil until the first full list arrived (a single frame before it would read as the whole inbox).
    @Published var items: [InboxItem]?
    /// The last list load failed, with why.
    @Published private(set) var loadError: String?
    /// The stream is down; the list is polled meanwhile.
    @Published private(set) var paused = false
    /// The last frame that could not be read (also logged); the view may miss that update until the next load.
    @Published private(set) var badFrame: String?

    private static let logger = Logger(subsystem: "com.example.devbox", category: "Inbox")
    private let client: DevdClient
    private let connect: Connect
    private let pollInterval: Duration
    private var stream: EventStream?
    private var poll: Task<Void, Never>?
    /// Frames that arrived while a list load was in flight: the fetched list may predate them, so they are applied
    /// over it. Kept while any load runs (they overlap: the poll and a stream open).
    private var framesDuringLoad: [InboxChange] = []
    private var loadsInFlight = 0

    init(client: DevdClient, connect: Connect? = nil, pollInterval: Duration = .seconds(5)) {
        self.client = client
        self.connect = connect ?? { path, id in try await client.streamLines(path, lastEventId: id) }
        self.pollInterval = pollInterval
    }

    func load() async {
        loadsInFlight += 1
        let mark = framesDuringLoad.count
        defer {
            loadsInFlight -= 1
            if loadsInFlight == 0 { framesDuringLoad = [] }
        }
        do {
            let list: InboxList = try await client.get("/api/inbox")
            items = framesDuringLoad[mark...].reduce(list.items, InboxView.upsert)
            loadError = nil
        } catch {
            loadError = errorText(error)
        }
    }

    func start() {
        guard stream == nil else { return }
        let s = EventStream(
            connect: { [connect] id in try await connect("/api/stream", id) },
            onOpen: { [weak self] in
                guard let self else { return }
                paused = false
                stopPoll()
                Task { await self.load() }
            },
            onEvent: { [weak self] e in self?.handle(e) },
            onDrop: { [weak self] error in
                guard let self else { return }
                Self.logger.info("inbox stream dropped: \(error.map { String(describing: $0) } ?? "closed by devd", privacy: .public)")
                paused = true
                startPoll()
            }
        )
        stream = s
        s.start()
    }

    func stop() {
        stream?.stop()
        stream = nil
        stopPoll()
        paused = false
    }

    private func startPoll() {
        guard poll == nil else { return }
        poll = Task { [weak self, pollInterval] in
            while !Task.isCancelled {
                await self?.load()
                do { try await Task.sleep(for: pollInterval) } catch { return }
            }
        }
    }

    private func stopPoll() {
        poll?.cancel()
        poll = nil
    }

    private func handle(_ e: SSEParser.Event) {
        guard e.name == "inbox" else { return } // ping; thread frames come only with ?session=
        do {
            let change = try JSONDecoder().decode(InboxChange.self, from: Data(e.data.utf8))
            if loadsInFlight > 0 { framesDuringLoad.append(change) }
            if let cur = items { items = InboxView.upsert(cur, change) }
        } catch {
            Self.logger.error("unreadable inbox frame: \(String(describing: error), privacy: .public)")
            badFrame = "unreadable inbox update: \(errorText(error))"
        }
    }

    // MARK: - Row actions (any session, tmux too; each answers the session's new item)

    private struct SnoozeUntil: Encodable { let until: Int }
    private struct SnoozeUntilReset: Encodable { let untilReset = true }
    private struct Empty: Encodable {}

    func settle(_ id: String) async throws { apply(try await client.post("/api/sessions/\(pathSegment(id))/settle", body: Empty())) }
    /// Back into the inbox: ends a settle and a snooze.
    func unsettle(_ id: String) async throws { apply(try await client.post("/api/sessions/\(pathSegment(id))/unsettle", body: Empty())) }
    func snooze(_ id: String, until: Int) async throws {
        apply(try await client.post("/api/sessions/\(pathSegment(id))/snooze", body: SnoozeUntil(until: until)))
    }
    func snoozeUntilReset(_ id: String) async throws {
        apply(try await client.post("/api/sessions/\(pathSegment(id))/snooze", body: SnoozeUntilReset()))
    }
    /// A tmux session was looked at now: devd clears its finish or failure (204; 409 for a chat session, whose
    /// thread has its own seen marker).
    func seen(_ id: String) async throws { try await client.postVoid("/api/sessions/\(pathSegment(id))/seen", body: Empty()) }
    /// For the snooze menu: when the active limit resets, or devd's reason why "until reset" is not possible.
    func snoozeReset(_ id: String) async throws -> SnoozeReset {
        try await client.get("/api/sessions/\(pathSegment(id))/snooze-reset")
    }

    private func apply(_ item: InboxItem) {
        if loadsInFlight > 0 { framesDuringLoad.append(.item(item)) }
        if let cur = items { items = InboxView.upsert(cur, .item(item)) }
    }
}

/// A session or request id as one URL path segment.
func pathSegment(_ s: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove("/")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}
