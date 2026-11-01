import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here, not duplicated. Verifies the exact paths/methods/bodies per `dashboard/src/api.ts` and the pure
/// function `agentSwitchError`.
@MainActor
final class SessionActionsTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeActions(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> SessionActions {
        MockURLProtocol.handler = handler
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return SessionActions(client: DevdClient(endpoints: endpoints, session: makeSession()))
    }

    /// `URLSession` routinely turns `httpBody` into `httpBodyStream` before the request reaches
    /// `URLProtocol` — so we read both, so the test does not depend on which way it went.
    private func bodyJSON(_ request: URLRequest) -> [String: Any] {
        if let data = request.httpBody {
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    // MARK: - stop / restart — no body

    func testStopPostsToStopPathWithoutBody() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.stop("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/stop")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertNil(req.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertNil(req.httpBodyStream)
    }

    func testRestartPostsToRestartPathWithoutBody() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.restart("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/restart")
        XCTAssertEqual(req.httpMethod, "POST")
    }

    // MARK: - end — a nil soloAction omits the key, otherwise it is sent

    func testEndWithoutSoloActionOmitsKey() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.end("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/end")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertTrue(bodyJSON(req).isEmpty)
    }

    func testEndWithDeleteSoloActionSendsIt() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.end("dev-x", soloAction: .delete)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(bodyJSON(req)["soloAction"] as? String, "delete")
    }

    // MARK: - important / critic / name

    func testSetImportantPostsBoolBody() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.setImportant("dev-x", true)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/important")
        XCTAssertEqual(bodyJSON(req)["important"] as? Bool, true)
    }

    func testSetCriticPostsBoolBody() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.setCritic("dev-x", false)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/critic")
        XCTAssertEqual(bodyJSON(req)["critic"] as? Bool, false)
    }

    func testSetNamePostsNameBody() async throws {
        let actions = makeActions { _ in .init(statusCode: 204) }
        try await actions.setName("dev-x", "my nick")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/name")
        XCTAssertEqual(bodyJSON(req)["name"] as? String, "my nick")
    }

    // MARK: - switch account / switch agent

    func testSwitchAccountPostsEmptyBodyAndDecodesResponse() async throws {
        let json = """
        {"ok":true,"accountId":"max5","label":"max5","unchanged":false,"exhausted":false,
         "panes":[{"target":"pane0","outcome":"restarted"}]}
        """.data(using: .utf8)!
        let actions = makeActions { _ in .init(statusCode: 200, data: json) }

        let result = try await actions.switchAccount("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/switch-account")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertTrue(bodyJSON(req).isEmpty)
        XCTAssertEqual(result.ok, true)
        XCTAssertEqual(result.accountId, "max5")
        XCTAssertEqual(result.panes.first?.outcome, .restarted)
    }

    func testSwitchAgentPostsAgentBodyAndDecodesResponse() async throws {
        let json = """
        {"ok":true,"status":"switched","panes":[{"target":"pane0","outcome":"restarted"}]}
        """.data(using: .utf8)!
        let actions = makeActions { _ in .init(statusCode: 200, data: json) }

        let result = try await actions.switchAgent("dev-x", .codex)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/agent")
        XCTAssertEqual(bodyJSON(req)["agent"] as? String, "codex")
        XCTAssertEqual(result.status, .switched)
    }

    // MARK: - reviews

    func testReviewsGetsLimit5PathAndDecodesArray() async throws {
        let json = """
        [{"id":1,"session_id":"dev-x","turn_id":"t1","round":1,"verdict":"ok",
          "findings":"[]","evidence":null,"ms":10,"at":123}]
        """.data(using: .utf8)!
        let actions = makeActions { _ in .init(statusCode: 200, data: json) }

        let result = try await actions.reviews("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/reviews")
        XCTAssertEqual(req.url?.query, "limit=5")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(result.first?.verdict, .ok)
    }

    // MARK: - cc-upkeep run

    func testCcUpkeepRunPostsSessionBody() async throws {
        let actions = makeActions { _ in .init(statusCode: 200, data: "{}".data(using: .utf8)!) }
        try await actions.ccUpkeepRun("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/cc-upkeep/run")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(bodyJSON(req)["session"] as? String, "dev-x")
    }

    // MARK: - agentSwitchError (pure function, 1:1 port of sessionsView.ts)

    func testAgentSwitchErrorUnchangedIsNil() {
        let r = SwitchAgentResponse(ok: true, status: .unchanged, panes: [])
        XCTAssertNil(SessionActions.agentSwitchError(r, label: "Codex"))
    }

    func testAgentSwitchErrorNoAgent() {
        let r = SwitchAgentResponse(ok: true, status: .noAgent, panes: [])
        XCTAssertEqual(
            SessionActions.agentSwitchError(r, label: "Codex"),
            "No running agent found in the session — nothing switched."
        )
    }

    func testAgentSwitchErrorFailedWithoutStragglers() {
        let r = SwitchAgentResponse(ok: false, status: .failed, panes: [])
        XCTAssertEqual(
            SessionActions.agentSwitchError(r, label: "Codex"),
            "Couldn't switch any panel onto Codex — check the container."
        )
    }

    func testAgentSwitchErrorFailedWithStragglers() {
        let r = SwitchAgentResponse(
            ok: false, status: .failed,
            panes: [.init(target: "pane0", outcome: .stuckOnDialog)]
        )
        XCTAssertEqual(
            SessionActions.agentSwitchError(r, label: "Codex"),
            "Couldn't switch any panel onto Codex: pane0 (stuck-on-dialog)."
        )
    }

    func testAgentSwitchErrorSwitchedFullSuccessIsNil() {
        let r = SwitchAgentResponse(ok: true, status: .switched, panes: [.init(target: "pane0", outcome: .restarted)])
        XCTAssertNil(SessionActions.agentSwitchError(r, label: "Codex"))
    }

    func testAgentSwitchErrorSwitchedWithStragglers() {
        let r = SwitchAgentResponse(
            ok: true, status: .switched,
            panes: [.init(target: "pane0", outcome: .restarted), .init(target: "pane1", outcome: .didNotReturn)]
        )
        XCTAssertEqual(
            SessionActions.agentSwitchError(r, label: "Codex"),
            "Switched to Codex, but some panes stayed behind: pane1 (did-not-return)."
        )
    }

    // MARK: - New session: tree / openSession / openSolo

    func testTreeGetsTreePathAndDecodesArray() async throws {
        let json = """
        [{"folder":"acme","project":"shop","repos":[
          {"name":"web","cloneUrl":"https://x/web.git","provider":"github","cloned":false}
        ],"soloAgent":null}]
        """.data(using: .utf8)!
        let actions = makeActions { _ in .init(statusCode: 200, data: json) }

        let result = try await actions.tree()

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/tree")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(result.first?.folder, "acme")
        XCTAssertEqual(result.first?.repos.first?.name, "web")
    }

    private func openResultJSON(pullStatus: String? = nil) -> Data {
        let pull = pullStatus.map { #","pull":{"status":"\#($0)"}"# } ?? ""
        return """
        {"session":{"id":"dev-shop-web","folder":"acme","project":"shop","repo":"web",
         "container":"c1","status":"running","solo":0},"created":true\(pull)}
        """.data(using: .utf8)!
    }

    /// `cloneUrl`/`agent`/`fresh` with a value → the body sends them; also checks the path/method, same as
    /// `openSession`/`openSolo` v `api.ts` (`POST /api/sessions`).
    func testOpenSessionPostsFullBodyAndDecodesResult() async throws {
        let actions = makeActions { _ in .init(statusCode: 200, data: self.openResultJSON()) }

        let result = try await actions.openSession(
            folder: "acme", project: "shop", repo: "web",
            cloneUrl: "https://x/web.git", agent: .codex, fresh: true
        )

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions")
        XCTAssertEqual(req.httpMethod, "POST")
        let body = bodyJSON(req)
        XCTAssertEqual(body["folder"] as? String, "acme")
        XCTAssertEqual(body["project"] as? String, "shop")
        XCTAssertEqual(body["repo"] as? String, "web")
        XCTAssertEqual(body["cloneUrl"] as? String, "https://x/web.git")
        XCTAssertEqual(body["agent"] as? String, "codex")
        XCTAssertEqual(body["fresh"] as? Bool, true)
        XCTAssertEqual(result.session.id, "dev-shop-web")
        XCTAssertEqual(result.created, true)
    }

    /// `cloneUrl`/`agent`/`fresh` missing → the keys do not appear in the body at all (`encodeIfPresent`),
    /// just as `JSON.stringify` drops `undefined` on the web.
    func testOpenSessionOmitsAbsentOptionalKeys() async throws {
        let actions = makeActions { _ in .init(statusCode: 200, data: self.openResultJSON()) }

        _ = try await actions.openSession(folder: "acme", project: "shop", repo: "web", cloneUrl: nil, agent: nil, fresh: nil)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        let body = bodyJSON(req)
        XCTAssertNil(body["cloneUrl"])
        XCTAssertNil(body["agent"])
        XCTAssertNil(body["fresh"])
    }

    func testOpenSolosPostsSoloTrueAndDecodesResult() async throws {
        let actions = makeActions { _ in .init(statusCode: 200, data: self.openResultJSON()) }

        _ = try await actions.openSolo(folder: "acme", project: "shop", agent: .claude)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions")
        let body = bodyJSON(req)
        XCTAssertEqual(body["solo"] as? Bool, true)
        XCTAssertEqual(body["agent"] as? String, "claude")
        XCTAssertNil(body["repo"])
    }

    func testOpenSessionDecodesPullConflict() async throws {
        let actions = makeActions { _ in .init(statusCode: 200, data: self.openResultJSON(pullStatus: "conflict")) }

        let result = try await actions.openSession(folder: "acme", project: "shop", repo: "web", cloneUrl: nil, agent: nil, fresh: nil)

        XCTAssertEqual(result.pull?.status, "conflict")
    }

    // MARK: - AgentProfiles.normalize (1:1 zrcadlo agentNameFor z newSession.ts)

    func testNormalizeUnknownFallsBackToClaude() {
        XCTAssertEqual(AgentProfiles.normalize(.unknown), .claude)
    }

    func testNormalizeNilFallsBackToClaude() {
        XCTAssertEqual(AgentProfiles.normalize(nil), .claude)
    }

    func testNormalizeKnownAgentsPassThroughUnchanged() {
        for agent in AgentProfiles.ids {
            XCTAssertEqual(AgentProfiles.normalize(agent), agent)
        }
    }
}
