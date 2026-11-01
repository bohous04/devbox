import Foundation
import UIKit
import UserNotifications
import os

/// APNs registration, notification categories/actions, and splitting a delivered payload into ack/deep-link.
/// Server contract (devd): `POST /api/push/register {token, platform:"ios", name}` (token
/// hex-validated, see `devd/src/api.ts`), `POST /api/push/ack {alertId}`; the payload from
/// `devd/src/apns.ts` (`apnsPayload`) carries `aps.category` (`done|blocked|emergency`) and
/// `sessionId`/`alertId`/`terminal`/`target`/`targetId` OUTSIDE `aps`, at the same `userInfo` level.
@MainActor
final class PushManager: ObservableObject {
    /// Parsed navigation target from the payload — `AppModel.pendingDeepLink` publishes it on to the UI
    /// (`SessionsContainer` switches tab, `SessionDetailView` opens the terminal, see `onDeepLink`).
    /// `alertId` does not belong here — `handle` deals with the ack right on delivery, navigation does not need it.
    enum PushDeepLink: Equatable {
        /// Session notification → detail (and terminal when the payload carried `terminal: true`).
        case session(id: String, terminal: Bool)
        /// Notification without a session but with a target (`target` from devd) → screen in the More tab.
        case more(MoreMenu.Destination)
        /// Locked vault → unlock sheet (only while the vault is still locked).
        case vault

        var sessionId: String? {
            if case .session(let id, _) = self { return id }
            return nil
        }
    }

    static let ackActionIdentifier = "ACK"

    private static let logger = Logger(subsystem: "com.example.devbox", category: "Push")

    /// The currently configured client via a closure, not a stored reference — `AppModel.client` is
    /// rebuilt after Settings are saved (new path/token), but `PushManager` outlives a single
    /// client and wants the NEWEST one for each request.
    private let clientProvider: () -> DevdClient?
    /// Where the app delivers the parsed deep link (typically `AppModel.pendingDeepLink = $0`) — always called
    /// on the MainActor.
    private let onDeepLink: (PushDeepLink) -> Void

    /// Last device token (hex) kept only in memory, never persisted — used for re-registration after
    /// a network path change in Settings (the system does not give the app a new token until authorization changes).
    private(set) var lastToken: String?

    init(clientProvider: @escaping () -> DevdClient?, onDeepLink: @escaping (PushDeepLink) -> Void) {
        self.clientProvider = clientProvider
        self.onDeepLink = onDeepLink
    }

