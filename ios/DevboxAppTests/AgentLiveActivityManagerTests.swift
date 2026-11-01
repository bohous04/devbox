import XCTest
@testable import DevboxApp

@MainActor
private final class ActivityCallLog {
    var values: [String] = []
}

@MainActor
private final class FakeAgentActivityClient: AgentLiveActivityClient {
    let name: String
    let log: ActivityCallLog
    var state = DevboxAgentActivityAttributes.preview
    var registrations: [AgentLiveActivityRegistration] = []
    var deletions: [String?] = []
    var stateError: Error?
    var deleteError: Error?
    var registerError: Error?
    var beforeState: (() async -> Void)?
    var beforeRegister: (() async -> Void)?
    var serverEnded = Set<String>()
    var dispositionError: Error?
    var beforeDisposition: (() async -> Void)?

    init(_ name: String, log: ActivityCallLog) { self.name = name; self.log = log }

    func agentActivityState() async throws -> DevboxAgentActivityAttributes.ContentState {
        log.values.append("\(name):GET")
        await beforeState?()
        if let stateError { throw stateError }
        return state
    }
    func serverEndedAgentActivity(deviceID: String, serverID: String, activityID: String) async throws -> Bool {
        log.values.append("\(name):DISPOSITION:\(activityID)")
        await beforeDisposition?()
        if let dispositionError { throw dispositionError }
        return serverEnded.contains(activityID)
    }
    func registerAgentActivity(_ registration: AgentLiveActivityRegistration) async throws {
        log.values.append("\(name):POST:\(registration.kind)")
        await beforeRegister?()
        if let registerError { throw registerError }
        registrations.append(registration)
    }
    func unregisterAgentActivities(deviceID: String, activityID: String?) async throws {
        log.values.append("\(name):DELETE:\(activityID ?? "all")")
        if let deleteError { throw deleteError }
        deletions.append(activityID)
    }
}

@MainActor
private final class FakeAgentActivityDriver: AgentActivityDriver {
    var activities: [AgentActivitySnapshot] = []
    var areActivitiesEnabled = true
    var pushToStartToken: Data? = Data([0xab, 0xcd])
    var requested: [DevboxAgentActivityAttributes.ContentState] = []
    var updates: [DevboxAgentActivityAttributes.ContentState] = []
    var ended: [String] = []
    var onChange: (() -> Void)?
    var onDismissed: ((String, String) -> Void)?

    func startObserving(onChange: @escaping () -> Void, onDismissed: @escaping (String, String) -> Void) {
        self.onChange = onChange
        self.onDismissed = onDismissed
    }
    func stopObserving() { onChange = nil; onDismissed = nil }
    func request(serverID: String, state: DevboxAgentActivityAttributes.ContentState) throws -> AgentActivitySnapshot {
        requested.append(state)
        let activity = AgentActivitySnapshot(id: "activity-\(requested.count)", serverID: serverID,
            lifecycle: .active, pushToken: Data([0x01, UInt8(requested.count)]))
        activities.append(activity)
        return activity
    }
    func update(id: String, state: DevboxAgentActivityAttributes.ContentState) async { updates.append(state) }
    func end(id: String) async { ended.append(id); activities.removeAll { $0.id == id } }
    func dismiss(_ id: String) {
        guard let activity = activities.first(where: { $0.id == id }) else { return }
        activities.removeAll { $0.id == id }
        onDismissed?(id, activity.serverID)
        onChange?()
    }
}

