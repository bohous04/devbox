import CryptoKit
import Foundation

/// One activity per configured server. All networking is serialized: a late registration
/// on an old client is followed by its DELETE before the new client can register anything.
///
/// devd sends the activity content (ContentState v2) via APNs; the app only registers tokens
/// (push-to-start at launch, update token after the activity starts) and in the foreground holds the authoritative
/// state from `GET /api/live-activities/state`. Only a configured app receives the context (client + server)
/// (`AppModel.configState == .configured`), so without a server nothing is registered.
@MainActor
final class AgentLiveActivityManager: ObservableObject {
    private enum DeliveryError: Error { case unavailable }
    @Published private(set) var enabled: Bool
    @Published private(set) var dismissed = false
    @Published private(set) var statusText = "Connect a server in Settings."
    @Published private(set) var lastState: DevboxAgentActivityAttributes.ContentState?

    private struct Context {
        let client: any AgentLiveActivityClient
        let serverID: String
        let revision: UUID
    }
    private struct Retirement {
        let context: Context
        let activityID: String?
    }
    private let driver: any AgentActivityDriver
    private let defaults: UserDefaults
    /// Every authoritative foreground state also goes to the home screen widget (`SharedActivityStore`).
    private let stateSink: (DevboxAgentActivityAttributes.ContentState) -> Void
    /// On a server change the widget state is deleted — it must not show sessions of another server.
    /// (Only on an actual change; see `noteWidgetServer`.)
    private let stateReset: () -> Void
    let deviceID: String
    private let environment: String
    private var context: Context?
    private var cleanup: [Retirement] = []
    private var revoked = false
    private var needsOptIn = true
    private var registered = Set<String>()
    private var retired = Set<String>()
    private var pendingDismissals = Set<String>()
    private var started = false
    private var foreground = false
    private var needsSync = false
    private var worker: Task<Void, Never>?
    private var polling: Task<Void, Never>?

    init(client: (any AgentLiveActivityClient)?, serverID: String?,
         driver: (any AgentActivityDriver)? = nil,
         defaults: UserDefaults = .standard,
         environment: String? = nil,
         stateSink: @escaping (DevboxAgentActivityAttributes.ContentState) -> Void = { SharedActivityStore.write($0) },
         stateReset: @escaping () -> Void = { SharedActivityStore.clear() }) {
        self.driver = driver ?? ActivityKitAgentDriver()
        self.defaults = defaults
        self.stateSink = stateSink
        self.stateReset = stateReset
        self.environment = environment ?? Self.apnsEnvironment
        self.enabled = defaults.object(forKey: "agentActivity.enabled") as? Bool ?? true
        if let saved = defaults.string(forKey: "agentActivity.deviceID"), UUID(uuidString: saved) != nil {
            deviceID = saved
        } else {
            deviceID = UUID().uuidString
            defaults.set(deviceID, forKey: "agentActivity.deviceID")
        }
        if let client, let serverID {
            context = Context(client: client, serverID: serverID, revision: UUID())
            dismissed = defaults.bool(forKey: Self.dismissalKey(serverID))
            noteWidgetServer(serverID)
        }
    }

