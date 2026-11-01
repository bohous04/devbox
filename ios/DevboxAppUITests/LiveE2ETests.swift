import XCTest

/// Live E2E (READ-ONLY) against the real devd on the VPS: app launch → onboarding (Tailnet URL only) →
/// Sessions tab → detail → back. Not a mock, the real devd at `DEVBOX_TAILNET_URL`.
///
/// Gated: `XCTSkip` without `DEVBOX_LIVE_TESTS=1` and `DEVBOX_TAILNET_URL` in the environment, so a normal `xcodebuild test` (CI, review)
/// does not depend on the network/VPS. Env is read from the `ProcessInfo` of the RUNNING TEST (the XCTRunner process gets
/// `TestAction.EnvironmentVariables` from the scheme) — the app under test does not need its own `launchEnvironment`,
/// the gate is handled purely on the test side.
///
/// READ-ONLY rule: the flow never taps Stop/End/Switch account/Switch agent/New session on a live
/// session — only list → detail → back (GET requests, no mutation).
///
/// The simulator Keychain keeps the configuration between app launches (unlike a fresh install) —
/// so the test handles BOTH starting states: the onboarding sheet (fresh/cleared state), or directly
/// the Sessions list (the app is already configured from a previous run). Cleanup/uninstall for a clean start
/// is left to a script outside the test (see task-15-report-ios.md).
final class LiveE2ETests: XCTestCase {
    private static var tailnetURL: String { ProcessInfo.processInfo.environment["DEVBOX_TAILNET_URL"] ?? "" }

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["DEVBOX_LIVE_TESTS"] == "1" else {
            throw XCTSkip("live E2E disabled — set DEVBOX_LIVE_TESTS=1 (scheme TestAction env) for a manual check against the real devd")
        }
        guard !Self.tailnetURL.isEmpty else {
            throw XCTSkip("DEVBOX_TAILNET_URL missing (e.g. http://<tailnet-ip>:4300)")
        }
    }

    func testOnboardingThroughSessionListToDetailIsReadOnly() throws {
        let app = XCUIApplication()
        app.launch()

        fillOnboardingIfPresent(app)
        attachScreenshot(app, name: "01b-after-onboarding")

        // Sessions list — wait for at least 1 row (the shared devd has live sessions running).
        let firstRow = openSessionsTab(app)
        XCTAssertTrue(firstRow.waitForExistence(timeout: 20), "Sessions list showed no rows within 20 s")
        attachScreenshot(app, name: "01-sessions-list")

        firstRow.tap()

        // Detail — StatGrid renders "Uptime" as a label (see SessionDetailView.statItems).
        // `.textCase(.uppercase)` changes the displayed text, hence a case-insensitive predicate instead of
        // relying on the exact "Uptime"/"UPTIME" form.
        let uptimeLabel = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Uptime")
        ).firstMatch
        XCTAssertTrue(uptimeLabel.waitForExistence(timeout: 10), "Session detail did not appear (Uptime stat missing)")
        attachScreenshot(app, name: "02-session-detail")

        // Terminal (Stage D) — open it, wait for the "read-only" badge (the default state, see
        // `TerminalScreen`/`dashboard/src/components/Terminal.tsx`), screenshot, close. `sorted()`
        // (see `SessionsScreen`) puts running sessions first, so `firstRow` is running and the
        // Terminal button exists. NO unlock/typing — just connect and close again (GET/WS handshake,
        // no mutation on a shared session).
        let terminalButton = app.buttons["Terminal"]
        XCTAssertTrue(terminalButton.waitForExistence(timeout: 5), "Terminal button not found in the detail")
        terminalButton.tap()

        // `.textCase(.uppercase)` changes the displayed text just like the StatGrid labels above —
        // case-insensitive predicate instead of relying on the exact "read-only"/"READ-ONLY" form.
        let readOnlyBadge = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "read-only")
        ).firstMatch
        XCTAssertTrue(readOnlyBadge.waitForExistence(timeout: 15), "Terminal did not open in the read-only state")
        attachScreenshot(app, name: "03-terminal-read-only")

        app.buttons["Close"].tap()
        XCTAssertTrue(uptimeLabel.waitForExistence(timeout: 5), "After closing the terminal the app did not return to the detail")

        // Back to the list — the only interaction after the detail is the system Back button, no action.
        // "iPhone Duo" draws Back as a floating button outside the navigation bar — the fallback is
        // tapping the Sessions tab again (pops to the root, also without any mutation).
        let back = app.navigationBars.buttons.element(boundBy: 0)
        if back.exists { back.tap() } else { _ = openSessionsTab(app) }
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10), "The sessions list did not show after going back")
    }

    /// Live E2E (MUTATING) — creates ITS OWN SOLO scratch session, switches its agent to Codex and
    /// back to Claude Code, then deletes it. The only session the test touches is the one it
    /// creates itself (SOLO in `acme/metro` — safe, because SOLO never mounts/touches
    /// any real repo, see `NewSessionLogic.SOLO`). The `cc-scratch` folder from the original
    /// brief did not exist on the VPS as of 2026-08-25 (verified via `/api/tree`) — `acme/metro` is
    /// an equally safe (and smaller, so less confusing in the UI) replacement with a guaranteed SOLO option.
    ///
    /// Gated ADDITIONALLY (on top of the class-level `DEVBOX_LIVE_TESTS`) via `DEVBOX_LIVE_MUTATING=1` — this
    /// is the only test in the file that creates/deletes something on the shared devd, hence the stricter opt-in.
    func testAgentSwitchAndSoloWorkspaceLifecycleIsMutating() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["DEVBOX_LIVE_MUTATING"] == "1",
            "mutating live E2E disabled — set DEVBOX_LIVE_MUTATING=1 (together with DEVBOX_LIVE_TESTS=1) for a manual check of the create/switch-agent/delete flow against the real devd"
        )

        let app = XCUIApplication()
        app.launch()
        fillOnboardingIfPresent(app)

        let firstRow = openSessionsTab(app)
        XCTAssertTrue(firstRow.waitForExistence(timeout: 20), "Sessions list showed no rows within 20 s")

        // --- New session: SOLO v acme/metro ---
        app.buttons["New session"].tap()
        XCTAssertTrue(app.navigationBars["New session"].waitForExistence(timeout: 10))

        app.buttons["Folder, —"].tap()
        if app.buttons["cc-scratch"].waitForExistence(timeout: 2) {
            app.buttons["cc-scratch"].tap()
            // Unknown project structure under cc-scratch — but SOLO is always available as the last
            // choice in the Repo picker (`NewSessionLogic.repoChoices`), so any project will do.
            app.buttons["Project, —"].tap()
            app.buttons.matching(NSPredicate(format: "label != %@", "—")).element(boundBy: 0).tap()
        } else {
            app.buttons["acme"].tap()
            app.buttons["Project, —"].tap()
            app.buttons["metro"].tap()
        }
        app.buttons["Repo, —"].tap()
        let soloOption = app.buttons["claudeSolo"]
        XCTAssertTrue(soloOption.waitForExistence(timeout: 5), "SOLO option did not appear in the Repo picker")
        soloOption.tap()

        let startButton = app.buttons["Start"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 5))
        startButton.tap()

        let runningMsg = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "running")).firstMatch
        XCTAssertTrue(runningMsg.waitForExistence(timeout: 20), "New session sheet 'running' message did not appear")
        attachScreenshot(app, name: "mut-01-session-started")
        app.buttons["Cancel"].tap()

        // The new SOLO session is "claudeSolo-N" under the "metro" project — find it by BOTH parts
        // of the label (just "claudeSolo" could hit someone else's existing SOLO session in another project).
        let newRow = app.buttons.matching(NSPredicate(
            format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@", "claudeSolo", "metro"
        )).firstMatch
        XCTAssertTrue(newRow.waitForExistence(timeout: 20), "The new SOLO session did not appear in the list")
        newRow.tap()
        attachScreenshot(app, name: "mut-02-detail-opened")

        // "Switch agent…" is below the fold, otherwise `waitForExistence` on iOS 17 does not find an invisible
        // (but existing) element in a CollectionView — a swipe first reveals the Agent section.
        app.swipeUp()
        let agentButton = app.buttons["Agent, Claude Code"]
        XCTAssertTrue(agentButton.waitForExistence(timeout: 10), "Agent picker (Claude Code) not found in the detail")

        // --- Switch to Codex ---
        agentButton.tap()
        let codexOption = app.buttons["Codex"]
        XCTAssertTrue(codexOption.waitForExistence(timeout: 5))
        codexOption.tap()

        let switchButton = app.buttons["Switch agent…"]
        XCTAssertTrue(switchButton.waitForExistence(timeout: 5))
        switchButton.tap()
        let confirmToCodex = app.buttons["Restart onto it?"]
        XCTAssertTrue(confirmToCodex.waitForExistence(timeout: 5), "Switch-agent confirmation dialog did not appear")
        confirmToCodex.tap()

        waitAndAssertNoErrorOnScreen(app, seconds: 75, context: "Switch agent → Codex")
        attachScreenshot(app, name: "mut-03-switched-to-codex")

        // --- Switch back to Claude Code ---
        app.buttons["Agent, Codex"].tap()
        let claudeOption = app.buttons["Claude Code"]
        XCTAssertTrue(claudeOption.waitForExistence(timeout: 5))
        claudeOption.tap()

        switchButton.tap()
        let confirmToClaude = app.buttons["Restart onto it?"]
        XCTAssertTrue(confirmToClaude.waitForExistence(timeout: 5), "Switch-agent-back confirmation dialog did not appear")
        confirmToClaude.tap()

        waitAndAssertNoErrorOnScreen(app, seconds: 75, context: "Switch agent → Claude Code")
        attachScreenshot(app, name: "mut-04-switched-back-to-claude")

        // --- Cleanup: Delete workspace (SOLO) ---
        let deleteButton = app.buttons["Delete workspace…"]
        XCTAssertTrue(deleteButton.waitForExistence(timeout: 10), "Delete workspace button not found")
        deleteButton.tap()
        let confirmDelete = app.buttons["Delete workspace"]
        XCTAssertTrue(confirmDelete.waitForExistence(timeout: 5), "Delete workspace confirmation dialog did not appear")
        confirmDelete.tap()

        // After a successful end() the detail dismiss()es itself back to the list.
        XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 30), "After Delete workspace the app did not return to the sessions list")
        attachScreenshot(app, name: "mut-05-cleaned-up")
    }

    // MARK: - Private

    /// The app starts on Overview (first tab as on the web, see `AppTab`) — Sessions is the second tab.
    /// Rows are cards in a `ScrollView` (not `List` cells), hence the lookup by the identifier
    /// `session-row` (see `SessionsScreen.listContent`).
    private func openSessionsTab(_ app: XCUIApplication) -> XCUIElement {
        // On some devices (the "iPhone Duo" simulator) tabs are not drawn as a `tabBar` but
        // as a floating bar — the tab button is then just a plain `button`.
        let tab = app.tabBars.buttons["Sessions"]
        if tab.waitForExistence(timeout: 5) {
            tab.tap()
        } else {
            app.buttons["Sessions"].firstMatch.tap()
        }
        return app.descendants(matching: .any).matching(identifier: "session-row").firstMatch
    }

    /// Fills in only the Tailnet URL and saves — the app treats that as a sufficient configuration
    /// (`AppModel.isConfigured`: the tailnet alone is enough, CF needs the complete triple).
    /// The "Tailnet URL" field does not appear if the app holds a configuration from a previous run
    /// (the simulator Keychain survives between launches) — in that case the test just continues.
    private func fillOnboardingIfPresent(_ app: XCUIApplication) {
        let tailnetField = app.textFields["Tailnet URL"]
        guard tailnetField.waitForExistence(timeout: 5) else { return }
        tailnetField.tap()
        tailnetField.typeText(Self.tailnetURL)
        app.buttons["Save"].tap()
    }

    /// Long passive wait for an action mutation to finish (switching the agent restarts the panes in
    /// the container, which can take tens of seconds) — periodically checks whether `SessionDetailView`
    /// shows the error section ("Error: …", see `SessionDetailView.run`). "Done" cannot be reliably
    /// detected other than by the absence of an error after a long enough window — `agentPick`
    /// (local @State) stays at the target value regardless of the request result, so the
    /// value in the Agent picker alone does not tell success from failure.
    private func waitAndAssertNoErrorOnScreen(_ app: XCUIApplication, seconds: TimeInterval, context: String) {
        let errorText = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Error:"))
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if errorText.firstMatch.exists {
                XCTFail("\(context): an error appeared on screen — \(errorText.firstMatch.label)")
                return
            }
            Thread.sleep(forTimeInterval: 5)
        }
        XCTAssertFalse(errorText.firstMatch.exists, "\(context): an error appeared on screen — \(errorText.firstMatch.exists ? errorText.firstMatch.label : "")")
    }

    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
