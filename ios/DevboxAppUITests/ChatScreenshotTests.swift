import XCTest

/// Screenshots of the chat screen on the DEBUG fixture thread (`-DevboxFixtures demo`, DevboxApp/Support/Fixtures/
/// ThreadFixtures.swift): no server, the same pictures every run. Written as PNGs to `CHAT_SHOTS_DIR` (pass it to xcodebuild as
/// `TEST_RUNNER_CHAT_SHOTS_DIR=<dir>`); skipped without it, so a normal `xcodebuild test` does not run it.
final class ChatScreenshotTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let path = ProcessInfo.processInfo.environment["CHAT_SHOTS_DIR"], !path.isEmpty else {
            throw XCTSkip("chat screenshots off — set TEST_RUNNER_CHAT_SHOTS_DIR to write them")
        }
        dir = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    // The appearance is the simulator's (`xcrun simctl ui <device> appearance dark|light`); the name only labels the files.
    func testDark() throws { try shoot(appearance: "dark") }
    func testLight() throws { try shoot(appearance: "light") }

    private func shoot(appearance: String) throws {
        let app = XCUIApplication()
        openThread(app)
        // The answer's last line: the thread has loaded and opened at its end.
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'example.com/docs/sync'")).firstMatch.waitForExistence(timeout: 20))
        sleep(1)
        try save(app, "ios-\(appearance)-end")

        // The changed-files card: collapsed, then open with one file's diff.
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS 'changed files'")).firstMatch
        if card.waitForExistence(timeout: 5) {
            card.tap()
            sleep(1)
            try save(app, "ios-\(appearance)-changes")
            card.tap()
            let file = app.buttons["src/sync/queue.ts"]
            if file.waitForExistence(timeout: 3) {
                file.tap()
                sleep(2)
                app.swipeUp(velocity: .slow)
                sleep(1)
                try save(app, "ios-\(appearance)-diff")
                file.tap()
                sleep(1)
            }
        }

        // The finished run's work, opened: every command with its mark.
        let fold = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Worked for'")).firstMatch
        if fold.waitForExistence(timeout: 3) {
            fold.tap()
            sleep(1)
            try save(app, "ios-\(appearance)-work")
        }

        // The chip's menu, then its Effort submenu: the levels, the current one ticked, and when it applies.
        let chip = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Model:'")).firstMatch
        if chip.waitForExistence(timeout: 3) {
            chip.tap()
            sleep(1)
            try save(app, "ios-\(appearance)-model-menu")
            let effort = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Effort'")).firstMatch
            if effort.waitForExistence(timeout: 3) {
                effort.tap()
                sleep(1)
                try save(app, "ios-\(appearance)-effort-menu")
            }
            // Closes the submenu, then the menu: a tap above them, away from the composer.
            for _ in 0..<2 { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap(); sleep(1) }
        }

        // The composer from its second line: two tiers, the field over the controls.
        let field = app.textFields["Message"].exists ? app.textFields["Message"] : app.textViews["Message"]
        if field.waitForExistence(timeout: 3) {
            field.tap()
            field.typeText("Also add a drain timeout, and say what happens to jobs that are still queued when it fires")
            sleep(1)
            try save(app, "ios-\(appearance)-composer")
        }

        // A fresh launch (no keyboard, no draft) for the top of the thread.
        app.terminate()
        openThread(app)
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Worked for'")).firstMatch.waitForExistence(timeout: 20))

        // The top: the earlier turn, the notice and the long prompt.
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        sleep(1)
        try save(app, "ios-\(appearance)-top")
    }

    private func openThread(_ app: XCUIApplication) {
        app.launchArguments = ["-DevboxFixtures", "demo"]
        app.launch()
        app.open(URL(string: "devbox://thread/dev-orchard-sync")!)
    }

    private func save(_ app: XCUIApplication, _ name: String) throws {
        try app.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("\(name).png"))
    }
}
