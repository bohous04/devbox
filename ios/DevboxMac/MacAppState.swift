import AppKit
import Combine
import SwiftUI
import os

/// What the Mac app's windows and its menu bar extra share: the connection (`AppModel`, the same Keychain settings
/// as the iOS app), one inbox stream (sidebars and the needs-you count), the live session list (titles), the
/// window/thread registry that survives a relaunch, and launch at login.
@MainActor
final class MacAppState: ObservableObject {
    let appModel: AppModel
    let windows: ThreadWindows
    let loginItem: LoginItem
    /// Built per client; nil until the app is configured.
    @Published private(set) var inbox: InboxStore?
    @Published private(set) var live: LiveStore?

    private static let logger = Logger(subsystem: "com.example.devbox", category: "MacApp")
    private var client: DevdClient?
    private var clientWatch: AnyCancellable?
    /// SwiftUI's window opener, taken from the first view that has one (the menu bar extra is always there).
    private var openWindow: OpenWindowAction?
    /// Threads asked for (a `devbox://` link) before any view could open a window.
    private var pending: [String] = []

    init() {
        appModel = AppModel()
        windows = ThreadWindows(defaults: .standard,
                                directory: URL.applicationSupportDirectory.appending(path: "Devbox/threads", directoryHint: .isDirectory))
        loginItem = LoginItem(service: MainAppLoginItem(), defaults: .standard)
        clientWatch = appModel.$client.sink { [weak self] in self?.use($0) }
    }

    func setOpenWindow(_ action: OpenWindowAction) {
        guard openWindow == nil else { return }
        openWindow = action
        let threads = pending
        pending = []
        threads.forEach(openThread)
    }

    /// Brings the thread's window to the front, or opens one (SwiftUI focuses a window already showing the value).
    func openThread(_ id: String) {
        NSApp.activate(ignoringOtherApps: true)
        guard let openWindow else {
            pending.append(id)
            return
        }
        openWindow(value: id)
    }

    /// `devbox://thread/<id>` (the listener's notification click, S5-R9); `devbox://session/<id>` opens the same window.
    func handle(url: URL) {
        switch AppModel.deepLink(from: url) {
        case .thread(let id)?, .session(let id, _)?:
            openThread(id)
        default:
            Self.logger.notice("ignoring link \(url.absoluteString, privacy: .public): the Mac app opens threads only")
        }
    }

    private func use(_ next: DevdClient?) {
        guard next !== client else { return }
        client = next
        inbox?.stop()
        live?.stop()
        windows.dropStores()
        guard let next else {
            inbox = nil
            live = nil
            return
        }
        let i = InboxStore(client: next)
        let l = LiveStore(client: next)
        inbox = i
        live = l
        i.start()
        l.start()
    }
}

/// Owns the app state (the delegate exists before any scene), saves the windows' threads when the app quits, and
/// takes the `devbox://` links.
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    @MainActor lazy var state = MacAppState()

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        state.loginItem.registerOnFirstLaunch()
    }

    /// Quit, log out and restart all come here first, before any window closes.
    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        state.windows.willTerminate()
        return .terminateNow
    }

    /// The menu bar extra keeps the app useful without windows.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    @MainActor
    func application(_ application: NSApplication, open urls: [URL]) {
        urls.forEach(state.handle)
    }
}