@MainActor
final class AgentLiveActivityManagerTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!
    private var log: ActivityCallLog!
    private var client: FakeAgentActivityClient!
    private var driver: FakeAgentActivityDriver!
    private var manager: AgentLiveActivityManager!
    private var widgetStates: [DevboxAgentActivityAttributes.ContentState] = []
    private var widgetResets = 0

    override func setUp() {
        super.setUp()
        suite = "AgentLiveActivityManagerTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        log = ActivityCallLog()
        client = FakeAgentActivityClient("old", log: log)
        driver = FakeAgentActivityDriver()
        widgetStates = []
        widgetResets = 0
        manager = AgentLiveActivityManager(client: client, serverID: "server-one", driver: driver,
            defaults: defaults, environment: "sandbox", stateSink: { [unowned self] in self.widgetStates.append($0) },
            stateReset: { [unowned self] in self.widgetResets += 1 })
    }

    override func tearDown() {
        manager.stop()
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func activate() async {
        manager.start()
        manager.setForeground(true)
        await manager.waitForSynchronization()
    }

    func testForegroundStartsFromAuthoritativeStateAndRegistersUpdateBeforeStart() async {
        await activate()
        XCTAssertTrue(manager.enabled)
        XCTAssertEqual(driver.requested, [client.state])
        XCTAssertEqual(client.registrations.map(\.kind), ["update", "start"])
        XCTAssertEqual(client.registrations.first?.token, "0101")
        XCTAssertEqual(client.registrations.first?.activityId, "activity-1")
        XCTAssertEqual(client.registrations.first?.environment, "sandbox")
        XCTAssertEqual(client.registrations.first?.optIn, true)
        XCTAssertNotNil(UUID(uuidString: manager.deviceID))
    }

    func testForegroundStateIsSharedWithWidget() async {
        await activate()
        XCTAssertEqual(widgetStates, [client.state])
    }

    func testWidgetGetsStateEvenWhenLiveActivityIsOff() async {
        manager.setEnabled(false)
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertEqual(widgetStates, [client.state])
    }

    func testBackgroundSyncDoesNotFetchStateForWidget() async {
        manager.start()
        await manager.waitForSynchronization()
        XCTAssertTrue(widgetStates.isEmpty)
    }

    func testLaunchRegistersPushToStartTokenEvenInBackground() async {
        manager.start()
        await manager.waitForSynchronization()
        XCTAssertEqual(client.registrations.map(\.kind), ["start"])
        XCTAssertEqual(client.registrations.first?.token, "abcd")
        XCTAssertNil(client.registrations.first?.activityId)
        XCTAssertEqual(client.registrations.first?.serverID, "server-one")
        XCTAssertTrue(driver.requested.isEmpty, "Background launch never requests an activity itself")
    }

    func testExistingPushStartedActivityIsAdoptedInBackgroundWithoutGETOrDuplicate() async {
        driver.activities = [.init(id: "from-apns", serverID: "server-one", lifecycle: .active, pushToken: Data([0xfe]))]
        manager.start()
        await manager.waitForSynchronization()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertFalse(log.values.contains("old:GET"))
        XCTAssertEqual(client.registrations.first?.activityId, "from-apns")
    }

    func testColdLaunchAdoptsNewPushStartedActivityWhenSavedPreviousActivityEnded() async {
        await activate()
        manager.stop()
        driver.activities = [.init(id: "new-from-apns", serverID: "server-one", lifecycle: .active, pushToken: Data([0xee]))]
        manager = AgentLiveActivityManager(client: client, serverID: "server-one", driver: driver,
            defaults: defaults, environment: "sandbox")
        manager.start()
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertTrue(driver.ended.isEmpty)
        XCTAssertEqual(driver.requested.count, 1, "Only the original foreground activity was requested")
        XCTAssertEqual(client.registrations.last(where: { $0.kind == "update" })?.activityId, "new-from-apns")
    }

    func testPendingSystemActivityIsAdoptedWithoutRetirementOrDuplicateRequest() async {
        driver.activities = [.init(id: "pending-apns", serverID: "server-one", lifecycle: .pending, pushToken: nil)]
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertTrue(driver.ended.isEmpty)
        XCTAssertTrue(client.deletions.isEmpty)
        XCTAssertEqual(manager.statusText, "Activity is running. Waiting for background updates to connect…")
    }

    func testIdleServerRegistersForFutureWorkWithoutShowingEmptyActivity() async throws {
        // Only done/unknown sessions (the v2 idle fixture from devd) do not start the activity.
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "agent-live-activity-v2-idle", withExtension: "json"))
        client.state = try JSONDecoder().decode(DevboxAgentActivityAttributes.ContentState.self, from: Data(contentsOf: url))
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertEqual(client.registrations.map(\.kind), ["start"])
    }

    func testDismissalRevokesPushAndDoesNotReappearOnRefreshUntilExplicitResume() async {
        await activate()
        driver.dismiss("activity-1")
        await manager.waitForSynchronization()
        XCTAssertTrue(manager.dismissed)
        XCTAssertEqual(client.deletions.count, 1)
        XCTAssertNil(client.deletions[0])
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(client.registrations.count, 2)
        manager.resume()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.requested.count, 2)
        XCTAssertEqual(client.registrations.last(where: { $0.kind == "update" })?.optIn, true)
    }

    func testImmediateServerEndWithoutIntermediateEndedStatePreservesFutureWork() async {
        await activate()
        client.serverEnded.insert("activity-1")
        client.state.counts = .init(done: 1)
        client.state.dot = .idle
        client.state.sessions = client.state.sessions.filter { $0.status == .done }
        driver.dismiss("activity-1")
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertTrue(client.deletions.isEmpty, "Server completion must not disable device-wide delivery")
        XCTAssertEqual(driver.requested.count, 1)
        client.state = DevboxAgentActivityAttributes.preview
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.requested.count, 2, "The next real job can create an activity")
    }

    func testColdLaunchAfterImmediateServerEndDoesNotBecomePersistedDismissal() async {
        await activate()
        manager.stop()
        driver.activities.removeAll()
        client.serverEnded.insert("activity-1")
        manager = AgentLiveActivityManager(client: client, serverID: "server-one", driver: driver,
            defaults: defaults, environment: "sandbox")
        await activate()
        XCTAssertFalse(manager.dismissed)
        XCTAssertTrue(client.deletions.isEmpty)
        XCTAssertEqual(driver.requested.count, 2)
    }

    func testServerEndedSnapshotRetiresOnlyItsTokenAndPreservesBackgroundRegistration() async {
        await activate()
        manager.setForeground(false)
        client.serverEnded.insert("activity-1")
        driver.activities = [.init(id: "activity-1", serverID: "server-one", lifecycle: .dismissed, pushToken: nil)]
        driver.onDismissed?("activity-1", "server-one")
        driver.onChange?()
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertEqual(client.deletions.count, 1)
        XCTAssertEqual(client.deletions[0], "activity-1")
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(client.registrations.filter { $0.kind == "start" }.count, 1)
    }

    func testColdLaunchAfterActualSwipeStillRequiresExplicitResume() async {
        await activate()
        manager.stop()
        driver.activities.removeAll()
        manager = AgentLiveActivityManager(client: client, serverID: "server-one", driver: driver,
            defaults: defaults, environment: "sandbox")
        await activate()
        XCTAssertTrue(manager.dismissed)
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(client.deletions.count, 1)
        XCTAssertNil(client.deletions[0])
    }

    func testUnreachableDispositionDefersBothRevocationAndRecreationUntilRetry() async {
        await activate()
        client.dispositionError = URLError(.notConnectedToInternet)
        driver.dismiss("activity-1")
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertTrue(client.deletions.isEmpty)
        XCTAssertEqual(driver.requested.count, 1)
        client.dispositionError = nil
        client.serverEnded.insert("activity-1")
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertEqual(driver.requested.count, 2)
    }

    func testEndpointChangeDuringDispositionCannotDismissNewServer() async {
        await activate()
        let replacement = FakeAgentActivityClient("new", log: log)
        client.beforeDisposition = { [self] in
            client.beforeDisposition = nil
            manager.configure(client: replacement, serverID: "server-two")
        }
        driver.dismiss("activity-1")
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertFalse(defaults.bool(forKey: "agentActivity.dismissed.server-two"))
        XCTAssertTrue(replacement.deletions.isEmpty)
        XCTAssertEqual(driver.activities.first?.serverID, "server-two")
    }

    func testSwipeDuringForegroundGETCannotCreateAReplacementBeforeClassification() async {
        await activate()
        client.beforeState = { [self] in
            client.beforeState = nil
            driver.dismiss("activity-1")
        }
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertTrue(manager.dismissed)
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(client.deletions.count, 1)
        XCTAssertNil(client.deletions[0])
    }

    func testResumeDuringDispositionSupersedesLateSwipeClassification() async {
        await activate()
        client.beforeDisposition = { [self] in
            client.beforeDisposition = nil
            manager.resume()
        }
        driver.dismiss("activity-1")
        await manager.waitForSynchronization()
        XCTAssertFalse(manager.dismissed)
        XCTAssertTrue(client.deletions.isEmpty)
        XCTAssertEqual(driver.requested.count, 2)
    }

    func testDisableEndsAndRevokesOnceWithoutPollingRegistrations() async {
        await activate()
        manager.setEnabled(false)
        await manager.waitForSynchronization()
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.ended, ["activity-1"])
        XCTAssertEqual(client.deletions.count, 1)
        XCTAssertEqual(client.registrations.count, 2)
        XCTAssertFalse(manager.enabled)
        XCTAssertEqual(defaults.bool(forKey: "agentActivity.enabled"), false)
    }

    func testTokenRotationRegistersNewTokenWithoutCreatingAnotherActivity() async {
        await activate()
        driver.activities[0] = .init(id: "activity-1", serverID: "server-one", lifecycle: .active, pushToken: Data([0xaa]))
        driver.onChange?()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(client.registrations.map(\.token), ["0101", "abcd", "aa"])
        XCTAssertNil(client.registrations.last?.optIn)
    }

    func testRegistrationFailureRetriesSameActivityOnRefresh() async {
        client.registerError = URLError(.notConnectedToInternet)
        await activate()
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertTrue(client.registrations.isEmpty)
        client.registerError = nil
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(client.registrations.map(\.kind), ["update", "start"])
    }

    func testFailedStateNeverCreatesActivityAndRecoversOnRetry() async {
        client.stateError = URLError(.notConnectedToInternet)
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertTrue(client.registrations.isEmpty)
        client.stateError = nil
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.requested.count, 1)
    }

    func testRegistration503ReportsBackgroundDeliveryUnavailableWithoutLosingForegroundActivity() async {
        client.registerError = DevdHTTPError(statusCode: 503)
        await activate()
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(manager.statusText, "Background updates are not available on the server.")
        XCTAssertTrue(client.registrations.isEmpty)
    }

    func testState503RemainsNetworkAvailabilityErrorAndCreatesNothing() async {
        client.stateError = DevdHTTPError(statusCode: 503)
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertEqual(manager.statusText, "Server is unreachable. Will retry.")
    }

    func testChangingEndpointDeletesOnOldClientBeforeRegisteringNewServer() async {
        await activate()
        let replacement = FakeAgentActivityClient("new", log: log)
        manager.configure(client: replacement, serverID: "server-two")
        await manager.waitForSynchronization()
        let oldDelete = log.values.firstIndex(of: "old:DELETE:all")!
        let newPost = log.values.firstIndex(of: "new:POST:update")!
        XCTAssertLessThan(oldDelete, newPost)
        XCTAssertEqual(driver.ended, ["activity-1"])
        XCTAssertEqual(driver.activities.first?.serverID, "server-two")
        XCTAssertEqual(replacement.registrations.first?.serverID, "server-two")
    }

    func testOldServerRevocationFailureBlocksNewRegistrationAndRetries() async {
        await activate()
        let replacement = FakeAgentActivityClient("new", log: log)
        client.deleteError = URLError(.notConnectedToInternet)
        manager.configure(client: replacement, serverID: "server-two")
        await manager.waitForSynchronization()
        XCTAssertTrue(replacement.registrations.isEmpty)
        XCTAssertTrue(driver.activities.isEmpty, "Old-server content must disappear even offline")
        client.deleteError = nil
        manager.retry()
        await manager.waitForSynchronization()
        XCTAssertEqual(replacement.registrations.map(\.kind), ["update", "start"])
    }

    func testConfigurationChangedDuringGETCannotStartOldServerActivity() async {
        let replacement = FakeAgentActivityClient("new", log: log)
        client.beforeState = { [weak self] in
            guard let self else { return }
            self.client.beforeState = nil
            self.manager.configure(client: replacement, serverID: "server-two")
        }
        await activate()
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(driver.activities.first?.serverID, "server-two")
        XCTAssertTrue(client.registrations.isEmpty)
        XCTAssertEqual(client.deletions.count, 1)
    }

    func testLateOldRegistrationIsDeletedBeforeNewRegistration() async {
        let replacement = FakeAgentActivityClient("new", log: log)
        client.beforeRegister = { [weak self] in
            guard let self else { return }
            self.client.beforeRegister = nil
            self.manager.configure(client: replacement, serverID: "server-two")
        }
        await activate()
        XCTAssertEqual(log.values.prefix(4), ["old:GET", "old:POST:update", "old:DELETE:all", "new:GET"])
        XCTAssertEqual(client.registrations.count, 1)
        XCTAssertEqual(replacement.registrations.map(\.kind), ["update", "start"])
    }

    func testBackgroundDuringGETNeverRequestsActivity() async {
        client.beforeState = { [weak self] in self?.manager.setForeground(false) }
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertTrue(client.registrations.isEmpty)
    }

    func testAuthorizationRevokedEndsActivityAndRemovesStartRegistration() async {
        await activate()
        driver.areActivitiesEnabled = false
        driver.onChange?()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.ended, ["activity-1"])
        XCTAssertEqual(client.deletions.count, 1)
        XCTAssertTrue(manager.statusText.contains("iPhone Settings"))
        driver.areActivitiesEnabled = true
        driver.onChange?()
        await manager.waitForSynchronization()
        XCTAssertEqual(client.registrations.last(where: { $0.kind == "update" })?.optIn, true)
    }

    func testConcurrentPushStartedDuplicateIsRetiredWithoutReplacingPrimary() async {
        await activate()
        driver.activities.append(.init(id: "duplicate", serverID: "server-one", lifecycle: .active, pushToken: Data([0xdd])))
        driver.onChange?()
        await manager.waitForSynchronization()
        XCTAssertEqual(driver.activities.map(\.id), ["activity-1"])
        XCTAssertEqual(client.deletions.compactMap { $0 }, ["duplicate"])
        XCTAssertEqual(driver.requested.count, 1)
    }

    func testDisabledPreferenceAndInstallationIDSurviveRelaunch() {
        manager.setEnabled(false)
        let next = AgentLiveActivityManager(client: client, serverID: "server-one", driver: driver,
            defaults: defaults, environment: "sandbox")
        XCTAssertFalse(next.enabled)
        XCTAssertEqual(next.deviceID, manager.deviceID)
        next.stop()
    }

    func testServerIdentityExcludesCredentialsAndStaysStableAcrossTokenRotation() {
        var endpoints = DevdEndpoints(cfBase: URL(string: "https://example.invalid"), cfId: "first", cfSecret: "one", tailnetBase: nil)
        let original = AgentLiveActivityManager.serverID(for: endpoints)
        endpoints.cfId = "second"
        endpoints.cfSecret = "two"
        XCTAssertEqual(original, AgentLiveActivityManager.serverID(for: endpoints))
        XCTAssertEqual(original.count, 64)
        endpoints.cfBase = URL(string: "https://another.invalid")
        XCTAssertNotEqual(original, AgentLiveActivityManager.serverID(for: endpoints))
    }

    func testUnsupportedStateVersionNeverCreatesActivity() async {
        client.state.version = 1
        await activate()
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertEqual(manager.statusText, "The server uses an unsupported Live Activity version.")
    }

    func testCredentialRotationOnSameServerSwapsClientWithoutRevokingRegistration() async {
        await activate()
        let rotated = FakeAgentActivityClient("rotated", log: log)
        manager.configure(client: rotated, serverID: "server-one")
        await manager.waitForSynchronization()
        XCTAssertFalse(log.values.contains { $0.hasSuffix(":DELETE:all") },
                       "Same server: the old client (old credentials) must not be asked to unregister")
        XCTAssertTrue(driver.ended.isEmpty)
        XCTAssertEqual(driver.requested.count, 1)
        XCTAssertEqual(rotated.registrations.map(\.kind), ["update", "start"])
        XCTAssertEqual(manager.serverID, "server-one")
    }

    func testNoServerMeansNoRegistrationAndNoActivity() async {
        manager.stop()
        manager = AgentLiveActivityManager(client: nil, serverID: nil, driver: driver,
            defaults: defaults, environment: "sandbox")
        await activate()
        XCTAssertNil(manager.serverID)
        XCTAssertTrue(driver.requested.isEmpty)
        XCTAssertTrue(log.values.isEmpty)
        XCTAssertEqual(manager.statusText, "Connect a server in Settings.")
    }

    func testServerChangeClearsWidgetStateButSameServerAndRelaunchDoNot() async {
        // First server in setUp: from "none stored" to server-one.
        XCTAssertEqual(widgetResets, 1)
        await activate()
        manager.configure(client: FakeAgentActivityClient("rotated", log: log), serverID: "server-one")
        XCTAssertEqual(widgetResets, 1, "Same server (credential rotation) keeps the widget state")

        // Relaunch: the app starts without a server and immediately configures the same one.
        manager.stop()
        manager = AgentLiveActivityManager(client: nil, serverID: nil, driver: driver, defaults: defaults,
            environment: "sandbox", stateSink: { _ in }, stateReset: { [unowned self] in self.widgetResets += 1 })
        manager.configure(client: client, serverID: "server-one")
        XCTAssertEqual(widgetResets, 1, "Relaunch with the same server keeps the widget state")

        manager.configure(client: FakeAgentActivityClient("new", log: log), serverID: "server-two")
        XCTAssertEqual(widgetResets, 2)
        manager.configure(client: nil, serverID: nil)
        XCTAssertEqual(widgetResets, 3)
    }
}

