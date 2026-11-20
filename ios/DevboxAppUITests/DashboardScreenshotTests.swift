import XCTest

/// iPhone screenshots of the More pages built from the dashboard (Unpushed, Agent upkeep, Operations, Production writes) on the DEBUG
/// `demo` fixtures (DevboxApp/Support/Fixtures/DashboardFixtures.swift). Written as PNGs to `DASHBOARD_SHOTS_DIR`
/// (pass `TEST_RUNNER_DASHBOARD_SHOTS_DIR=<dir>` to xcodebuild); skipped without it. The appearance is the
/// simulator's (`xcrun simctl ui <device> appearance dark|light`); `DASHBOARD_SHOTS_LOOK` only labels the files.
final class DashboardScreenshotTests: XCTestCase {
    func testPages() throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["DASHBOARD_SHOTS_DIR"], !path.isEmpty else {
            throw XCTSkip("dashboard screenshots off — set TEST_RUNNER_DASHBOARD_SHOTS_DIR to write them")
        }
        let dir = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let look = env["DASHBOARD_SHOTS_LOOK"] ?? "light"
        let app = XCUIApplication()
        app.launchArguments = ["-DevboxFixtures", "demo"]
        app.launch()
        // Each page, and a text that shows its fixture data has loaded.
        for (page, loaded) in [("unpushed", "acme/web"), ("upkeep", "2.4.0"), ("operations", "acme-web"),
                               ("prodWrites", "acme-prod")] {
            app.open(URL(string: "devbox://more/\(page)")!)
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", loaded)).firstMatch
                .waitForExistence(timeout: 20), page)
            sleep(1)
            try app.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("ios-\(page)-\(look).png"))
        }
    }
}
