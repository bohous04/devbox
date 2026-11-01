import XCTest
@testable import DevboxApp

/// `AppModel.endpoints` is a pure function (no Keychain) — tested directly. `saveConfig`/`init`
/// are tested via an injected `KeychainStore(requireBiometryForVault: false)`, because the app
/// has no enrolled biometrics in the simulator (same reason as in `KeychainStoreTests`).
@MainActor
final class AppModelTests: XCTestCase {
    private static let keys = [
        KeychainStore.cfHostname,
        KeychainStore.cfClientId,
        KeychainStore.cfClientSecret,
        KeychainStore.tailnetBase,
        KeychainStore.vaultPassphrase,
    ]

    override func setUpWithError() throws {
        try super.setUpWithError()
        cleanupKeychain()
        // Vault tests (Stage G, task 30) mock `model.client` via `MockURLProtocol` (the same
        // type as DevdClientTests/SessionActionsTests, one test target) — reset here, not in a
        // separate `setUp()`, so the two hooks do not collide on call order.
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    override func tearDownWithError() throws {
        cleanupKeychain()
        try super.tearDownWithError()
    }

    private func cleanupKeychain() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        for key in Self.keys {
            keychain.delete(key)
        }
    }

    // MARK: - endpoints() normalization

    func testLiveActivityURLTargetsSessionTerminal() {
        let link = AppModel.deepLink(from: URL(string: "devbox://session/dev-shop-cms?terminal=1")!)
        XCTAssertEqual(link, .session(id: "dev-shop-cms", terminal: true))
    }

