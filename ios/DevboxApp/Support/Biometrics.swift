import Foundation
import LocalAuthentication

/// Biometric prompt errors as the UI needs them: `cancelled` is silent (the user changed their
/// mind — no red message, same as a 409 in a race with the mac), the rest is shown.
enum BiometricError: Error, Equatable, CustomStringConvertible {
    case cancelled
    /// The device has neither biometrics nor a passcode enabled — the prompt cannot be shown at all.
    case unavailable(String)
    case failed(String)

    var description: String {
        switch self {
        case .cancelled: return "Cancelled"
        case .unavailable(let why), .failed(let why): return why
        }
    }
}

/// "It's me" confirmation before a sensitive action. A protocol for tests: the simulator has no Face ID
/// and `LAContext` would fail every prompt there — `SshApprovalsStoreTests` inject a fake.
protocol BiometricGate {
    func confirm(reason: String) async throws
}

/// Production gate over `LAContext`. Policy `.deviceOwnerAuthentication`, not pure
/// `…WithBiometrics`: Face ID goes first, but after biometrics lock out (5 failures) the system
/// offers the device passcode — otherwise approving from the phone would be impossible and only the dashboard would remain.
final class LocalAuthGate: BiometricGate {
    func confirm(reason: String) async throws {
        let context = LAContext()
        var probe: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &probe) else {
            throw BiometricError.unavailable(probe?.localizedDescription ?? "Face ID or passcode is not set up on this device.")
        }
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
                throw BiometricError.failed("Authentication failed.")
            }
        } catch let error as LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel:
                throw BiometricError.cancelled
            default:
                throw BiometricError.failed(error.localizedDescription)
            }
        }
    }

    /// "Face ID" / "Touch ID" for button labels; `nil` = a device without biometrics (then the
    /// label sticks to a generic "Unlock", so it does not promise what is not possible).
    static func biometryName() -> String? {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return nil
        }
    }
}
