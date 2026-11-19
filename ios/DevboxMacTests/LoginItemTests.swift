import XCTest
@testable import DevboxApp

/// Launch at login is on by default: the first launch registers the app, later launches respect the user's choice.
@MainActor
final class LoginItemTests: XCTestCase {
    private final class FakeService: LoginItemService {
        var status: LoginItemStatus = .disabled
        var registers = 0
        var failRegister: Error?
        func register() throws {
            registers += 1
            if let failRegister { throw failRegister }
            status = .enabled
        }
        func unregister() throws { status = .disabled }
    }

    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() {
        super.setUp()
        suite = "LoginItemTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testFirstLaunchRegistersOnce() {
        let service = FakeService()
        LoginItem(service: service, defaults: defaults).registerOnFirstLaunch()
        XCTAssertEqual(service.registers, 1)
        XCTAssertEqual(service.status, .enabled)
        LoginItem(service: service, defaults: defaults).registerOnFirstLaunch()
        XCTAssertEqual(service.registers, 1)
    }

    func testTurnedOffInSettingsStaysOffOnTheNextLaunch() {
        let service = FakeService()
        let item = LoginItem(service: service, defaults: defaults)
        item.registerOnFirstLaunch()
        item.set(enabled: false)
        XCTAssertFalse(item.enabled)
        LoginItem(service: service, defaults: defaults).registerOnFirstLaunch()
        XCTAssertEqual(service.status, .disabled)
    }

    func testAFailedFirstRegistrationIsShownAndRetriedNextLaunch() {
        struct Refused: Error {}
        let service = FakeService()
        service.failRegister = Refused()
        let item = LoginItem(service: service, defaults: defaults)
        item.registerOnFirstLaunch()
        XCTAssertNotNil(item.error)
        XCTAssertFalse(item.enabled)
        service.failRegister = nil
        LoginItem(service: service, defaults: defaults).registerOnFirstLaunch()
        XCTAssertEqual(service.registers, 2)
        XCTAssertEqual(service.status, .enabled)
    }

    func testNeedsApprovalIsSaid() {
        let service = FakeService()
        service.status = .requiresApproval
        let item = LoginItem(service: service, defaults: defaults)
        XCTAssertEqual(item.statusText, "Allow Devbox in System Settings › General › Login Items.")
    }
}
