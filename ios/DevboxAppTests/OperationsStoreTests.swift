import XCTest
@testable import DevboxApp

/// Paths and the pure helpers against `dashboard/src/operationsView.ts` and `pages/Operations.tsx`.
@MainActor
final class OperationsStoreTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore() -> OperationsStore {
        MockURLProtocol.handler = { req in .init(statusCode: req.httpMethod == "POST" ? 204 : 200, data: req.httpMethod == "POST" ? Data() : "[]".data(using: .utf8)!) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://100.100.100.100:4300")!)
        return OperationsStore(client: DevdClient(endpoints: endpoints, session: URLSession(configuration: config)))
    }

    private func row(_ id: Int, _ status: String, op: String = "deploy", params: String = "{}") -> OperationRow {
        OperationRow(id: id, ts: 0, session_id: nil, op: op, params: params, status: status, result: nil, error: nil)
    }

    func testDemoFixtureDecodes() throws {
        let data = try JSONSerialization.data(withJSONObject: DashboardFixtures.operations(now: Date()))
        let rows = try JSONDecoder().decode([OperationRow].self, from: data)
        XCTAssertTrue(rows.allSatisfy { OperationsStore.review($0).problem == nil })
    }

    func testApproveAndRejectPostThenReload() async throws {
        let store = makeStore()
        try await store.approve(7)
        try await store.reject(8)
        XCTAssertEqual(MockURLProtocol.capturedRequests.map { "\($0.httpMethod!) \($0.url!.path)" }, [
            "POST /api/operations/7/approve", "GET /api/operations", "POST /api/operations/8/reject", "GET /api/operations",
        ])
    }

    func testPendingFirstThenNewest() {
        let sorted = OperationsStore.pendingFirst([row(1, "executed"), row(2, "pending"), row(3, "failed"), row(4, "pending")])
        XCTAssertEqual(sorted.map(\.id), [4, 2, 3, 1])
    }

    func testReviewReadsChangesAndDependencies() {
        let ok = OperationsStore.review(row(1, "pending", params: #"{"changes":"[\"a\",\"b\"]","afterWrite":"9","requestId":"012"}"#))
        XCTAssertEqual(ok, .init(changes: ["a", "b"], afterWrite: 9, requestId: nil, problem: nil))
        XCTAssertNotNil(OperationsStore.review(row(1, "pending", params: "nope")).problem)
        XCTAssertNotNil(OperationsStore.review(row(1, "pending", params: #"{"changes":"[1]"}"#)).problem)
        XCTAssertEqual(OperationsStore.review(row(1, "pending", params: #"{"app":"x"}"#)).changes, [])
    }

    func testStatusLabels() {
        XCTAssertEqual(OperationsStore.statusLabel(row(1, "pending")), "Awaiting approval")
        XCTAssertEqual(OperationsStore.statusLabel(row(1, "approved", params: #"{"afterWrite":"4"}"#)), "Approved · waiting for SQL #4")
        XCTAssertEqual(OperationsStore.statusLabel(row(1, "approved")), "Approved · queued")
        XCTAssertEqual(OperationsStore.statusLabel(row(1, "weird")), "weird")
    }

    func testTitleFieldsAndDecisions() {
        let r = row(1, "pending", params: #"{"app":"acme-web","branch":"main","changes":"[]","fingerprint":"f","replicas":2}"#)
        XCTAssertEqual(OperationsStore.title(r), "acme-web")
        XCTAssertEqual(OperationsStore.fields(r).map { "\($0.key)=\($0.value)" }, ["branch=main", "replicas=2"])
        XCTAssertEqual(OperationsStore.title(row(1, "pending")), "deploy")
        XCTAssertTrue(OperationsStore.canDecide(r))
        XCTAssertFalse(OperationsStore.canDecide(row(1, "pending", op: "db-onboard")))
        XCTAssertFalse(OperationsStore.canDecide(row(1, "executed")))
    }

    func testCounts() {
        let c = OperationsStore.counts([row(1, "pending"), row(2, "approved"), row(3, "running"), row(4, "executed"), row(5, "failed")])
        XCTAssertEqual([c.pending, c.inProgress, c.completed], [1, 2, 1])
    }
}
