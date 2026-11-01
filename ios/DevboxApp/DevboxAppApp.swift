import SwiftUI
import UIKit
import UserNotifications
import os

// App entry point. Without configuration (no CF or tailnet path in Keychain) the app forces
// onboarding — a fullscreen Settings sheet that closes itself as soon as at least one path
// is saved (see `AppModel.configured` and `SettingsScreen`). After onboarding the content is
// tabs matching the web (Overview, Sessions, Statistics, Hardware, More — see `SessionsContainer`).
@main
struct DevboxAppApp: App {
    @StateObject private var appModel = AppModel()
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    /// DEBUG Live Activity sample (`--live-activity-preview`) — no server, account or push registration.
    private var activityPreview: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--live-activity-preview")
        #else
        false
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if activityPreview {
                    AgentActivityPreviewScreen()
                } else {
                    ContentView()
                }
                #else
                ContentView()
                #endif
            }
                .environmentObject(appModel)
                .task {
                    // End old cards from build 12 on EVERY launch (even in preview mode —
                    // it starts nothing new), see LegacySessionActivityCleanup.swift.
                    appModel.legacySessionActivityCleanup.appLaunched()
                    guard !activityPreview else { return }
                    // AppDelegate is created before `appModel` (SwiftUI lifecycle) and cannot build
                    // `PushManager` itself — so the wiring happens from here, once.
                    appDelegate.pushManager = appModel.pushManager
                    // Live Activity: token observation runs in the background too (push-to-start can launch the app
                    // without UI, and the update token must be registered even then).
                    appModel.liveActivityManager.start()
                    appModel.liveActivityManager.setForeground(scenePhase == .active)
                }
                .onChange(of: scenePhase) { _, phase in
                    appModel.legacySessionActivityCleanup.sceneBecame(active: phase == .active)
                    guard !activityPreview else { return }
                    appModel.liveActivityManager.setForeground(phase == .active)
                }
                .task(id: appModel.configured) {
                    // Ask for push notification permission only after onboarding — an app without a
                    // configured path has nowhere to register the token. `task(id:)` runs again
                    // as soon as `configured` flips to `true` (and also right at launch when the app
                    // was already configured).
                    guard !activityPreview, appModel.configured else { return }
                    await appModel.pushManager.requestAuthorization()
                }
                .onOpenURL { appModel.handleDeepLinkURL($0) }
                // Onboarding ONLY for a provably empty configuration — `.unknown` (Keychain
                // unreadable, the app was woken by a push while the phone was locked) does not show onboarding, see
                // `ContentView`, which waits for `reloadConfiguration()`.
                .fullScreenCover(isPresented: Binding(
                    get: { !activityPreview && appModel.configState == .notConfigured },
                    set: { _ in }
                )) {
                    // The explicit `.environmentObject(appModel)` is NOT a needless duplicate of
                    // `.environmentObject(appModel)` higher up on `ContentView()` — the live
                    // E2E test (Task 15) found it: without it `SettingsScreen`'s `@EnvironmentObject` worked
                    // only by chance (Test connection, body-embedded Button), but the toolbar button
                    // "Save" (`ToolbarItem` → UIKit `UIBarButtonItem` bridging) crashed on
                    // `EnvironmentObject.error()` — the environment inherited the modifier chain above
                    // `ContentView`, but the UIKit-bridged toolbar action of the fullScreenCover content did not
                    // get it. Fix = inject the env object again directly into the presented content.
                    //
                    // `NavigationStack` wraps `SettingsScreen` only HERE (Stage G, task 30) —
                    // the screen itself no longer holds one, because `MoreScreen` pushes it into ITS OWN
                    // `NavigationStack` (a nested `NavigationStack` would break the back gesture and produce two
                    // navigation bars on top of each other).
                    NavigationStack {
                        SettingsScreen()
                            .environmentObject(appModel)
                    }
                }
        }
    }
}

