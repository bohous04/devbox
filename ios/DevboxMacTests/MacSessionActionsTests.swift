import XCTest
@testable import DevboxApp

/// The sidebar row's F9 items (MacSessionActions.swift): which appear for which session, and what the calls send and
/// say. The API calls go through `MockURLProtocol` (DevdClientTests.swift).
@MainActor
final class MacSessionActionsTests: XCTestCase {
    private typealias M = MacSessionMenu
    private let accounts: M.Accounts = .loaded([.init(id: "max-a", label: "Max A", current: false),
                                                 .init(id: "max-b", label: "Max B", current: false)])
    private let codexAccounts: M.Accounts = .loaded([.init(id: "default", label: "Codex main", current: true)])

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func menu(_ runtime: InboxItem.Runtime, _ agent: String, worktree: Bool? = false, accountId: String? = nil,
                      claude: M.Accounts? = nil) -> M.Menu {
        M.menu(sessionId: "dev-shop-cms", runtime: runtime, agent: agent,
               facts: worktree.map { M.Facts(worktree: $0, accountId: accountId) }, claude: claude ?? accounts, codex: codexAccounts)
    }

    // MARK: - Which items appear

    /// devd refuses agent and account switches on chat sessions (409), so chat gets Rename and End only.
    func testChatOffersRenameAndEndOnly() {
        for agent in ["claude", "codex", "grok"] {
            let m = menu(.chat, agent)
            XCTAssertTrue(m.canRename)
            XCTAssertEqual(m.agents, [], agent)
            XCTAssertNil(m.account, agent)
            XCTAssertNotNil(m.end)
        }
    }

    /// An unknown runtime from a newer devd gets no switches either.
    func testUnknownRuntimeOffersNoSwitches() {
        let m = menu(.unknown, "claude")
        XCTAssertEqual(m.agents, [])
        XCTAssertNil(m.account)
    }

    /// Every tmux agent profile, the current one checked; Vibe is chat-only and not offered.
    func testTerminalAgentsListTheProfilesWithTheCurrentChecked() {
        let m = menu(.tmux, "codex")
        XCTAssertEqual(m.agents.map(\.id), ["claude", "claude-gemini", "claude-openrouter", "codex", "grok", "antigravity"])
        XCTAssertEqual(m.agents.filter(\.current).map(\.id), ["codex"])
        XCTAssertEqual(menu(.tmux, "something-new").agents.filter(\.current).map(\.id), ["claude"],
                       "an unknown profile reads as claude, as devd and the dashboard read it")
    }

    /// Claude Code: Automatic plus the usable Anthropic accounts, the session's lease checked.
    func testClaudeCodeAccountsHaveAutomaticAndTheCurrentChecked() throws {
        let account = try XCTUnwrap(menu(.tmux, "claude", accountId: "max-b").account)
        XCTAssertEqual(account.pool, .claude)
        XCTAssertEqual(account.title, "Change Account (Claude Code)")
        XCTAssertTrue(account.automatic)
        XCTAssertEqual(account.accounts.map(\.id), ["max-a", "max-b"])
        XCTAssertEqual(account.accounts.filter(\.current).map(\.id), ["max-b"])
        XCTAssertNil(account.note)
    }

    /// Codex names its account (devd has no automatic choice there); the session's own list comes marked, and the
    /// Anthropic lease does not mark it.
    func testCodexAccountsHaveNoAutomatic() throws {
        let account = try XCTUnwrap(menu(.tmux, "codex", accountId: "max-a").account)
        XCTAssertEqual(account.pool, .codex)
        XCTAssertEqual(account.title, "Change Account (Codex)")
        XCTAssertFalse(account.automatic)
        XCTAssertEqual(account.accounts.map(\.id), ["default"])
        XCTAssertEqual(account.accounts.filter(\.current).map(\.id), ["default"])
    }

