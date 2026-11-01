import XCTest
@testable import DevboxApp

/// Verifies the get/set/delete roundtrip over `KeychainStore`. The tests run in the host app's process
/// (DevboxApp hosts the test target), so the Keychain behaves as in the real app.
final class KeychainStoreTests: XCTestCase {
    private let store = KeychainStore()

    override func tearDown() {
        for key in [
            KeychainStore.cfClientId,
            KeychainStore.cfClientSecret,
            KeychainStore.cfHostname,
            KeychainStore.tailnetBase,
            KeychainStore.vaultPassphrase,
        ] {
            store.delete(key)
        }
        super.tearDown()
    }

    func testGetMissingKeyReturnsNil() {
        XCTAssertNil(store.get(KeychainStore.cfClientId))
    }

    func testSetThenGetRoundtrips() {
        XCTAssertTrue(store.set(KeychainStore.cfHostname, "devbox.example.ts.net"))
        XCTAssertEqual(store.get(KeychainStore.cfHostname), "devbox.example.ts.net")
    }

    func testSetOverwritesExistingValue() {
        XCTAssertTrue(store.set(KeychainStore.tailnetBase, "https://old.example"))
        XCTAssertTrue(store.set(KeychainStore.tailnetBase, "https://new.example"))
        XCTAssertEqual(store.get(KeychainStore.tailnetBase), "https://new.example")
    }

    func testDeleteRemovesValue() {
        store.set(KeychainStore.cfClientSecret, "secret-value")
        store.delete(KeychainStore.cfClientSecret)
        XCTAssertNil(store.get(KeychainStore.cfClientSecret))
    }

    func testVaultPassphraseRoundtripsWithoutBiometry() {
        // The simulator has no enrolled biometrics in tests — the production branch with
        // .biometryCurrentSet would make SecItemAdd fail, so we inject false.
        let vaultStore = KeychainStore(requireBiometryForVault: false)
        XCTAssertTrue(vaultStore.set(KeychainStore.vaultPassphrase, "s3cr3t-passphrase"))
        XCTAssertEqual(vaultStore.get(KeychainStore.vaultPassphrase), "s3cr3t-passphrase")
    }

    // MARK: - exists() — bez biometrie (Etapa G, task 30)

    func testExistsReturnsFalseForMissingKey() {
        XCTAssertFalse(store.exists(KeychainStore.vaultPassphrase))
    }

    func testExistsReturnsTrueAfterSetWithoutBiometry() {
        // `requireBiometryForVault: false` just like testVaultPassphraseRoundtripsWithoutBiometry
        // — on a simulator without biometrics: `exists` must return true even without access control, not only
        // for the production `.biometryCurrentSet` branch (which the simulator cannot exercise in tests).
        let vaultStore = KeychainStore(requireBiometryForVault: false)
        vaultStore.set(KeychainStore.vaultPassphrase, "s3cr3t-passphrase")
        XCTAssertTrue(vaultStore.exists(KeychainStore.vaultPassphrase))
    }

    func testExistsReturnsFalseAfterDeleteWithoutBiometry() {
        let vaultStore = KeychainStore(requireBiometryForVault: false)
        vaultStore.set(KeychainStore.vaultPassphrase, "s3cr3t-passphrase")
        vaultStore.delete(KeychainStore.vaultPassphrase)
        XCTAssertFalse(vaultStore.exists(KeychainStore.vaultPassphrase))
    }

    // MARK: - read() + availability after locking (notifications while the phone is locked)

    func testReadDistinguishesValueAndMissing() {
        store.set(KeychainStore.tailnetBase, "100.100.100.100:4300")
        XCTAssertEqual(store.read(KeychainStore.tailnetBase), .value("100.100.100.100:4300"))
        XCTAssertEqual(store.read(KeychainStore.cfClientId), .missing)
    }

    func testSetStoresConfigKeysAccessibleAfterFirstUnlock() {
        XCTAssertTrue(store.set(KeychainStore.cfClientSecret, "secret-value"))
        XCTAssertEqual(accessibility(of: KeychainStore.cfClientSecret), "cku")
    }

    /// The second write goes through `SecItemUpdate` (no delete beforehand) — the value is overwritten
    /// and the accessibility stays `AfterFirstUnlockThisDeviceOnly`.
    func testSetTwiceUpdatesValueKeepingAfterFirstUnlock() {
        XCTAssertTrue(store.set(KeychainStore.cfHostname, "old.example"))
        XCTAssertTrue(store.set(KeychainStore.cfHostname, "new.example"))
        XCTAssertEqual(store.read(KeychainStore.cfHostname), .value("new.example"))
        XCTAssertEqual(accessibility(of: KeychainStore.cfHostname), "cku")
    }

    /// Writing over an existing old item (`WhenUnlocked`) also migrates it via the update.
    func testSetOverLegacyItemUpgradesAccessibility() {
        addLegacyItem(KeychainStore.tailnetBase, "100.100.100.100:4300")
        XCTAssertTrue(store.set(KeychainStore.tailnetBase, "100.100.100.101:4300"))
        XCTAssertEqual(store.get(KeychainStore.tailnetBase), "100.100.100.101:4300")
        XCTAssertEqual(accessibility(of: KeychainStore.tailnetBase), "cku")
    }

    func testVaultPassphraseKeepsWhenUnlockedProtection() {
        let vaultStore = KeychainStore(requireBiometryForVault: false)
        XCTAssertTrue(vaultStore.set(KeychainStore.vaultPassphrase, "s3cr3t-passphrase"))
        XCTAssertEqual(accessibility(of: KeychainStore.vaultPassphrase), "aku")
    }

    /// An older build stored `WhenUnlockedThisDeviceOnly` — the migration must switch the item to
    /// `AfterFirstUnlockThisDeviceOnly` WITHOUT losing the value (the user re-enters nothing).
    func testMigrateAccessibilityUpgradesLegacyItemsKeepingValue() {
        addLegacyItem(KeychainStore.tailnetBase, "100.100.100.100:4300")
        XCTAssertEqual(accessibility(of: KeychainStore.tailnetBase), "aku")

        store.migrateAccessibility(keys: [KeychainStore.tailnetBase])

        XCTAssertEqual(accessibility(of: KeychainStore.tailnetBase), "cku")
        XCTAssertEqual(store.get(KeychainStore.tailnetBase), "100.100.100.100:4300")
    }

    private var service: String { Bundle.main.bundleIdentifier ?? "com.example.devbox" }

    private func addLegacyItem(_ key: String, _ value: String) {
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        XCTAssertEqual(SecItemAdd(attributes as CFDictionary, nil), errSecSuccess)
    }

    private func accessibility(of key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let attributes = result as? [String: Any] else { return nil }
        return attributes[kSecAttrAccessible as String] as? String
    }
}
