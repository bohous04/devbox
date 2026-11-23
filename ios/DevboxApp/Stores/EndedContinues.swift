import Foundation

/// Continues of ended sessions in flight (POST /api/ended/:id/continue), one per transcript: a second press, or the
/// transcript opened again on the iPhone or in another Mac window, joins the running one instead of starting another
/// session (devd refuses a second one too, 409). Shared like TmuxTabMemory: the iPhone's transcript screen is built
/// outside the inbox screen that owns the InboxStore.
@MainActor
final class EndedContinues: ObservableObject {
    static let shared = EndedContinues()

    @Published private(set) var running: Set<String> = []
    private var tasks: [String: Task<ContinueResult, Error>] = [:]

    /// `start` runs only when no continue of `id` is in flight.
    func run(_ id: String, _ start: @escaping () async throws -> ContinueResult) async throws -> ContinueResult {
        if let task = tasks[id] { return try await task.value }
        let task = Task { try await start() }
        tasks[id] = task
        running.insert(id)
        defer { tasks[id] = nil; running.remove(id) }
        return try await task.value
    }

    func start(_ id: String, client: DevdClient) async throws -> ContinueResult {
        try await run(id) { try await client.post("/api/ended/\(pathSegment(id))/continue", body: nil, timeout: 300) }
    }
}
