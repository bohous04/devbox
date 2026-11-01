import XCTest
@testable import DevboxApp

/// Mock `URLProtocol` that captures requests instead of the real network — so the tests verify exactly
/// what `DevdClient` sends (URL/headers) and how it reacts to a scripted response/error.
final class MockURLProtocol: URLProtocol {
    struct Stub {
        let statusCode: Int
        let data: Data
        let error: Error?

        init(statusCode: Int, data: Data = Data(), error: Error? = nil) {
            self.statusCode = statusCode
            self.data = data
            self.error = error
        }
    }

    /// Decides the response per request (typically by host, to simulate CF vs. tailnet).
    static var handler: ((URLRequest) -> Stub)?
    static var capturedRequests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.capturedRequests.append(request)
        guard let handler = MockURLProtocol.handler else {
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let stub = handler(request)
        if let error = stub.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: stub.statusCode, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class DevdClientTests: XCTestCase {
    private let cfBase = URL(string: "https://cf.example.com")!
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

    private func okStub(_ json: String = "{\"ok\":true}") -> MockURLProtocol.Stub {
        .init(statusCode: 200, data: json.data(using: .utf8)!)
    }

    // (a) CF 200 → the CF path is used, both headers present.
    func testCf200UsesCfPathWithHeaders() async throws {
        MockURLProtocol.handler = { _ in self.okStub() }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        let result: [String: Bool] = try await client.get("/api/health")

        XCTAssertEqual(result["ok"], true)
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1)
        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.host, "cf.example.com")
        XCTAssertEqual(req.value(forHTTPHeaderField: "CF-Access-Client-Id"), "id-1")
        XCTAssertEqual(req.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "secret-1")
    }

