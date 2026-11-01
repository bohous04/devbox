import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here, not duplicated. Verifies the exact paths/methods/bodies per `dashboard/src/api.ts`
/// (`updateSchedule`/`runSchedule`/`deleteSchedule`) — for this the app extends `DevdClient`
/// with generic `put`/`deleteVoid` (nothing else in the app has needed PUT/DELETE so far).
@MainActor
final class CronStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> CronStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return CronStore(client: DevdClient(endpoints: endpoints, session: session))
    }

    private func schedule(id: String = "s1", enabled: Int = 1, important: Int = 0) -> Schedule {
        Schedule(
            id: id, name: "Nightly", cron: "0 3 * * *", folder: "f", project: "p", repo: "r",
            clone_url: "https://x/r.git", prompt: "do stuff", important: important, enabled: enabled, last_run_at: nil
        )
    }

    /// `URLSession` routinely turns `httpBody` into `httpBodyStream` before the request reaches
    /// `URLProtocol` — so we read both (same pattern as `SessionActionsTests`).
    private func bodyJSON(_ request: URLRequest) -> [String: Any] {
        if let data = request.httpBody {
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func scheduleJSON(_ s: Schedule) -> Data {
        #"{"id":"\#(s.id)","name":"\#(s.name)","cron":"\#(s.cron)","folder":"\#(s.folder)","project":"\#(s.project)","repo":"\#(s.repo)","clone_url":"\#(s.clone_url)","prompt":"\#(s.prompt)","important":\#(s.important),"enabled":\#(s.enabled),"last_run_at":null}"#
            .data(using: .utf8)!
    }

    // MARK: - load

    func testLoadGetsSchedulesPath() async {
        let store = makeStore { _ in .init(statusCode: 200, data: "[]".data(using: .utf8)!) }
        await store.load()
        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/schedules")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(store.schedules?.count, 0)
    }

    // MARK: - setEnabled / setImportant (PUT with a partial body)

    func testSetEnabledPutsOnlyEnabledKeyThenReloads() async throws {
        let s = schedule(enabled: 1)
        var callCount = 0
        let store = makeStore { req in
            callCount += 1
            if req.httpMethod == "PUT" { return .init(statusCode: 200, data: self.scheduleJSON(self.schedule(enabled: 0))) }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.setEnabled(s)

        let putReq = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(putReq.url?.path, "/api/schedules/s1")
        XCTAssertEqual(putReq.httpMethod, "PUT")
        let body = bodyJSON(putReq)
        XCTAssertEqual(body["enabled"] as? Int, 0, "enabled==1 toggles to 0")
        XCTAssertNil(body["important"], "the patch carries only the CHANGED field, not the whole Schedule")
        XCTAssertEqual(callCount, 2, "after a mutation the app refetches the whole list (same as the web)")
    }

    func testSetImportantPutsOnlyImportantKey() async throws {
        let s = schedule(important: 0)
        let store = makeStore { req in
            if req.httpMethod == "PUT" { return .init(statusCode: 200, data: self.scheduleJSON(self.schedule(important: 1))) }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.setImportant(s)

        let putReq = MockURLProtocol.capturedRequests[0]
        let body = bodyJSON(putReq)
        XCTAssertEqual(body["important"] as? Int, 1)
        XCTAssertNil(body["enabled"])
    }

    // MARK: - run (POST without a body)

    func testRunPostsToRunPathWithoutReloading() async throws {
        let store = makeStore { _ in .init(statusCode: 204) }

        try await store.run(schedule())

        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1, "the web does not reload after run either — it just starts it")
        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/schedules/s1/run")
        XCTAssertEqual(req.httpMethod, "POST")
    }

    // MARK: - delete (DELETE + reload)

    func testDeleteSendsDeleteMethodThenReloads() async throws {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            return .init(statusCode: req.httpMethod == "DELETE" ? 204 : 200, data: "[]".data(using: .utf8)!)
        }

        try await store.delete(schedule())

        XCTAssertEqual(paths, ["/api/schedules/s1", "/api/schedules"])
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].httpMethod, "DELETE")
    }
}
