import XCTest
@testable import DevboxApp

/// The changed-files card's logic (dashboard changesView.ts / diffView.ts) and its store.
@MainActor
final class ChangesTests: XCTestCase {
    private func file(_ path: String, _ status: ChangeStatus = .modified, _ a: Int? = 1, _ r: Int? = 0) -> ChangedFile {
        ChangedFile(path: path, status: status, added: a, removed: r)
    }

    func testTitleStatAndIncompleteCounts() {
        var c = SessionChanges(base: "origin/main", files: [file("a.ts")], totals: .init(files: 1, added: 1, removed: 0))
        XCTAssertEqual(ChangesView.title(c), "1 changed file")
        c.totals.files = 3
        XCTAssertEqual(ChangesView.title(c), "3 changed files")
        XCTAssertFalse(ChangesView.countsIncomplete(c))
        c.countsCapped = true
        XCTAssertTrue(ChangesView.countsIncomplete(c))
        c.countsCapped = nil; c.countsUnavailable = true
        XCTAssertTrue(ChangesView.countsIncomplete(c))
        XCTAssertNil(ChangesView.stat(file("bin.png", .added, nil, nil)))
        XCTAssertEqual(ChangesView.stat(file("a.ts", .modified, 4, 2))?.added, 4)
    }

    func testGroupsByFolderInFirstSeenOrder() {
        let groups = ChangesView.groupByFolder([
            file("src/a.ts", .modified, 3, 1), file("README.md", .modified, 1, 1),
            file("src/b.ts", .added, 5, 0), file("src/img.png", .added, nil, nil),
        ])
        XCTAssertEqual(groups.map(\.dir), ["src/", ""])
        XCTAssertEqual(groups[0].files.map(\.path), ["src/a.ts", "src/b.ts", "src/img.png"])
        XCTAssertEqual(groups[0].added, 8)
        XCTAssertEqual(groups[0].removed, 1)
        XCTAssertEqual(ChangesView.splitPath("src/sync/queue.ts").dir, "src/sync/")
        XCTAssertEqual(ChangesView.splitPath("queue.ts").name, "queue.ts")
    }

    func testAnchorIsTheLatestFinishedRunsLastAnswer() {
        func item(_ seq: Int, _ kind: ThreadItem.Kind, _ run: String) -> ThreadItem {
            ThreadItem(seq: seq, runId: run, itemId: "i\(seq)", kind: kind, text: "x", ts: 0)
        }
        func run(_ id: String, _ status: RunRow.Status, ended: Int?) -> RunRow {
            RunRow(runId: id, origin: .user, status: status, endedAt: ended, endedSeq: ended)
        }
        let items = [item(1, .user, "r1"), item(2, .assistant, "r1"), item(3, .assistant, "r1"), item(4, .user, "r2"), item(5, .assistant, "r2")]
        let rows = items.enumerated().map { ChatRow(id: $0, item: $1, pending: nil, queued: false, critic: false) }
        XCTAssertEqual(ChangesView.anchor(rows, runs: [run("r1", .completed, ended: 3), run("r2", .failed, ended: 6)]),
                       ChangesAnchor(rowId: 4, endedSeq: 6))
        XCTAssertEqual(ChangesView.anchor(rows, runs: [run("r1", .completed, ended: 3)]), ChangesAnchor(rowId: 2, endedSeq: 3))
        // A newer turn is coming: no card until it ends.
        XCTAssertNil(ChangesView.anchor(rows, runs: [run("r1", .completed, ended: 3), run("r2", .running, ended: nil)]))
        XCTAssertNil(ChangesView.anchor(rows, runs: []))
    }

    func testParsesUnifiedDiffWithLineNumbers() {
        let diff = """
        diff --git a/x.ts b/x.ts
        index 1..2 100644
        --- a/x.ts
        +++ b/x.ts
        @@ -10,3 +10,3 @@ export
         keep
        -old
        +new
        +--- not a header
        \\ No newline at end of file

        """
        let lines = DiffView.parse(diff)
        XCTAssertEqual(lines.map(\.kind), [.hunk, .ctx, .del, .add, .add, .note])
        XCTAssertEqual(lines[1], DiffLine(kind: .ctx, text: "keep", old: 10, new: 10))
        XCTAssertEqual(lines[2], DiffLine(kind: .del, text: "old", old: 11, new: nil))
        XCTAssertEqual(lines[3], DiffLine(kind: .add, text: "new", old: nil, new: 11))
        XCTAssertEqual(lines[4].text, "--- not a header")
    }

    func testEscapesInvisibleAndDirectionCharacters() {
        // Zero-width space, a right-to-left override and a bidi isolate are shown; a tab stays.
        XCTAssertEqual(DiffView.escapeInvisible("a\u{200B}b\t\u{202E}c\u{2066}"), [
            .init(text: "a", escaped: false), .init(text: "\\u200b", escaped: true), .init(text: "b\t", escaped: false),
            .init(text: "\\u202e", escaped: true), .init(text: "c", escaped: false), .init(text: "\\u2066", escaped: true),
        ])
        // A combining accent on a letter renders (NFD); one after a space has no base and is escaped.
        XCTAssertEqual(DiffView.escapeInvisible("e\u{0301}"), [.init(text: "e\u{0301}", escaped: false)])
        XCTAssertEqual(DiffView.escapeInvisible(" \u{0301}"), [.init(text: " ", escaped: false), .init(text: "\\u0301", escaped: true)])
        XCTAssertEqual(DiffView.escapeInvisible("x\u{E0001}"), [.init(text: "x", escaped: false), .init(text: "\\u{e0001}", escaped: true)])
    }

