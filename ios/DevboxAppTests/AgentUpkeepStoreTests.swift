import XCTest
@testable import DevboxApp

/// Paths, bodies and the pure helpers against `dashboard/src/pages/AgentUpkeep.tsx`.
@MainActor
final class AgentUpkeepStoreTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private let empty = #"{"provider":"claude","latest":"2.0.0","image":null,"mode":"nightly","sessions":[]}"#.data(using: .utf8)!
    private let result = #"{"provider":"codex","updated":["a"],"restarted":[],"deferred":["b"],"failed":[],"unchanged":["c","d"],"built":false}"#.data(using: .utf8)!

    private func makeStore() -> AgentUpkeepStore {
        MockURLProtocol.handler = { [empty, result] req in .init(statusCode: 200, data: req.httpMethod == "POST" ? result : empty) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://100.100.100.100:4300")!)
        return AgentUpkeepStore(client: DevdClient(endpoints: endpoints, session: URLSession(configuration: config)))
    }

    private func session(_ version: String?, running: Int? = 1, restart: Bool? = false, project: String = "acme", repo: String = "web") -> AgentUpkeepSession {
        AgentUpkeepSession(id: "dev-\(project)-\(repo)", project: project, repo: repo, version: version, running: running, restartRequired: restart)
    }

    private func bodyJSON(_ request: URLRequest) -> [String: Any] {
        if let data = request.httpBody { return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:] }
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

    func testDemoFixtureDecodes() throws {
        let data = try JSONSerialization.data(withJSONObject: DashboardFixtures.upkeep)
        XCTAssertFalse(try JSONDecoder().decode(AgentUpkeepStatus.self, from: data).sessions.isEmpty)
    }

    func testSelectingAProviderLoadsItsStatus() async {
        let store = makeStore()
        await store.load()
        await store.select(.codex)
        XCTAssertEqual(MockURLProtocol.capturedRequests.map { $0.url?.query }, ["provider=claude", "provider=codex"])
        XCTAssertEqual(store.provider, .codex)
    }

    func testRunPostsTheProviderAndSessionAndSummarises() async throws {
        let store = makeStore()
        await store.select(.codex)
        await store.run(session: "dev-acme-web")
        let post = try XCTUnwrap(MockURLProtocol.capturedRequests.first { $0.httpMethod == "POST" })
        XCTAssertEqual(post.url?.path, "/api/agent-upkeep/run")
        XCTAssertEqual(bodyJSON(post) as? [String: String], ["provider": "codex", "session": "dev-acme-web"])
        XCTAssertEqual(store.result, "Installed in 1 session(s) · Deferred: b (active work or update cooldown) · 2 already current")
        XCTAssertFalse(store.busy)
    }

    func testSummaryWithoutChangesSaysSo() {
        let r = AgentUpkeepResult(updated: [], restarted: [], deferred: [], failed: [], unchanged: [], built: false, error: nil)
        XCTAssertEqual(AgentUpkeepStore.summary(r), "No changes confirmed. Review the refreshed versions and session history.")
    }

    func testOlderComparesNumericParts() {
        XCTAssertTrue(AgentUpkeepStore.older("2.9.0", "2.10.0"))
        XCTAssertFalse(AgentUpkeepStore.older("2.10.0", "2.9.0"))
        XCTAssertFalse(AgentUpkeepStore.older("2.4.1", "2.4.1"))
        XCTAssertTrue(AgentUpkeepStore.older("1.0.0", "1.0.1"))
    }

    func testSessionStateFollowsTheWebOrder() {
        XCTAssertEqual(AgentUpkeepStore.state(session("2.3.0", restart: true), latest: "2.4.0"), .update)
        XCTAssertEqual(AgentUpkeepStore.state(session("2.4.0", restart: true), latest: "2.4.0"), .reopen)
        XCTAssertEqual(AgentUpkeepStore.state(session("2.4.0", running: nil), latest: "2.4.0"), .unknown)
        XCTAssertEqual(AgentUpkeepStore.state(session(nil), latest: "2.4.0"), .unknown)
        XCTAssertEqual(AgentUpkeepStore.state(session("2.4.0"), latest: nil), .unknown)
        XCTAssertEqual(AgentUpkeepStore.state(session("2.4.0"), latest: "2.4.0"), .current)
    }

    func testAntigravityHasNoUpdate() {
        XCTAssertFalse(AgentUpkeepStore.canUpdate(.agy))
        XCTAssertTrue(AgentUpkeepStore.canUpdate(.claude))
        XCTAssertEqual(AgentUpkeepStore.label(.update, provider: .agy), "Newer version available — rebuild the devbox image")
    }

    func testFilterBySearchAndRepository() {
        let all = [session("2.4.0"), session("2.3.0", project: "orchard", repo: "sync")]
        XCTAssertEqual(AgentUpkeepStore.repositories(all), ["acme/web", "orchard/sync"])
        XCTAssertEqual(AgentUpkeepStore.filter(all, search: " SYNC ", repo: "").map(\.repo), ["sync"])
        XCTAssertEqual(AgentUpkeepStore.filter(all, search: "", repo: "acme/web").map(\.repo), ["web"])
        XCTAssertEqual(AgentUpkeepStore.filter(all, search: "2.3", repo: "acme/web").map(\.repo), [])
    }
}
