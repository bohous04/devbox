import AppKit
import SwiftUI
import XCTest
@testable import DevboxApp

/// The Mac New Session sheet's rules (MacNewSession.swift): the pages and what is sent, and how devd's open progress
/// (`GET /api/open-progress`) becomes the stepped bar. The progress numbers port cli/src/format.ts.
@MainActor
final class MacNewSessionTests: XCTestCase {
    private typealias N = MacNewSession

    /// acme has two projects; orchard is a flat folder (one project named after it); solo has one project of its own name
    /// and no repos.
    private let tree: [TreeProject] = try! JSONDecoder().decode([TreeProject].self, from: Data(#"""
        [{"folder":"acme","project":"shop","soloAgent":"codex","repos":[
           {"name":"web","cloneUrl":"https://git.example/acme/web.git","provider":"github","cloned":true,"bare":true,"agent":"grok"},
           {"name":"api","cloneUrl":"https://git.example/acme/api.git","provider":"github","cloned":false,"bare":null,"agent":null}]},
         {"folder":"acme","project":"tools","soloAgent":null,"repos":[]},
         {"folder":"orchard","project":"orchard","soloAgent":null,"repos":[
           {"name":"sync","cloneUrl":"https://git.example/orchard/sync.git","provider":"github","cloned":true,"bare":false,"agent":null}]}]
        """#.utf8))

    private struct Live: RepoKeyed { let id: String; let project: String; let repo: String }

    /// A folder with projects: Folder → Project → Repo → Agent, and Back retraces each page.
    func testPagesWithAProjectStep() {
        var p = N.Picks()
        XCTAssertEqual(p.page, .folder)
        XCTAssertFalse(p.back(tree: tree), "Back on the first page is the sheet's Cancel")
        p.pick("acme", tree: tree)
        XCTAssertEqual(p.page, .project)
        XCTAssertEqual(p.project, "")
        p.pick("shop", tree: tree)
        XCTAssertEqual(p.page, .repo)
        p.pick("web", tree: tree)
        XCTAssertEqual(p.page, .agent)
        XCTAssertEqual(p.agent, .grok, "the repo's remembered agent comes preselected")
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertEqual(p.page, .repo)
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertEqual(p.page, .project)
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertEqual(p.page, .folder)
        XCTAssertEqual(p.folder, "acme", "Back keeps what was picked, so its row is highlighted again")
    }

    /// A folder whose only project is itself (a flat folder) skips the Project page, forward and back.
    func testFlatFolderSkipsTheProjectPage() {
        var p = N.Picks()
        p.pick("orchard", tree: tree)
        XCTAssertEqual(p.page, .repo)
        XCTAssertEqual(p.project, "orchard")
        p.pick("sync", tree: tree)
        XCTAssertEqual(p.page, .agent)
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertEqual(p.page, .repo)
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertEqual(p.page, .folder, "Back from Repo skips the Project page too")
    }

    /// Picking another folder forgets the project and repo picked under the old one.
    func testAnotherFolderStartsOver() {
        var p = N.Picks()
        p.pick("acme", tree: tree)
        p.pick("shop", tree: tree)
        p.pick("web", tree: tree)
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertTrue(p.back(tree: tree))
        XCTAssertTrue(p.back(tree: tree))
        p.pick("orchard", tree: tree)
        XCTAssertEqual(p.project, "orchard")
        XCTAssertEqual(p.repo, "")
        XCTAssertEqual(p.page, .repo)
    }

    /// Each repo says whether it is cloned and how many sessions it has; the old layout says sessions share its files.
    func testRepoRowsCarryTheirContext() {
        var p = N.Picks()
        p.pick("acme", tree: tree)
        p.pick("shop", tree: tree)
        let sessions = [Live(id: "dev-shop-web", project: "shop", repo: "web"), Live(id: "dev-shop-web-2", project: "shop", repo: "web")]
        XCTAssertEqual(N.choices(p, tree: tree, sessions: sessions), [
            .init(value: "api", title: "api", detail: "Not cloned yet: devd clones it first"),
            .init(value: "web", title: "web", detail: "Cloned · 2 sessions"),
            .init(value: NewSessionLogic.SOLO, title: "Scratch workspace", detail: "No repo, an empty workspace"),
        ])
        var o = N.Picks()
        o.pick("orchard", tree: tree)
        XCTAssertEqual(N.choices(o, tree: tree, sessions: [Live(id: "dev-orchard-sync", project: "orchard", repo: "sync")]).first,
                       .init(value: "sync", title: "sync", detail: "Cloned · 1 session · shares its working directory"))
        XCTAssertEqual(N.choices(N.Picks(), tree: tree, sessions: [Live]()).map(\.detail), ["2 projects", "1 repo"])
        var a = N.Picks()
        a.pick("orchard", tree: tree)
        a.pick("sync", tree: tree)
        XCTAssertEqual(N.choices(a, tree: tree, sessions: [Live]()).compactMap(\.detail), [], "nothing remembered: Claude is only the default")
        p.pick("web", tree: tree)
        XCTAssertEqual(N.choices(p, tree: tree, sessions: [Live]()).filter { $0.detail != nil },
                       [.init(value: "grok", title: "Grok Build", detail: "Last used here")])
    }

    /// The values picked on the pages are the ones sent, and a session is always created: `fresh: true`, never the
    /// unset `fresh` with which devd rejoins the repo's existing session.
    func testCreateSendsThePicksAndAlwaysCreates() async throws {
        var p = N.Picks()
        p.pick("acme", tree: tree)
        p.pick("shop", tree: tree)
        p.pick("api", tree: tree)
        p.agent = .codex
        let request = try XCTUnwrap(N.request(p, tree: tree))
        XCTAssertEqual(request, .init(folder: "acme", project: "shop", repo: "api", cloneUrl: "https://git.example/acme/api.git", agent: .codex))

        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(#"""
            {"session":{"id":"dev-shop-api","folder":"acme","project":"shop","repo":"api","container":"c1","status":"running","solo":0},"created":true}
            """#.utf8)) }
        _ = try await N.create(request, actions: mockActions(), requestId: "r1")
        let sent = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(sent.url?.path, "/api/sessions")
        XCTAssertEqual(Self.body(sent) as NSDictionary, ["folder": "acme", "project": "shop", "repo": "api", "agent": "codex",
                                                          "cloneUrl": "https://git.example/acme/api.git", "fresh": true,
                                                          "requestId": "r1"] as NSDictionary)

        var s = N.Picks()
        s.pick("acme", tree: tree)
        s.pick("tools", tree: tree)
        s.pick(NewSessionLogic.SOLO, tree: tree)
        MockURLProtocol.capturedRequests = []
        _ = try await N.create(try XCTUnwrap(N.request(s, tree: tree)), actions: mockActions(), requestId: "r2")
        XCTAssertEqual(Self.body(try XCTUnwrap(MockURLProtocol.capturedRequests.first)) as NSDictionary,
                       ["folder": "acme", "project": "tools", "agent": "claude", "solo": true] as NSDictionary,
                       "a scratch workspace is always a new one; devd takes no fresh for it")
        XCTAssertNil(N.request(N.Picks(), tree: tree), "nothing to send before the Agent page")
    }

    /// Arrows move the highlight among the visible rows and stop at the ends; the filter keeps the rows that match.
    func testCursorMovesAndFilters() {
        let rows = ["alpha", "beta", "gamma", "delta"].map { N.Choice(value: $0, title: $0, detail: nil) }
        var c = N.Cursor(highlight: "beta")
        XCTAssertEqual(c.current(rows)?.value, "beta")
        c.move(1, in: rows)
        XCTAssertEqual(c.current(rows)?.value, "gamma")
        c.move(5, in: rows)
        XCTAssertEqual(c.current(rows)?.value, "delta")
        c.filter = "ta"
        XCTAssertEqual(c.visible(rows).map(\.value), ["beta", "delta"])
        XCTAssertEqual(c.current(rows)?.value, "delta")
        c.filter = "AL"
        XCTAssertEqual(c.current(rows)?.value, "alpha", "a hidden highlight falls to the first match")
        c.move(-1, in: rows)
        XCTAssertEqual(c.current(rows)?.value, "alpha")
        c.filter = "zzz"
        XCTAssertNil(c.current(rows))
    }

    /// The real sheet in an offscreen window, fed real events; `seen` follows its picks.
    private final class Host {
        let window: NSWindow
        var seen = MacNewSession.Picks()
        private let state: MacAppState

        @MainActor init(tree: [TreeProject]) throws {
            FixtureMode.requested = "demo"
            state = MacAppState(isTestRun: false, isFixtureRun: true)
            state.appModel.reloadConfiguration()
            let live = try XCTUnwrap(state.live)
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 520), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: MacNewSessionSheet(actions: SessionActions(client: try XCTUnwrap(state.appModel.client)),
                                                                  onStarted: {}, onOpen: { _ in }, tree: tree,
                                                                  onPicks: { [weak self] in self?.seen = $0 })
                .environmentObject(live))
            window.contentView = host
            window.setContentSize(host.fittingSize)
            window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            Self.spin(0.5)
        }

        @MainActor func close() {
            window.close()
            state.inbox?.stop()
            state.live?.stop()
            FixtureMode.requested = nil
        }

        static func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

        @MainActor func press(_ chars: String, _ keyCode: UInt16, flags: NSEvent.ModifierFlags = []) throws {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                                       windowNumber: window.windowNumber, context: nil, characters: chars,
                                                       charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode))
            window.sendEvent(event)
            Self.spin(0.4)
        }

        @MainActor func down() throws { try press(String(UnicodeScalar(NSDownArrowFunctionKey)!), 125, flags: [.numericPad, .function]) }
    }

    /// ↓ and Return walk the pages (skipping a flat folder's Project page), Esc goes back the same way.
    func testKeysWalkThePages() throws {
        let h = try Host(tree: tree)
        defer { h.close() }
        // Folders sort acme, orchard: ↓ highlights orchard, the flat folder.
        try h.down()
        try h.press("\r", 36)
        XCTAssertEqual(h.seen.page, .repo, "a flat folder goes straight to Repo")
        XCTAssertEqual(h.seen.folder, "orchard")
        try h.press("\r", 36)
        XCTAssertEqual(h.seen.page, .agent)
        XCTAssertEqual(h.seen.repo, "sync")
        try h.down()
        XCTAssertEqual(h.seen.agent, AgentProfiles.ids[1], "↓ on the Agent page picks the next agent")
        try h.press("\u{1b}", 53)
        XCTAssertEqual(h.seen.page, .repo)
        try h.press("\u{1b}", 53)
        XCTAssertEqual(h.seen.page, .folder, "Esc from Repo skips the Project page too")
        try h.press("\r", 36)
        XCTAssertEqual(h.seen.page, .repo, "the folder picked before is highlighted again")
    }

    /// A double click on a row picks it once: a click within the double-click interval of a page change is the second
    /// click of that double click, landing on the new page, and is not a pick there. (Synthetic clicks do not reach
    /// SwiftUI's tap gesture in an offscreen window, so the rule is tested on its own.)
    func testClickRightAfterAPageChangeIsIgnored() {
        XCTAssertFalse(N.settled(now: 100.2, pageChangedAt: 100, doubleClick: 0.5))
        XCTAssertTrue(N.settled(now: 100.5, pageChangedAt: 100, doubleClick: 0.5))
        XCTAssertTrue(N.settled(now: 3, pageChangedAt: 0, doubleClick: 0.5), "before any page change")
    }

    /// Esc first clears a typed filter, then goes back.
    func testEscClearsTheFilterFirst() throws {
        let many = try JSONDecoder().decode([TreeProject].self, from: Data(("[" + (1...9).map {
            #"{"folder":"acme","project":"p\#($0)","soloAgent":null,"repos":[]}"#
        }.joined(separator: ",") + "]").utf8))
        let h = try Host(tree: many)
        defer { h.close() }
        try h.press("\r", 36)
        XCTAssertEqual(h.seen.page, .project)
        try h.press("7", 26)
        try h.press("\u{1b}", 53)
        XCTAssertEqual(h.seen.page, .project, "the first Esc cleared the filter")
        try h.press("\u{1b}", 53)
        XCTAssertEqual(h.seen.page, .folder)
    }

    private func mockActions() -> SessionActions {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return SessionActions(client: DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test:4300")!),
                                                 session: URLSession(configuration: config)))
    }

    private static func body(_ request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func testStepsMapToStages() {
        XCTAssertEqual(N.stage(for: "clone"), .repo)
        XCTAssertEqual(N.stage(for: "fetch"), .repo)
        XCTAssertEqual(N.stage(for: "worktree"), .checkout)
        XCTAssertEqual(N.stage(for: "pull"), .pull)
        XCTAssertEqual(N.stage(for: "container"), .container)
        XCTAssertNil(N.stage(for: "something-new"))
    }

    /// cli/src/format.ts openProgressPercent; the text below is its formatOpenProgress with the bar drawn apart.
    func testPercentFollowsTheCLI() {
        XCTAssertEqual(N.percent(OpenProgress(step: "fetch")), 0)
        XCTAssertEqual(N.percent(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 50))), 40)
        XCTAssertEqual(N.percent(OpenProgress(step: "clone", clone: .init(phase: "Receiving objects", percent: 50))), 16)
        XCTAssertEqual(N.percent(OpenProgress(step: "pull")), 75)
        XCTAssertEqual(N.percent(OpenProgress(step: "container", detail: "waiting for the docker sidecar")), 90)
        XCTAssertEqual(N.percent(OpenProgress(step: "container", detail: "something else")), 85)
        XCTAssertEqual(N.percent(OpenProgress(step: "something-new")), 0)
    }

    func testStatusTextIsDevdsOwn() {
        XCTAssertEqual(N.status(OpenProgress(step: "clone", clone: .init(phase: "Receiving objects", percent: 45, detail: "3.21 GiB | 30.12 MiB/s"))),
                       "Cloning · Receiving objects · 3.21 GiB | 30.12 MiB/s")
        XCTAssertEqual(N.status(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 12))), "Checking out", "the bar carries the percentage")
        XCTAssertEqual(N.status(OpenProgress(step: "container", detail: "starting the container")), "Starting container · starting")
        XCTAssertEqual(N.status(OpenProgress(step: "something-new")), "something-new")
    }

    /// The bar and the stages never move back when a later step starts lower in its band than the last one ended.
    func testTrackerIsMonotonic() {
        // A repo's first open: the clone ends at 45 %, the checkout after it starts at 5 %.
        var t = N.Tracker()
        XCTAssertNil(t.stage)
        t.apply(OpenProgress(step: "clone", clone: .init(phase: "Checking out files", percent: 100)))
        XCTAssertEqual(t.stage, .repo)
        XCTAssertEqual(t.percent, 45)
        t.apply(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 0)))
        XCTAssertEqual(t.stage, .checkout)
        XCTAssertEqual(t.percent, 45, "the bar does not move back")
        XCTAssertEqual(t.status, "Checking out", "the text is always devd's latest")
        t.apply(OpenProgress(step: "container", detail: "starting the container"))
        XCTAssertEqual(t.stage, .container)
        t.finish()
        XCTAssertEqual(t.stage, .ready)
        XCTAssertEqual(t.percent, 100)
    }

    func testDurationFormatting() {
        XCTAssertEqual(N.duration(0), "0.0 s")
        XCTAssertEqual(N.duration(1.24), "1.2 s")
        XCTAssertEqual(N.duration(9.99), "9.9 s", "rounded down: a running count never shows 10 early")
        XCTAssertEqual(N.duration(10), "10 s")
        XCTAssertEqual(N.duration(59.9), "59 s")
        XCTAssertEqual(N.duration(125.4), "2 min 5 s")
        XCTAssertEqual(N.duration(-0.3), "0.0 s")
    }

    /// Step times are devd's: each stage sums its steps' start and end (fetch and clone are both the repo stage), the
    /// running one counts on from devd's clock at the report plus this Mac's monotonic time since, and a skipped step
    /// has none. The answer's times close them all and give the total.
    func testStageTimesComeFromDevdsClock() {
        typealias P = OpenProgress.Phase
        var t = N.Tracker()
        t.apply(OpenProgress(step: "container", detail: "starting the container",
                             phases: [P(step: "fetch", startedAt: 5_000, endedAt: 6_200), P(step: "worktree", startedAt: 6_200, endedAt: 9_000),
                                      P(step: "container", startedAt: 9_000)],
                             now: 12_000), at: 100)
        XCTAssertEqual(t.time(.repo, at: 100), .init(seconds: 1.2, running: false))
        XCTAssertEqual(t.time(.repo, at: 100)?.text, "1.2 s")
        XCTAssertEqual(t.time(.checkout, at: 100)?.text, "2.8 s")
        XCTAssertNil(t.time(.pull, at: 100), "devd skipped the pull: no time")
        XCTAssertEqual(t.time(.container, at: 100)?.text, "3.0 s…")
        XCTAssertEqual(t.time(.container, at: 105.5)?.text, "8.5 s…", "counts on by this Mac's clock since the report")
        XCTAssertEqual(t.total(at: 105.5)?.text, "12 s…")
        XCTAssertNil(t.time(.ready, at: 100))

        var done = t
        done.finish(phases: [P(step: "fetch", startedAt: 5_000, endedAt: 6_200), P(step: "worktree", startedAt: 6_200, endedAt: 9_000),
                             P(step: "container", startedAt: 9_000, endedAt: 17_400)])
        XCTAssertEqual(done.time(.container, at: 999)?.text, "8.4 s")
        XCTAssertEqual(done.total(at: 999), .init(seconds: 12.4, running: false))

        var old = t
        old.finish()
        XCTAssertNil(old.time(.container, at: 999), "no end from devd: no made-up time")
        XCTAssertEqual(old.time(.repo, at: 999)?.text, "1.2 s", "the steps devd ended keep theirs")
        XCTAssertNil(old.total(at: 999))

        // A report read on devd before the last estimate (it arrived late) does not move the count back.
        var late = t
        XCTAssertEqual(late.time(.container, at: 101)?.text, "4.0 s…")
        late.apply(OpenProgress(step: "container", phases: [P(step: "fetch", startedAt: 5_000, endedAt: 6_200),
                                                            P(step: "worktree", startedAt: 6_200, endedAt: 9_000), P(step: "container", startedAt: 9_000)],
                                now: 12_500), at: 101)
        XCTAssertEqual(late.time(.container, at: 101)?.text, "4.0 s…")
        XCTAssertEqual(late.time(.container, at: 101.5)?.text, "4.5 s…")
        // An answer without steps (it rejoined a running session) keeps the times the reports gave.
        var empty = t
        empty.finish(phases: [])
        XCTAssertEqual(empty.time(.repo, at: 999)?.text, "1.2 s")

        var older = N.Tracker()
        older.apply(OpenProgress(step: "worktree"), at: 100)
        XCTAssertNil(older.time(.checkout, at: 200), "a devd without times shows none")
        XCTAssertNil(older.total(at: 200))
    }

    /// Both fields decode from devd's JSON and are absent from an older devd.
    func testPhasesDecode() throws {
        let p = try JSONDecoder().decode(OpenProgress.self, from: Data(#"""
            {"step":"pull","phases":[{"step":"fetch","startedAt":10.5,"endedAt":900.25},{"step":"pull","startedAt":900.25}],"now":1000}
            """#.utf8))
        XCTAssertEqual(p.phases, [.init(step: "fetch", startedAt: 10.5, endedAt: 900.25), .init(step: "pull", startedAt: 900.25)])
        XCTAssertEqual(p.now, 1000)
        let r = try JSONDecoder().decode(OpenResult.self, from: Data(#"""
            {"session":{"id":"dev-shop-web","folder":"acme","project":"shop","repo":"web","container":"c1","status":"running","solo":0},
             "created":true,"phases":[{"step":"container","startedAt":1,"endedAt":2}]}
            """#.utf8))
        XCTAssertEqual(r.phases, [.init(step: "container", startedAt: 1, endedAt: 2)])
        XCTAssertNil(try JSONDecoder().decode(OpenProgress.self, from: Data(#"{"step":"pull"}"#.utf8)).phases)
    }

    /// A request that may have reached devd is not offered again (a second Create could make a duplicate).
    func testOutcomeUnknownWhenDevdMayHaveTheRequest() {
        XCTAssertTrue(N.outcomeUnknown(URLError(.timedOut)))
        XCTAssertTrue(N.outcomeUnknown(URLError(.networkConnectionLost)))
        XCTAssertTrue(N.outcomeUnknown(DevdHTTPError(statusCode: 524)))
        XCTAssertTrue(N.outcomeUnknown(DevdHTTPError(statusCode: 520)))
        // The tunnel fallback timed out after the direct path refused: the fallback's answer decides.
        XCTAssertTrue(N.outcomeUnknown(DevdClientError(description: "both paths failed", underlying: [URLError(.cannotConnectToHost), DevdHTTPError(statusCode: 524)])))
        XCTAssertFalse(N.outcomeUnknown(DevdClientError(description: "both paths failed", underlying: [URLError(.timedOut), DevdHTTPError(statusCode: 400, serverMessage: "invalid agent")])))
        XCTAssertTrue(N.outcomeUnknown(DevdClientError(description: "both paths failed", underlying: [URLError(.cannotConnectToHost), URLError(.timedOut)])))
        XCTAssertFalse(N.outcomeUnknown(DevdHTTPError(statusCode: 400, serverMessage: "invalid agent")))
        XCTAssertFalse(N.outcomeUnknown(URLError(.cannotConnectToHost)))
    }

    /// Another open of the same repo (the CLI, another window) is not shown as ours; a devd without requestId still is.
    func testTrackerShowsOnlyItsOwnOpen() {
        var t = N.Tracker()
        t.observe(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 80), requestId: "other"), requestId: "mine")
        XCTAssertNil(t.stage)
        XCTAssertEqual(t.percent, 0)
        XCTAssertEqual(t.status, "Waiting for devd (another open of this repo is running)…")
        t.observe(OpenProgress(step: "fetch", requestId: "mine"), requestId: "mine")
        XCTAssertEqual(t.stage, .repo)
        t.observe(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 50)), requestId: "mine")
        XCTAssertEqual(t.stage, .repo, "after our id showed up, a report without one is another client's")

        var old = N.Tracker()
        old.observe(OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 50)), requestId: "mine")
        XCTAssertEqual(old.stage, .checkout, "an old devd sends no requestId: its progress counts as before")
    }

    /// The request polls the repo's own progress key.
    func testOpenProgressAsksForTheRepo() async throws {
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(#"{"progress":{"step":"worktree","git":{"phase":"Updating files","percent":30}}}"#.utf8)) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let actions = SessionActions(client: DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test:4300")!),
                                                        session: URLSession(configuration: config)))
        let p = try await actions.openProgress(folder: "acme", project: "shop", repo: "cms")
        XCTAssertEqual(p, OpenProgress(step: "worktree", git: .init(phase: "Updating files", percent: 30)))
        let url = try XCTUnwrap(MockURLProtocol.capturedRequests.first?.url)
        XCTAssertEqual(url.path, "/api/open-progress")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.map(\.value), ["acme", "shop", "cms"])

        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(#"{"progress":null}"#.utf8)) }
        let none = try await actions.openProgress(folder: "acme", project: "shop", repo: "cms")
        XCTAssertNil(none)
    }
}
