import XCTest

final class SmokeTests: XCTestCase {
    // Only checks that the XCTest harness and the test target run — no app logic is tested here.
    func testHarnessRuns() throws {
        XCTAssertTrue(true)
    }
}
