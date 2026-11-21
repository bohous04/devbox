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

    // The app takes the appearance from its launch arguments (`-DevboxAppearance`), whatever the simulator's.
    func testDark() throws { try shoot(appearance: "dark") }
    func testLight() throws { try shoot(appearance: "light") }

    /// The composer's row on a narrow phone at an accessibility text size: the model chip must leave the field room.
    /// Run it on a small simulator (iPhone SE width); the file name says what it shows, not the device.
    func testCompactAccessibilityText() throws {
        let app = XCUIApplication()
        openThread(app, extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'example.com/docs/sync'")).firstMatch.waitForExistence(timeout: 20))
        sleep(1)
        try save(app, "ios-compact-ax-end")
    }

    /// The composer's `/` and `@` suggestions in a bar over the keyboard; a tap on one puts it in the message.
    func testComposerTriggers() throws {
        for look in ["light", "dark"] {
            let app = XCUIApplication()
            openThread(app, extra: ["-DevboxAppearance", look])
            let field = app.textFields["Message"].exists ? app.textFields["Message"] : app.textViews["Message"]
            XCTAssertTrue(field.waitForExistence(timeout: 20))
            field.tap()
            field.typeText("/")
            let review = app.buttons["/review, Review a pull request"]
            XCTAssertTrue(review.waitForExistence(timeout: 5), "the commands bar")
            try save(app, "ios-\(look)-commands")
            review.tap()
            XCTAssertTrue(review.waitForNonExistence(timeout: 3), "the bar closes after the pick")
            XCTAssertEqual(field.value as? String, "/review ")
            field.typeText("@sync")
            let manifest = app.buttons["src/sync/manifest.ts"]
            let shown = manifest.waitForExistence(timeout: 5)
            if !shown { try save(app, "ios-\(look)-files-missing"); print(app.debugDescription) }
            XCTAssertTrue(shown, "the files bar")
            sleep(1)
            try save(app, "ios-\(look)-files")
            manifest.tap()
            XCTAssertEqual(field.value as? String, "/review @src/sync/manifest.ts ")
            app.terminate()
        }
    }

    private func shoot(appearance: String) throws {
        let app = XCUIApplication()
        let look = ["-DevboxAppearance", appearance]
        openThread(app, extra: look)
        // The answer's last line: the thread has loaded and opened at its end.
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'example.com/docs/sync'")).firstMatch.waitForExistence(timeout: 20))
        sleep(1)
        try save(app, "ios-\(appearance)-end")

        // The changed-files card, one row at the end; the header's +/− opens it, then one file's diff.
        // In the thread, not the header's chip (whose label also names the changed files).
        let card = app.scrollViews.buttons.containing(NSPredicate(format: "label CONTAINS 'changed files'")).firstMatch
        let file = app.buttons["src/sync/queue.ts"]
        if card.waitForExistence(timeout: 5) {
            XCTAssertFalse(file.exists, "the changes card starts as its one row")
            let chip = app.navigationBars.buttons.containing(NSPredicate(format: "label CONTAINS 'lines added'")).firstMatch
            XCTAssertTrue(chip.waitForExistence(timeout: 3), "the header carries the changes")
            // From the top of the thread, where the lazy stack has not built the card: the chip still opens it.
            for _ in 0..<6 { app.swipeDown(velocity: .fast) }
            sleep(1)
            XCTAssertFalse(card.exists && card.isHittable, "the card is scrolled off")
            chip.tap()
            XCTAssertTrue(file.waitForExistence(timeout: 3), "the header's changes open the card")
            sleep(1)
            try save(app, "ios-\(appearance)-changes")
            if file.exists {
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
            // A tap outside closes the menu (with its submenu): on the navigation bar's title, which does nothing itself.
            // Not Escape: the simulator's menu does not get it, and the menu offers no dismiss element.
            app.navigationBars.firstMatch.tap()
            sleep(1)
            XCTAssertFalse(app.descendants(matching: .any)["Applies from your next message."].exists, "the chip's menu is still open")
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
        openThread(app, extra: look)
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Worked for'")).firstMatch.waitForExistence(timeout: 20))

        // The top: the earlier turn, the notice and the long prompt.
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        sleep(1)
        try save(app, "ios-\(appearance)-top")
    }

    private func openThread(_ app: XCUIApplication, extra: [String] = []) {
        app.launchArguments = ["-DevboxFixtures", "demo"] + extra
        app.launch()
        app.open(URL(string: "devbox://thread/dev-orchard-sync")!)
    }

    private func save(_ app: XCUIApplication, _ name: String) throws {
        try app.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("\(name).png"))
    }
}