/// `client` is stable only once the app is configured (`AppModel.configured ==
/// true`) — until then the fullScreenCover blocks interaction and this branch is practically never shown;
/// if it still rendered for a moment (right after app launch), it shows only a loading placeholder
/// instead of crashing on a force-unwrap.
///
/// `configState == .unknown` (Keychain cannot be read while the phone is locked) also ends up on
/// `ProgressView` — the configuration is reloaded as soon as iOS makes protected data available (unlock)
/// or the app comes to the foreground. But when the phone is unlocked, the scene active and the state still
/// `.unknown`, `ConfigLoadFailedView` is shown (see `ConfigLoadingKind.decide`).
struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.scenePhase) private var scenePhase
    /// `UIApplication.isProtectedDataAvailable` is not observable — the copy is refreshed
    /// from notifications and on scenePhase changes, so `content` gets redrawn.
    @State private var protectedDataAvailable = UIApplication.shared.isProtectedDataAvailable

    var body: some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                protectedDataAvailable = true
                reloadIfNotConfigured()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataWillBecomeUnavailableNotification)) { _ in
                protectedDataAvailable = false
            }
            .onChange(of: scenePhase, initial: true) { _, newPhase in
                protectedDataAvailable = UIApplication.shared.isProtectedDataAvailable
                if newPhase == .active { reloadIfNotConfigured() }
            }
    }

    private func reloadIfNotConfigured() {
        guard appModel.configState != .configured else { return }
        appModel.reloadConfiguration()
    }

    @ViewBuilder
    private var content: some View {
        if let client = appModel.client {
            // NO `.id(appModel.clientIdentity)` here (review Critical, stage G task 30 fix) —
            // that would tear down the WHOLE `SessionsContainer` on EVERY client change (tabs, navigation, and
            // the currently open `SettingsScreen` with its own local state — the Test connection
            // result/Save error would then never get a chance to show). `SessionsContainer` keeps
            // a stable identity itself; only `store` (LiveStore) is rebuilt on a client change,
            // explicitly via `rebuild(client:)`, see `.onChange(of: appModel.clientIdentity)` below.
            SessionsContainer(client: client, appModel: appModel)
        } else {
            switch ConfigLoadingKind.decide(
                state: appModel.configState,
                protectedDataAvailable: protectedDataAvailable,
                sceneActive: scenePhase == .active
            ) {
            case .waiting: ProgressView()
            case .failed: ConfigLoadFailedView()
            }
        }
    }
}

/// Keychain cannot be read even though the phone is unlocked — instead of an endless spinner: an explanation,
/// retry, and a way into Settings (not prefilled; `saveConfig` rejects an empty save, so it
/// deletes nothing). The sheet disappears by itself once saving builds the client (`ContentView` switches branch).
private struct ConfigLoadFailedView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "key.slash")
                .font(.largeTitle)
                .foregroundStyle(Theme.C.mutedForeground)
            Text("Couldn't load the saved sign-in.")
                .multilineTextAlignment(.center)
            Button("Try again") { appModel.reloadConfiguration() }
                .buttonStyle(DevboxButtonStyle(variant: .outline))
            Button("Open Settings") { showSettings = true }
        }
        .padding(Theme.S.screenPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.background)
        .sheet(isPresented: $showSettings) {
            // As with onboarding: the env object again directly on the presented content
            // (the UIKit-bridged toolbar "Save" would otherwise not get it, see `DevboxAppApp`).
            NavigationStack {
                SettingsScreen()
                    .environmentObject(appModel)
            }
        }
    }
}

