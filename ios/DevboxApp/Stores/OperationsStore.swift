import Foundation

/// View-model for `OperationsScreen`, mirrors `dashboard/src/pages/Operations.tsx` and `operationsView.ts`. Polls every
/// 5 s like the web: proposals and their execution move on the server without this screen.
@MainActor
final class OperationsStore: ObservableObject {
    struct Review: Equatable {
        let changes: [String]
        let afterWrite: Int?
        let requestId: Int?
        let problem: String?
    }

    @Published private(set) var rows: [OperationRow]?
    @Published private(set) var error: String?

    private let client: DevdClient
    private let pollInterval: Duration
    private var pollTask: Task<Void, Never>?

    init(client: DevdClient, pollInterval: Duration = .seconds(5)) {
        self.client = client
        self.pollInterval = pollInterval
    }

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

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    deinit { pollTask?.cancel() }

    func load() async {
        do {
            rows = try await client.get("/api/operations")
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    func approve(_ id: Int) async throws {
        try await client.postVoid("/api/operations/\(id)/approve", body: nil)
        await load()
    }

    func reject(_ id: Int) async throws {
        try await client.postVoid("/api/operations/\(id)/reject", body: nil)
        await load()
    }

    // MARK: - Pure (1:1 with operationsView.ts and Operations.tsx)

    /// Pending on top, otherwise newest first.
    nonisolated static func pendingFirst(_ rows: [OperationRow]) -> [OperationRow] {
        rows.sorted { a, b in
            let pa = a.status == "pending" ? 0 : 1, pb = b.status == "pending" ? 0 : 1
            return pa != pb ? pa < pb : a.id > b.id
        }
    }

    nonisolated static func params(_ r: OperationRow) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(r.params.utf8))) as? [String: Any] ?? [:]
    }

    /// The prepared changes and the SQL proposal a deployment waits for. Unreadable details block approval, never
    /// rejection.
    nonisolated static func review(_ r: OperationRow) -> Review {
        let unreadable = Review(changes: [], afterWrite: nil, requestId: nil,
                                problem: "Prepared operation details could not be read. Prepare the operation again before approval.")
        guard let p = (try? JSONSerialization.jsonObject(with: Data(r.params.utf8))) as? [String: Any] else { return unreadable }
        var changes: [String] = []
        if let raw = p["changes"] as? String {
            guard let list = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [Any],
                  let strings = list as? [String] else { return unreadable }
            changes = strings
        }
        func number(_ v: Any?) -> Int? {
            guard let s = v as? String, s.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil else { return nil }
            return Int(s)
        }
        return Review(changes: changes, afterWrite: number(p["afterWrite"]), requestId: number(p["requestId"]), problem: nil)
    }

    nonisolated static func statusLabel(_ r: OperationRow) -> String {
        if r.status == "approved", let sql = review(r).afterWrite { return "Approved · waiting for SQL #\(sql)" }
        let labels = ["pending": "Awaiting approval", "approved": "Approved · queued", "running": "Running",
                      "executed": "Executed", "failed": "Failed", "rejected": "Rejected"]
        return labels[r.status] ?? r.status
    }

    /// The app's name when the proposal names one, otherwise the operation.
    nonisolated static func title(_ r: OperationRow) -> String {
        params(r)["app"] as? String ?? r.op
    }

    /// The parameters worth showing, in key order (the web shows them in JSON order, which Foundation does not keep).
    nonisolated static func fields(_ r: OperationRow) -> [(key: String, value: String)] {
        let hidden: Set = ["app", "changes", "fingerprint", "idempotencyKey", "afterWrite"]
        return params(r).filter { !hidden.contains($0.key) }.sorted { $0.key < $1.key }.map { key, value in
            if let s = value as? String { return (key, s) }
            let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
            return (key, data.flatMap { String(data: $0, encoding: .utf8) } ?? "\(value)")
        }
    }

    /// `db-onboard` is approved through its database request (web only), never from the card.
    nonisolated static func canDecide(_ r: OperationRow) -> Bool {
        r.status == "pending" && r.op != "db-onboard"
    }

    nonisolated static func counts(_ rows: [OperationRow]) -> (pending: Int, inProgress: Int, completed: Int) {
        (rows.filter { $0.status == "pending" }.count,
         rows.filter { $0.status == "approved" || $0.status == "running" }.count,
         rows.filter { $0.status == "executed" }.count)
    }
}
