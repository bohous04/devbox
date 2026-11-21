import XCTest
@testable import DevboxApp

/// The Mac New Session sheet's rules (MacNewSession.swift): what the primary button does, and how devd's open progress
/// (`GET /api/open-progress`) becomes the stepped bar. The progress numbers port cli/src/format.ts.
@MainActor
final class MacNewSessionTests: XCTestCase {
    private typealias N = MacNewSession

    /// No session on the repo: Create (devd starts one). With one: Open Existing reuses it, Create makes another.
    func testPrimaryActionSaysWhatItDoes() {
        XCTAssertEqual(N.action(hasExisting: false, mode: .openExisting), .init(label: "Create", fresh: nil, creates: true))
        XCTAssertEqual(N.action(hasExisting: false, mode: .create), .init(label: "Create", fresh: nil, creates: true))
        XCTAssertEqual(N.action(hasExisting: true, mode: .openExisting), .init(label: "Open Existing", fresh: nil, creates: false))
        XCTAssertEqual(N.action(hasExisting: true, mode: .create), .init(label: "Create", fresh: true, creates: true))
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