/// Holds the `LiveStore` built over the current `DevdClient` and drives polling by scene phase —
/// polling in the background makes no sense (see `LiveStore.start`/`stop`). Also holds the navigation `path`
/// (`NavigationStack`) and the tab selection (`TabView`) — on `AppModel.pendingDeepLink` (push notification)
/// it switches straight to the Sessions tab and jumps to that session's detail; `SessionDetailView` then
/// consumes `terminal` from here and opens the terminal (simplification from the plan: navigation
/// always goes to the detail, the terminal opens from there). A notification with a target (`PushDeepLink.more`)
/// switches to the More tab and pushes the screen onto `morePath`; `.vault` opens the unlock sheet.
///
/// Tabs and their order follow the web bottom bar (Overview, Sessions, Statistics, Hardware,
/// More — see `AppTab`). `selectedTab` lets a deep link (`onChange` below) jump to Sessions
/// even when the user was on another tab (`AppTab.route(for:)`).
///
/// Five tabs, NOT more — with more than 5 tabs the iPhone hides the rest in the system "More → More" overflow (and
/// the last visible icon would lose its own). AI limits, Folders, Activity etc. therefore
/// live as `NavigationLink`s inside `MoreScreen` (`MoreMenu`), not as their own tabs.
///
/// `client`/`actions` are plain (not `@State`) stored properties — `init(client:)` runs again on EVERY
/// redraw of the parent (`ContentView`, whenever `appModel.client` changes), so both
/// properties refresh to the newest client by themselves. `store` (`@StateObject`) is a DIFFERENT case: SwiftUI
/// ignores its initial value (`LiveStore(client:)` in `init`) after the first build and keeps
/// the ORIGINAL instance across redraws regardless of what `init` computes each time — so it
/// needs an explicit `rebuild(client:)`, see `.onChange(of: appModel.clientIdentity)` in `body`.
private struct SessionsContainer: View {
    @StateObject private var store: LiveStore
    private let actions: SessionActions
    private let client: DevdClient
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var appModel: AppModel
    @State private var path: [String] = []
    /// The More tab stack — a deep link with a target (`PushDeepLink.more`) pushes the screen straight onto it.
    @State private var morePath: [MoreMenu.Destination] = []
    @State private var selectedTab = AppTab.initial
    /// Vault unlocking from the banner — state shared with `VaultUnlockSheet` (see VaultUnlockView.swift).
    /// `@StateObject` like `store`: the first instance survives parent redraws; the initializer reads
    /// only whether a stored passphrase exists (`exists`, no Face ID prompt).
    @StateObject private var vaultUnlock: VaultUnlockController
    @State private var showVaultSheet = false

    init(client: DevdClient, appModel: AppModel) {
        self.client = client
        _store = StateObject(wrappedValue: LiveStore(client: client))
        _vaultUnlock = StateObject(wrappedValue: VaultUnlockController(appModel: appModel))
        actions = SessionActions(client: client)
    }

    /// Vault banner (Stage G, task 30) under the navigation bar of EVERY tab — while the vault is
    /// locked, it is visible above any content. It used to hang as a `safeAreaInset` on the whole
    /// `TabView`: that drew it at navigation bar height and covered the toolbar ("New session"
    /// in Sessions). At the root of each `NavigationStack` it is inserted between the bar and the content. Sessions
    /// under the banner keep running (spec §3: a locked vault does NOT break them, only credentials-dependent
    /// things). Unlocking is right in the banner: with a stored passphrase one tap + Face ID, without it
    /// a sheet with a field and "Remember" turned on, so next time it is also one tap. Settings remains
    /// the second path.
    private func withVaultBanner<Content: View>(_ content: Content) -> some View {
        content.safeAreaInset(edge: .top) {
            if appModel.vaultLocked {
                VaultBannerView(controller: vaultUnlock, onEnterPassphrase: { showVaultSheet = true })
            }
        }
    }

    private func tabLabel(_ tab: AppTab) -> some View {
        Label(tab.title, systemImage: tab.systemImage)
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                withVaultBanner(OverviewScreen(client: client))
            }
            .tabItem { tabLabel(.overview) }
            .tag(AppTab.overview)

            NavigationStack(path: $path) {
                withVaultBanner(SessionsScreen(actions: actions))
            }
            .tabItem { tabLabel(.sessions) }
            .tag(AppTab.sessions)