    private func codexView(_ panes: String, current: String? = "a") throws -> CodexSessionAccounts {
        let accounts = #"[{"id":"a","label":"A","disabled":false,"available":true,"unavailableReason":null},"#
            + #"{"id":"b","label":"B","disabled":false,"available":true,"unavailableReason":null},"#
            + #"{"id":"c","label":"C","disabled":false,"available":false,"unavailableReason":"not mounted in this session"},"#
            + #"{"id":"d","label":"D","disabled":true,"available":true,"unavailableReason":null}]"#
        let currentJSON = current.map { "\"\($0)\"" } ?? "null"
        let json = "{\"accounts\":\(accounts),\"panes\":\(panes),\"currentAccountId\":\(currentJSON)}"
        return try JSONDecoder().decode(CodexSessionAccounts.self, from: Data(json.utf8))
    }

    /// The session's Codex list as the CLI filters it: only accounts available here, the current one marked; an
    /// unfinished switch can only be finished on its account; no pane or two unfinished targets offer nothing.
    func testCodexChoicesFollowTheSession() throws {
        XCTAssertEqual(M.codexChoices(try codexView(#"[{"target":"main:0.0","accountId":"a"}]"#)),
                       .loaded([.init(id: "a", label: "A", current: true), .init(id: "b", label: "B", current: false)]))
        XCTAssertEqual(M.codexChoices(try codexView(#"[{"target":"main:0.0","accountId":null,"pending":{"accountId":"b"}}]"#, current: nil)),
                       .loaded([.init(id: "b", label: "B (finish switching)", current: false, finishing: true)]))
        guard case .unavailable(let none) = M.codexChoices(try codexView("[]")) else { return XCTFail("no pane offers nothing") }
        XCTAssertTrue(none.hasPrefix("No running Codex pane"))
        let twoPending = #"[{"target":"main:0.0","accountId":null,"pending":{"accountId":"a"}},{"target":"main:1.0","accountId":null,"pending":{"accountId":"b"}}]"#
        guard case .unavailable(let two) = M.codexChoices(try codexView(twoPending)) else {
            return XCTFail("two unfinished targets offer nothing")
        }
        XCTAssertTrue(two.contains("unfinished switches"))
        XCTAssertEqual(M.menu(sessionId: "s", runtime: .tmux, agent: "codex", facts: nil, claude: accounts,
                              codex: .unavailable("No running Codex pane found — start Codex in Terminal first.")).account?.note,
                       "No running Codex pane found — start Codex in Terminal first.")
    }

    /// The proxy profiles and the ACP agents run on no account pool: no Change Account, as in the F9 menu.
    func testAgentsWithoutAnAccountPoolHaveNoAccountMenu() {
        for agent in ["claude-gemini", "claude-openrouter", "grok", "antigravity", "something-new"] {
            XCTAssertNil(menu(.tmux, agent).account, agent)
            XCTAssertFalse(menu(.tmux, agent).agents.isEmpty, agent)
        }
    }

    /// A load in flight or a failed one is said in the submenu, not left empty.
    func testAccountLoadStateIsSaid() {
        XCTAssertEqual(menu(.tmux, "claude", claude: .loading).account?.note, "Loading accounts…")
        XCTAssertEqual(menu(.tmux, "claude", claude: .failed("account pool is not configured")).account?.note,
                       "Couldn't load accounts: account pool is not configured")
        XCTAssertEqual(menu(.tmux, "claude", claude: .loaded([])).account?.note, "No usable account")
    }

    /// End says what it deletes, in the CLI's words: a worktree session loses its files, a shared workspace stays.
    func testEndConfirmationSaysWhetherTheWorktreeIsDeleted() {
        XCTAssertEqual(menu(.tmux, "claude", worktree: true).end,
                       M.EndConfirmation(title: "End session dev-shop-cms?",
                                         message: "Permanent — this session's files are deleted, its branch stays."))
        XCTAssertEqual(menu(.chat, "claude", worktree: false).end?.message, "Permanent — the workspace stays.")
    }

    /// Before the live list has the session, its worktree and name are unknown: Rename and End wait.
    func testUnknownSessionDisablesRenameAndEnd() {
        let m = menu(.tmux, "claude", worktree: nil)
        XCTAssertFalse(m.canRename)
        XCTAssertNil(m.end)
        XCTAssertFalse(m.agents.isEmpty)
    }

    func testConversationCarriesOnlyWithinClaudeCode() {
        XCTAssertTrue(M.conversationCarries(from: .claude, to: .claudeOpenrouter))
        XCTAssertFalse(M.conversationCarries(from: .claude, to: .codex))
        XCTAssertFalse(M.conversationCarries(from: .codex, to: .codex))
    }

    // MARK: - Calls and their outcomes

    private func makeActions(_ handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> (MacSessionActions, SessionActions) {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test:4300")!),
                                session: URLSession(configuration: config))
        let model = MacSessionActions()
        model.attach(client: client, live: nil)
        model.codexPollInterval = .milliseconds(1)
        return (model, SessionActions(client: client))
    }

    private func body(_ request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func item(runtime: String = "tmux", agent: String = "claude") throws -> InboxItem {
        let json: [String: Any] = ["sessionId": "dev-shop-cms", "runtime": runtime, "title": "shop/cms", "project": "shop", "repo": "cms",
                                   "agent": agent, "attention": ["section": "idle", "since": 0]]
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// End never runs from the menu: it opens the confirmation, and only `confirm()` posts it.
    func testEndAsksBeforeItPosts() async throws {
        let (model, _) = makeActions { _ in .init(statusCode: 204) }
        model.requestEnd(try item(), M.EndConfirmation(title: "End session dev-shop-cms?", message: "Permanent — x."), worktree: true)
        guard case .job(let job)? = model.sheet, case .confirm = job.phase else { return XCTFail("End did not ask first") }
        XCTAssertTrue(job.destructive)
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 0)

        await model.confirm()?.value
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-shop-cms/end")
        XCTAssertEqual(body(req).count, 0, "no soloAction: devd keeps a solo workspace, as the F9 End does")
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, .init(text: "Ended — this session's files are deleted, its branch stays.", tone: .success))
    }

    /// devd still backing up (202 pending) is said, not reported as done.
    func testEndPendingIsSaid() async throws {
        let (model, _) = makeActions { _ in .init(statusCode: 202, data: Data(#"{"pending":true}"#.utf8)) }
        model.requestEnd(try item(), M.EndConfirmation(title: "End session dev-shop-cms?", message: "Permanent — x."), worktree: true)
        await model.confirm()?.value
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, .init(text: "Ending dev-shop-cms — backup queued or in progress; cleanup finishes in the background. You'll get a notification.",
                                      tone: .success))
    }

    /// Closing the sheet while a job runs stops the waiting; the outcome is unknown, not a failure.
    func testCancelledJobIsUnknown() async throws {
        let (model, _) = makeActions { req in
            req.httpMethod == "POST" ? .init(statusCode: 202, data: Data(#"{"running":true}"#.utf8))
                : .init(statusCode: 200, data: Data(#"{"accounts":[],"panes":[],"currentAccountId":null,"switching":true}"#.utf8))
        }
        model.codexPollInterval = .milliseconds(20)
        model.requestCodexAccount(try item(agent: "codex"), account: .init(id: "x", label: "X", current: false))
        let task = model.confirm()
        try await Task.sleep(for: .milliseconds(50))
        model.cancelRunning()
        await task?.value
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, MacSessionActions.unknownOutcome)
    }

    /// An error from devd lands in the sheet.
    func testAgentSwitchErrorIsShown() async throws {
        let (model, _) = makeActions { _ in .init(statusCode: 409, data: Data(#"{"error":"session is not running"}"#.utf8)) }
        model.requestAgent(try item(), to: .codex)
        guard case .job(let job)? = model.sheet else { return XCTFail("no sheet") }
        XCTAssertTrue(job.destructive, "a switch to another CLI drops the conversation")
        await model.confirm()?.value
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-shop-cms/agent")
        XCTAssertEqual(body(req)["agent"] as? String, "codex")
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, .init(text: "session is not running", tone: .failure))
    }

    func testAgentOutcomes() throws {
        func r(_ json: String) throws -> SwitchAgentResponse { try JSONDecoder().decode(SwitchAgentResponse.self, from: Data(json.utf8)) }
        XCTAssertEqual(MacSessionActions.agentOutcome(try r(#"{"ok":true,"status":"switched","panes":[{"target":"main:0.0","outcome":"restarted"}]}"#), label: "Codex"),
                       .init(text: "Switched to Codex.", tone: .success))
        XCTAssertEqual(MacSessionActions.agentOutcome(try r(#"{"ok":true,"status":"unchanged","panes":[]}"#), label: "Codex").text,
                       "Already on Codex — nothing to do.")
        XCTAssertEqual(MacSessionActions.agentOutcome(try r(#"{"ok":false,"status":"no-agent","panes":[]}"#), label: "Codex").tone, .failure)
        XCTAssertEqual(MacSessionActions.agentOutcome(try r(#"{"ok":true,"status":"switched","panes":[{"target":"main:1.0","outcome":"did-not-exit"}]}"#), label: "Codex").tone,
                       .warning)
    }

    /// A named Anthropic account goes in the body; Automatic sends none and devd picks.
    func testClaudeAccountSwitchSendsThePickedAccount() async throws {
        let ok = #"{"ok":true,"accountId":"max-b","label":"Max B","unchanged":false,"exhausted":false,"panes":[{"target":"main:0.0","outcome":"restarted"}]}"#
        let (model, _) = makeActions { _ in .init(statusCode: 200, data: Data(ok.utf8)) }
        model.requestClaudeAccount(try item(), account: .init(id: "max-b", label: "Max B", current: false))
        await model.confirm()?.value
        XCTAssertEqual(body(try XCTUnwrap(MockURLProtocol.capturedRequests.last))["accountId"] as? String, "max-b")
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, .init(text: "Switched Claude Code to Max B; the same conversations are resumed.", tone: .success))

        model.requestClaudeAccount(try item(), account: nil)
        await model.confirm()?.value
        let auto = try XCTUnwrap(MockURLProtocol.capturedRequests.last)
        XCTAssertEqual(auto.url?.path, "/api/sessions/dev-shop-cms/switch-account")
        XCTAssertNil(body(auto)["accountId"])
    }

    func testClaudeAccountOutcomes() throws {
        func r(_ json: String) throws -> SwitchAccountResponse { try JSONDecoder().decode(SwitchAccountResponse.self, from: Data(json.utf8)) }
        XCTAssertEqual(MacSessionActions.claudeAccountOutcome(try r(#"{"ok":false,"accountId":null,"label":null,"unchanged":false,"exhausted":false,"panes":[]}"#), picked: false),
                       .init(text: "No usable Anthropic account — check the dashboard (Login page).", tone: .failure))
        XCTAssertEqual(MacSessionActions.claudeAccountOutcome(try r(#"{"ok":true,"accountId":"a","label":"A","unchanged":true,"exhausted":false,"panes":[]}"#), picked: true).text,
                       "Already on A — nothing to do.")
        XCTAssertEqual(MacSessionActions.claudeAccountOutcome(try r(#"{"ok":false,"accountId":"a","label":"A","unchanged":false,"exhausted":false,"panes":[{"target":"main:0.0","outcome":"did-not-return"}]}"#), picked: true),
                       .init(text: "Account switch failed for A: main:0.0 (did-not-return).", tone: .failure))
        XCTAssertEqual(MacSessionActions.claudeAccountOutcome(try r(#"{"ok":true,"accountId":"a","label":"A","unchanged":false,"exhausted":true,"panes":[{"target":"main:0.0","outcome":"restarted"}]}"#), picked: false).tone,
                       .warning)
    }

    /// A Codex switch that outlasts devd's wait (202 running) is followed until devd reports its result.
    func testCodexSwitchFollowsABackgroundSwitch() async throws {
        let polls = Counter()
        let (model, _) = makeActions { req in
            if req.httpMethod == "POST" { return .init(statusCode: 202, data: Data(#"{"running":true}"#.utf8)) }
            return polls.next() < 2 ? .init(statusCode: 200, data: Data(#"{"accounts":[],"panes":[],"currentAccountId":null,"switching":true}"#.utf8))
                : .init(statusCode: 200, data: Data(#"{"accounts":[],"panes":[],"currentAccountId":null,"lastSwitch":{"ok":true,"accountId":"default","label":"Codex main","unchanged":false,"panes":[{"target":"main:0.0","outcome":"restarted"}]}}"#.utf8))
        }
        model.requestCodexAccount(try item(agent: "codex"), account: .init(id: "default", label: "Codex main", current: false))
        await model.confirm()?.value
        let post = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(post.url?.path, "/api/sessions/dev-shop-cms/codex-account")
        XCTAssertEqual(body(post)["accountId"] as? String, "default")
        XCTAssertGreaterThanOrEqual(polls.value, 2, "polled while switching, then read the result")
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, .init(text: "Switched Codex to Codex main; the same conversations are resumed.", tone: .success))
    }

    /// A switch that never reports back, or polls that keep failing, end as unknown (it may still finish), not failed.
    func testCodexSwitchThatNeverReportsEndsAsUnknown() async throws {
        let (_, actions) = makeActions { req in
            if req.httpMethod == "POST" { return .init(statusCode: 202, data: Data(#"{"running":true}"#.utf8)) }
            return .init(statusCode: 200, data: Data(#"{"accounts":[],"panes":[],"currentAccountId":null,"switching":true}"#.utf8))
        }
        let account = M.Choice(id: "x", label: "X", current: false)
        let stuck = try await MacSessionActions.codexSwitch(actions: actions, sessionId: "dev-shop-cms", account: account,
                                                            pollEvery: .milliseconds(5), maxWait: .milliseconds(30), progress: { _ in })
        XCTAssertEqual(stuck.tone, .warning)
        XCTAssertTrue(stuck.text.hasPrefix("The switch is still running on devd"), stuck.text)

        let (_, failing) = makeActions { req in
            req.httpMethod == "POST" ? .init(statusCode: 202, data: Data(#"{"running":true}"#.utf8)) : .init(statusCode: 502)
        }
        let lost = try await MacSessionActions.codexSwitch(actions: failing, sessionId: "dev-shop-cms", account: account,
                                                           pollEvery: .milliseconds(1), maxWait: .seconds(60), progress: { _ in })
        XCTAssertEqual(lost.tone, .warning)
        XCTAssertTrue(lost.text.hasPrefix("The switch is still running on devd"), lost.text)
    }

    func testCodexSwitchFailureIsShown() async throws {
        let (model, _) = makeActions { _ in .init(statusCode: 200, data: Data(#"{"ok":false,"accountId":"x","label":"X","unchanged":false,"panes":[],"error":"No running Codex pane"}"#.utf8)) }
        model.requestCodexAccount(try item(agent: "codex"), account: .init(id: "x", label: "X", current: false))
        await model.confirm()?.value
        guard case .job(let done)? = model.sheet, case .done(let outcome) = done.phase else { return XCTFail("no outcome") }
        XCTAssertEqual(outcome, .init(text: "Codex account switch failed: No running Codex pane.", tone: .failure))
    }

    /// Rename posts the trimmed name; an error is thrown for the sheet to show.
    func testRenamePostsTheTrimmedName() async throws {
        let (model, _) = makeActions { _ in .init(statusCode: 204) }
        try await model.rename("dev-shop-cms", to: "  billing fix ")
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.path, "/api/sessions/dev-shop-cms/name")
        XCTAssertEqual(body(req)["name"] as? String, "billing fix")
    }

    /// The account lists load on their own: the Anthropic pool failing leaves a Codex session's list usable, and the
    /// error is kept. The Codex list is the session's own.
    func testAccountListsLoadIndependently() async throws {
        let (model, _) = makeActions { req in
            if req.url?.path == "/api/accounts" { return .init(statusCode: 503, data: Data(#"{"error":"account pool is not configured"}"#.utf8)) }
            return .init(statusCode: 200, data: Data(#"{"accounts":[{"id":"default","label":"Codex main","disabled":false,"available":true,"unavailableReason":null}],"panes":[{"target":"main:0.0","accountId":"default"}],"currentAccountId":"default"}"#.utf8))
        }
        await model.loadClaudeAccounts()
        await model.loadCodexAccounts("dev-shop-cms")
        XCTAssertEqual(model.claude, .failed("account pool is not configured"))
        XCTAssertEqual(model.codex["dev-shop-cms"], .loaded([.init(id: "default", label: "Codex main", current: true)]))
        XCTAssertEqual(MockURLProtocol.capturedRequests.last?.url?.path, "/api/sessions/dev-shop-cms/codex-account")
    }
}

/// A count the mock's handler bumps from URLSession's threads.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    /// Counts one more and returns the new count.
    func next() -> Int { lock.withLock { count += 1; return count } }
}
