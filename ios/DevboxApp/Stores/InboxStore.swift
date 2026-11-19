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
            idle: of(.idle).sorted(by: newestFirst),
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
        }
    }

    /// Reasons shown in red (the dashboard's danger dot).
    static func isProblem(_ r: AttentionReason?) -> Bool {
        [.failed, .rateLimited, .disconnected, .bridgeBehind, .ciFailed].contains(r)
    }

    static func ms(_ d: Date) -> Int { Int((d.timeIntervalSince1970 * 1000).rounded()) }
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
