import Foundation

/// View-model for `ProdWritesScreen` — mirrors `dashboard/src/pages/ProdWrites.tsx`. Polls like the
/// web (every 5 s, `setInterval`) — approved/denied writes to the production DB also happen outside the app (on
/// the web, or automatically by an agent) and the queue should move on its own, not only after a manual refresh.
@MainActor
final class ProdWritesStore: ObservableObject {
    @Published private(set) var rows: [ProdWrite]?
    @Published private(set) var error: String?
    @Published private(set) var previews: [Int: String] = [:]

    private let client: DevdClient
    private let pollInterval: Duration
    private var pollTask: Task<Void, Never>?

    init(client: DevdClient, pollInterval: Duration = .seconds(5)) {
        self.client = client
        self.pollInterval = pollInterval
    }

    /// Idempotent — a second call without `stop()` in between does not double the polling.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.load()
                if Task.isCancelled { return }
                try? await Task.sleep(for: self.pollInterval)
            }
        }
    }

    /// Idempotent — calling it without running polling is a no-op.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    deinit {
        pollTask?.cancel()
    }

    func load() async {
        do {
            rows = try await client.get("/api/prod-db/writes")
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    private struct ActionResult: Decodable { let rows: Int; let note: String }

    /// GET, not a mutation — `dashboard/src/api.ts` `prodWritePreview` sends it without a body/method.
    func loadPreview(_ id: Int) async {
        do {
            let resp: ActionResult = try await client.get("/api/prod-db/writes/\(id)/preview")
            previews[id] = resp.note
        } catch {
            previews[id] = "preview failed: \(errorText(error))"
        }
    }

    /// Mutation of the PRODUCTION database — the app only WIRES it up (see the `ProdWritesScreen` confirm dialogs),
    /// it never runs it on its own.
    func approve(_ id: Int) async throws {
        let _: ActionResult = try await client.post("/api/prod-db/writes/\(id)/approve", body: nil)
        await load()
    }

    func reject(_ id: Int) async throws {
        try await client.postVoid("/api/prod-db/writes/\(id)/reject", body: nil)
        await load()
    }

    // MARK: - Pure

    nonisolated static func pending(_ rows: [ProdWrite]) -> [ProdWrite] {
        rows.filter { $0.status == .pending }
    }

    nonisolated static func past(_ rows: [ProdWrite]) -> [ProdWrite] {
        rows.filter { $0.status != .pending }
    }

    /// 1:1 `STATUS_LABEL` z `dashboard/src/pages/ProdWrites.tsx`.
    nonisolated static func statusLabel(_ status: ProdWrite.Status) -> String {
        switch status {
        case .pending: return "waiting"
        case .approved: return "approved"
        case .executed: return "executed"
        case .failed: return "error"
        case .rejected: return "rejected"
        }
    }

}
