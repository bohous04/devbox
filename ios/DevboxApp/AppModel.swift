import Foundation
import Network

/// One-tap vault unlock error that happens BEFORE any network call (see
/// `AppModel.unlockVaultWithSavedPassphrase`). The text is user-visible — in English.
enum VaultUnlockError: Error, CustomStringConvertible {
    case noSavedPassphrase

    var description: String {
        switch self {
        case .noSavedPassphrase: return "No saved passphrase — enter it once and turn on Remember."
        }
    }
}

/// Result of `AppModel.saveConfig` — the texts are user-visible (Settings shows them in an alert).
enum ConfigSaveError: Error, Equatable, CustomStringConvertible {
    /// All fields empty — this used to delete the whole configuration (even when onboarding showed only
    /// because of a temporarily unreadable Keychain); now nothing is deleted.
    case emptyConfig
    case keychainWriteFailed

    var description: String {
        switch self {
        case .emptyConfig: return "Fill in at least the tailnet address or the Cloudflare details"
        case .keychainWriteFailed: return "Could not write to Keychain. Please try again."
        }
    }
}

/// `unknown` = Keychain cannot be read right now (locked phone, the app was woken by a background push) —
/// this is NOT "not configured": no onboarding, just waiting for `reloadConfiguration()`.
enum ConfigState: Equatable {
    case unknown
    case configured
    case notConfigured
}

/// What to show while the app has no client (`ContentView`). `waiting` = a plain `ProgressView`;
/// `failed` = an explanation with "Try again" and a way into Settings.
enum ConfigLoadingKind: Equatable {
    case waiting
    case failed

    /// `.unknown` on a locked phone (protected data unavailable) is an expected wait for
    /// unlock. But when the data are available, the scene active, and the state still `.unknown`, Keychain
    /// failed for another reason — an endless spinner would leave the user with no way out.
    static func decide(state: ConfigState, protectedDataAvailable: Bool, sceneActive: Bool) -> ConfigLoadingKind {
        state == .unknown && protectedDataAvailable && sceneActive ? .failed : .waiting
    }
}

