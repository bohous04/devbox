import XCTest
@testable import DevboxApp

/// The inbox: grouping and ordering (dashboard/src/inboxView.ts `groupInbox`), live upserts, the snooze menu's
/// times, row actions and the stream fallback.
@MainActor
final class InboxStoreTests: XCTestCase {
    private func item(_ id: String, _ section: String, since: Int, reason: String? = nil, until: Int? = nil, runtime: String = "chat") throws -> InboxItem {
        var attention: [String: Any] = ["section": section, "since": since, "reason": reason.map { $0 as Any } ?? NSNull()]
        if let until { attention["until"] = until }
        let json: [String: Any] = ["sessionId": id, "runtime": runtime, "title": "t-\(id)", "project": "p", "repo": "r", "agent": "claude",
                                   "attention": attention, "lastText": NSNull()]
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testSearchMatchesEveryWordInTitleProjectRepoBranchOrMessageIgnoringCaseAndAccents() throws {
        let json: [String: Any] = ["sessionId": "dev-acme-web", "runtime": "chat", "title": "Café menu redesign", "project": "acme",
                                   "repo": "web", "agent": "claude", "attention": ["section": "idle", "since": 0], "lastText": "Tests pass",
                                   "branch": "menu-redesign", "topic": "Fix the login redirect"]
        let i = try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertTrue(InboxView.matches(i, ""))
        XCTAssertTrue(InboxView.matches(i, "cafe ACME"))
        XCTAssertTrue(InboxView.matches(i, "tests web"))
        XCTAssertTrue(InboxView.matches(i, "menu-redesign"))
        // The topic is what the row may be titled by.
        XCTAssertTrue(InboxView.matches(i, "login redirect"))
        XCTAssertFalse(InboxView.matches(i, "cafe billing"))
    }

    func testDecodesShelvesReasonsAndUntil() throws {
        let json = #"""
        {"items":[
          {"sessionId":"a","runtime":"chat","title":"A","project":"p","repo":"r","agent":"codex","attention":{"section":"snoozed","reason":"completed","since":5,"until":99},"lastText":"hi"},
          {"sessionId":"b","runtime":"tmux","title":"B","project":"p","repo":"r","agent":"claude","attention":{"section":"settled","reason":null,"since":0},"lastText":null},
          {"sessionId":"c","runtime":"chat","title":"C","project":"p","repo":"r","agent":"claude","attention":{"section":"needs_you","reason":"ci-failed","since":1},"lastText":null},
          {"sessionId":"d","runtime":"chat","title":"D","project":"p","repo":"r","agent":"claude","attention":{"section":"working","reason":"pr-checks","since":1},"lastText":null}
        ]}
        """#
        let list = try JSONDecoder().decode(InboxList.self, from: Data(json.utf8))
        XCTAssertEqual(list.items.map(\.attention.section), [.snoozed, .settled, .needsYou, .working])
        XCTAssertEqual(list.items[0].attention.until, 99)
        XCTAssertEqual(list.items.map(\.attention.reason), [.completed, nil, .ciFailed, .prChecks])
    }

    /// A section this app does not know yet (a later devd) shows with the idle sessions rather than nowhere.
    func testUnknownSectionGroupsWithIdle() throws {
        let g = InboxView.group([try item("i1", "idle", since: 1), try item("u1", "parked", since: 2)])
        XCTAssertEqual(g.idle.map(\.sessionId), ["u1", "i1"])
    }

    func testGroupingNeedsYouOldestFirstTheRestNewestFirst() throws {
        let items = [
            try item("n1", "needs_you", since: 30), try item("n2", "needs_you", since: 10),
            try item("w1", "working", since: 1), try item("w2", "working", since: 2),
            try item("i1", "idle", since: 5), try item("s1", "snoozed", since: 1, until: 9), try item("s2", "snoozed", since: 7),
            try item("x1", "settled", since: 3), try item("x2", "settled", since: 4),
        ]
        let g = InboxView.group(items)
        XCTAssertEqual(g.needsYou.map(\.sessionId), ["n2", "n1"])
        XCTAssertEqual(g.working.map(\.sessionId), ["w2", "w1"])
        XCTAssertEqual(g.idle.map(\.sessionId), ["i1"])
        XCTAssertEqual(g.snoozed.map(\.sessionId), ["s2", "s1"])
        XCTAssertEqual(g.settled.map(\.sessionId), ["x2", "x1"])
    }

    func testUpsertReplacesAddsAndRemoves() throws {
        let a = try item("a", "idle", since: 1)
        let b = try item("b", "idle", since: 2)
        let a2 = try item("a", "needs_you", since: 3)
        var items = InboxView.upsert([a, b], .item(a2))
        XCTAssertEqual(items, [a2, b])
        items = InboxView.upsert(items, .item(try item("c", "working", since: 4)))
        XCTAssertEqual(items.map(\.sessionId), ["a", "b", "c"])
        items = InboxView.upsert(items, .removed(sessionId: "b"))
        XCTAssertEqual(items.map(\.sessionId), ["a", "c"])
    }

    func testRemovalFrameDecodes() throws {
        let c = try JSONDecoder().decode(InboxChange.self, from: Data(#"{"sessionId":"x","removed":true}"#.utf8))
        XCTAssertEqual(c, .removed(sessionId: "x"))
    }

    private func date(_ h: Int, _ m: Int) -> Date {
        var c = DateComponents()
        c.year = 2026; c.month = 11; c.day = 19; c.hour = h; c.minute = m
        return Calendar.current.date(from: c)!
    }

    func testSnoozeTimesBeforeNineIsTodayAtNine() {
        let now = date(7, 30)
        let t = InboxView.snoozeTimes(now: now)
        XCTAssertEqual(t.hour, Int(now.timeIntervalSince1970 * 1000) + 3_600_000)
        XCTAssertEqual(t.morningLabel, "9:00")
        XCTAssertEqual(t.morningAt, Int(date(9, 0).timeIntervalSince1970 * 1000))
    }

    func testSnoozeTimesFromNineIsTomorrowAtNine() {
        let t = InboxView.snoozeTimes(now: date(9, 0))
        XCTAssertEqual(t.morningLabel, "Tomorrow 9:00")
        XCTAssertEqual(t.morningAt, Int(date(9, 0).addingTimeInterval(86_400).timeIntervalSince1970 * 1000))
    }

    func testShelfBlockAndReasonLabels() throws {
        XCTAssertEqual(InboxView.shelfBlock(try item("a", "needs_you", since: 1, reason: "request")), "Answer the open request first")
        XCTAssertNil(InboxView.shelfBlock(try item("a", "needs_you", since: 1, reason: "failed")))
        XCTAssertEqual(InboxView.reasonLabel(.ciFailed), "CI failed")
        XCTAssertEqual(InboxView.reasonLabel(.rateLimited), "rate limit reached — wait or switch model")
        XCTAssertEqual(InboxView.reasonLabel(.prChecks), "waiting for CI checks")
        XCTAssertEqual(InboxView.reasonLabel(nil), "")
    }

    // MARK: - Store over devd

    private func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test")!),
                          session: URLSession(configuration: config))
    }

    private func itemJSON(_ id: String, _ section: String) -> String {
        #"{"sessionId":"\#(id)","runtime":"chat","title":"T","project":"p","repo":"r","agent":"claude","attention":{"section":"\#(section)","reason":null,"since":1},"lastText":null}"#
    }

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    func testStreamOpenLoadsTheListThenInboxFramesUpdateIt() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(#"{"items":[\#(self.itemJSON("a", "idle"))]}"#.utf8)) }
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = InboxStore(client: client(), connect: { path, _ in
            XCTAssertEqual(path, "/api/stream")
            return AsyncThrowingStream { feed = $0 }
        })
        store.start()
        try await waitUntil { store.items?.count == 1 }
        for l in ["event: inbox", "data: \(itemJSON("b", "needs_you"))", ""] { feed?.yield(l) }
        try await waitUntil { store.items?.count == 2 }
        XCTAssertEqual(store.items?.last?.attention.section, .needsYou)
        for l in ["event: inbox", "data: {broken", ""] { feed?.yield(l) }
        try await waitUntil { store.badFrame != nil }
        store.stop()
    }

    /// A frame that arrives while the list is being fetched must survive the fetched (older) list.
    func testFrameDuringReloadIsKeptOverTheFetchedList() async throws {
        let gate = DispatchSemaphore(value: 0)
        MockURLProtocol.handler = { _ in
            _ = gate.wait(timeout: .now() + 3)
            return .init(statusCode: 200, data: Data(#"{"items":[\#(self.itemJSON("a", "idle"))]}"#.utf8))
        }
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = InboxStore(client: client(), connect: { _, _ in AsyncThrowingStream { feed = $0 } })
        store.items = [try item("a", "idle", since: 1)]
        store.start()
        try await waitUntil { feed != nil && !MockURLProtocol.capturedRequests.isEmpty }
        for l in ["event: inbox", "data: \(itemJSON("a", "needs_you"))", ""] { feed?.yield(l) }
        try await waitUntil { store.items?.first?.attention.section == .needsYou }
        gate.signal()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(store.items?.first?.attention.section, .needsYou)
        store.stop()
    }

    func testStreamDropPausesAndPolls() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(#"{"items":[]}"#.utf8)) }
        let store = InboxStore(client: client(), connect: { _, _ in throw URLError(.networkConnectionLost) }, pollInterval: .milliseconds(20))
        store.start()
        try await waitUntil { store.paused && MockURLProtocol.capturedRequests.count >= 2 }
        XCTAssertEqual(store.items, [])
        store.stop()
    }

    func testRowActionsHitDevdAndUpsertTheAnswer() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/a/snooze-reset" { return .init(statusCode: 200, data: Data(#"{"reason":"no active usage limit"}"#.utf8)) }
            if req.url?.path == "/api/sessions/a/settle" { return .init(statusCode: 409, data: Data(#"{"error":"request-open","message":"Answer the open request first: a session waiting for you cannot be settled or snoozed"}"#.utf8)) }
            return .init(statusCode: 200, data: Data(self.itemJSON("a", "snoozed").utf8))
        }
        let store = InboxStore(client: client(), connect: { _, _ in AsyncThrowingStream { _ in } })
        store.items = [try item("a", "idle", since: 1)]
        try await store.snooze("a", until: 123)
        XCTAssertEqual(store.items?.first?.attention.section, .snoozed)
        let reset = try await store.snoozeReset("a")
        XCTAssertEqual(reset, .reason("no active usage limit"))
        do {
            try await store.settle("a")
            XCTFail("expected 409")
        } catch {
            XCTAssertEqual(chatErrorText(error), "Answer the open request first: a session waiting for you cannot be settled or snoozed")
        }
        try await store.snoozeUntilReset("a")
        try await store.unsettle("a")
        let paths = MockURLProtocol.capturedRequests.map { "\($0.httpMethod!) \($0.url!.path)" }
        XCTAssertEqual(paths, ["POST /api/sessions/a/snooze", "GET /api/sessions/a/snooze-reset", "POST /api/sessions/a/settle",
                               "POST /api/sessions/a/snooze", "POST /api/sessions/a/unsettle"])
    }
}


/// Ended sessions' transcripts on the Settled shelf (dashboard/src/endedView.ts).
@MainActor
final class EndedSessionTests: XCTestCase {
    private func endedJSON(_ id: String, endedAt: Int, title: String = "acme/app", topic: String? = nil, mode: String = "handoff") -> String {
        let t = topic.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"\#(id)","sessionId":"dev-acme-app","runtime":"chat","title":"\#(title)","folder":"acme","project":"acme","repo":"app","agent":"claude","branch":"feat/x","topic":\#(t),"lastText":null,"endedAt":\#(endedAt),"continueMode":"\#(mode)"}"#
    }

    private func ended(_ id: String, endedAt: Int, title: String = "acme/app", topic: String? = nil, mode: String = "handoff") throws -> EndedSession {
        try JSONDecoder().decode(EndedSession.self, from: Data(endedJSON(id, endedAt: endedAt, title: title, topic: topic, mode: mode).utf8))
    }

    private func settled(_ id: String, since: Int) throws -> InboxItem {
        let json = #"{"sessionId":"\#(id)","runtime":"chat","title":"T","project":"p","repo":"r","agent":"claude","attention":{"section":"settled","reason":null,"since":\#(since)},"lastText":null}"#
        return try JSONDecoder().decode(InboxItem.self, from: Data(json.utf8))
    }

    func testFramesDecodeAndUpsert() throws {
        let a = try ended("a", endedAt: 1)
        let change = try JSONDecoder().decode(EndedChange.self, from: Data(endedJSON("b", endedAt: 2).utf8))
        var list = InboxView.upsertEnded([a], change)
        XCTAssertEqual(list.map(\.id), ["a", "b"])
        list = InboxView.upsertEnded(list, try JSONDecoder().decode(EndedChange.self, from: Data(#"{"id":"a","removed":true}"#.utf8)))
        XCTAssertEqual(list.map(\.id), ["b"])
    }

    func testSettledShelfMixesTranscriptsNewestFirstAndCountsThem() throws {
        let g = InboxView.group([try settled("s-old", since: 1), try settled("s-new", since: 30)])
        let shelf = try XCTUnwrap(InboxView.shelves(g, ended: [try ended("e-mid", endedAt: 20), try ended("e-new", endedAt: 40)]).last)
        XCTAssertEqual(shelf.label, "Settled")
        XCTAssertEqual(shelf.count, 4)
        XCTAssertEqual(shelf.rows.map(\.id), ["ended:e-new", "s-new", "ended:e-mid", "s-old"])
        // Transcripts alone still make a Settled shelf.
        XCTAssertEqual(InboxView.shelves(InboxView.group([]), ended: [try ended("e", endedAt: 1)]).map(\.label), ["Settled"])
    }

    func testRowWordsAndTheButtonLabel() throws {
        XCTAssertEqual(InboxView.endedTitle(try ended("e", endedAt: 1, title: "Login fix")), "Login fix")
        XCTAssertEqual(InboxView.endedTitle(try ended("e", endedAt: 1, topic: "Fix the login form")), "Fix the login form")
        XCTAssertEqual(InboxView.endedSecondLine(try ended("e", endedAt: 1)), "acme/app · feat/x")
        XCTAssertEqual(InboxView.continueLabel(.resume), "Continue in a new session (resume)")
        XCTAssertEqual(InboxView.continueLabel(.handoff), "Start a new session with this chat (handoff)")
        XCTAssertEqual(InboxView.endedId(fromTag: InboxView.endedTag("dev-a-1")), "dev-a-1")
        XCTAssertNil(InboxView.endedId(fromTag: "dev-a"))
        XCTAssertEqual(ImagePrep.endedAttachmentPath(endedId: "dev-a-1", path: "/inbox/dev-a/0b4e.png"), "/api/ended/dev-a-1/attachments/0b4e.png")
    }

    private func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test")!),
                          session: URLSession(configuration: config))
    }

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    func testTheStoreLoadsTranscriptsFollowsTheirFramesAndHides() async throws {
        MockURLProtocol.handler = { req in
            switch req.url?.path {
            case "/api/ended": return .init(statusCode: 200, data: Data(#"{"items":[\#(self.endedJSON("a", endedAt: 1))]}"#.utf8))
            case "/api/ended/a/hide": return .init(statusCode: 204, data: Data())
            default: return .init(statusCode: 200, data: Data(#"{"items":[]}"#.utf8))
            }
        }
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = InboxStore(client: client(), connect: { _, _ in AsyncThrowingStream { feed = $0 } })
        store.start()
        try await waitUntil { store.ended.count == 1 }
        for l in ["event: inbox-ended", "data: \(endedJSON("b", endedAt: 2))", ""] { feed?.yield(l) }
        try await waitUntil { store.ended.count == 2 }
        try await store.hideEnded("a")
        XCTAssertEqual(store.ended.map(\.id), ["b"])
        XCTAssertTrue(MockURLProtocol.capturedRequests.contains { $0.httpMethod == "POST" && $0.url?.path == "/api/ended/a/hide" })
        store.stop()
    }
}

/// Polls `cond` on the main actor for up to 2 s (stream callbacks arrive asynchronously).
@MainActor
func waitUntil(_ cond: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
    for _ in 0..<200 {
        if cond() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("condition not met within 2 s", file: file, line: line)
}