    /// The widget keeps the last server's state across app restarts (the app starts without a server
    /// and configures it right away), so it is compared with the stored server, not with `context`.
    private func noteWidgetServer(_ serverID: String?) {
        let key = "agentActivity.widgetServerID"
        guard defaults.string(forKey: key) != serverID else { return }
        stateReset()
        if let serverID { defaults.set(serverID, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    func start() {
        guard !started else { return }
        started = true
        driver.startObserving(onChange: { [weak self] in self?.scheduleSync() },
                              onDismissed: { [weak self] id, serverID in self?.activityDisappeared(id: id, serverID: serverID) })
        // Immediate APNs end can skip the observable .ended state, including while the app
        // is terminated. Ask the server before treating a missing activity as a swipe-away.
        if let context, let knownID = defaults.string(forKey: Self.activityKey(context.serverID)),
           !driver.activities.contains(where: { $0.id == knownID }),
           !driver.activities.contains(where: { $0.serverID == context.serverID && $0.isLive }) {
            let since = defaults.object(forKey: Self.startedKey(context.serverID)) as? Date ?? Date()
            if Date().timeIntervalSince(since) < 8 * 60 * 60 {
                pendingDismissals.insert(knownID)
            } else {
                // ActivityKit expires running activities after eight hours. That is not a
                // swipe-away and must not permanently suppress tomorrow's agents.
                defaults.removeObject(forKey: Self.activityKey(context.serverID))
            }
        }
        scheduleSync()
    }

    func setForeground(_ active: Bool) {
        foreground = active
        polling?.cancel()
        polling = nil
        if active {
            // Re-register on every foreground entry: the server may have restarted or lost
            // registration state while ActivityKit retained the activity and token.
            registered.removeAll()
            scheduleSync()
            polling = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    guard let self, !Task.isCancelled else { return }
                    self.scheduleSync()
                }
            }
        }
    }

    /// Server the app is currently registering tokens for (`nil` = none configured).
    var serverID: String? { context?.serverID }

    func configure(client: (any AgentLiveActivityClient)?, serverID: String?) {
        if let previous = context, let client, previous.serverID == serverID {
            // Same server, just a new client (e.g. CF service token rotation): the registration
            // stays valid and the old client with old credentials would not get the DELETE through anyway —
            // the registration would get stuck. Just re-register the tokens with the new client.
            context = Context(client: client, serverID: previous.serverID, revision: UUID())
            registered.removeAll()
            scheduleSync()
            return
        }
        if let previous = context { cleanup.append(Retirement(context: previous, activityID: nil)) }
        noteWidgetServer(serverID)
        context = nil
        if let client, let serverID { context = Context(client: client, serverID: serverID, revision: UUID()) }
        dismissed = serverID.map { defaults.bool(forKey: Self.dismissalKey($0)) } ?? false
        registered.removeAll()
        retired.removeAll()
        pendingDismissals.removeAll()
        revoked = false
        needsOptIn = true
        lastState = nil
        scheduleSync()
    }

    func setEnabled(_ value: Bool) {
        guard enabled != value else { return }
        enabled = value
        defaults.set(value, forKey: "agentActivity.enabled")
        if value { clearDismissal() }
        needsOptIn = value
        revoked = false
        registered.removeAll()
        scheduleSync()
    }

    /// A swipe away is respected until this explicit action (or turning the setting on).
    func resume() {
        clearDismissal()
        needsOptIn = true
        revoked = false
        registered.removeAll()
        scheduleSync()
    }

    func retry() {
        registered.removeAll()
        scheduleSync()
    }

    /// Test and application shutdown seam. Normal backgrounding keeps token observers alive
    /// so a push-to-start launch can register its update token without foreground polling.
    func stop() {
        started = false
        foreground = false
        polling?.cancel()
        polling = nil
        driver.stopObserving()
        worker?.cancel()
        worker = nil
    }

    private func clearDismissal() {
        dismissed = false
        pendingDismissals.removeAll()
        if let context {
            defaults.removeObject(forKey: Self.dismissalKey(context.serverID))
            defaults.removeObject(forKey: Self.activityKey(context.serverID))
        }
    }

    private func activityDisappeared(id: String, serverID: String) {
        guard serverID == context?.serverID else { return }
        pendingDismissals.insert(id)
        scheduleSync()
    }

    private func resolveDismissals(context: Context) async throws -> Bool {
        for id in pendingDismissals.sorted() {
            let serverEnded = try await context.client.serverEndedAgentActivity(
                deviceID: deviceID, serverID: context.serverID, activityID: id)
            guard isCurrent(context) else { return false }
            // A resume action or endpoint change during the request supersedes its result.
            guard pendingDismissals.remove(id) != nil else { continue }
            let replacement = driver.activities.contains {
                $0.serverID == context.serverID && $0.id != id && $0.isLive
            }
            if serverEnded || replacement {
                if defaults.string(forKey: Self.activityKey(context.serverID)) == id {
                    defaults.removeObject(forKey: Self.activityKey(context.serverID))
                }
            } else {
                userDismissed(serverID: context.serverID)
                return false
            }
        }
        return true
    }

    private func userDismissed(serverID: String) {
        guard serverID == context?.serverID else { return }
        dismissed = true
        defaults.set(true, forKey: Self.dismissalKey(serverID))
        revoked = false
        scheduleSync()
    }

    private func scheduleSync() {
        guard started else { return }
        needsSync = true
        guard worker == nil else { return }
        worker = Task { [weak self] in
            guard let self else { return }
            while self.needsSync, !Task.isCancelled {
                self.needsSync = false
                await self.synchronize()
            }
            self.worker = nil
        }
    }

    // Internal seam: tests await exactly the same serialized loop as foreground/token events.
    func waitForSynchronization() async {
        while let pending = worker { await pending.value }
    }

    private var allowed: Bool { enabled && !dismissed && driver.areActivitiesEnabled }

    private func synchronize() async {
        let current = context
        let revision = current?.revision
        // Old-server activities must disappear locally even when old-server networking fails.
        for activity in driver.activities where activity.isLive && (activity.serverID != current?.serverID || !allowed) {
            await driver.end(id: activity.id)
        }
        if !allowed, let current, !revoked {
            cleanup.append(Retirement(context: current, activityID: nil))
            revoked = true
            needsOptIn = enabled && !dismissed
            registered.removeAll()
            defaults.removeObject(forKey: Self.activityKey(current.serverID))
        }
        do {
            while let old = cleanup.first {
                try await old.context.client.unregisterAgentActivities(deviceID: deviceID, activityID: old.activityID)
                cleanup.removeFirst()
                guard !Task.isCancelled else { return }
            }
            guard context?.revision == revision else { needsSync = true; return }
            guard let current else { statusText = "Connect a server in Settings."; return }
            guard allowed else {
                // The home screen widget does not depend on the Live Activity: a disabled/closed activity does not take its state away.
                if foreground, let state = try? await current.client.agentActivityState(),
                   state.version == 2, isCurrentContext(current), foreground {
                    stateSink(state)
                }
                if !enabled { statusText = "Live Activity is off." }
                else if dismissed { statusText = "The activity was dismissed. You can show it again." }
                else { statusText = "Allow Live Activities in iPhone Settings → Devbox." }
                return
            }
            revoked = false
            // A failed lookup leaves the decision pending: neither disable future pushes
            // nor recreate a possibly user-dismissed activity until it is resolved.
            guard try await resolveDismissals(context: current) else { return }
            // Retire a completed/dismissed token, but never let it unregister a newer activity.
            for activity in driver.activities where activity.serverID == current.serverID && !activity.isLive {
                guard !retired.contains(activity.id) else { continue }
                try await current.client.unregisterAgentActivities(deviceID: deviceID, activityID: activity.id)
                retired.insert(activity.id)
                if defaults.string(forKey: Self.activityKey(current.serverID)) == activity.id {
                    defaults.removeObject(forKey: Self.activityKey(current.serverID))
                }
            }
            guard canReconcile(current) else { return }
            if foreground {
                let state = try await current.client.agentActivityState()
                // `foreground` deliberately again: during the await the app may have gone to the background, and
                // foreground state must no longer overwrite content that APNs delivered in the meantime.
                guard canReconcile(current), foreground else { return }
                guard state.version == 2 else {
                    statusText = "The server uses an unsupported Live Activity version."
                    return
                }
                lastState = state
                stateSink(state)
            }
            guard canReconcile(current) else { return }
            var activity = await reconcileActivities(context: current)
            guard canReconcile(current) else { return }
            // An activity is started only for work that is waiting/working/stalled; done/unknown
            // sessions alone do not start it (the server then ends it itself after 90 s).
            if activity == nil, foreground, let state = lastState, state.hasActiveWork {
                // Re-read immediately before request: a push-to-start may have arrived during GET.
                activity = driver.activities.first { $0.serverID == current.serverID && $0.isLive }
                if activity == nil {
                    do {
                        activity = try driver.request(serverID: current.serverID, state: state)
                    } catch {
                        statusText = "iPhone can't show the Live Activity right now. Try turning it on again."
                        return
                    }
                }
            }
            if let activity {
                if defaults.string(forKey: Self.activityKey(current.serverID)) != activity.id {
                    defaults.set(Date(), forKey: Self.startedKey(current.serverID))
                }
                defaults.set(activity.id, forKey: Self.activityKey(current.serverID))
                if foreground, let state = lastState { await driver.update(id: activity.id, state: state) }
                guard canReconcile(current) else { return }
                // APNs updates need the per-activity token, never the normal notification token.
                guard let token = driver.activities.first(where: { $0.id == activity.id && $0.isLive })?.pushToken else {
                    statusText = "Activity is running. Waiting for background updates to connect…"
                    return
                }
                try await register(token: token, kind: "update", activityID: activity.id, context: current)
                guard canReconcile(current) else { return }
            }
            if let token = driver.pushToStartToken {
                try await register(token: token, kind: "start", activityID: nil, context: current)
                guard canReconcile(current) else { return }
            }
            statusText = activity == nil ? "Ready. The activity appears when an agent starts working." : "Live Activity is connected."
        } catch {
            guard context?.revision == revision else { needsSync = true; return }
            if error is DeliveryError {
                statusText = "Background updates are not available on the server."
                return
            }
            // No raw error/endpoint/token is shown or logged. Network failure does not end a
            // useful activity or forge progress; its existing content expires at staleDate.
            statusText = cleanup.isEmpty
                ? "Server is unreachable. Will retry."
                : "Waiting for the previous registration to be removed. Will retry."
        }
    }

    private func isCurrentContext(_ context: Context) -> Bool {
        !Task.isCancelled && self.context?.revision == context.revision
    }

    private func isCurrent(_ context: Context) -> Bool {
        isCurrentContext(context) && allowed
    }

    private func canReconcile(_ context: Context) -> Bool {
        isCurrent(context) && pendingDismissals.isEmpty
    }

    private func reconcileActivities(context: Context) async -> AgentActivitySnapshot? {
        let activities = driver.activities.filter { $0.serverID == context.serverID && $0.isLive }
        let known = defaults.string(forKey: Self.activityKey(context.serverID))
        let primary = activities.first { $0.id == known } ?? activities.first
        // Foreground request and APNs push-to-start can cross. Adopt one and retire extras
        // whenever ActivityKit reports them, including a launch from a terminated app.
        for duplicate in activities where duplicate.id != primary?.id {
            await driver.end(id: duplicate.id)
            // Keep the authenticated client with failed retirement even after ActivityKit
            // removes the ended activity from its inventory.
            do {
                try await context.client.unregisterAgentActivities(deviceID: deviceID, activityID: duplicate.id)
                retired.insert(duplicate.id)
            } catch {
                cleanup.append(Retirement(context: context, activityID: duplicate.id))
            }
        }
        return primary
    }

    private func register(token: Data, kind: String, activityID: String?, context: Context) async throws {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard !hex.isEmpty else { return }
        let key = "\(kind):\(activityID ?? ""):\(hex)"
        guard !registered.contains(key), canReconcile(context) else { return }
        do {
            try await context.client.registerAgentActivity(.init(deviceId: deviceID, serverID: context.serverID,
                kind: kind, token: hex, activityId: activityID, environment: environment,
                optIn: kind == "update" && needsOptIn ? true : nil))
        } catch let error as DevdHTTPError where error.statusCode == 503 {
            throw DeliveryError.unavailable
        }
        // If Settings changed while POST was in flight, configure queued old-client DELETE;
        // do not mark the old token registered for the new endpoint.
        if canReconcile(context) {
            registered.insert(key)
            needsOptIn = false
        }
    }

    private static func dismissalKey(_ serverID: String) -> String { "agentActivity.dismissed.\(serverID)" }
    private static func activityKey(_ serverID: String) -> String { "agentActivity.current.\(serverID)" }
    private static func startedKey(_ serverID: String) -> String { "agentActivity.started.\(serverID)" }

    static var apnsEnvironment: String {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "DevboxAPNSEnvironment") as? String {
            if configured == "development" || configured == "sandbox" { return "sandbox" }
            if configured == "production" { return "production" }
        }
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Stable opaque namespace. No hostname, URL credentials or service-token material goes
    /// into ActivityKit attributes, APNs registration or UserDefaults keys.
    static func serverID(for endpoints: DevdEndpoints) -> String {
        func identity(_ url: URL?) -> String {
            guard let url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "" }
            parts.user = nil
            parts.password = nil
            parts.query = nil
            parts.fragment = nil
            return parts.string ?? ""
        }
        let namespace = "\(identity(endpoints.cfBase))\n\(identity(endpoints.tailnetBase))"
        return SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