    // (b) CF 403 → fallback to tailnet (without CF headers) and the active path switches for next time.
    func testCf403FallsBackToTailnetAndCachesActivePath() async throws {
        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com" ? .init(statusCode: 403) : self.okStub()
        }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        let result: [String: Bool] = try await client.get("/api/health")
        XCTAssertEqual(result["ok"], true)
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2)
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].url?.host, "cf.example.com")
        let tailnetReq = MockURLProtocol.capturedRequests[1]
        XCTAssertEqual(tailnetReq.url?.host, "100.100.100.100")
        XCTAssertNil(tailnetReq.value(forHTTPHeaderField: "CF-Access-Client-Id"))

        // The next request goes straight to tailnet, with no new CF attempt.
        _ = try await client.get("/api/health") as [String: Bool]
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 3)
        XCTAssertEqual(MockURLProtocol.capturedRequests[2].url?.host, "100.100.100.100")
    }

    // (c) Both paths fail → the error contains a description of both.
    func testBothPathsFailingThrowsErrorDescribingBoth() async {
        MockURLProtocol.handler = { _ in .init(statusCode: 0, error: URLError(.notConnectedToInternet)) }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.get("/api/health") as [String: Bool]
            XCTFail("expected an error, both paths failed")
        } catch {
            let message = String(describing: error)
            XCTAssertTrue(message.contains("cf"), "the error should mention the cf path: \(message)")
            XCTAssertTrue(message.contains("tailnet"), "the error should mention the tailnet path: \(message)")
        }
    }

    // `DevdClientError.underlying` must carry BOTH errors themselves (not just a joined description), in the order
    // [active path, fallback] — `errorText` picks from them by priority (see ErrorTextTests).
    // Two DISTINGUISHABLE error codes (per host) verify that the order is really kept, not that
    // the test just happens to pass with two identical errors.
    func testBothPathsFailingFillsUnderlyingWithBothErrorsInOrder() async {
        MockURLProtocol.handler = { request in
            let code: URLError.Code = request.url?.host == "cf.example.com" ? .cannotConnectToHost : .timedOut
            return .init(statusCode: 0, error: URLError(code))
        }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.get("/api/health") as [String: Bool]
            XCTFail("expected an error, both paths failed")
        } catch let error as DevdClientError {
            XCTAssertEqual(error.underlying.count, 2)
            XCTAssertEqual((error.underlying[0] as? URLError)?.code, .cannotConnectToHost, "the first is the error of the ACTIVE (cf) path")
            XCTAssertEqual((error.underlying[1] as? URLError)?.code, .timedOut, "the second is the error of the FALLBACK (tailnet) path")
        } catch {
            XCTFail("expected DevdClientError, got \(error)")
        }
    }

    // (d) wsURL respects the active path and maps the scheme http(s) → ws(s).
    func testWsURLReflectsActivePathAndSchemeTranslation() async throws {
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        let cfWsURL = try await client.wsURL("/api/sessions/abc/terminal")
        XCTAssertEqual(cfWsURL.scheme, "wss")
        XCTAssertEqual(cfWsURL.host, "cf.example.com")
        XCTAssertEqual(cfWsURL.path, "/api/sessions/abc/terminal")

        // Force the active path to switch to tailnet (CF 403 → fallback).
        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com" ? .init(statusCode: 403) : self.okStub()
        }
        _ = try await client.get("/api/health") as [String: Bool]

        let tailnetWsURL = try await client.wsURL("/api/sessions/abc/terminal")
        XCTAssertEqual(tailnetWsURL.scheme, "ws")
        XCTAssertEqual(tailnetWsURL.host, "100.100.100.100")
        XCTAssertEqual(tailnetWsURL.path, "/api/sessions/abc/terminal")
    }

    // (e) postVoid with 204/empty body does not throw.
    func testPostVoidWith204DoesNotThrow() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 204) }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        try await client.postVoid("/api/push/ack", body: ["alertId": "a1"])
    }

    // (f) only tailnet configured (cfBase nil) → goes straight via tailnet.
    func testOnlyTailnetConfiguredGoesDirectlyToTailnet() async throws {
        MockURLProtocol.handler = { _ in self.okStub() }
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        let result: [String: Bool] = try await client.get("/api/health")

        XCTAssertEqual(result["ok"], true)
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1)
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].url?.host, "100.100.100.100")
        XCTAssertNil(MockURLProtocol.capturedRequests[0].value(forHTTPHeaderField: "CF-Access-Client-Id"))
    }

    // Non-2xx outside the 403 fallback logic (e.g. 404) → an error with the code, no attempt on the other path.
    func testNon2xxNon403DoesNotTriggerFallback() async {
        MockURLProtocol.handler = { _ in .init(statusCode: 404) }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.get("/api/missing") as [String: Bool]
            XCTFail("expected an HTTP error")
        } catch {
            XCTAssertTrue(String(describing: error).contains("404"))
        }
        // Only one attempt — 404 does not trigger the fallback to the other path.
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1)
    }

    // Pre-onboarding state (no path set) must not crash — it must throw an error, not crash.
    func testNoEndpointsConfiguredWsURLThrowsInsteadOfCrashing() async {
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: nil)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.wsURL("/api/sessions/abc/terminal")
            XCTFail("expected an error — no path is configured")
        } catch {
            // OK — the point is it did not crash on a force-unwrap.
        }
    }

    func testNoEndpointsConfiguredGetThrowsInsteadOfCrashing() async {
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: nil)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.get("/api/health") as [String: Bool]
            XCTFail("expected an error — no path is configured")
        } catch {
            // OK
        }
    }

    // CF hostname set but no service token → an error instead of a silent request without headers.
    // With no tailnet configured there is nowhere to fall back to, so this error propagates directly.
    func testCfConfiguredWithoutTokenThrowsWithoutSendingRequest() async {
        MockURLProtocol.handler = { _ in self.okStub() }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: nil, cfSecret: nil, tailnetBase: nil)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.get("/api/health") as [String: Bool]
            XCTFail("expected an error — CF path without a service token")
        } catch {
            XCTAssertTrue(String(describing: error).lowercased().contains("token"))
        }
        // No request was made at all — the missing token is detected before the request is built.
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 0)
    }

    // MARK: - wsRequest (terminal — Stage D)

    // wsRequest on the active CF path: wss scheme + BOTH CF headers (unlike `wsURL`, which only
    // returns a URL without headers — `URLSessionWebSocketTask(with:)` needs them for the handshake).
    func testWsRequestOnCfPathHasHeadersAndWssScheme() async throws {
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        let request = try await client.wsRequest("/api/sessions/abc/terminal")

        XCTAssertEqual(request.url?.scheme, "wss")
        XCTAssertEqual(request.url?.host, "cf.example.com")
        XCTAssertEqual(request.url?.path, "/api/sessions/abc/terminal")
        XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "id-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "secret-1")
    }

    // wsRequest on the tailnet path (CF 403 → fallback switched the active path): ws scheme, no CF headers.
    func testWsRequestOnTailnetPathHasNoHeaders() async throws {
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com" ? .init(statusCode: 403) : self.okStub()
        }
        _ = try await client.get("/api/health") as [String: Bool] // forces the active path to switch to tailnet

        let request = try await client.wsRequest("/api/sessions/abc/terminal")

        XCTAssertEqual(request.url?.scheme, "ws")
        XCTAssertEqual(request.url?.host, "100.100.100.100")
        XCTAssertEqual(request.url?.path, "/api/sessions/abc/terminal")
        XCTAssertNil(request.value(forHTTPHeaderField: "CF-Access-Client-Id"))
        XCTAssertNil(request.value(forHTTPHeaderField: "CF-Access-Client-Secret"))
    }

    // CF configured without a service token → wsRequest throws (the same guard as `perform`),
    // not a silent handshake without headers.
    func testWsRequestOnCfPathWithoutTokenThrows() async {
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: nil, cfSecret: nil, tailnetBase: nil)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            _ = try await client.wsRequest("/api/sessions/abc/terminal")
            XCTFail("expected an error — CF path without a service token")
        } catch {
            XCTAssertTrue(String(describing: error).lowercased().contains("token"))
        }
    }

    // MARK: - POST fallback (fix round: double mutation)

    // (g) POST + timeout on the primary path → an error WITHOUT an attempt on the other path. A timeout means
    // "the response got lost", not "the server never got the request" — a second attempt could perform the action
    // twice.
    func testPostTimeoutOnPrimaryDoesNotFallback() async {
        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com"
                ? .init(statusCode: 0, error: URLError(.timedOut))
                : self.okStub()
        }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        do {
            try await client.postVoid("/api/sessions/s1/stop", body: nil)
            XCTFail("expected an error — a POST timeout must not fall back")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1, "a POST timeout must not trigger a second attempt (double mutation)")
    }

    // (h) POST + HTTP 403 on the primary path → the fallback happens (the CF Access gate rejected the request
    // before devd, the server never got it).
    func testPost403OnPrimaryFallsBack() async throws {
        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com" ? .init(statusCode: 403) : self.okStub()
        }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        try await client.postVoid("/api/sessions/s1/stop", body: nil)

        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2)
        XCTAssertEqual(MockURLProtocol.capturedRequests[1].url?.host, "100.100.100.100")
    }

    // (i) POST + connect-phase URLError (the connection was never established) → the fallback happens.
    func testPostCannotConnectToHostFallsBack() async throws {
        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com"
                ? .init(statusCode: 0, error: URLError(.cannotConnectToHost))
                : self.okStub()
        }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        try await client.postVoid("/api/sessions/s1/stop", body: nil)

        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2)
        XCTAssertEqual(MockURLProtocol.capturedRequests[1].url?.host, "100.100.100.100")
    }

    // (j) GET + timeout still falls back — GET behaviour is unchanged by the per-method distinction.
    func testGetTimeoutStillFallsBack() async throws {
        MockURLProtocol.handler = { request in
            request.url?.host == "cf.example.com"
                ? .init(statusCode: 0, error: URLError(.timedOut))
                : self.okStub()
        }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        let result: [String: Bool] = try await client.get("/api/health")

        XCTAssertEqual(result["ok"], true)
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2)
    }

    // (k) An action POST gets an extended timeoutInterval (150 s, see `perform`); GET stays at the
    // URLRequest default (60 s) — the session-level 8s timeout is handled elsewhere (AppModel), this only
    // verifies that the per-request value is set exclusively for POST.
    func testPostRequestGetsExtendedTimeoutIntervalGetDoesNot() async throws {
        MockURLProtocol.handler = { _ in self.okStub() }
        let endpoints = DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())

        try await client.postVoid("/api/sessions/s1/stop", body: nil)
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1)
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].timeoutInterval, 150)

        _ = try await client.get("/api/health") as [String: Bool]
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2)
        XCTAssertNotEqual(MockURLProtocol.capturedRequests[1].timeoutInterval, 150)
    }
}