@MainActor
final class AgentLiveActivityClientTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return DevdClient(endpoints: .init(cfBase: nil, cfId: nil, cfSecret: nil,
            tailnetBase: URL(string: "https://example.invalid")!), session: URLSession(configuration: config))
    }

    func testGETDecodesServerV2Fixture() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "agent-live-activity-v2", withExtension: "json"))
        let payload = try Data(contentsOf: url)
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: payload) }
        let state = try await client().agentActivityState()
        XCTAssertEqual(state.version, 2)
        XCTAssertEqual(state.sessions.count, 8)
        XCTAssertEqual(state.sessions.first?.deepLink?.absoluteString, "devbox://session/dev-wait-old")
    }

    func testRegistrationAndRevocationUseDedicatedAPIAndShortTimeout() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data("{\"ok\":true}".utf8)) }
        let client = client()
        try await client.registerAgentActivity(.init(deviceId: "device", serverID: "opaque", kind: "update",
            token: "abc123", activityId: "activity", environment: "sandbox", optIn: true))
        try await client.unregisterAgentActivities(deviceID: "device", activityID: "activity")
        try await client.unregisterAgentActivities(deviceID: "device", activityID: nil)
        let requests = MockURLProtocol.capturedRequests
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/live-activities/register", "/api/live-activities/device/activity", "/api/live-activities/device"])
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "DELETE", "DELETE"])
        XCTAssertTrue(requests.allSatisfy { $0.timeoutInterval == 8 })
    }

    func testGETReadsAuthoritativeStateFromDedicatedEndpoint() async throws {
        let expected = DevboxAgentActivityAttributes.preview
        let payload = try JSONEncoder().encode(expected)
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: payload) }
        let actual = try await client().agentActivityState()
        XCTAssertEqual(actual, expected)
        XCTAssertEqual(MockURLProtocol.capturedRequests.first?.url?.path, "/api/live-activities/state")
        XCTAssertEqual(MockURLProtocol.capturedRequests.first?.httpMethod, "GET")
    }

    func testDispositionGETIncludesServerNamespaceWithoutSendingPushTokens() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data("{\"serverEnded\":true}".utf8)) }
        let ended = try await client().serverEndedAgentActivity(deviceID: "device", serverID: "server+one", activityID: "activity")
        XCTAssertTrue(ended)
        let request = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/live-activities/device/activity")
        let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query, [URLQueryItem(name: "serverID", value: "server+one")])
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(request.timeoutInterval, 8)
    }
}
