import XCTest
@testable import DevboxApp

/// Terminal sharing from the session detail (Task 7). `MockURLProtocol` is defined in
/// `DevdClientTests.swift` (same test target) — reused here, not duplicated.
final class ShareTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeClient(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> DevdClient {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return DevdClient(endpoints: endpoints, session: URLSession(configuration: config))
    }

    /// `URLSession` routinely turns `httpBody` into `httpBodyStream` before the request reaches
    /// `URLProtocol` — so we read both, same as `SessionActionsTests`.
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

    // MARK: - TerminalShare / ActiveShare decoding (Models.swift)

    func testTerminalShareDecodesCreateResponse() throws {
        let json = #"{"id":"sh1","url":"https://share.example.com/s/tok123","expiresAt":1760000000000}"#
            .data(using: .utf8)!

        let share = try JSONDecoder().decode(TerminalShare.self, from: json)

        XCTAssertEqual(share.id, "sh1")
        XCTAssertEqual(share.url, "https://share.example.com/s/tok123")
        XCTAssertEqual(share.expiresAt, 1_760_000_000_000)
    }

    func testActiveShareDecodesListRowWithNullName() throws {
        let json = #"{"id":"sh1","session_id":"dev-x","name":null,"created_at":1,"expires_at":2,"revoked_at":null}"#
            .data(using: .utf8)!

        let share = try JSONDecoder().decode(ActiveShare.self, from: json)

        XCTAssertEqual(share.id, "sh1")
        XCTAssertEqual(share.session_id, "dev-x")
        XCTAssertNil(share.name)
        XCTAssertEqual(share.created_at, 1)
        XCTAssertEqual(share.expires_at, 2)
    }

    func testActiveShareDecodesListRowWithName() throws {
        let json = #"{"id":"sh1","session_id":"dev-x","name":"web","created_at":1,"expires_at":2}"#
            .data(using: .utf8)!

        let share = try JSONDecoder().decode(ActiveShare.self, from: json)

        XCTAssertEqual(share.name, "web")
    }

    // MARK: - SessionLive.host (InstaBox gating)

    func testSessionLiveDecodesInstaboxHost() throws {
        let json = """
        {"id":"dev-x","folder":"f","project":"p","repo":"r","container":"c","port_base":4100,
         "status":"running","solo":0,"created_at":1,"last_active_at":1,"ports":[],
         "claudeState":"idle","workspace":"w","important":0,"accountId":null,"host":"instabox"}
        """.data(using: .utf8)!

        let session = try JSONDecoder().decode(SessionLive.self, from: json)

        XCTAssertEqual(session.host, .instabox)
    }

    func testSessionLiveHostMissingDecodesAsNil() throws {
        let json = """
        {"id":"dev-x","folder":"f","project":"p","repo":"r","container":"c","port_base":4100,
         "status":"running","solo":0,"created_at":1,"last_active_at":1,"ports":[],
         "claudeState":"idle","workspace":"w","important":0,"accountId":null}
        """.data(using: .utf8)!

        let session = try JSONDecoder().decode(SessionLive.self, from: json)

        XCTAssertNil(session.host)
    }

    // MARK: - DevdClient.createShare: request body {minutes} + decode

    func testCreateSharePostsMinutesBodyAndDecodesResult() async throws {
        let json = #"{"id":"sh1","url":"https://share.example.com/s/tok123","expiresAt":1760000000000}"#
            .data(using: .utf8)!
        let client = makeClient { _ in .init(statusCode: 201, data: json) }

        let result = try await client.createShare(sessionId: "dev-x", minutes: 240)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/shares")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(bodyJSON(req)["minutes"] as? Int, 240)
        XCTAssertEqual(result.id, "sh1")
        XCTAssertEqual(result.url, "https://share.example.com/s/tok123")
        XCTAssertEqual(result.expiresAt, 1_760_000_000_000)
    }

    // MARK: - DevdClient.shares: GET /api/shares

    func testSharesGetsSharesPathAndDecodesArray() async throws {
        let json = #"[{"id":"sh1","session_id":"dev-x","name":null,"created_at":1,"expires_at":2}]"#
            .data(using: .utf8)!
        let client = makeClient { _ in .init(statusCode: 200, data: json) }

        let result = try await client.shares()

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/shares")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(result.first?.id, "sh1")
        XCTAssertEqual(result.first?.session_id, "dev-x")
    }

    // MARK: - DevdClient.revokeShare: DELETE /api/shares/:id

    func testRevokeShareDeletesSharePathWithoutBody() async throws {
        let client = makeClient { _ in .init(statusCode: 204) }

        try await client.revokeShare("sh1")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/shares/sh1")
        XCTAssertEqual(req.httpMethod, "DELETE")
        XCTAssertNil(req.httpBodyStream)
    }

    // MARK: - Server error text surfaced via errorText (400/404/409 — brief requirement)

    func testCreateShareSurfaces409ServerErrorText() async {
        let json = #"{"error":"session is not running"}"#.data(using: .utf8)!
        let client = makeClient { _ in .init(statusCode: 409, data: json) }

        do {
            _ = try await client.createShare(sessionId: "dev-x", minutes: 30)
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(errorText(error), "session is not running")
        }
    }

    func testCreateShareSurfaces400ServerErrorText() async {
        let json = #"{"error":"minutes must be an integer 1…1440"}"#.data(using: .utf8)!
        let client = makeClient { _ in .init(statusCode: 400, data: json) }

        do {
            _ = try await client.createShare(sessionId: "dev-x", minutes: 9999)
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(errorText(error), "minutes must be an integer 1…1440")
        }
    }

    func testRevokeShareSurfaces404ServerErrorText() async {
        let json = #"{"error":"unknown or already revoked share"}"#.data(using: .utf8)!
        let client = makeClient { _ in .init(statusCode: 404, data: json) }

        do {
            try await client.revokeShare("sh1")
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(errorText(error), "unknown or already revoked share")
        }
    }

    /// No body (or an undecodable body) → `errorText` falls back to the generic message, not a crash
    /// while decoding `{error}`.
    func testCreateShareWithoutErrorBodyFallsBackToGenericText() async {
        let client = makeClient { _ in .init(statusCode: 404) }

        do {
            _ = try await client.createShare(sessionId: "dev-x", minutes: 30)
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(errorText(error), "Server error (HTTP 404)")
        }
    }

    // MARK: - ShareView.presets (mirrors dashboard/src/shareView.ts SHARE_PRESETS)

    func testSharePresetsLabelsAndMinutes() {
        XCTAssertEqual(ShareView.presets.map { $0.label }, ["30 min", "1 h", "4 h", "8 h", "24 h"])
        XCTAssertEqual(ShareView.presets.map { $0.minutes }, [30, 60, 240, 480, 1440])
    }

    // MARK: - ShareView.expiryLabel (mirrors dashboard/src/share/guest.ts untilLabel)

    func testExpiryLabelSameDayIsHHMM() {
        let now = dateAt(2026, 10, 19, 10, 5)
        let expires = dateAt(2026, 10, 19, 14, 7)

        XCTAssertEqual(ShareView.expiryLabel(expires.timeIntervalSince1970 * 1000, now: now), "14:07")
    }

    func testExpiryLabelDifferentDayIncludesDate() {
        let now = dateAt(2026, 10, 19, 10, 5)
        let expires = dateAt(2026, 10, 20, 9, 0)

        XCTAssertEqual(ShareView.expiryLabel(expires.timeIntervalSince1970 * 1000, now: now), "10/20 09:00")
    }

    // MARK: - ShareView.warning (mirrors dashboard/src/shareView.ts shareWarning — fixed copy)

    func testWarningContainsExpiryAndFixedCopy() {
        let now = dateAt(2026, 10, 19, 10, 0)
        let expires = dateAt(2026, 10, 19, 10, 30)

        XCTAssertEqual(
            ShareView.warning(expiresAtMs: expires.timeIntervalSince1970 * 1000, now: now),
            "Anyone with the link gets full terminal access to this session until 10:30 — they can see the code and may obtain your AI account logins (Claude, Codex). Share only with people you trust."
        )
    }

    // MARK: - Final review: taint, filtering of expired shares, unreadable link

    private func session(tainted: String?) throws -> SessionLive {
        let extra = tainted.map { #","tainted":\#($0)"# } ?? ""
        let json = """
        {"id":"dev-x","folder":"f","project":"p","repo":"r","container":"c","port_base":4100,
         "status":"running","solo":0,"created_at":1,"last_active_at":1,"ports":[],
         "claudeState":"idle","workspace":"w","important":0,"accountId":null\(extra)}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(SessionLive.self, from: json)
    }

    private func share(_ id: String, session: String, expires: Int) -> ActiveShare {
        let json = #"{"id":"\#(id)","session_id":"\#(session)","name":null,"created_at":1,"expires_at":\#(expires)}"#
        return try! JSONDecoder().decode(ActiveShare.self, from: json.data(using: .utf8)!)
    }

    func testSessionLiveDecodesTaintedAndMissingIsNil() throws {
        XCTAssertEqual(try session(tainted: "true").tainted, true)
        XCTAssertEqual(try session(tainted: "false").tainted, false)
        XCTAssertNil(try session(tainted: nil).tainted)
    }

    func testActiveSharesFiltersOtherSessionsAndExpiredRows() {
        let now = Date(timeIntervalSince1970: 1_000)
        let rows = [share("a", session: "dev-x", expires: 2_000_000), share("b", session: "dev-x", expires: 500_000),
                    share("c", session: "dev-y", expires: 2_000_000)]

        XCTAssertEqual(ShareView.activeShares(rows, sessionId: "dev-x", now: now).map(\.id), ["a"])
    }

    func testTaintShownOnlyWithoutLiveShareAndWithExactCopy() throws {
        XCTAssertEqual(ShareView.taintMessage, "Sharing ended — the session stays restricted until you rebuild it")
        XCTAssertEqual(ShareView.taintAction, "Rebuild session")
        XCTAssertTrue(ShareView.showsTaint(session: try session(tainted: "true"), activeShares: []))
        XCTAssertFalse(ShareView.showsTaint(session: try session(tainted: "true"), activeShares: [share("a", session: "dev-x", expires: 9)]))
        XCTAssertFalse(ShareView.showsTaint(session: try session(tainted: "false"), activeShares: []))
        XCTAssertFalse(ShareView.showsTaint(session: try session(tainted: nil), activeShares: []))
    }

    func testLinkStateInvalidUrlIsErrorNotRecreate() {
        XCTAssertEqual(ShareView.linkState(nil), .notCreated)
        let ok = TerminalShare(id: "s", url: "https://share.example.com/s/tok", expiresAt: 1)
        XCTAssertEqual(ShareView.linkState(ok), .ready(URL(string: "https://share.example.com/s/tok")!))
        XCTAssertEqual(ShareView.linkState(TerminalShare(id: "s", url: "", expiresAt: 1)), .invalid)
        XCTAssertEqual(ShareView.linkState(TerminalShare(id: "s", url: "not a url", expiresAt: 1)), .invalid)
    }

    func testRecreateSessionPostsRecreatePath() async throws {
        let client = makeClient { _ in .init(statusCode: 200, data: #"{"session":{}}"#.data(using: .utf8)!) }

        try await client.recreateSession("dev-x")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-x/recreate")
        XCTAssertEqual(req.httpMethod, "POST")
    }

    private func dateAt(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        var comps = DateComponents()
        comps.year = year; comps.month = month; comps.day = day; comps.hour = hour; comps.minute = minute
        return Calendar.current.date(from: comps)!
    }
}
