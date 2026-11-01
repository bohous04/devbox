import XCTest
import UIKit
import UserNotifications
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target) — reused
/// here the same way as in `SessionActionsTests`. The pure functions (`hexToken`/`deepLink`/`ackAlertId`) are
/// tested without a network; `register(token:)` checks via the mock URLProtocol the exact path/body that
/// `PushManager` sends through `DevdClient`.
@MainActor
final class PushManagerTests: XCTestCase {
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

    private func makeManager(client: DevdClient?, onDeepLink: @escaping (PushManager.PushDeepLink) -> Void = { _ in }) -> PushManager {
        PushManager(clientProvider: { client }, onDeepLink: onDeepLink)
    }

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

    /// Payload tvaru `apnsPayload` (devd/src/apns.ts): `sessionId`/`terminal`/`alertId` VEDLE
    /// `aps`, category inside `aps.category`.
    private func userInfo(sessionId: String? = nil, terminal: Bool? = nil, alertId: String? = nil, category: String? = nil) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [:]
        if let category {
            info["aps"] = ["alert": ["title": "t", "body": "m"], "category": category, "sound": "default"]
        }
        if let sessionId { info["sessionId"] = sessionId }
        if let terminal { info["terminal"] = terminal }
        if let alertId { info["alertId"] = alertId }
        return info
    }

    // MARK: - hexToken

    func testHexTokenLowercasesAndPadsSingleDigitBytes() {
        let data = Data([0x00, 0xFF, 0x1A, 0x2B])
        XCTAssertEqual(PushManager.hexToken(data), "00ff1a2b")
    }

    func testHexTokenEmptyDataIsEmptyString() {
        XCTAssertEqual(PushManager.hexToken(Data()), "")
    }

    // MARK: - deepLink(from:)

    func testDeepLinkFullPayload() {
        let info = userInfo(sessionId: "dev-x", terminal: true, alertId: "alert-1")
        let link = PushManager.deepLink(from: info)
        XCTAssertEqual(link, .session(id: "dev-x", terminal: true))
    }

    func testDeepLinkWithoutTerminalDefaultsToFalse() {
        let info = userInfo(sessionId: "dev-x")
        let link = PushManager.deepLink(from: info)
        XCTAssertEqual(link, .session(id: "dev-x", terminal: false))
    }

    func testDeepLinkWithAlertIdButNoTerminal() {
        let info = userInfo(sessionId: "dev-x", alertId: "alert-1")
        let link = PushManager.deepLink(from: info)
        XCTAssertEqual(link, .session(id: "dev-x", terminal: false))
    }

    func testDeepLinkMissingSessionIdReturnsNil() {
        let info = userInfo(terminal: true, alertId: "alert-1")
        XCTAssertNil(PushManager.deepLink(from: info))
    }

    /// `target` from `devd/src/apns.ts` (NotifyTarget) → a screen under More, or unlocking the vault.
    func testDeepLinkTargetsMapToMoreDestinationsAndVault() {
        XCTAssertEqual(PushManager.deepLink(from: ["target": "prodWrites", "targetId": "7"]), .more(.prodWrites))
        XCTAssertEqual(PushManager.deepLink(from: ["target": "sshApprovals", "targetId": "a-1"]), .more(.sshKeys))
        XCTAssertEqual(PushManager.deepLink(from: ["target": "schedules"]), .more(.schedules))
        XCTAssertEqual(PushManager.deepLink(from: ["target": "subscriptions"]), .more(.subscriptions))
        XCTAssertEqual(PushManager.deepLink(from: ["target": "vault"]), .vault)
    }

    func testDeepLinkUnknownTargetReturnsNil() {
        XCTAssertNil(PushManager.deepLink(from: ["target": "nesmysl"]))
        XCTAssertNil(PushManager.deepLink(from: ["target": 42]))
    }

    /// The session link wins — a target on a session notification changes nothing.
    func testDeepLinkSessionWinsOverTarget() {
        XCTAssertEqual(PushManager.deepLink(from: ["sessionId": "dev-x", "terminal": true, "target": "schedules"]), .session(id: "dev-x", terminal: true))
    }

    func testHandleTargetCallsOnDeepLink() {
        var receivedLink: PushManager.PushDeepLink?
        let manager = makeManager(client: nil, onDeepLink: { receivedLink = $0 })
        manager.handle(userInfo: ["target": "vault"], actionIdentifier: UNNotificationDefaultActionIdentifier)
        XCTAssertEqual(receivedLink, .vault)
    }

    // MARK: - ackAlertId(from:actionIdentifier:)

    func testAckActionReturnsAlertIdRegardlessOfCategory() {
        let info = userInfo(sessionId: "dev-x", alertId: "alert-1", category: "done")
        XCTAssertEqual(
            PushManager.ackAlertId(from: info, actionIdentifier: PushManager.ackActionIdentifier),
            "alert-1"
        )
    }

    func testDefaultActionOnEmergencyReturnsAlertId() {
        let info = userInfo(sessionId: "dev-x", alertId: "alert-1", category: "emergency")
        XCTAssertEqual(
            PushManager.ackAlertId(from: info, actionIdentifier: UNNotificationDefaultActionIdentifier),
            "alert-1"
        )
    }

    func testDefaultActionOnDoneReturnsNil() {
        let info = userInfo(sessionId: "dev-x", alertId: "alert-1", category: "done")
        XCTAssertNil(PushManager.ackAlertId(from: info, actionIdentifier: UNNotificationDefaultActionIdentifier))
    }

    func testDismissActionReturnsNilEvenOnEmergency() {
        let info = userInfo(sessionId: "dev-x", alertId: "alert-1", category: "emergency")
        XCTAssertNil(PushManager.ackAlertId(from: info, actionIdentifier: UNNotificationDismissActionIdentifier))
    }

    func testMissingAlertIdReturnsNilRegardlessOfAction() {
        let info = userInfo(sessionId: "dev-x", category: "emergency")
        XCTAssertNil(PushManager.ackAlertId(from: info, actionIdentifier: PushManager.ackActionIdentifier))
        XCTAssertNil(PushManager.ackAlertId(from: info, actionIdentifier: UNNotificationDefaultActionIdentifier))
    }

    // MARK: - register(token:) — path/body via DevdClient

    func testRegisterPostsTokenPlatformAndDeviceName() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())
        let manager = makeManager(client: client)

        await manager.register(token: "deadbeef")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/push/register")
        XCTAssertEqual(req.httpMethod, "POST")
        let body = bodyJSON(req)
        XCTAssertEqual(body["token"] as? String, "deadbeef")
        XCTAssertEqual(body["platform"] as? String, "ios")
        XCTAssertEqual(body["name"] as? String, UIDevice.current.name)
    }

    /// Without a configured client (the app is still in onboarding) there is nowhere to send — a no-op,
    /// not a crash.
    func testRegisterWithoutClientIsNoOp() async {
        let manager = makeManager(client: nil)
        await manager.register(token: "deadbeef")
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty)
    }

    // MARK: - ack(alertId:) — same seam, just path/body

    func testAckPostsAlertId() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())
        let manager = makeManager(client: client)

        await manager.ack(alertId: "alert-1")

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/push/ack")
        XCTAssertEqual(bodyJSON(req)["alertId"] as? String, "alert-1")
    }

    // MARK: - handle(userInfo:actionIdentifier:) — deep link SYNCHRONOUSLY, ack fire-and-forget

    /// `handle` is non-async — so the `onDeepLink` call MUST happen before `handle` returns
    /// control to the caller (`AppDelegate.deliver`/`didReceive`), regardless of whether a
    /// client/network is set up at the moment. This test checks it directly: the closure sets `receivedLink`
    /// synchronously in the test body, no `await`/`expectation` needed.
    func testHandleCallsOnDeepLinkSynchronously() {
        var receivedLink: PushManager.PushDeepLink?
        let manager = makeManager(client: nil, onDeepLink: { receivedLink = $0 })

        manager.handle(userInfo: userInfo(sessionId: "dev-x", terminal: true), actionIdentifier: UNNotificationDefaultActionIdentifier)

        XCTAssertEqual(receivedLink, .session(id: "dev-x", terminal: true))
    }

    func testHandleWithoutSessionIdDoesNotCallOnDeepLink() {
        var called = false
        let manager = makeManager(client: nil, onDeepLink: { _ in called = true })

        manager.handle(userInfo: userInfo(alertId: "alert-1", category: "emergency"), actionIdentifier: PushManager.ackActionIdentifier)

        XCTAssertFalse(called)
    }

    /// The ack runs as a separate `Task` (fire-and-forget) — `handle` itself does not wait for the POST, but
    /// it should show up shortly after the call. Checks only that it IS sent, not the exact order
    /// relative to `completionHandler` (that is a property of `AppDelegate.didReceive`, described in the comment
    /// there — a real `UNNotificationResponse` is hard to build in tests).
    func testHandleSchedulesAckWithoutBlockingCaller() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())
        let manager = makeManager(client: client)

        manager.handle(
            userInfo: userInfo(sessionId: "dev-x", alertId: "alert-1", category: "emergency"),
            actionIdentifier: PushManager.ackActionIdentifier
        )
        // `handle` returned control right away (non-async) — the POST lands a bit later via the fire-and-
        // forget `Task`, hence a short wait instead of a synchronous assertion.
        try await Task.sleep(for: .milliseconds(100))

        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/push/ack")
        XCTAssertEqual(bodyJSON(req)["alertId"] as? String, "alert-1")
    }

    func testHandleWithoutAlertIdDoesNotPostAck() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        let client = DevdClient(endpoints: endpoints, session: makeSession())
        let manager = makeManager(client: client)

        manager.handle(userInfo: userInfo(sessionId: "dev-x"), actionIdentifier: UNNotificationDefaultActionIdentifier)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty)
    }
}

