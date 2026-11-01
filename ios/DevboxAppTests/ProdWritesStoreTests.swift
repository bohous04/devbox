import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here, not duplicated. Verifies the exact paths/methods per `dashboard/src/api.ts`
/// (`prodWritePreview` is GET, `prodWriteApprove`/`prodWriteReject` are POST) and the pure helpers
/// pending/past/statusLabel.
@MainActor
final class ProdWritesStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> ProdWritesStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return ProdWritesStore(client: DevdClient(endpoints: endpoints, session: session))
    }

    private func write(id: Int, status: ProdWrite.Status) -> ProdWrite {
        ProdWrite(id: id, ts: 1000, session_id: "dev-x-y", db: "prod", sql: "UPDATE x SET y=1", status: status, decided_at: nil, result: nil, error: nil)
    }

    // MARK: - pending / past

    func testPendingAndPastPartitionByStatus() {
        let rows = [write(id: 1, status: .pending), write(id: 2, status: .executed), write(id: 3, status: .rejected)]
        XCTAssertEqual(ProdWritesStore.pending(rows).map(\.id), [1])
        XCTAssertEqual(ProdWritesStore.past(rows).map(\.id), [2, 3])
    }

    // MARK: - statusLabel

    func testStatusLabelMatchesWebStrings() {
        XCTAssertEqual(ProdWritesStore.statusLabel(.pending), "waiting")
        XCTAssertEqual(ProdWritesStore.statusLabel(.approved), "approved")
        XCTAssertEqual(ProdWritesStore.statusLabel(.executed), "executed")
        XCTAssertEqual(ProdWritesStore.statusLabel(.failed), "error")
        XCTAssertEqual(ProdWritesStore.statusLabel(.rejected), "rejected")
    }

    // MARK: - load

    func testLoadGetsProdDbWritesPath() async {
        let store = makeStore { _ in .init(statusCode: 200, data: "[]".data(using: .utf8)!) }
        await store.load()
        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/prod-db/writes")
        XCTAssertEqual(req.httpMethod, "GET")
    }

    // MARK: - preview (GET, ne mutace)

    func testLoadPreviewIsAGetRequest() async {
        let json = "{\"rows\":3,\"note\":\"3 rows affected\"}".data(using: .utf8)!
        let store = makeStore { _ in .init(statusCode: 200, data: json) }

        await store.loadPreview(7)

        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/prod-db/writes/7/preview")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(store.previews[7], "3 rows affected")
    }

    func testLoadPreviewFailureStoresErrorMessage() async {
        let store = makeStore { _ in .init(statusCode: 500) }
        await store.loadPreview(7)
        XCTAssertTrue(store.previews[7]?.hasPrefix("preview failed:") == true)
    }

    // MARK: - approve / reject (POST + reload)

    func testApprovePostsToApprovePathThenReloads() async throws {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            if req.url?.path.hasSuffix("/approve") == true {
                return .init(statusCode: 200, data: "{\"rows\":1,\"note\":\"ok\"}".data(using: .utf8)!)
            }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.approve(9)

        XCTAssertEqual(paths, ["/api/prod-db/writes/9/approve", "/api/prod-db/writes"])
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].httpMethod, "POST")
    }

    func testRejectPostsToRejectPathThenReloads() async throws {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            return .init(statusCode: req.url?.path.hasSuffix("/reject") == true ? 204 : 200, data: "[]".data(using: .utf8)!)
        }

        try await store.reject(9)

        XCTAssertEqual(paths, ["/api/prod-db/writes/9/reject", "/api/prod-db/writes"])
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].httpMethod, "POST")
    }
}