            NavigationStack {
                withVaultBanner(StatsScreen(client: client))
            }
            .tabItem { tabLabel(.stats) }
            .tag(AppTab.stats)

            NavigationStack {
                withVaultBanner(HardwareScreen(client: client))
            }
            .tabItem { tabLabel(.hardware) }
            .tag(AppTab.hardware)

            NavigationStack(path: $morePath) {
                withVaultBanner(MoreScreen(client: client))
            }
            .tabItem { tabLabel(.more) }
            .tag(AppTab.more)
        }
        .sheet(isPresented: $showVaultSheet) {
            VaultUnlockSheet(controller: vaultUnlock)
                // The sheet is presented content — the env object must go inside again, same as
                // with the onboarding fullScreenCover above (Task 15).
                .environmentObject(appModel)
        }
        .environmentObject(store)
        .task {
            store.start()
            await appModel.refreshVaultStatus()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                store.start()
                Task { await appModel.refreshVaultStatus() }
            } else {
                store.stop()
            }
        }
        // The client changed (Settings Save with a different hostname/tailnet) — rebuild ONLY `store`
        // (`LiveStore`), not the whole `SessionsContainer` (see the doc comment above and the review Critical
        // fix). `client` at this point is already the current value — `init(client:)` ran again
        // with the same `appModel.client` that also forced this `clientIdentity` change (both
        // are set in the same `saveConfig()` call, i.e. in the same update cycle).
        .onChange(of: appModel.clientIdentity) { _, _ in
            store.rebuild(client: client)
        }
        // `initial: true` — without it a link set BEFORE this modifier even
        // existed (cold launch by tapping a notification: `AppDelegate` delivers the buffer to `AppModel`
        // before SwiftUI manages to build `SessionsContainer`) would be lost — `onChange` without
        // `initial` reacts only to CHANGES AFTER attaching, not to an already existing value.
        .onChange(of: appModel.pendingDeepLink, initial: true) { _, link in
            guard let link else { return }
            switch AppTab.route(for: link) {
            case .sessions(let sessionsPath):
                // `pendingDeepLink` is NOT cleared here — `SessionDetailView` (after the push) still
                // needs to read it (terminal) before clearing it itself.
                selectedTab = .sessions
                path = sessionsPath
            case .more(let destinations):
                selectedTab = .more
                morePath = destinations
                appModel.pendingDeepLink = nil
            case .vault:
                appModel.pendingDeepLink = nil
                // The state is checked fresh: between the notification and the tap someone may have unlocked the vault —
                // then (and ONLY when devd confirms it) the app just opens, no sheet. A failed
                // query opens the sheet too.
                Task {
                    let locked = await appModel.refreshVaultStatus()
                    if AppModel.shouldOpenVaultSheet(confirmedLocked: locked) {
                        vaultUnlock.refresh()
                        showVaultSheet = true
                    }
                }
            }
        }
        // `devbox://sessions` — the session list (stack root), `initial` for the same reason as above.
        .onChange(of: appModel.requestedTab, initial: true) { _, tab in
            guard let tab else { return }
            selectedTab = tab
            if tab == .sessions { path = [] }
            appModel.requestedTab = nil
        }
    }
}

/// Orange "Vault locked" bar with an action on the right: stored passphrase → one-tap unlock
/// (Face ID comes from Keychain, see `AppModel.unlockVaultWithSavedPassphrase`); without it →
/// `onEnterPassphrase` opens `VaultUnlockSheet`. An error is shown right in the bar.
private struct VaultBannerView: View {
    @ObservedObject var controller: VaultUnlockController
    let onEnterPassphrase: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Image(systemName: "lock.fill")
                Text("Vault locked")
                    .font(.footnote.weight(.medium))
                Spacer()
                if controller.busy {
                    ProgressView()
                } else if controller.hasSaved {
                    Button {
                        Task { await controller.unlockWithSaved() }
                    } label: {
                        Label(controller.savedButtonTitle, systemImage: controller.biometry == "Touch ID" ? "touchid" : "faceid")
                            .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                } else {
                    Button("Unlock…", action: onEnterPassphrase)
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
            if let error = controller.error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(Theme.C.dangerText)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.C.warn.opacity(0.18))
        .task { controller.refresh() }
    }
}