    /// The widget and the Live Activity with no waiting session open the sessions list.
    func testSessionsDeepLinkRequestsSessionsTab() {
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false))
        model.handleDeepLinkURL(URL(string: "devbox://sessions")!)
        XCTAssertEqual(model.requestedTab, .sessions)
        XCTAssertNil(model.pendingDeepLink)
    }

    func testSessionLinkDoesNotRequestTabOnly() {
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false))
        model.handleDeepLinkURL(URL(string: "devbox://session/dev-x")!)
        XCTAssertNil(model.requestedTab)
        XCTAssertEqual(model.pendingDeepLink?.sessionId, "dev-x")
    }

    func testMoreAndVaultURLs() {
        XCTAssertEqual(AppModel.deepLink(from: URL(string: "devbox://more/prodWrites")!), .more(.prodWrites))
        XCTAssertEqual(AppModel.deepLink(from: URL(string: "devbox://more/sshKeys")!), .more(.sshKeys))
        XCTAssertEqual(AppModel.deepLink(from: URL(string: "devbox://more/sshApprovals")!), .more(.sshKeys))
        XCTAssertEqual(AppModel.deepLink(from: URL(string: "devbox://vault")!), .vault)
        XCTAssertNil(AppModel.deepLink(from: URL(string: "devbox://more/nesmysl")!))
        XCTAssertNil(AppModel.deepLink(from: URL(string: "devbox://more")!))
    }

    func testForeignOrMalformedDeepLinkIsIgnored() {
        XCTAssertNil(AppModel.deepLink(from: URL(string: "https://example.com/session/dev-x")!))
        XCTAssertNil(AppModel.deepLink(from: URL(string: "devbox://session")!))
    }

    func testHostnameWithoutSchemeGetsHttps() {
        let endpoints = AppModel.endpoints(hostname: "devbox.example.ts.net", cfId: nil, cfSecret: nil, tailnet: nil)
        XCTAssertEqual(endpoints.cfBase, URL(string: "https://devbox.example.ts.net"))
    }

    func testHostnameWithHttpsSchemeIsUnchanged() {
        let endpoints = AppModel.endpoints(hostname: "https://devbox.example.ts.net", cfId: nil, cfSecret: nil, tailnet: nil)
        XCTAssertEqual(endpoints.cfBase, URL(string: "https://devbox.example.ts.net"))
    }

    func testHostnameTrailingSlashIsTrimmed() {
        let endpoints = AppModel.endpoints(hostname: "https://devbox.example.ts.net/", cfId: nil, cfSecret: nil, tailnet: nil)
        XCTAssertEqual(endpoints.cfBase, URL(string: "https://devbox.example.ts.net"))
    }

    func testEmptyHostnameIsNil() {
        let endpoints = AppModel.endpoints(hostname: "", cfId: nil, cfSecret: nil, tailnet: nil)
        XCTAssertNil(endpoints.cfBase)
    }

    func testWhitespaceOnlyHostnameIsNil() {
        let endpoints = AppModel.endpoints(hostname: "   ", cfId: nil, cfSecret: nil, tailnet: nil)
        XCTAssertNil(endpoints.cfBase)
    }

    func testNilHostnameIsNil() {
        let endpoints = AppModel.endpoints(hostname: nil, cfId: nil, cfSecret: nil, tailnet: nil)
        XCTAssertNil(endpoints.cfBase)
    }

    func testTailnetWithoutSchemeGetsHttp() {
        let endpoints = AppModel.endpoints(hostname: nil, cfId: nil, cfSecret: nil, tailnet: "100.100.100.100:4300")
        XCTAssertEqual(endpoints.tailnetBase, URL(string: "http://100.100.100.100:4300"))
    }

    func testTailnetWithSchemeIsUnchanged() {
        let endpoints = AppModel.endpoints(hostname: nil, cfId: nil, cfSecret: nil, tailnet: "http://100.100.100.100:4300")
        XCTAssertEqual(endpoints.tailnetBase, URL(string: "http://100.100.100.100:4300"))
    }

    func testTailnetTrailingSlashIsTrimmed() {
        let endpoints = AppModel.endpoints(hostname: nil, cfId: nil, cfSecret: nil, tailnet: "http://100.100.100.100:4300/")
        XCTAssertEqual(endpoints.tailnetBase, URL(string: "http://100.100.100.100:4300"))
    }

    func testCfIdAndSecretAreTrimmedAndEmptyBecomesNil() {
        let endpoints = AppModel.endpoints(hostname: nil, cfId: "  id-1  ", cfSecret: "", tailnet: nil)
        XCTAssertEqual(endpoints.cfId, "id-1")
        XCTAssertNil(endpoints.cfSecret)
    }

    // MARK: - init(keychain:) reads the existing configuration

    func testInitWithEmptyKeychainIsNotConfigured() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)

        XCTAssertFalse(model.configured)
        XCTAssertNil(model.client)
    }

    func testInitWithExistingTailnetValueIsConfigured() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.tailnetBase, "100.100.100.100:4300")

        let model = AppModel(keychain: keychain)

        XCTAssertTrue(model.configured)
        XCTAssertNotNil(model.client)
    }

    // MARK: - saveConfig roundtrip

    func testSaveConfigPersistsToKeychainAndRebuildsClient() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        XCTAssertFalse(model.configured)
        XCTAssertNil(model.client)

        let result = model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")

        XCTAssertNoThrow(try result.get())
        XCTAssertEqual(keychain.get(KeychainStore.cfHostname), "devbox.example.ts.net")
        XCTAssertEqual(keychain.get(KeychainStore.cfClientId), "id-1")
        XCTAssertEqual(keychain.get(KeychainStore.cfClientSecret), "secret-1")
        XCTAssertNil(keychain.get(KeychainStore.tailnetBase))
        XCTAssertTrue(model.configured)
        XCTAssertNotNil(model.client)
    }

    // Review fix round 1: a CF hostname on its own (no id/secret) must not flip `configured` to
    // true — `DevdClient` would reject such a request anyway (missing service token), and in `SettingsScreen`
    // it would also mean the onboarding sheet closes before the "Test connection" result arrives.
    func testCfHostnameWithoutIdAndSecretIsNotConfigured() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)

        let result = model.saveConfig(hostname: "devbox.example.ts.net", cfId: "", cfSecret: "", tailnet: "")

        XCTAssertNoThrow(try result.get())
        XCTAssertFalse(model.configured)
        XCTAssertNil(model.client)
    }

    /// An empty form (typically the onboarding cover shown because of an unreadable Keychain
    /// on a locked phone) MUST NOT delete the saved credentials — saveConfig returns an error
    /// and leaves the Keychain alone.
    func testSaveConfigWithAllFieldsEmptyKeepsExistingKeychainEntries() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.cfHostname, "old.example.ts.net")
        keychain.set(KeychainStore.cfClientId, "old-id")
        keychain.set(KeychainStore.cfClientSecret, "old-secret")
        keychain.set(KeychainStore.tailnetBase, "100.100.100.100:4300")
        let model = AppModel(keychain: keychain)
        XCTAssertTrue(model.configured)

        let result = model.saveConfig(hostname: "", cfId: " ", cfSecret: "", tailnet: "  ")

        guard case .failure(let error) = result else { return XCTFail("expected an error for an empty form") }
        XCTAssertEqual(error, .emptyConfig)
        XCTAssertEqual(error.description, "Fill in at least the tailnet address or the Cloudflare details")
        XCTAssertEqual(keychain.get(KeychainStore.cfHostname), "old.example.ts.net")
        XCTAssertEqual(keychain.get(KeychainStore.cfClientId), "old-id")
        XCTAssertEqual(keychain.get(KeychainStore.cfClientSecret), "old-secret")
        XCTAssertEqual(keychain.get(KeychainStore.tailnetBase), "100.100.100.100:4300")
        XCTAssertTrue(model.configured)
        XCTAssertNotNil(model.client)
    }

    /// A partially empty form may still turn off one path (CF fields empty, tailnet stays).
    func testSaveConfigWithEmptyCfFieldsDeletesOnlyCfEntries() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.cfHostname, "old.example.ts.net")
        keychain.set(KeychainStore.cfClientId, "old-id")
        keychain.set(KeychainStore.cfClientSecret, "old-secret")
        let model = AppModel(keychain: keychain)

        let result = model.saveConfig(hostname: "", cfId: "", cfSecret: "", tailnet: "100.100.100.100:4300")

        XCTAssertNoThrow(try result.get())
        XCTAssertNil(keychain.get(KeychainStore.cfHostname))
        XCTAssertNil(keychain.get(KeychainStore.cfClientId))
        XCTAssertNil(keychain.get(KeychainStore.cfClientSecret))
        XCTAssertEqual(keychain.get(KeychainStore.tailnetBase), "100.100.100.100:4300")
        XCTAssertTrue(model.configured)
    }

    // MARK: - configState — an unavailable Keychain (locked phone) is not "not configured"

    func testUnavailableKeychainGivesUnknownStateWithoutClient() {
        let reader = FakeKeychainReader()
        reader.unavailable = errSecInteractionNotAllowed
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)

        XCTAssertEqual(model.configState, .unknown)
        XCTAssertFalse(model.configured)
        XCTAssertNil(model.client)
    }

    func testReloadAfterKeychainBecomesAvailableConfigures() {
        let reader = FakeKeychainReader()
        reader.unavailable = errSecInteractionNotAllowed
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)
        XCTAssertEqual(model.configState, .unknown)

        reader.unavailable = nil
        reader.values = [KeychainStore.tailnetBase: "100.100.100.100:4300"]
        model.reloadConfiguration()

        XCTAssertEqual(model.configState, .configured)
        XCTAssertTrue(model.configured)
        XCTAssertNotNil(model.client)
    }

    func testReadableEmptyKeychainIsNotConfigured() {
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: FakeKeychainReader())

        XCTAssertEqual(model.configState, .notConfigured)
        XCTAssertNil(model.client)
    }

    /// One unreadable item is enough — without it we cannot tell whether the app has the path.
    func testSingleUnavailableEndpointKeyGivesUnknownState() {
        let reader = FakeKeychainReader()
        reader.values = [KeychainStore.cfHostname: "devbox.example.ts.net", KeychainStore.cfClientId: "id-1"]
        reader.unavailableKeys = [KeychainStore.cfClientSecret]
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)

        XCTAssertEqual(model.configState, .unknown)
        XCTAssertNil(model.client)
    }

    /// A transient read failure after a successful start must not "sign out" the app.
    func testTransientFailureAfterConfiguredKeepsClient() {
        let reader = FakeKeychainReader()
        reader.values = [KeychainStore.tailnetBase: "100.100.100.100:4300"]
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)
        XCTAssertEqual(model.configState, .configured)

        reader.unavailable = errSecInteractionNotAllowed
        model.reloadConfiguration()

        XCTAssertEqual(model.configState, .configured)
        XCTAssertNotNil(model.client)
    }

    // MARK: - Live Activity — tokens only for a configured server

    func testLiveActivityHasNoServerUntilConfigured() {
        let reader = FakeKeychainReader()
        reader.unavailable = errSecInteractionNotAllowed
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)
        XCTAssertNil(model.liveActivityManager.serverID, "Unknown (locked Keychain) must not register anything")

        reader.unavailable = nil
        reader.values = [KeychainStore.tailnetBase: "100.100.100.100:4300"]
        model.reloadConfiguration()
        XCTAssertEqual(model.liveActivityManager.serverID, AgentLiveActivityManager.serverID(
            for: AppModel.endpoints(hostname: nil, cfId: nil, cfSecret: nil, tailnet: "100.100.100.100:4300")))
    }

    func testLiveActivityStaysOffForEmptyConfiguration() {
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: FakeKeychainReader())
        XCTAssertEqual(model.configState, .notConfigured)
        XCTAssertNil(model.liveActivityManager.serverID)
    }

    func testLiveActivityFollowsServerChangeOnSave() {
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false))
        model.saveConfig(hostname: "", cfId: "", cfSecret: "", tailnet: "100.100.100.100:4300")
        let first = model.liveActivityManager.serverID
        XCTAssertNotNil(first)
        model.saveConfig(hostname: "", cfId: "", cfSecret: "", tailnet: "100.100.100.101:4300")
        XCTAssertNotNil(model.liveActivityManager.serverID)
        XCTAssertNotEqual(model.liveActivityManager.serverID, first)
    }

    // MARK: - ConfigLoadingKind — spinner vs. explanation while there is no client

    func testUnknownWithProtectedDataAndActiveSceneIsFailed() {
        XCTAssertEqual(ConfigLoadingKind.decide(state: .unknown, protectedDataAvailable: true, sceneActive: true), .failed)
    }

    func testUnknownWhileLockedOrInactiveKeepsWaiting() {
        XCTAssertEqual(ConfigLoadingKind.decide(state: .unknown, protectedDataAvailable: false, sceneActive: true), .waiting)
        XCTAssertEqual(ConfigLoadingKind.decide(state: .unknown, protectedDataAvailable: true, sceneActive: false), .waiting)
        XCTAssertEqual(ConfigLoadingKind.decide(state: .unknown, protectedDataAvailable: false, sceneActive: false), .waiting)
    }

    func testKnownStatesNeverShowFailure() {
        for state in [ConfigState.configured, .notConfigured] {
            XCTAssertEqual(ConfigLoadingKind.decide(state: state, protectedDataAvailable: true, sceneActive: true), .waiting)
        }
    }

    // MARK: - testConnection()

    func testTestConnectionWithoutClientReturnsFailure() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)

        let result = await model.testConnection()

        switch result {
        case .success:
            XCTFail("expected an error — no client is configured")
        case .failure:
            break
        }
    }

    /// Test connection from the form must not write or delete anything before the test succeeds.
    func testFormTestConnectionDoesNotTouchKeychain() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.tailnetBase, "100.100.100.100:4300")
        let model = AppModel(keychain: keychain)

        let empty = await model.testConnection(hostname: "", cfId: "", cfSecret: "", tailnet: "")
        guard case .failure(let emptyError) = empty else { return XCTFail("expected an error for an empty form") }
        XCTAssertEqual(emptyError as? ConfigSaveError, .emptyConfig)

        // A CF hostname alone = an unusable path, fails right away without the network.
        let partial = await model.testConnection(hostname: "other.example.ts.net", cfId: "", cfSecret: "", tailnet: "")
        guard case .failure = partial else { return XCTFail("expected an error for an incomplete CF path") }

        XCTAssertEqual(keychain.get(KeychainStore.tailnetBase), "100.100.100.100:4300")
        XCTAssertNil(keychain.get(KeychainStore.cfHostname))
        XCTAssertTrue(model.configured)
    }

    // MARK: - currentConfig() — pre-fill for Settings opened from More (review pass #1, stage B/C)

    func testCurrentConfigReturnsEmptyStringsWhenNothingSaved() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)

        guard let config = model.currentConfig() else { return XCTFail("a readable Keychain must give a configuration") }

        XCTAssertEqual(config.hostname, "")
        XCTAssertEqual(config.cfId, "")
        XCTAssertEqual(config.cfSecret, "")
        XCTAssertEqual(config.tailnet, "")
    }

    func testCurrentConfigReflectsSavedValues() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")

        guard let config = model.currentConfig() else { return XCTFail("a readable Keychain must give a configuration") }

        XCTAssertEqual(config.hostname, "devbox.example.ts.net")
        XCTAssertEqual(config.cfId, "id-1")
        XCTAssertEqual(config.cfSecret, "secret-1")
        XCTAssertEqual(config.tailnet, "")
    }

    /// An unreadable item must not look empty in the pre-fill — Save would then delete it.
    func testCurrentConfigIsNilWhenAnyEndpointKeyUnavailable() {
        let reader = FakeKeychainReader()
        reader.values = [KeychainStore.cfHostname: "devbox.example.ts.net", KeychainStore.tailnetBase: "100.100.100.100:4300"]
        reader.unavailableKeys = [KeychainStore.cfClientSecret]
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)

        XCTAssertNil(model.currentConfig())
    }

    func testCurrentConfigReadsThroughReader() {
        let reader = FakeKeychainReader()
        reader.values = [KeychainStore.tailnetBase: "100.100.100.100:4300"]
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false), reader: reader)

        XCTAssertEqual(model.currentConfig()?.tailnet, "100.100.100.100:4300")
        XCTAssertEqual(model.currentConfig()?.hostname, "")
    }

    // MARK: - clientIdentity — changes after saveConfig (review pass #2, stage B/C — split-brain)

    func testClientIdentityChangesAfterSaveConfig() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        let before = model.clientIdentity

        model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")

        XCTAssertNotEqual(model.clientIdentity, before)
    }

    /// The SECOND save too (a different value, the client is rebuilt again) must give a NEW identity AGAIN —
    /// otherwise `SessionsContainer`'s `.onChange(of: appModel.clientIdentity)` (DevboxAppApp.swift)
    /// would miss the second client change.
    func testClientIdentityChangesAgainOnSecondSaveConfig() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")
        let afterFirst = model.clientIdentity

        model.saveConfig(hostname: "other.example.ts.net", cfId: "id-2", cfSecret: "secret-2", tailnet: "")

        XCTAssertNotEqual(model.clientIdentity, afterFirst)
    }

    /// Fix round (review Critical): `clientIdentity` is NO longer bumped on EVERY `saveConfig`, only
    /// when the endpoints really differ — otherwise a no-op Save/Test connection would needlessly rebuild
    /// `LiveStore` in the running `SessionsContainer` (`.onChange(of: appModel.clientIdentity)`).
    func testClientIdentityUnchangedOnNoOpSaveConfig() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")
        let afterFirst = model.clientIdentity

        // The same values again (Test connection over an unchanged form, or Save without changes).
        model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")

        XCTAssertEqual(model.clientIdentity, afterFirst)
    }

    /// Trimming/normalization (spaces around the value) also counts as the SAME endpoint — `endpointsEqual`
    /// compares the normalized `DevdEndpoints`, not the raw input strings.
    func testClientIdentityUnchangedWhenOnlyWhitespaceDiffers() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.saveConfig(hostname: "devbox.example.ts.net", cfId: "id-1", cfSecret: "secret-1", tailnet: "")
        let afterFirst = model.clientIdentity

        model.saveConfig(hostname: "  devbox.example.ts.net  ", cfId: "id-1", cfSecret: "secret-1", tailnet: "")

        XCTAssertEqual(model.clientIdentity, afterFirst)
    }

    // MARK: - Vault (Stage G, task 30)

    private func makeMockedClient(_ handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> DevdClient {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://100.100.100.100:4300")!)
        return DevdClient(endpoints: endpoints, session: URLSession(configuration: config))
    }

    /// `URLSession` usually turns `httpBody` into `httpBodyStream` before the request reaches
    /// `URLProtocol` — so we read both, same pattern as `SessionActionsTests.bodyJSON`.
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

    func testRefreshVaultStatusUpdatesLockedFromResponse() async throws {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 200, data: #"{"locked":true}"#.data(using: .utf8)!) }
        XCTAssertFalse(model.vaultLocked)

        await model.refreshVaultStatus()

        XCTAssertTrue(model.vaultLocked)
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/vault")
        XCTAssertEqual(req.httpMethod, "GET")
    }

    /// Mirrors the web `nextVaultStatus`: a request error (an older devd without the route, or devd not
    /// responding right now) is NOT proof of locking/unlocking — the last known state must not be overwritten.
    func testRefreshVaultStatusLeavesLockedUnchangedOnFailure() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 500) }

        await model.refreshVaultStatus()

        XCTAssertFalse(model.vaultLocked)
    }

    /// Tapping the vault-locked notification: the sheet does NOT open only when devd confirms
    /// `locked:false`. A request error (nil) = better a sheet than a silent app.
    func testRefreshVaultStatusReturnsConfirmedStateOrNil() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 200, data: #"{"locked":false}"#.data(using: .utf8)!) }
        let unlocked = await model.refreshVaultStatus()
        XCTAssertEqual(unlocked, false)
        model.client = makeMockedClient { _ in .init(statusCode: 500) }
        let failed = await model.refreshVaultStatus()
        XCTAssertNil(failed)
    }

    func testVaultSheetOpensUnlessConfirmedUnlocked() {
        XCTAssertTrue(AppModel.shouldOpenVaultSheet(confirmedLocked: true))
        XCTAssertTrue(AppModel.shouldOpenVaultSheet(confirmedLocked: nil))
        XCTAssertFalse(AppModel.shouldOpenVaultSheet(confirmedLocked: false))
    }

    func testUnlockVaultPostsPassphraseToUnlockPathAndUpdatesLocked() async throws {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 200, data: #"{"locked":false}"#.data(using: .utf8)!) }

        let result = await model.unlockVault(passphrase: "s3cr3t")

        if case .failure(let error) = result { XCTFail("expected success, got \(error)") }
        XCTAssertFalse(model.vaultLocked)
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/vault/unlock")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(bodyJSON(req)["passphrase"] as? String, "s3cr3t")
    }

    // MARK: - Unlock with the saved passphrase (Face ID)

    /// The saved passphrase is read from the Keychain (in production that triggers Face ID itself via the
    /// item's access control) and sent to `/api/vault/unlock` — one tap from the banner and from Settings.
    func testUnlockVaultWithSavedPassphraseReadsKeychainAndPosts() async throws {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.vaultPassphrase, "s3cr3t")
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 200, data: #"{"locked":false}"#.data(using: .utf8)!) }

        let result = await model.unlockVaultWithSavedPassphrase()

        if case .failure(let error) = result { XCTFail("expected success, got \(error)") }
        XCTAssertFalse(model.vaultLocked)
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/vault/unlock")
        XCTAssertEqual(bodyJSON(req)["passphrase"] as? String, "s3cr3t")
        // A successful passphrase stays saved for next time.
        XCTAssertTrue(model.vaultPassphraseSaved())
    }

    func testUnlockVaultWithSavedPassphraseWithoutSavedValueFailsWithoutRequest() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 200, data: #"{"locked":false}"#.data(using: .utf8)!) }

        let result = await model.unlockVaultWithSavedPassphrase()

        guard case .failure(let error) = result else { return XCTFail("must fail without a saved passphrase") }
        XCTAssertEqual(errorText(error), "No saved passphrase — enter it once and turn on Remember.")
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty)
    }

    /// The passphrase changed on devd: the saved value is useless and the "Unlock with Face
    /// ID" button would otherwise keep failing forever. After a 401 it is forgotten, so the UI falls back to manual entry.
    func testUnlockVaultWithSavedPassphraseForgetsValueRejectedByServer() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.vaultPassphrase, "stale")
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 401) }

        let result = await model.unlockVaultWithSavedPassphrase()

        guard case .failure = result else { return XCTFail("401 must be an error") }
        XCTAssertFalse(model.vaultPassphraseSaved())
    }

    /// A network error (devd not running) is NOT a reason to forget the passphrase — it may still be correct.
    func testUnlockVaultWithSavedPassphraseKeepsValueOnNetworkFailure() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        keychain.set(KeychainStore.vaultPassphrase, "s3cr3t")
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 503) }

        _ = await model.unlockVaultWithSavedPassphrase()

        XCTAssertTrue(model.vaultPassphraseSaved())
    }

    func testUnlockVaultWithWrongPassphraseReturnsFailureAndKeepsLocked() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        model.client = makeMockedClient { _ in .init(statusCode: 401) }

        let result = await model.unlockVault(passphrase: "wrong")

        switch result {
        case .success:
            XCTFail("expected an error — the server rejected the passphrase")
        case .failure:
            break
        }
    }

    func testUnlockVaultWithoutClientReturnsFailure() async {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)

        let result = await model.unlockVault(passphrase: "anything")

        switch result {
        case .success:
            XCTFail("expected an error — no client is configured")
        case .failure:
            break
        }
    }

    // MARK: - unlockErrorText (H0 fix pack: network vs. wrong passphrase)

    /// The only case where devd actually verified the passphrase and rejected it — see `/api/vault/unlock`
    /// in devd/src/api.ts (401 = "wrong passphrase").
    func testUnlockErrorTextForHTTP401IsWrongPassphrase() {
        XCTAssertEqual(AppModel.unlockErrorText(DevdHTTPError(statusCode: 401)), "Wrong passphrase.")
    }

    /// Anything else (a different HTTP status, a network error) means the app never got as far as
    /// verification — it must not look like "try a different password".
    func testUnlockErrorTextForOtherHTTPStatusIsNetworkText() {
        XCTAssertEqual(AppModel.unlockErrorText(DevdHTTPError(statusCode: 503)), "Couldn't reach devd: Server error (HTTP 503)")
    }

    func testUnlockErrorTextForGenericErrorIsNetworkText() {
        let error = DevdClientError(description: "no route to host")
        XCTAssertEqual(AppModel.unlockErrorText(error), "Couldn't reach devd: no route to host")
    }

    /// Errors that are not about the network at all (no saved passphrase, biometrics failed) are
    /// shown with their own text — a "Couldn't reach devd" prefix would be a lie.
    func testUnlockErrorTextForLocalErrorsIsTheirOwnText() {
        XCTAssertEqual(AppModel.unlockErrorText(VaultUnlockError.noSavedPassphrase), "No saved passphrase — enter it once and turn on Remember.")
        XCTAssertEqual(AppModel.unlockErrorText(BiometricError.failed("Face ID is locked out")), "Face ID is locked out")
    }

    // MARK: - Vault passphrase in Keychain (remember/forget)

    func testVaultPassphraseSavedRoundtrip() {
        let keychain = KeychainStore(requireBiometryForVault: false)
        let model = AppModel(keychain: keychain)
        XCTAssertFalse(model.vaultPassphraseSaved())

        model.rememberVaultPassphrase("s3cr3t")
        XCTAssertTrue(model.vaultPassphraseSaved())
        XCTAssertEqual(model.savedVaultPassphrase(), "s3cr3t")

        model.forgetVaultPassphrase()
        XCTAssertFalse(model.vaultPassphraseSaved())
        XCTAssertNil(model.savedVaultPassphrase())
    }
}

/// Fake `KeychainReading` — simulates a locked phone (`errSecInteractionNotAllowed`), which
/// cannot be triggered through the real Keychain in the simulator.
private final class FakeKeychainReader: KeychainReading {
    var values: [String: String] = [:]
    /// Set = EVERY read fails with this OSStatus.
    var unavailable: OSStatus?
    var unavailableKeys: Set<String> = []

    func read(_ key: String) -> KeychainRead {
        if let unavailable { return .unavailable(unavailable) }
        if unavailableKeys.contains(key) { return .unavailable(errSecInteractionNotAllowed) }
        if let value = values[key] { return .value(value) }
        return .missing
    }
}
