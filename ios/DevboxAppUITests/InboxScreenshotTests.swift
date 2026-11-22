import XCTest

/// iPhone screenshots of the inbox on the DEBUG `demo` fixtures (DevboxApp/Support/Fixtures/InboxFixtures.swift): the
/// list, a row's trailing swipe, and the undo notice after a settle. Written as PNGs to `INBOX_SHOTS_DIR` (pass
/// `TEST_RUNNER_INBOX_SHOTS_DIR=<dir>` to xcodebuild); skipped without it. `INBOX_SHOTS_LOOK` (light or dark) picks
/// the app's appearance and names the files. Also checks the gestures themselves: the swipe offers Settle, and a
/// settled row leaves the list until Undo brings it back.
final class InboxScreenshotTests: XCTestCase {
    func testInbox() throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["INBOX_SHOTS_DIR"], !path.isEmpty else {
            throw XCTSkip("inbox screenshots off — set TEST_RUNNER_INBOX_SHOTS_DIR to write them")
        }
        let dir = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let look = env["INBOX_SHOTS_LOOK"] ?? "light"
        let app = XCUIApplication()
        app.launchArguments = ["-DevboxFixtures", "demo", "-DevboxAppearance", look]
        app.launch()
        func shot(_ name: String) throws {
            try app.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("ios-inbox-\(name)-\(look).png"))
        }

        // A row is one element whose label starts with its mark and title (InboxRow.spoken).
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Done, Add a retry queue")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the fixture inbox did not load")
        sleep(1)
        try shot("list")

        // A slow drag reveals the actions without a full swipe.
        let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -150, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.2)
        let settle = app.buttons["Settle"]
        XCTAssertTrue(settle.waitForExistence(timeout: 5), "the trailing swipe offers Settle")
        sleep(1)
        try shot("swipe")

        settle.tap()
        let undo = app.buttons["Undo settle"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5), "the undo notice follows the settle")
        XCTAssertFalse(row.exists, "the settled row left the list")
        try shot("undo")

        undo.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Undo brings the row back")
    }
}