/// Root app state: reads the network configuration from `KeychainStore`, holds the `DevdClient`
/// built from it, and drives onboarding (`configState == .notConfigured` until the app has at least one working
/// path — tailnet alone is enough, CF needs the complete hostname+id+secret triple, see
/// `isConfigured`). Sessions/Store come in stage C; for now there is only configuration here.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var configState: ConfigState = .unknown
    /// Derived from `configState` — `unknown` counts as `false` here, but onboarding is driven by
    /// `configState == .notConfigured`, not by this.
    var configured: Bool { configState == .configured }
    @Published var client: DevdClient?
    /// Unprocessed navigation target from a push notification (`PushManager.onDeepLink`) — `SessionsContainer`
    /// (DevboxAppApp.swift) navigates to the session detail on change, `SessionDetailView` then
    /// consumes it (opens the terminal when the payload carried `terminal: true`) and clears it. More targets
    /// and the vault are consumed directly by `SessionsContainer`. `nil` = nothing pending.
    @Published var pendingDeepLink: PushManager.PushDeepLink?
    /// Unprocessed tab switch request (`devbox://sessions` from the widget / Live Activity when nothing
    /// is waiting). `SessionsContainer` switches the tab and clears it.
    @Published var requestedTab: AppTab?
    /// Identity of the NETWORK PATH of the current `client` — changes in `saveConfig()`, but ONLY when the
    /// endpoints actually differ from the previous ones (not on a no-op save, see `endpointsEqual`).
    /// `SessionsContainer` (DevboxAppApp.swift) reacts to its change with `.onChange(...)` and rebuilds
    /// ONLY `LiveStore` (`rebuild(client:)`), not itself as a whole — `LiveStore` is a `@StateObject`, and without
    /// this, after `client` is rebuilt in Settings, it would stay bound to the FIRST client and polling
    /// would use the old path (split-brain, review of stages B/C). The earlier fix (`.id(...)` on the whole
    /// container) fixed this split-brain, but on EVERY saveConfig it also tore down the tabs, navigation
    /// and the currently open `SettingsScreen` with its own local state (review Critical, stage G).
    @Published private(set) var clientIdentity = UUID()
    /// Last known vault state (`GET /api/vault`) — shared between the banner in `SessionsContainer`
    /// and the unlock UI in Settings. Default `false`: until the app verifies the state (`refreshVaultStatus`
    /// is called at launch and on return to the foreground), the banner must not flash on an unlocked devd.
    @Published private(set) var vaultLocked = false
    /// State of the device network interface (wifi/mobile data), NOT the reachability of devd itself —
    /// `OfflineBanner`/`errorText` together distinguish "the phone has no connection at all" (this) from
    /// "there is a connection, but devd does not respond" (request errors). Default `true`: the app learns it only after
    /// the first callback from `NWPathMonitor`, which on a satisfied network arrives practically immediately, so
    /// there is no reason for the banner to flash before the app even determines the state.
    @Published private(set) var isOnline = true

    private let keychain: KeychainStore
    private let reader: KeychainReading
    private let pathMonitor = NWPathMonitor()
    /// Endpoints the current `client` is built from (nil = no successful load) — they
    /// decide whether the client and `clientIdentity` should be rebuilt.
    private var loadedEndpoints: DevdEndpoints?

    /// APNs registration/categories/ack — owned by AppModel (survives UI redraws and client
    /// changes), `lazy` because the closures below capture `self`, which is allowed only after full initialization.
    lazy var pushManager: PushManager = PushManager(
        clientProvider: { [weak self] in self?.client },
        onDeepLink: { [weak self] link in self?.pendingDeepLink = link }
    )

    /// Server-driven agent Live Activity (APNs tokens, authoritative state in the foreground). It receives the context
    /// (client + opaque serverID) in `apply` only when `configState == .configured` —
    /// so neither an unconfigured nor a locked (`unknown`) app registers any tokens.
    lazy var liveActivityManager = AgentLiveActivityManager(client: nil, serverID: nil)

    /// Cleanup of orphaned per-session Live Activities from build 12 (see LegacySessionActivityCleanup.swift);
    /// DevboxAppApp runs it at launch and on return to the foreground. Delete together with that file.
    lazy var legacySessionActivityCleanup = LegacySessionActivityCleanup()

    /// `reader` = where the configuration is read from; the default is `keychain` itself, tests inject a fake
    /// (a locked Keychain cannot be triggered in the simulator).
    init(keychain: KeychainStore = KeychainStore(), reader: KeychainReading? = nil) {
        self.keychain = keychain
        self.reader = reader ?? keychain
        reloadConfiguration()
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                self?.isOnline = satisfied
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.example.devbox.pathmonitor"))
    }

    deinit {
        pathMonitor.cancel()
    }

    /// Reloads the network configuration from Keychain. Called by `init` and then by `ContentView` when
    /// protected data become available (phone unlocked) or the app comes to the foreground, until it is
    /// `configured`. An unavailable Keychain yields `.unknown` (no client, no onboarding) — but
    /// a transient error does not sign out an app that is already configured.
    func reloadConfiguration() {
        guard let values = readEndpointValues() else {
            if configState != .configured {
                configState = .unknown
                client = nil
                loadedEndpoints = nil
            }
            return
        }
        // The read succeeded = the device is unlocked; switch existing items to AfterFirstUnlock so
        // the next push wake-up while the phone is locked can read them.
        keychain.migrateAccessibility(keys: Self.endpointKeys.filter { values[$0] != nil })
        apply(Self.endpoints(from: values))
    }

    /// Opening from the Live Activity (`devbox://session/<id>`, optionally `?terminal=1`) uses the same navigation
    /// path as tapping an APNs notification, so it also works on cold start and from another tab.
    /// `devbox://sessions` (widget, activity without a waiting session) just switches to the Sessions tab.
    func handleDeepLinkURL(_ url: URL) {
        if url.scheme == "devbox", url.host == "sessions" {
            requestedTab = .sessions
            return
        }
        guard let link = Self.deepLink(from: url) else { return }
        pendingDeepLink = link
    }

    /// `devbox://session/<id>[?terminal=1]`, `devbox://more/<target>` (same dictionary as `target`
    /// in the push payload, see `PushManager.link(forTarget:)`) and `devbox://vault`.
    static func deepLink(from url: URL) -> PushManager.PushDeepLink? {
        guard url.scheme == "devbox" else { return nil }
        let first = url.pathComponents.dropFirst().first
        switch url.host {
        case "session":
            guard let sessionId = first, !sessionId.isEmpty else { return nil }
            let terminal = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "terminal" })?.value == "1"
            return .session(id: sessionId, terminal: terminal)
        case "more":
            guard let target = first, target != "vault" else { return nil }
            return PushManager.link(forTarget: target)
        case "vault":
            return .vault
        default:
            return nil
        }
    }

    /// Saves the configuration to Keychain and rebuilds the client. An empty (after trimming whitespace) field
    /// means "delete this key", not "save an empty string" — this way e.g. the CF path can be turned off
    /// without reinstalling the app. ALL fields empty are rejected though (`.emptyConfig`)
    /// and nothing is deleted — an empty onboarding form must not discard stored credentials. A Keychain
    /// write failure (see `KeychainStore.set`) returns `.keychainWriteFailed`.
    @discardableResult
    func saveConfig(hostname: String, cfId: String, cfSecret: String, tailnet: String) -> Result<Void, ConfigSaveError> {
        guard [hostname, cfId, cfSecret, tailnet].contains(where: { Self.normalizeString($0) != nil }) else {
            return .failure(.emptyConfig)
        }

        var ok = true
        ok = writeOrDelete(KeychainStore.cfHostname, hostname) && ok
        ok = writeOrDelete(KeychainStore.cfClientId, cfId) && ok
        ok = writeOrDelete(KeychainStore.cfClientSecret, cfSecret) && ok
        ok = writeOrDelete(KeychainStore.tailnetBase, tailnet) && ok

        // Read back from Keychain (not from the form), so the state matches what was actually
        // saved. An unreadable Keychain deletes nothing and signs nothing out here — the client just is not rebuilt.
        if let values = readEndpointValues() {
            apply(Self.endpoints(from: values))
        }
        // A new path/token in Settings builds a new client — but devd on the other side (or a new
        // devd, if the hostname changed) does not know it yet. After the first grant of
        // permission the system does not give the app a second token, so the last known one is sent again (no-op without a client).
        if configured {
            pushManager.reregisterCurrentToken()
        }
        return ok ? .success(()) : .failure(.keychainWriteFailed)
    }

    /// Current network configuration from Keychain, as Settings shows it when opened from More (outside
    /// onboarding) — without this the fields would open empty and Save would delete the existing path
    /// (see `SettingsScreen.prefill`). `nil` = at least one key is unreadable right now
    /// (`KeychainRead.unavailable`): an empty string would look like "not filled in" here, and the next
    /// Save/Test would delete that item — Settings then prefills nothing and blocks saving.
    func currentConfig() -> (hostname: String, cfId: String, cfSecret: String, tailnet: String)? {
        guard let values = readEndpointValues() else { return nil }
        return (
            hostname: values[KeychainStore.cfHostname] ?? "",
            cfId: values[KeychainStore.cfClientId] ?? "",
            cfSecret: values[KeychainStore.cfClientSecret] ?? "",
            tailnet: values[KeychainStore.tailnetBase] ?? ""
        )
    }

    // MARK: - Vault

    private struct VaultUnlockBody: Encodable { let passphrase: String }

    /// `GET /api/vault` — mirrors the web `nextVaultStatus` (`dashboard/src/vaultView.ts`): a failure
    /// (older devd without the route, or devd not responding right now — restart/deploy) is NOT proof of locked
    /// or unlocked; `vaultLocked` simply does not change in that case.
    /// Returns the state CONFIRMED by a devd response, `nil` = the request failed (or there is no client) — then
    /// `vaultLocked` is not overwritten and the caller decides itself (see `shouldOpenVaultSheet`).
    @discardableResult
    func refreshVaultStatus() async -> Bool? {
        guard let client else { return nil }
        guard let status: VaultStatus = try? await client.get("/api/vault") else { return nil }
        vaultLocked = status.locked
        return status.locked
    }

    /// Tapping the vault-locked notification: the sheet does not open only when devd confirms
    /// it is unlocked. An unreachable devd (nil) is not proof of unlocking — better a sheet than a silent app.
    static func shouldOpenVaultSheet(confirmedLocked: Bool?) -> Bool {
        confirmedLocked != false
    }

    /// `POST /api/vault/unlock` — success updates `vaultLocked` right away, so the banner in
    /// `SessionsContainer` does not have to wait for the next foreground refresh.
    func unlockVault(passphrase: String) async -> Result<Void, Error> {
        guard let client else {
            // User-visible (Settings renders it) — must be in English.
            return .failure(DevdClientError(description: "No network path configured"))
        }
        do {
            let status: VaultStatus = try await client.post("/api/vault/unlock", body: VaultUnlockBody(passphrase: passphrase))
            vaultLocked = status.locked
            return .success(())
        } catch {
            return .failure(error)
        }
    }

    /// Classifies the error from `unlockVault` for the UI (`VaultSection`): a `DevdHTTPError` with status 401 is
    /// the only case where devd actually checked the passphrase and rejected it (see `/api/vault/unlock` in
    /// devd/src/api.ts — it does not distinguish other errors there). Anything else (URLError, 5xx, 503 "vault
    /// not configured") means the app never got as far as verification — reporting "Wrong
    /// passphrase" would be misleading, the user might needlessly try another password.
    nonisolated static func unlockErrorText(_ error: Error) -> String {
        if let httpError = error as? DevdHTTPError, httpError.statusCode == 401 {
            return "Wrong passphrase."
        }
        // Local errors (no stored passphrase, biometrics) are not about the network — no prefix.
        if error is VaultUnlockError || error is BiometricError {
            return errorText(error)
        }
        return "Couldn't reach devd: \(errorText(error))"
    }

    /// Is a vault passphrase stored? A check without reading the data (`KeychainStore.exists`), so it
    /// does not trigger Face ID just to decide whether Settings offers "Unlock with Face ID"
    /// or an empty field for one-time entry.
    func vaultPassphraseSaved() -> Bool {
        keychain.exists(KeychainStore.vaultPassphrase)
    }

    /// One-tap unlock: reads the stored passphrase (in production this itself triggers Face ID —
    /// the item has the `.biometryCurrentSet` access control, see `KeychainStore`) and sends it to devd.
    /// Shared by the banner in `SessionsContainer` and the Vault section in Settings.
    ///
    /// After a 401 the stored value is FORGOTTEN: the passphrase changed on devd and the button would otherwise
    /// fail forever without the UI offering manual entry. A network error (devd not running) keeps the
    /// value — it may still be correct.
    func unlockVaultWithSavedPassphrase() async -> Result<Void, Error> {
        guard vaultPassphraseSaved() else { return .failure(VaultUnlockError.noSavedPassphrase) }
        // The item exists, but the read returned nothing = the user closed the Face ID dialog
        // (`errSecUserCanceled`). A silent error, same as a cancelled SSH key approval.
        guard let saved = savedVaultPassphrase(), !saved.isEmpty else { return .failure(BiometricError.cancelled) }
        let result = await unlockVault(passphrase: saved)
        if case .failure(let error) = result, (error as? DevdHTTPError)?.statusCode == 401 {
            forgetVaultPassphrase()
        }
        return result
    }

    /// The read ITSELF triggers biometrics (access control on the key, see `KeychainStore`) — called only
    /// after tapping "Unlock with Face ID", not when Settings is merely shown.
    func savedVaultPassphrase() -> String? {
        keychain.get(KeychainStore.vaultPassphrase)
    }

    @discardableResult
    func rememberVaultPassphrase(_ passphrase: String) -> Bool {
        keychain.set(KeychainStore.vaultPassphrase, passphrase)
    }

    func forgetVaultPassphrase() {
        keychain.delete(KeychainStore.vaultPassphrase)
    }

    /// Calls `/api/health` via the currently configured client and returns the devd version.
    /// Without a configured path it returns an error right away, without attempting a request.
    func testConnection() async -> Result<String, Error> {
        guard let client else {
            // User-visible (Settings renders it) — must be in English, see the app UI language.
            return .failure(DevdClientError(description: "No network path configured"))
        }
        return await health(via: client)
    }

    /// "Test connection" over the form values — a temporary client, NOTHING is written to Keychain
    /// (saving is up to the caller, after success). An empty form returns the same error
    /// as `saveConfig`.
    func testConnection(hostname: String, cfId: String, cfSecret: String, tailnet: String) async -> Result<String, Error> {
        guard [hostname, cfId, cfSecret, tailnet].contains(where: { Self.normalizeString($0) != nil }) else {
            return .failure(ConfigSaveError.emptyConfig)
        }
        let endpoints = Self.endpoints(hostname: hostname, cfId: cfId, cfSecret: cfSecret, tailnet: tailnet)
        guard Self.isConfigured(endpoints) else {
            return .failure(DevdClientError(description: "No network path configured"))
        }
        return await health(via: DevdClient(endpoints: endpoints, session: Self.makeSession()))
    }

    private func health(via client: DevdClient) async -> Result<String, Error> {
        do {
            let health: HealthResponse = try await client.get("/api/health")
            return .success(health.version)
        } catch {
            return .failure(error)
        }
    }

    /// Pure, testable normalization of form inputs into `DevdEndpoints`: adds the scheme
    /// when missing (CF → https, tailnet → http), trims a trailing "/" and whitespace, and maps an empty
    /// result to `nil` instead of an invalid URL.
    static func endpoints(hostname: String?, cfId: String?, cfSecret: String?, tailnet: String?) -> DevdEndpoints {
        DevdEndpoints(
            cfBase: normalizeURL(hostname, defaultScheme: "https"),
            cfId: normalizeString(cfId),
            cfSecret: normalizeString(cfSecret),
            tailnetBase: normalizeURL(tailnet, defaultScheme: "http")
        )
    }

    // MARK: - Private

    /// `URLSession.shared` has a default `timeoutIntervalForRequest` of 60 s — for a blackholed address
    /// (tailnet IP out of reach, no RST/ICMP) a request would hang for almost a minute and polling would
    /// pile up in the meantime (the next tick starts another request before the previous one times out).
    /// A short timeout gives the multipath fallback (see `DevdClient`) a chance to try the other path before
    /// the UI gets stuck on "loading". `.ephemeral`, not `.default` — the app needs no
    /// URL cache or cookie storage between requests to its own devd.
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        return URLSession(configuration: config)
    }

    private func writeOrDelete(_ key: String, _ rawValue: String) -> Bool {
        guard let trimmed = Self.normalizeString(rawValue) else {
            keychain.delete(key)
            return true
        }
        return keychain.set(key, trimmed)
    }

    private static let endpointKeys = [
        KeychainStore.cfHostname,
        KeychainStore.cfClientId,
        KeychainStore.cfClientSecret,
        KeychainStore.tailnetBase,
    ]

    /// `nil` = at least one endpoint key is unavailable (`KeychainRead.unavailable`) — then it cannot be
    /// decided whether the app has a path, and nothing may be inferred (neither onboarding nor deletion).
    private func readEndpointValues() -> [String: String]? {
        var values: [String: String] = [:]
        for key in Self.endpointKeys {
            switch reader.read(key) {
            case .value(let value): values[key] = value
            case .missing: break
            case .unavailable: return nil
            }
        }
        return values
    }

    private static func endpoints(from values: [String: String]) -> DevdEndpoints {
        endpoints(
            hostname: values[KeychainStore.cfHostname],
            cfId: values[KeychainStore.cfClientId],
            cfSecret: values[KeychainStore.cfClientSecret],
            tailnet: values[KeychainStore.tailnetBase]
        )
    }

    /// Applies successfully loaded endpoints to the state. The client and `clientIdentity` are rebuilt ONLY on
    /// an actual path change — see the `clientIdentity` doc above: a no-op Save (same values again) or
    /// a repeated reload has nothing to rebuild in `SessionsContainer`.
    private func apply(_ endpoints: DevdEndpoints) {
        let isReady = Self.isConfigured(endpoints)
        let changed = loadedEndpoints.map { !Self.endpointsEqual($0, endpoints) } ?? true
        let previousClient = client
        loadedEndpoints = endpoints
        configState = isReady ? .configured : .notConfigured
        if !isReady {
            client = nil
        } else if changed || client == nil {
            client = DevdClient(endpoints: endpoints, session: Self.makeSession())
        }
        if changed {
            clientIdentity = UUID()
        }
        // New client = new path or credentials. The manager itself unregisters on the original server
        // (with the old client) before the new server gets the tokens; the same server just re-registers.
        if client !== previousClient {
            liveActivityManager.configure(
                client: client,
                serverID: client == nil ? nil : AgentLiveActivityManager.serverID(for: endpoints)
            )
        }
    }

    /// The CF path is usable only with the complete triple (hostname + id + secret) — a hostname
    /// alone without a service token would be rejected by `DevdClient` (see `perform`), so the app would
    /// report "configured" but no request would get through. Tailnet alone is enough.
    private static func isConfigured(_ endpoints: DevdEndpoints) -> Bool {
        let cfReady = endpoints.cfBase != nil && endpoints.cfId != nil && endpoints.cfSecret != nil
        return cfReady || endpoints.tailnetBase != nil
    }

    /// Manual field comparison instead of `DevdEndpoints: Equatable` — that type lives in `Api/DevdClient.swift`,
    /// outside the scope of this fix. Decides whether `saveConfig()` should bump `clientIdentity`
    /// (see there) — a no-op Save (same values again) must not trigger `LiveStore.rebuild(client:)`.
    private static func endpointsEqual(_ a: DevdEndpoints, _ b: DevdEndpoints) -> Bool {
        a.cfBase == b.cfBase && a.cfId == b.cfId && a.cfSecret == b.cfSecret && a.tailnetBase == b.tailnetBase
    }

    private static func normalizeString(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizeURL(_ value: String?, defaultScheme: String) -> URL? {
        guard var trimmed = normalizeString(value) else { return nil }
        if trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        if !trimmed.contains("://") {
            trimmed = "\(defaultScheme)://\(trimmed)"
        }
        guard let url = URL(string: trimmed), url.host != nil else { return nil }
        return url
    }
}
