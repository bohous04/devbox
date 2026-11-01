import XCTest
@testable import DevboxApp

/// Cleanup of orphaned per-session Live Activities from build 12 (see LegacySessionActivityCleanup.swift).
/// ActivityKit is not called in the test — a fake `LegacyActivityEnding` only counts calls.
@MainActor
final class LegacySessionActivityCleanupTests: XCTestCase {
    private final class FakeEnder: LegacyActivityEnding {
        var calls = 0
        func endAllImmediately() { calls += 1 }
    }

    func testLaunchEndsLegacyActivities() {
        let fake = FakeEnder()
        let cleanup = LegacySessionActivityCleanup(ender: fake)
        cleanup.appLaunched()
        XCTAssertEqual(fake.calls, 1)
    }

    func testEnteringForegroundEndsAgainButBackgroundDoesNot() {
        let fake = FakeEnder()
        let cleanup = LegacySessionActivityCleanup(ender: fake)
        cleanup.sceneBecame(active: true)
        cleanup.sceneBecame(active: false)
        cleanup.sceneBecame(active: true)
        XCTAssertEqual(fake.calls, 2)
    }

    func testAppModelOwnsCleanupBackedByActivityKitEnder() {
        let model = AppModel(keychain: KeychainStore(requireBiometryForVault: false))
        XCTAssertTrue(model.legacySessionActivityCleanup.ender is ActivityKitLegacySessionEnder)
    }
}