/// Adapter for APNs callbacks and — IMPORTANT — the only real `UNUserNotificationCenterDelegate`.
/// `@UIApplicationDelegateAdaptor` is the only way a SwiftUI-lifecycle app receives
/// `didRegisterForRemoteNotificationsWithDeviceToken`; `pushManager` is set from outside
/// (`DevboxAppApp.body`'s `.task`), because AppDelegate is created before `AppModel`/`PushManager` and
/// cannot build it itself.
///
/// `PushManager` itself is NOT the delegate (see its `requestAuthorization`) — the delegate must be
/// set already in `didFinishLaunchingWithOptions`, otherwise a cold-launch tap on a notification (the app
/// is only just starting) would never call `didReceive`, because at delivery time there would be no
/// delegate yet. `AppDelegate` therefore forwards to `PushManager.handle`, and while that does not exist
/// (`pushManager == nil`, right after launch), it buffers the response and delivers it once `pushManager`
/// arrives (`didSet` → `flushPendingResponseIfPossible`).
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    private static let logger = Logger(subsystem: "com.example.devbox", category: "Push")

    var pushManager: PushManager? {
        didSet { flushPendingResponseIfPossible() }
    }

    /// Test/diagnostic access — `deliver` reads/writes it, `PushManagerTests`
    /// (`AppDelegateTests`) verify buffer/flush without having to build a real `UNNotificationResponse`
    /// (which cannot easily be constructed in tests).
    private(set) var pendingResponse: (userInfo: [AnyHashable: Any], actionIdentifier: String)?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // MUST happen here, not later (e.g. in a SwiftUI `.task`) — the system checks whether the
        // delegate is set at the moment the response is DELIVERED, not whenever one shows up later. Setting it later
        // would lose a cold-launch tap on a notification (the app is being launched because of it).
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        pushManager?.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // The simulator (no real APNs) always ends up here — informational, not an app error.
        Self.logger.info("APNs registration failed (expected in the simulator): \(String(describing: error))")
    }

    /// Seam shared between `didReceive` and tests: takes the same fields as a notification response, but without
    /// needing a real `UNNotificationResponse`. Delivers directly when `pushManager` already exists,
    /// otherwise buffers.
    func deliver(userInfo: [AnyHashable: Any], actionIdentifier: String) {
        guard let pushManager else {
            pendingResponse = (userInfo, actionIdentifier)
            return
        }
        pushManager.handle(userInfo: userInfo, actionIdentifier: actionIdentifier)
    }

    private func flushPendingResponseIfPossible() {
        guard let pushManager, let pending = pendingResponse else { return }
        pendingResponse = nil
        pushManager.handle(userInfo: pending.userInfo, actionIdentifier: pending.actionIdentifier)
    }
}

// MARK: - UNUserNotificationCenterDelegate

/// Called by the system from its own queue, not guaranteed on the main thread — the methods are therefore
/// `nonisolated` and hop over themselves via `Task { @MainActor in }`, the same pattern as
/// `TerminalSession`'s `URLSessionWebSocketDelegate`.
extension AppDelegate: UNUserNotificationCenterDelegate {
    /// Foreground presentation — banner+sound even while the app is in the foreground (otherwise the system default is
    /// silent without this callback).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let actionIdentifier = response.actionIdentifier
        // `completionHandler()` IMMEDIATELY, synchronously — it must not wait for `deliver`/`PushManager.handle`
        // (let alone the network ack POST, which inside can take tens of seconds).
        completionHandler()
        Task { @MainActor in
            self.deliver(userInfo: userInfo, actionIdentifier: actionIdentifier)
        }
    }
}
