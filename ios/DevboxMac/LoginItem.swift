import Foundation
import ServiceManagement
import os

enum LoginItemStatus: Equatable {
    case enabled, disabled, requiresApproval, notFound
    /// A state newer than this app knows.
    case unknown(Int)
}

protocol LoginItemService: AnyObject {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
}

/// `SMAppService.mainApp`: the app itself as a login item.
final class MainAppLoginItem: LoginItemService {
    var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        case .notRegistered: return .disabled
        @unknown default: return .unknown(SMAppService.mainApp.status.rawValue)
        }
    }

    func register() throws { try SMAppService.mainApp.register() }
    func unregister() throws { try SMAppService.mainApp.unregister() }
}

/// Launch at login, on by default (global constraint "Mac app restart"): the first launch registers the app; the
/// Settings toggle turns it off and later launches leave that alone.
@MainActor
final class LoginItem: ObservableObject {
    @Published private(set) var enabled: Bool
    /// The last register/unregister failure, shown in Settings.
    @Published private(set) var error: String?

    private static let logger = Logger(subsystem: "com.example.devbox", category: "LoginItem")
    private static let doneKey = "loginItemRegisteredOnce"
    private let service: LoginItemService
    private let defaults: UserDefaults

    init(service: LoginItemService, defaults: UserDefaults) {
        self.service = service
        self.defaults = defaults
        enabled = service.status == .enabled
    }

    /// Only a successful registration counts: a failed one is shown and tried again on the next launch.
    func registerOnFirstLaunch() {
        guard !defaults.bool(forKey: Self.doneKey) else { return }
        if apply(true) { defaults.set(true, forKey: Self.doneKey) }
    }

    func set(enabled on: Bool) {
        defaults.set(true, forKey: Self.doneKey)
        apply(on)
    }

    var statusText: String? {
        switch service.status {
        case .requiresApproval: return "Allow Devbox in System Settings › General › Login Items."
        case .notFound: return "macOS does not find this copy of Devbox; move it to Applications and try again."
        case .unknown(let raw): return "macOS reports a login item state this app does not know (\(raw))."
        case .enabled, .disabled: return nil
        }
    }

    @discardableResult
    private func apply(_ on: Bool) -> Bool {
        defer { enabled = service.status == .enabled }
        do {
            if on { try service.register() } else { try service.unregister() }
            error = nil
            return true
        } catch {
            Self.logger.error("login item \(on ? "register" : "unregister", privacy: .public) failed: \(String(describing: error), privacy: .public)")
            self.error = "Could not \(on ? "turn on" : "turn off") launch at login: \(error.localizedDescription)"
            return false
        }
    }
}