/// `AppDelegate` (DevboxAppApp.swift) must be a real `UNUserNotificationCenterDelegate` from
/// `didFinishLaunchingWithOptions` on — otherwise a cold-launch tap on a notification would never reach
/// `didReceive` (PushManager does not exist yet at that point, the app is still being built). `deliver` is a seam
/// that takes the same fields as a notification response, without having to build a real
/// `UNNotificationResponse` (current SDKs have no usable public initializer for tests) —
/// so this checks just the buffer/flush logic, not actual system delivery.
@MainActor
final class AppDelegateTests: XCTestCase {
    func testDeliverBuffersWhenPushManagerNotYetSet() {
        let appDelegate = AppDelegate() // `pushManager` stays nil — simulates the window between launch and the `.task` wiring

        appDelegate.deliver(userInfo: ["sessionId": "dev-x"], actionIdentifier: UNNotificationDefaultActionIdentifier)

        XCTAssertNotNil(appDelegate.pendingResponse)
    }

    func testAssigningPushManagerFlushesBufferedResponse() {
        let appDelegate = AppDelegate()
        var receivedLink: PushManager.PushDeepLink?
        let manager = PushManager(clientProvider: { nil }, onDeepLink: { receivedLink = $0 })

        appDelegate.deliver(userInfo: ["sessionId": "dev-x", "terminal": true], actionIdentifier: UNNotificationDefaultActionIdentifier)
        XCTAssertNil(receivedLink) // still buffered

        appDelegate.pushManager = manager // didSet → flushPendingResponseIfPossible

        XCTAssertEqual(receivedLink, .session(id: "dev-x", terminal: true))
        XCTAssertNil(appDelegate.pendingResponse)
    }

    func testDeliverWithPushManagerAlreadySetForwardsImmediatelyWithoutBuffering() {
        var receivedLink: PushManager.PushDeepLink?
        let manager = PushManager(clientProvider: { nil }, onDeepLink: { receivedLink = $0 })
        let appDelegate = AppDelegate()
        appDelegate.pushManager = manager

        appDelegate.deliver(userInfo: ["sessionId": "dev-y"], actionIdentifier: UNNotificationDefaultActionIdentifier)

        XCTAssertEqual(receivedLink?.sessionId, "dev-y")
        XCTAssertNil(appDelegate.pendingResponse)
    }
}
