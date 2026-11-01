import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here, not duplicated. Checks the pure helpers (pending/secondsLeft/minutesLeft) and the network paths
/// (GET of all three sources — approvals/grants/gate, POST approve/deny with body `{by, grantMinutes}`,
/// reload after an action) and above all the 409 behavior: a decision the mac/dashboard made first must
/// NOT be reported as an error by the app, but it still has to reload the rows (see `SshApprovalsScreen.performAction`).
///
/// `load()` fetches three endpoints concurrently (`async let`), not sequentially — so the tests compare
/// the SET of visited paths, not the exact order (same pattern as `OverviewStoreTests`).
@MainActor
final class SshApprovalsStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    /// Biometric gate for tests: the simulator has no Face ID, so the production `LocalAuthGate`
    /// would fail every approval here with "unavailable". Records the prompt reasons and how many
    /// requests had already gone out at the moment of the prompt (order: Face ID BEFORE the POST, not after).
    final class FakeBiometricGate: BiometricGate {
        var result: Result<Void, Error> = .success(())
        private(set) var reasons: [String] = []
        private(set) var requestsAtConfirm: [Int] = []

        func confirm(reason: String) async throws {
            reasons.append(reason)
            requestsAtConfirm.append(MockURLProtocol.capturedRequests.count)
            try result.get()
        }
    }

    private func makeStore(gate: FakeBiometricGate = FakeBiometricGate(), handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> SshApprovalsStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return SshApprovalsStore(client: DevdClient(endpoints: endpoints, session: session), biometrics: gate)
    }

    // MARK: - Face ID before approval

    func testApproveReasonNamesKeyTargetAndDuration() {
        let r = row("a", status: "pending", expires: 90_000)
        XCTAssertEqual(SshApprovalsStore.approveReason(r, choice: .once), "Approve SSH key “shop” for web/app (once)")
        XCTAssertEqual(SshApprovalsStore.approveReason(r, choice: .minutes(60)), "Approve SSH key “shop” for web/app (60 min)")
        // Unknown id (the row vanished from the poll in the meantime) — a generic reason, not an empty string.
        XCTAssertEqual(SshApprovalsStore.approveReason(nil, choice: .once), "Approve SSH key request (once)")
    }

    /// Permanent must be clearly distinguishable from a time-limited approval in the prompt reason — a different
    /// word ("permanently"), not just "0 min", which would look like an input mistake.
    func testApproveReasonPermanentSaysPermanently() {
        let r = row("a", status: "pending", expires: 90_000)
        XCTAssertEqual(SshApprovalsStore.approveReason(r, choice: .permanent), "Approve SSH key “shop” for web/app (permanently)")
    }

    func testApproveAsksBiometricsBeforePosting() async throws {
        let gate = FakeBiometricGate()
        let store = makeStore(gate: gate) { req in
            if req.url?.path.hasSuffix("/approve") == true {
                return .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!)
            }
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }
        try await store.approve(id: "abc", choice: .minutes(60))
        XCTAssertEqual(gate.reasons, ["Approve SSH key request (60 min)"])
        // The prompt came before any request went out — an approval without Face ID must not be sent.
        XCTAssertEqual(gate.requestsAtConfirm, [0])
        XCTAssertTrue(MockURLProtocol.capturedRequests.contains { $0.url?.path == "/api/ssh-approvals/abc/approve" })
    }

    func testApproveCancelledByUserSendsNothing() async {
        let gate = FakeBiometricGate()
        gate.result = .failure(BiometricError.cancelled)
        let store = makeStore(gate: gate) { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
        do {
            try await store.approve(id: "abc", choice: .once)
            XCTFail("cancelled biometrics must stop the approval")
        } catch let error as BiometricError {
            XCTAssertEqual(error, .cancelled)
        } catch {
            XCTFail("expected BiometricError, got \(error)")
        }
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty)
    }

    func testApproveBiometricFailureSendsNothing() async {
        let gate = FakeBiometricGate()
        gate.result = .failure(BiometricError.failed("Face ID is locked out"))
        let store = makeStore(gate: gate) { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
        do {
            try await store.approve(id: "abc", choice: .once)
            XCTFail("failed biometrics must stop the approval")
        } catch {
            XCTAssertEqual(errorText(error), "Face ID is locked out")
        }
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty)
    }

    func testDenyDoesNotAskForBiometrics() async throws {
        let gate = FakeBiometricGate()
        let store = makeStore(gate: gate) { req in
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            if req.url?.path.hasSuffix("/deny") == true { return .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }
        try await store.deny(id: "abc")
        XCTAssertEqual(gate.reasons, [])
        XCTAssertTrue(MockURLProtocol.capturedRequests.contains { $0.url?.path == "/api/ssh-approvals/abc/deny" })
    }

    /// `URLSession` usually turns `httpBody` into `httpBodyStream` before the request reaches
    /// `URLProtocol` — so we read both to be safe (same pattern as `CronStoreTests`).
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

    private func row(_ id: String, status: String, expires: Double, grantUntil: Double? = nil,
                      target: String? = nil, server: String? = nil, grantPermanent: Int? = nil) -> SshApproval {
        SshApproval(id: id, session_id: "dev-web-app", title: "shop", why: "restart",
                    target: target, cwd: "/workspace", project: "web", repo: "app",
                    status: status, decided_by: nil, created_at: 0, decided_at: nil,
                    expires_at: expires, grant_until: grantUntil, server: server, grant_permanent: grantPermanent)
    }

    // MARK: - pure helpers

    func testPendingFiltruje() {
        let rows = [row("a", status: "pending", expires: 90_000), row("b", status: "denied", expires: 0)]
        XCTAssertEqual(SshApprovalsStore.pending(rows).map(\.id), ["a"])
    }

    func testOdpocetSeNezaporny() {
        let r = row("a", status: "pending", expires: 10_000)
        XCTAssertEqual(SshApprovalsStore.secondsLeft(r, now: 4_000), 6)
        XCTAssertEqual(SshApprovalsStore.secondsLeft(r, now: 30_000), 0)
    }

    func testMinutesLeftSeNezaporny() {
        let g = row("a", status: "approved", expires: 0, grantUntil: 600_000)
        XCTAssertEqual(SshApprovalsStore.minutesLeft(g, now: 60_000), 9)
        XCTAssertEqual(SshApprovalsStore.minutesLeft(g, now: 700_000), 0)
    }

    /// Response for `/api/ssh-gate` for stubs that don't care about the gate and just want a valid shape
    /// (otherwise decoding `SshGate` from `"[]"` would fall into the error branch and muddy the test).
    private func gateStub(_ enabled: Bool = true) -> MockURLProtocol.Stub {
        .init(statusCode: 200, data: "{\"enabled\":\(enabled)}".data(using: .utf8)!)
    }

    // MARK: - load

    func testLoadFetchesApprovalsGrantsAndGate() async {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }
        await store.load()
        XCTAssertEqual(Set(paths), Set(["/api/ssh-approvals", "/api/ssh-grants", "/api/ssh-gate"]))
        XCTAssertEqual(MockURLProtocol.capturedRequests.first?.httpMethod, "GET")
        XCTAssertEqual(store.rows, [])
        XCTAssertEqual(store.grants, [])
        XCTAssertEqual(store.gate, .enabled)
        XCTAssertNil(store.error)
    }

    func testLoadFailureStoresErrorMessage() async {
        let store = makeStore { _ in .init(statusCode: 500) }
        await store.load()
        XCTAssertNotNil(store.error)
    }

    // MARK: - ssh-gate (tri-state — see spec "Break-glass": disabled ≠ unknown ≠ enabled)

    func testGateDefaultsUnknownBeforeFirstLoad() {
        let store = makeStore { _ in .init(statusCode: 200) }
        XCTAssertEqual(store.gate, .unknown)
    }

    func testLoadReflectsEnabledAndDisabledGate() async {
        var enabled = true
        let store = makeStore { req in
            if req.url?.path == "/api/ssh-gate" { return self.gateStub(enabled) }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }
        await store.load()
        XCTAssertEqual(store.gate, .enabled)
        XCTAssertNil(store.error)

        enabled = false
        await store.load()
        XCTAssertEqual(store.gate, .disabled)
        XCTAssertNil(store.error)
    }

    /// Key regression test: a persistent outage of ONLY `/api/ssh-gate` (approvals/grants keep
    /// working — typically version skew during a rolling devd restart, or an error isolated to this
    /// route) must not silently leave the gate at `.enabled`. It must fall to `.unknown` — false
    /// reassurance about a security control is worse than a needless warning.
    func testGateFetchFailureSetsUnknownAndDoesNotBlankRowsGrantsOrError() async {
        let store = makeStore { req in
            if req.url?.path == "/api/ssh-gate" { return .init(statusCode: 500) }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }
        await store.load()
        XCTAssertEqual(store.rows, [])
        XCTAssertEqual(store.grants, [])
        XCTAssertEqual(store.gate, .unknown)
        // A gate failure goes to `gate`, not to the generic `error` section — otherwise the app would report
        // "Error: …" even though rows/grants arrived fine (same fix as the web).
        XCTAssertNil(store.error)
    }

    /// `.unknown` is not just the default before the first load — the gate MUST return to it even after
    /// a successful read, as soon as the next poll of `/api/ssh-gate` fails. Without this a temporary
    /// outage after a healthy start would leave the app claiming "enabled" forever.
    func testGateReturnsToUnknownWhenGateFetchFailsAfterASuccessfulRead() async {
        var gateShouldFail = false
        let store = makeStore { req in
            if req.url?.path == "/api/ssh-gate" {
                return gateShouldFail ? .init(statusCode: 500) : self.gateStub(true)
            }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }
        await store.load()
        XCTAssertEqual(store.gate, .enabled)

        gateShouldFail = true
        await store.load()
        XCTAssertEqual(store.gate, .unknown)
    }

    // MARK: - approve / deny (POST + reload)

    func testApproveSendsByIosAndGrantMinutesThenReloads() async throws {
        var paths: [String] = []
        var approveBody: [String: Any] = [:]
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            if req.url?.path.hasSuffix("/approve") == true {
                approveBody = self.bodyJSON(req)
                return .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!)
            }
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.approve(id: "a1", choice: .minutes(60))

        XCTAssertEqual(paths.first, "/api/ssh-approvals/a1/approve")
        XCTAssertEqual(Set(paths.dropFirst()), Set(["/api/ssh-approvals", "/api/ssh-grants", "/api/ssh-gate"]))
        XCTAssertEqual(approveBody["by"] as? String, "ios")
        XCTAssertEqual(approveBody["grantMinutes"] as? Int, 60)
        XCTAssertNil(approveBody["grantPermanent"])
    }

    /// `.permanent` must send `grantMinutes: 0` and `grantPermanent: true` — the server
    /// (`parseGrantDuration`) requires zero minutes for a permanent grant.
    func testApprovePermanentSendsGrantPermanentTrueAndZeroMinutes() async throws {
        var approveBody: [String: Any] = [:]
        let store = makeStore { req in
            if req.url?.path.hasSuffix("/approve") == true {
                approveBody = self.bodyJSON(req)
                return .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!)
            }
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.approve(id: "a1", choice: .permanent)

        XCTAssertEqual(approveBody["by"] as? String, "ios")
        XCTAssertEqual(approveBody["grantMinutes"] as? Int, 0)
        XCTAssertEqual(approveBody["grantPermanent"] as? Bool, true)
    }

    func testDenySendsByIosThenReloads() async throws {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            if req.url?.path.hasSuffix("/deny") == true {
                return .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!)
            }
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.deny(id: "a1")

        XCTAssertEqual(paths.first, "/api/ssh-approvals/a1/deny")
        XCTAssertEqual(Set(paths.dropFirst()), Set(["/api/ssh-approvals", "/api/ssh-grants", "/api/ssh-gate"]))
        XCTAssertEqual(MockURLProtocol.capturedRequests[0].httpMethod, "POST")
    }

    // MARK: - 409 (mac/dashboard decided first)

    func test409NaApproveSePropagujeAlePorPrenacte() async {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            if req.url?.path.hasSuffix("/approve") == true {
                return .init(statusCode: 409, data: "{\"error\":\"request is no longer open\"}".data(using: .utf8)!)
            }
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        do {
            try await store.approve(id: "a1", choice: .once)
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual((error as? DevdHTTPError)?.statusCode, 409)
        }
        // Even after the error the app reloads — the next poll shows who decided.
        XCTAssertEqual(paths.first, "/api/ssh-approvals/a1/approve")
        XCTAssertEqual(Set(paths.dropFirst()), Set(["/api/ssh-approvals", "/api/ssh-grants", "/api/ssh-gate"]))
    }

    // MARK: - revoke (DELETE /api/ssh-grants/:id, bez biometrie)

    func testRevokeDeletesGrantWithoutBiometricsThenReloads() async throws {
        let gate = FakeBiometricGate()
        var paths: [String] = []
        var methods: [String: String] = [:]
        let store = makeStore(gate: gate) { req in
            let path = req.url?.path ?? ""
            paths.append(path)
            methods[path] = req.httpMethod
            if path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        try await store.revoke(grantId: "a1")

        XCTAssertEqual(paths.first, "/api/ssh-grants/a1")
        XCTAssertEqual(methods["/api/ssh-grants/a1"], "DELETE")
        XCTAssertEqual(Set(paths.dropFirst()), Set(["/api/ssh-approvals", "/api/ssh-grants", "/api/ssh-gate"]))
        // Revoking a grant does not go through Face ID — only approval does.
        XCTAssertEqual(gate.reasons, [])
    }

    func testRevokeFailurePropagatesButStillReloads() async {
        var paths: [String] = []
        let store = makeStore { req in
            paths.append(req.url?.path ?? "")
            if req.url?.path == "/api/ssh-grants/a1" {
                return .init(statusCode: 409, data: "{\"error\":\"request has no live grant to revoke\"}".data(using: .utf8)!)
            }
            if req.url?.path == "/api/ssh-gate" { return self.gateStub() }
            return .init(statusCode: 200, data: "[]".data(using: .utf8)!)
        }

        do {
            try await store.revoke(grantId: "a1")
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual((error as? DevdHTTPError)?.statusCode, 409)
        }
        XCTAssertEqual(paths.first, "/api/ssh-grants/a1")
        XCTAssertEqual(Set(paths.dropFirst()), Set(["/api/ssh-approvals", "/api/ssh-grants", "/api/ssh-gate"]))
    }

    // MARK: - Decision (Encodable) — grantPermanent is encoded only for a permanent approval

    func testDecisionPermanentEncodesGrantPermanentTrueAndZeroMinutes() throws {
        let data = try JSONEncoder().encode(SshApprovalsStore.Decision(by: "ios", grantMinutes: 0, grantPermanent: true))
        let dict = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(dict["by"] as? String, "ios")
        XCTAssertEqual(dict["grantMinutes"] as? Int, 0)
        XCTAssertEqual(dict["grantPermanent"] as? Bool, true)
    }

    func testDecisionMinutesOmitsGrantPermanentKey() throws {
        let data = try JSONEncoder().encode(SshApprovalsStore.Decision(by: "ios", grantMinutes: 240))
        let dict = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(dict["by"] as? String, "ios")
        XCTAssertEqual(dict["grantMinutes"] as? Int, 240)
        XCTAssertNil(dict["grantPermanent"])
        XCTAssertFalse(dict.keys.contains("grantPermanent"))
    }

    // MARK: - targetLabel (1:1 web sshTargetLabel)

    func testTargetLabelKnownServer() {
        let r = row("a", status: "pending", expires: 0, target: "user@192.0.2.11:2222", server: "shop")
        XCTAssertEqual(SshApprovalsStore.targetLabel(r), "shop · user@192.0.2.11:2222")
    }

    func testTargetLabelUnknownServer() {
        let r = row("a", status: "pending", expires: 0, target: "root@10.0.0.5:22", server: nil)
        XCTAssertEqual(SshApprovalsStore.targetLabel(r), "unknown server: root@10.0.0.5:22")
    }

    func testTargetLabelNoTarget() {
        let r = row("a", status: "pending", expires: 0, target: nil, server: nil)
        XCTAssertEqual(SshApprovalsStore.targetLabel(r), "no target")
    }

    // MARK: - grantLabel (Forever / N min left / N h M min left)

    func testGrantLabelPermanent() {
        let g = row("a", status: "approved", expires: 0, grantUntil: 0, grantPermanent: 1)
        XCTAssertEqual(SshApprovalsStore.grantLabel(g, now: Date(timeIntervalSince1970: 0)), "Forever")
    }

    func testGrantLabelUnderHourShowsMinutes() {
        let g = row("a", status: "approved", expires: 0, grantUntil: 600_000)
        XCTAssertEqual(SshApprovalsStore.grantLabel(g, now: Date(timeIntervalSince1970: 60)), "9 min left")
    }

    func testGrantLabelOverHourShowsHoursAndMinutes() {
        // grant_until - now = 150 min = 2 h 30 min.
        let g = row("a", status: "approved", expires: 0, grantUntil: 9_000_000)
        XCTAssertEqual(SshApprovalsStore.grantLabel(g, now: Date(timeIntervalSince1970: 0)), "2 h 30 min left")
    }

    // MARK: - SshApprovalsScreen.customMinutes — input from the "Custom number of minutes" alert

    func testCustomMinutesAcceptsOnlyPositiveIntegers() {
        XCTAssertEqual(SshApprovalsScreen.customMinutes("90"), 90)
        XCTAssertEqual(SshApprovalsScreen.customMinutes(" 15 "), 15)
        for invalid in ["", "0", "-5", "abc", "1.5"] {
            XCTAssertNil(SshApprovalsScreen.customMinutes(invalid), invalid)
        }
        XCTAssertEqual(SshApprovalsScreen.invalidMinutesText, "Enter a positive number of minutes.")
    }
}
