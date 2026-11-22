import XCTest
@testable import DevboxApp

/// Paths, bodies and the pure helpers against `dashboard/src/unpushedView.ts` (`MockURLProtocol` lives in
/// `DevdClientTests.swift`).
@MainActor
final class UnpushedStoreTests: XCTestCase {
    // The capture is shared: a thread store of an earlier test may still post its look (thread/seen) after it ended,
    // so each test looks for its own POST, not the first one.
    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> UnpushedStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://100.100.100.100:4300")!)
        return UnpushedStore(client: DevdClient(endpoints: endpoints, session: URLSession(configuration: config)))
    }

    private func bodyJSON(_ request: URLRequest) -> [String: Any] {
        if let data = request.httpBody { return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:] }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func commit(_ subject: String) -> UnpushedCommit { UnpushedCommit(hash: "abcdef1234", subject: subject, at: 1, author: "a") }

    private func branch(_ name: String, count: Int, commits: [UnpushedCommit] = [], upstream: String? = nil) -> UnpushedBranch {
        UnpushedBranch(branch: name, upstream: upstream, count: count, commits: commits, truncated: commits.count < count)
    }

    private func repo(_ path: String, project: String = "acme", folder: String = "work", branches: [UnpushedBranch],
                      noRemote: Bool = false, error: String? = nil, provider: String? = "github") -> UnpushedRepo {
        UnpushedRepo(folder: folder, project: project, repo: "web", path: path, bare: false, noRemote: noRemote,
                     count: branches.reduce(0) { $0 + $1.count }, branches: branches, error: error, detailsSkipped: nil,
                     remote: provider.map { UnpushedRemote(provider: $0, owner: "acme", name: "web") }, base: "main")
    }

    func testDemoFixtureDecodes() throws {
        let data = try JSONSerialization.data(withJSONObject: DashboardFixtures.unpushed(now: Date()))
        let status = try JSONDecoder().decode(UnpushedStatus.self, from: data)
        XCTAssertEqual(status.report?.total, status.report?.folders.reduce(0) { $0 + $1.count })
    }

    func testLoadAsksForAFreshScanOnlyOnRescan() async {
        let store = makeStore { _ in .init(statusCode: 200, data: #"{"report":null,"scanning":false,"error":null}"#.data(using: .utf8)!) }
        await store.load()
        await store.load(fresh: true)
        XCTAssertEqual(MockURLProtocol.capturedRequests.map { $0.url?.query }, [nil, "fresh=1"])
    }

    func testPushPostsPathAndBranchThenHidesTheBranch() async throws {
        let report = #"{"report":{"at":100,"total":1,"scanned":1,"folders":[{"folder":"work","count":1,"repos":[{"folder":"work","project":"acme","repo":"web","path":"/srv/web","bare":false,"noRemote":false,"count":1,"branches":[{"branch":"feat","upstream":null,"count":1,"commits":[],"truncated":true}]}]}]},"scanning":true,"error":null}"#
        let store = makeStore { req in
            req.httpMethod == "POST" ? .init(statusCode: 200, data: #"{"ok":true,"at":200}"#.data(using: .utf8)!)
                                     : .init(statusCode: 200, data: report.data(using: .utf8)!)
        }
        let r = repo("/srv/web", branches: [branch("feat", count: 1)])
        try await store.push(r, r.branches[0])
        store.stop()
        let post = MockURLProtocol.capturedRequests.first { $0.httpMethod == "POST" && $0.url?.path.hasPrefix("/api/unpushed/") == true }!
        XCTAssertEqual(post.url?.path, "/api/unpushed/push")
        XCTAssertEqual(bodyJSON(post) as? [String: String], ["path": "/srv/web", "branch": "feat"])
        XCTAssertEqual(store.notice?.text, "Pushed feat to origin (acme/web).")
        // The report was scanned before the push, so the pushed branch is gone from what the screen shows.
        XCTAssertEqual(store.report?.folders.count, 0)
    }

    func testCreatePrPostsTitleAndCommitBody() async throws {
        let store = makeStore { req in
            req.httpMethod == "POST" ? .init(statusCode: 200, data: #"{"url":"https://git.example.com/pr/7","number":7,"at":200}"#.data(using: .utf8)!)
                                     : .init(statusCode: 200, data: #"{"report":null,"scanning":false,"error":null}"#.data(using: .utf8)!)
        }
        let b = branch("feat", count: 2, commits: [commit("second"), commit("first")])
        let r = repo("/srv/web", branches: [b])
        try await store.createPr(r, b, title: "Ship it")
        let post = MockURLProtocol.capturedRequests.first { $0.httpMethod == "POST" && $0.url?.path.hasPrefix("/api/unpushed/") == true }!
        XCTAssertEqual(post.url?.path, "/api/unpushed/pr")
        XCTAssertEqual(bodyJSON(post) as? [String: String], ["path": "/srv/web", "branch": "feat", "title": "Ship it", "body": "- first\n- second"])
        XCTAssertEqual(store.notice, .init(text: "Pull request #7 created for feat (acme/web).", url: URL(string: "https://git.example.com/pr/7")))
    }

    func testLabelsMatchTheWeb() {
        XCTAssertEqual(UnpushedStore.shortHash("abcdef1234"), "abcdef1")
        XCTAssertEqual(UnpushedStore.branchLabel(branch("a", count: 1, upstream: "origin/a")), "a → origin/a")
        XCTAssertEqual(UnpushedStore.branchLabel(branch("a", count: 1)), "a · no upstream")
        XCTAssertEqual(UnpushedStore.upstreamLabel(branch("a", count: 1, upstream: "origin/a")), "→ origin/a")
        XCTAssertEqual(UnpushedStore.upstreamLabel(branch("a", count: 1)), "no upstream")
        XCTAssertEqual(UnpushedStore.commitsLabel(1), "1 commit")
        XCTAssertEqual(UnpushedStore.commitsLabel(5, shown: 3), "5 commits · showing 3")
        XCTAssertEqual(UnpushedStore.commitsLabel(3, shown: 3), "3 commits")
        XCTAssertEqual(UnpushedStore.repoTitle(repo("/x", project: "work", branches: [])), "web")
        XCTAssertEqual(UnpushedStore.repoTitle(repo("/x", branches: [])), "acme/web")
    }

    func testPushAndPrNeedARemoteAndAWorkingGit() {
        XCTAssertTrue(UnpushedStore.canCreatePr(repo("/x", branches: [])))
        XCTAssertFalse(UnpushedStore.canCreatePr(repo("/x", branches: [], provider: "other")))
        XCTAssertTrue(UnpushedStore.canPush(repo("/x", branches: [], provider: "other")))
        XCTAssertFalse(UnpushedStore.canPush(repo("/x", branches: [], noRemote: true)))
        XCTAssertFalse(UnpushedStore.canPush(repo("/x", branches: [], error: "boom")))
    }

    func testPrTitleAndBody() {
        XCTAssertEqual(UnpushedStore.prTitle(branch("feat", count: 1, commits: [commit("Fix it")])), "Fix it")
        XCTAssertEqual(UnpushedStore.prTitle(branch("feat", count: 2, commits: [commit("b"), commit("a")])), "feat")
        XCTAssertEqual(UnpushedStore.prBody(branch("feat", count: 3, commits: [commit("b"), commit("a")])), "- a\n- b\n\n…and 1 more commit")
    }

    func testWithoutPushedOnlyHidesBranchesPushedAfterTheScan() {
        let a = repo("/a", branches: [branch("one", count: 2), branch("two", count: 1)])
        let b = repo("/b", branches: [branch("main", count: 4)])
        let report = UnpushedReport(at: 100, total: 7, scanned: 2, folders: [UnpushedFolder(folder: "work", count: 7, repos: [a, b])])
        XCTAssertEqual(UnpushedStore.withoutPushed(report, [.init(path: "/a", branch: "one", at: 99)]), report)
        let out = UnpushedStore.withoutPushed(report, [.init(path: "/a", branch: "one", at: 100), .init(path: "/b", branch: "main", at: 150)])
        XCTAssertEqual(out.total, 1)
        XCTAssertEqual(out.folders.map(\.count), [1])
        XCTAssertEqual(out.folders[0].repos.map(\.path), ["/a"])
        XCTAssertEqual(out.folders[0].repos[0].branches.map(\.branch), ["two"])
    }
}
