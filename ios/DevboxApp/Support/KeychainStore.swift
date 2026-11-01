import Foundation
import LocalAuthentication
import Security
import os

/// Result of a Keychain read. `missing` = the item provably does not exist
/// (`errSecItemNotFound`); `unavailable` = the Keychain cannot answer right now — typically
/// `errSecInteractionNotAllowed` (-25308), when iOS wakes the app with a background push on a locked
/// phone. `unavailable` must NEVER be interpreted as "not configured" (and thereby onboarding
/// and wiping credentials).
enum KeychainRead: Equatable {
    case value(String)
    case missing
    case unavailable(OSStatus)
}

/// Read-only side of `KeychainStore` — `AppModel` uses it to decide `configState` and tests
/// replace it with a fake (a locked phone cannot be reproduced in the simulator via the real Keychain).
protocol KeychainReading {
    func read(_ key: String) -> KeychainRead
}

/// Storage for sensitive values in the iOS Keychain: Cloudflare Access token, tailnet address
/// and the vault passphrase. `kSecAttrService` = the app's bundle id, `kSecAttrAccount` = the key
/// (see the static constants below, so the whole app shares them).
final class KeychainStore: KeychainReading {
    private static let logger = Logger(subsystem: "com.example.devbox", category: "KeychainStore")

    static let cfClientId = "cfClientId"
    static let cfClientSecret = "cfClientSecret"
    static let cfHostname = "cfHostname"
    static let tailnetBase = "tailnetBase"
    static let vaultPassphrase = "vaultPassphrase"

    /// In production `vaultPassphrase` is read only after biometrics (Face/Touch ID) — `SecAccessControlCreateWithFlags`
    /// with `.biometryCurrentSet`. The simulator in tests has no enrolled biometrics and SecItemAdd
    /// with this access control policy would fail there, so tests inject false and the item is
    /// stored without the biometric restriction (only `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
    /// Other keys (network configuration) are `AfterFirstUnlockThisDeviceOnly`, see `set`.
    private let requireBiometryForVault: Bool
    private var service: String { Bundle.main.bundleIdentifier ?? "com.example.devbox" }

    init(requireBiometryForVault: Bool = true) {
        self.requireBiometryForVault = requireBiometryForVault
    }

    /// Compatibility shortcut over `read` — both a missing and an unavailable item give `nil`. For
    /// configuration decisions use `read`, so a locked Keychain can be told apart.
    func get(_ key: String) -> String? {
        if case .value(let value) = read(key) { return value }
        return nil
    }

    func read(_ key: String) -> KeychainRead {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        // The vault passphrase is behind biometrics — reading it brings up the system Face ID dialog, which
        // without its own context shows only a generic "DevboxApp wants to use Face ID". A context
        // with a reason says WHY (unlocking the vault), same as for SSH key approvals.
        if key == Self.vaultPassphrase {
            let context = LAContext()
            context.localizedReason = "Unlock the devbox vault"
            query[kSecUseAuthenticationContext as String] = context
        }
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            // Unreadable data is not proof that the item is missing — better "unavailable" than onboarding.
            guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
                return .unavailable(errSecDecode)
            }
            return .value(value)
        case errSecItemNotFound:
            return .missing
        default:
            Self.logger.error("KeychainStore.read(\(key, privacy: .public)) selhal, OSStatus \(status)")
            return .unavailable(status)
        }
    }

    /// Switches existing items from the old `WhenUnlockedThisDeviceOnly` to
    /// `AfterFirstUnlockThisDeviceOnly`, so the app can read them even after being woken by a push on a locked
    /// phone. The value stays (no re-entry). Call only after a successful read, i.e. on an
    /// unlocked device. `vaultPassphrase` does not belong here — its protection (biometrics) does not change.
    func migrateAccessibility(keys: [String]) {
        for key in keys where key != Self.vaultPassphrase {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: key,
            ]
            let update: [String: Any] = [
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ]
            let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            if status != errSecSuccess {
                Self.logger.error("KeychainStore.migrateAccessibility(\(key, privacy: .public)) selhal, OSStatus \(status)")
            }
        }
    }

    /// Returns `true` only on `errSecSuccess` — the caller (e.g. the Settings Save flow) can thus detect
    /// a silent write failure instead of assuming the value was stored.
    ///
    /// Network configuration is written via `SecItemUpdate` (and only when the item does not exist,
    /// `SecItemAdd`) — the earlier "delete and add" lost the stored value when the add failed
    /// (a transient error must not wipe credentials). Only `vaultPassphrase` stays
    /// on delete+add: access control (biometrics) cannot be changed on an existing item via update.
    @discardableResult
    func set(_ key: String, _ value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        let status = key == Self.vaultPassphrase ? replaceVaultPassphrase(data) : upsert(key, data)
        if status != errSecSuccess {
            Self.logger.error("KeychainStore.set(\(key, privacy: .public)) selhal, OSStatus \(status)")
        }
        return status == errSecSuccess
    }

    /// Network configuration must be readable even on a locked phone (a push wakes the app in the
    /// background) — otherwise the app would look unconfigured and show onboarding. Update also sets
    /// the accessibility, so the write also migrates an old `WhenUnlocked` item.
    private func upsert(_ key: String, _ data: Data) -> OSStatus {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        var attributes = query
        attributes.merge(update) { _, new in new }
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    private func replaceVaultPassphrase(_ data: Data) -> OSStatus {
        delete(Self.vaultPassphrase)
        var attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.vaultPassphrase,
            kSecValueData as String: data,
        ]
        if requireBiometryForVault {
            let accessControl = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                .biometryCurrentSet,
                nil
            )
            if let accessControl {
                attributes[kSecAttrAccessControl as String] = accessControl
            }
        } else {
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    /// Existence without reading data — unlike `get` it does NOT trigger biometrics. `kSecUseAuthenticationUI:
    /// .skip` SILENTLY OMITS ACL-protected items (`vaultPassphrase` in production) from the match result
    /// instead of returning `errSecInteractionNotAllowed` — for a single-item query that means
    /// `errSecItemNotFound`, as if the item did not exist at all (on a real device the one-tap Face ID
    /// unlock would never be offered after "remember"). Modern replacement: an `LAContext` with
    /// `interactionNotAllowed = true`, passed via `kSecUseAuthenticationContext`, forces
    /// `SecItemCopyMatching` to actually return `errSecInteractionNotAllowed` when the item requires
    /// authentication — we take that as "exists". The simulator in tests has no ACL items at all (`requireBiometryForVault:
    /// false`), so there the status stays `errSecSuccess`/`errSecItemNotFound` with no change in behaviour.
    func exists(_ key: String) -> Bool {
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecUseAuthenticationContext as String: context,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
