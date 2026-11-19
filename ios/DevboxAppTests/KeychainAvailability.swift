import Security
import XCTest

/// The Mac app keeps its configuration in the data protection keychain (see `KeychainStore.itemQuery`), which needs
/// a build signed with a development team. An unsigned ("Sign to Run Locally") test run gets errSecMissingEntitlement
/// for every item: tests of the real keychain skip then instead of failing. iOS always has it.
enum KeychainAvailability {
    static func skipIfUnavailable() throws {
        #if os(macOS)
        // A read of a missing item answers "not found" even without the entitlement; a write tells.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "keychain-availability-probe",
            kSecAttrAccount as String: "probe",
            kSecUseDataProtectionKeychain as String: true,
        ]
        var item = query
        item[kSecValueData as String] = Data("probe".utf8)
        let status = SecItemAdd(item as CFDictionary, nil)
        SecItemDelete(query as CFDictionary)
        if status == errSecMissingEntitlement {
            throw XCTSkip("the data protection keychain needs a team-signed build (OSStatus \(status))")
        }
        #endif
    }
}