    /// Registers categories/actions and requests permission; on consent calls
    /// `UIApplication.registerForRemoteNotifications()`, whose result arrives in
    /// `handleDeviceToken`/AppDelegate `didFailToRegister...` (see `DevboxAppApp.swift`). The caller
    /// (DevboxAppApp) triggers this only after onboarding (`AppModel.configured == true`), not during it
    /// — an app without a configured path has nowhere to register the token.
    ///
    /// `center.delegate` is NOT set here — it must already be in place in
    /// `AppDelegate.didFinishLaunchingWithOptions` (see there), otherwise a cold-launch tap on a
    /// notification would never call `didReceive`. `AppDelegate` is therefore the real delegate and only
    /// forwards to `PushManager.handle`.
    func requestAuthorization() async {
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories(Self.makeCategories())
        let granted: Bool
        do {
            granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            Self.logger.warning("notification permission request failed: \(String(describing: error))")
            return
        }
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// APNs calls `didRegisterForRemoteNotificationsWithDeviceToken` with a binary token — the app
    /// sends it to the server as hex (`hexToken`) together with the device name (listed in `push_devices`).
    /// Fire-and-forget: the delegate callback is synchronous, the actual POST runs in the background (`register`).
    func handleDeviceToken(_ data: Data) {
        let token = Self.hexToken(data)
        lastToken = token
        Task { await register(token: token) }
    }

    /// After the client is rebuilt (new path in Settings) the system does not give the app a new token — but it is enough
    /// to send the same one again, this time to the (possibly) new devd address.
    func reregisterCurrentToken() {
        guard let token = lastToken else { return }
        Task { await register(token: token) }
    }

    private struct RegisterBody: Encodable {
        let token: String
        let platform: String
        let name: String
    }

    /// Test seam (see `PushManagerTests`) — also called from `handleDeviceToken`/
    /// `reregisterCurrentToken`, but can be called directly so a test verifies the exact path/body without
    /// having to wait for the fire-and-forget `Task` from `handleDeviceToken`.
    func register(token: String) async {
        guard let client = clientProvider() else { return }
        do {
            try await client.postVoid("/api/push/register", body: RegisterBody(token: token, platform: "ios", name: UIDevice.current.name))
        } catch {
            Self.logger.warning("registrace push tokenu selhala: \(String(describing: error))")
        }
    }

    private struct AckBody: Encodable { let alertId: String }

    /// Same seam reason as `register` — called from the delegate callback, but tests can call it
    /// directly.
    func ack(alertId: String) async {
        guard let client = clientProvider() else { return }
        do {
            try await client.postVoid("/api/push/ack", body: AckBody(alertId: alertId))
        } catch {
            Self.logger.warning("push alert acknowledgement failed: \(String(describing: error))")
        }
    }

    // MARK: - Pure

    static func hexToken(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// `userInfo` is the flat payload from `apnsPayload` (`devd/src/apns.ts`) — `sessionId`/`terminal`/
    /// `target` sit NEXT TO `aps`, not inside it. `sessionId` takes precedence; without it
    /// `target` decides (`NotifyTarget` in `devd/src/agentEvents.ts`). Unknown target = just open the app.
    static func deepLink(from userInfo: [AnyHashable: Any]) -> PushDeepLink? {
        if let sessionId = userInfo["sessionId"] as? String {
            return .session(id: sessionId, terminal: (userInfo["terminal"] as? Bool) ?? false)
        }
        guard let target = userInfo["target"] as? String else { return nil }
        return link(forTarget: target)
    }

    /// Dictionary of targets from devd (and from `devbox://more/<target>`, see `AppModel.deepLink(from:)`).
    static func link(forTarget target: String) -> PushDeepLink? {
        if target == "vault" { return .vault }
        return MoreMenu.Destination(target: target).map { .more($0) }
    }

    /// The `alertId` to acknowledge, or `nil` when the response implies no acknowledgement —
    /// only the explicit "Acknowledge" action, or the default notification open IF the category is
    /// `emergency` (tapping a done/blocked notification sends no ack — those do not even have an `alertId`).
    static func ackAlertId(from userInfo: [AnyHashable: Any], actionIdentifier: String) -> String? {
        guard let alertId = userInfo["alertId"] as? String else { return nil }
        if actionIdentifier == ackActionIdentifier { return alertId }
        if actionIdentifier == UNNotificationDefaultActionIdentifier, category(from: userInfo) == "emergency" {
            return alertId
        }
        return nil
    }

    private static func category(from userInfo: [AnyHashable: Any]) -> String? {
        (userInfo["aps"] as? [String: Any])?["category"] as? String
    }

    /// The three categories mirror `ApnsNotification["category"]` from `devd/src/apns.ts`. Only `emergency`
    /// has an action — "Acknowledge" stops re-sends on the server (`POST /api/push/ack`, see
    /// `tickPushAlerts` in `devd/src/pushChannel.ts`).
    private static func makeCategories() -> Set<UNNotificationCategory> {
        let ack = UNNotificationAction(identifier: ackActionIdentifier, title: "Acknowledge", options: [.foreground])
        let emergency = UNNotificationCategory(identifier: "emergency", actions: [ack], intentIdentifiers: [])
        let done = UNNotificationCategory(identifier: "done", actions: [], intentIdentifiers: [])
        let blocked = UNNotificationCategory(identifier: "blocked", actions: [], intentIdentifiers: [])
        return [done, blocked, emergency]
    }

    /// Called by `AppDelegate` (the real `UNUserNotificationCenterDelegate`, see
    /// `didFinishLaunchingWithOptions` in `DevboxAppApp.swift` and `AppDelegate.deliver`), either directly
    /// or from a buffer delivered only after app launch. The deep link goes SYNCHRONOUSLY (`onDeepLink`) —
    /// navigation must not wait on anything network-related. The ack runs as a separate fire-and-forget `Task`,
    /// because `POST /api/push/ack` (via `DevdClient.postVoid`) can take up to 150 s for a non-GET request
    /// (see `DevdClient.perform`), which would needlessly delay completion/navigation.
    func handle(userInfo: [AnyHashable: Any], actionIdentifier: String) {
        if let link = Self.deepLink(from: userInfo) {
            onDeepLink(link)
        }
        if let alertId = Self.ackAlertId(from: userInfo, actionIdentifier: actionIdentifier) {
            Task { await self.ack(alertId: alertId) }
        }
    }
}