    func testShortURLAndCodeOnlyCells() {
        XCTAssertEqual(ChatMarkdownParse.shortURL("https://example.com/docs"), "https://example.com/docs")
        let long = ChatMarkdownParse.shortURL("https://example.com/docs/sync/offline-queue/retry-and-backoff#drain-order")
        XCTAssertEqual(long.count, 34)
        XCTAssertTrue(long.hasPrefix("example.com/docs/"))
        XCTAssertTrue(long.hasSuffix("#drain-order"))
        XCTAssertTrue(ChatMarkdownParse.linkBareURLs("see https://example.com/docs/sync/offline-queue/retry-and-backoff")
            .contains("](https://example.com/docs/sync/offline-queue/retry-and-backoff)"))
        XCTAssertTrue(ChatMarkdownParse.isCodeOnly(" `bun test src/a.ts` "))
        XCTAssertFalse(ChatMarkdownParse.isCodeOnly("`a` and `b`"))
        XCTAssertFalse(ChatMarkdownParse.isCodeOnly("run `a`"))
        XCTAssertEqual(ToolCallView.firstLine("\n  error TS5112: no\nmore"), "error TS5112: no")
        XCTAssertNil(ToolCallView.firstLine(" \n"))
    }

    func testLimiterRunsAtMostFourAtOnceInCallOrder() async {
        let limiter = AsyncLimiter(4)
        var gates: [Int: CheckedContinuation<Void, Never>] = [:]
        var running = 0, peak = 0
        var started: [Int] = []
        var tasks: [Task<Void, Never>] = []
        for i in 0..<6 {
            tasks.append(Task { @MainActor in
                await limiter.run {
                    running += 1; peak = max(peak, running); started.append(i)
                    await withCheckedContinuation { gates[i] = $0 }
                    running -= 1
                }
            })
            await Task.yield()
        }
        func settle() async { for _ in 0..<20 { await Task.yield() } }
        await settle()
        XCTAssertEqual(started, [0, 1, 2, 3], "two wait while four run")
        gates[1]!.resume()
        await settle()
        XCTAssertEqual(started, [0, 1, 2, 3, 4], "a finished one lets the next waiting one in")
        for i in [0, 2, 3, 4] { gates[i]!.resume() }
        await settle()
        gates[5]!.resume()
        for t in tasks { await t.value }
        XCTAssertEqual(started, [0, 1, 2, 3, 4, 5])
        XCTAssertEqual(peak, 4)
    }

    // MARK: store

    private func makeStore(_ handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> ChangesStore {
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.invalid")!),
                                session: URLSession(configuration: config))
        return ChangesStore(sessionId: "dev-acme-web", client: client)
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testNoCommitsAndCleanWorktreeShowNoCard() async {
        let store = makeStore { _ in .init(statusCode: 409, data: Data(#"{"error":"the repository has no commits","code":"no_commits"}"#.utf8)) }
        await store.load()
        XCTAssertEqual(store.state, .none)

        let clean = makeStore { _ in .init(statusCode: 200, data: Data(#"{"base":"HEAD","files":[],"totals":{"files":0,"added":0,"removed":0}}"#.utf8)) }
        await clean.load()
        XCTAssertEqual(clean.state, .none)

        // The same 409 with another code is an error the card shows.
        let other = makeStore { _ in .init(statusCode: 409, data: Data(#"{"error":"repository has no commits yet","code":"root_owned"}"#.utf8)) }
        await other.load()
        guard case .failed = other.state else { return XCTFail("only no_commits hides the card, got \(other.state)") }

        let failing = makeStore { _ in .init(statusCode: 500, data: Data(#"{"error":"boom"}"#.utf8)) }
        await failing.load()
        guard case .failed = failing.state else { return XCTFail("a server error is shown, got \(failing.state)") }
    }

    func testDiffIsFetchedOnceAndAFailureIsNotCached() async throws {
        var fail = true
        let store = makeStore { req in
            if fail { return .init(statusCode: 500, data: Data(#"{"error":"boom"}"#.utf8)) }
            return .init(statusCode: 200, data: Data(#"{"path":"src/a b.ts","status":"modified","base":"origin/main","binary":false,"truncated":false,"diff":""}"#.utf8))
        }
        do { _ = try await store.diff("src/a b.ts"); XCTFail("expected the failure") } catch {}
        fail = false
        _ = try await store.diff("src/a b.ts")
        _ = try await store.diff("src/a b.ts")
        let diffs = MockURLProtocol.capturedRequests.filter { $0.url?.path.hasSuffix("/changes/diff") == true }
        XCTAssertEqual(diffs.count, 2, "the failed fetch and one successful one; the second open is cached")
        XCTAssertEqual(diffs.last?.url?.query, "path=src%2Fa%20b.ts")
    }
}
