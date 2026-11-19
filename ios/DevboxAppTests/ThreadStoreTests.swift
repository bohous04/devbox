import XCTest
@testable import DevboxApp

/// `ThreadView` against the shared cases in `shared/fixtures/thread-events.json` — the same file drives
/// `dashboard/src/threadView.test.ts`, so the app and the dashboard apply a thread identically.
final class ThreadStoreTests: XCTestCase {
    private struct Derived: Decodable {
        let activeRun: String?
        let queued: [String]
        let critic: [String]
    }

    private enum Step: Decodable {
        case event(LoggedEvent)
        case snapshot(ThreadSnapshotFrame)
        case notice(ThreadItem)

        private enum K: String, CodingKey { case event, snapshot, notice }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            if let e = try c.decodeIfPresent(LoggedEvent.self, forKey: .event) { self = .event(e) }
            else if let s = try c.decodeIfPresent(ThreadSnapshotFrame.self, forKey: .snapshot) { self = .snapshot(s) }
            else { self = .notice(try c.decode(ThreadItem.self, forKey: .notice)) }
        }
    }

    private struct Case: Decodable {
        let name: String
        let steps: [Step]
        let expect: ThreadSnapshot
        let derived: Derived?
    }

    private struct Fixture: Decodable { let cases: [Case] }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "thread-events", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testSharedFixtureCases() throws {
        let cases = try fixture().cases
        XCTAssertGreaterThan(cases.count, 20)
        for c in cases {
            var t = ThreadSnapshot.empty
            for step in c.steps {
                switch step {
                case .event(let e): t = ThreadView.apply(t, e)
                case .snapshot(let s): t = ThreadView.mergeSnapshot(t, s)
                case .notice(let i): t = ThreadView.applyNotice(t, i)
                }
            }
            XCTAssertEqual(t, c.expect, c.name)
            if let d = c.derived {
                XCTAssertEqual(ThreadView.activeRun(t)?.runId, d.activeRun, c.name)
                XCTAssertEqual(ThreadView.queuedRunIds(t), d.queued, c.name)
                XCTAssertEqual(ThreadView.criticRunIds(t), d.critic, c.name)
            }
        }
    }

    func testToolInputNullIsKeptAsAValue() throws {
        let json = #"{"seq":1,"ts":5,"event":{"type":"tool.started","runId":"r","itemId":"t","tool":"X","input":null}}"#
        let e = try JSONDecoder().decode(LoggedEvent.self, from: Data(json.utf8))
        let t = ThreadView.apply(.empty, e)
        XCTAssertEqual(t.items.first?.input, .null)
    }
}

/// `ThreadStore` over devd: load, stream frames, resume after the app was in the background, sending.
@MainActor
final class ThreadStoreLiveTests: XCTestCase {
    private func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test")!),
                          session: URLSession(configuration: config))
    }

    private func snapshot(lastSeq: Int, seenSeq: Int = 0, items: String = "[]", runs: String = "[]") -> Data {
        Data(#"{"lastSeq":\#(lastSeq),"seenSeq":\#(seenSeq),"runs":\#(runs),"items":\#(items),"pending":[],"background":[],"native":null}"#.utf8)
    }

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private var requests: [String] {
        MockURLProtocol.capturedRequests.map { r in
            let q = r.url!.query.map { "?\($0)" } ?? ""
            return "\(r.httpMethod!) \(r.url!.path(percentEncoded: true))\(q)"
        }
    }

    func testLoadThenStreamFromItsSeqAndApplyFrames() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/s1/thread" { return .init(statusCode: 200, data: self.snapshot(lastSeq: 5, seenSeq: 5)) }
            return .init(statusCode: 204)
        }
        var paths: [String] = []
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { path, _ in
            paths.append(path)
            return AsyncThrowingStream { feed = $0 }
        })
        await store.start()
        try await waitUntil { feed != nil }
        XCTAssertEqual(paths, ["/api/stream?session=s1&afterSeq=5"])
        let event = #"{"seq":6,"ts":1,"event":{"type":"run.queued","runId":"r1","text":"hi","attachments":[]}}"#
        let notice = #"{"seq":6,"runId":null,"itemId":"notice:1","kind":"notice","text":"Switched","status":"done","ts":2}"#
        for l in ["event: thread", "id: 6", "data: \(event)", "", "event: thread-notice", "data: \(notice)", "", "event: ping", "data: {}", ""] { feed?.yield(l) }
        try await waitUntil { store.thread?.items.count == 2 }
        XCTAssertEqual(store.thread?.lastSeq, 6)
        XCTAssertEqual(store.thread?.items.map(\.text), ["hi", "Switched"])
        for l in ["event: thread", "data: {not json", ""] { feed?.yield(l) }
        try await waitUntil { store.badFrame != nil }
        store.stop()
    }

    /// Plan review focus 3: the stream drops while the app is in the background; on return the store fetches the
    /// thread after its seq, merges it, and resubscribes from the new seq.
    func testResumeAfterBackgroundFetchesAfterSeqThenResubscribes() async throws {
        MockURLProtocol.handler = { req in
            switch (req.url?.path, req.url?.query) {
            case ("/api/sessions/s1/thread", nil): return .init(statusCode: 200, data: self.snapshot(lastSeq: 5, seenSeq: 5))
            case ("/api/sessions/s1/thread", "afterSeq=5"):
                let items = #"[{"seq":7,"runId":"r1","itemId":"m1","kind":"assistant","text":"done while away","status":"done","ts":3}]"#
                return .init(statusCode: 200, data: self.snapshot(lastSeq: 7, seenSeq: 5, items: items))
            default: return .init(statusCode: 204)
            }
        }
        var paths: [String] = []
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { path, _ in
            paths.append(path)
            return AsyncThrowingStream { _ in }
        })
        await store.start()
        try await waitUntil { paths.count == 1 }
        store.stop()
        await store.resume()
        try await waitUntil { paths.count == 2 }
        XCTAssertEqual(store.thread?.items.map(\.text), ["done while away"])
        XCTAssertEqual(store.thread?.lastSeq, 7)
        XCTAssertEqual(paths, ["/api/stream?session=s1&afterSeq=5", "/api/stream?session=s1&afterSeq=7"])
        try await waitUntil { self.requests.contains("POST /api/sessions/s1/thread/seen") }
        XCTAssertEqual(Array(requests.prefix(2)), ["GET /api/sessions/s1/thread", "GET /api/sessions/s1/thread?afterSeq=5"])
        store.stop()
    }

    func testTmuxSessionIsReportedNotStreamed() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8)) }
        var connects = 0
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in connects += 1; return AsyncThrowingStream { _ in } })
        await store.start()
        XCTAssertTrue(store.isTmux)
        XCTAssertNil(store.thread)
        XCTAssertEqual(connects, 0)
    }

    func testSendUploadsImagesThenPostsTheMessage() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/s1/inbox" { return .init(statusCode: 201, data: Data(#"{"path":"/inbox/s1/x.jpg","size":3}"#.utf8)) }
            return .init(statusCode: 202, data: Data(#"{"queued":true}"#.utf8))
        }
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in AsyncThrowingStream { _ in } })
        try await store.send(text: "look", images: [Data([1]), Data([2])])
        try await store.send(text: "plain", images: [])
        try await store.answer(requestId: "q 1", answer: "A")
        try await store.interrupt()
        XCTAssertEqual(requests, ["POST /api/sessions/s1/inbox?for=thread", "POST /api/sessions/s1/inbox?for=thread",
                                  "POST /api/sessions/s1/thread/messages", "POST /api/sessions/s1/thread/messages",
                                  "POST /api/sessions/s1/thread/requests/q%201", "POST /api/sessions/s1/thread/interrupt"])
        let bodies = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/api/sessions/s1/thread/messages" }.map(bodyJSON)
        XCTAssertEqual(bodies[0] as NSDictionary, ["text": "look", "attachments": [["path": "/inbox/s1/x.jpg"], ["path": "/inbox/s1/x.jpg"]]] as NSDictionary)
        XCTAssertEqual(bodies[1] as NSDictionary, ["text": "plain"] as NSDictionary)
    }

    func testChatErrorTextMirrorsTheComposer() {
        XCTAssertEqual(chatErrorText(DevdHTTPError(statusCode: 409, serverMessage: "agent-disconnected")), "agent not connected — message not sent")
        XCTAssertEqual(chatErrorText(DevdHTTPError(statusCode: 504, serverMessage: "agent-timeout")), "no reply from the agent — check the thread before resending")
        XCTAssertEqual(chatErrorText(DevdHTTPError(statusCode: 409, serverMessage: "bridge-too-old", serverDetail: "recreate the container")), "recreate the container")
        XCTAssertEqual(chatErrorText(DevdHTTPError(statusCode: 400, serverMessage: "text must be a non-empty string")), "text must be a non-empty string")
    }
}

/// A captured request's JSON body (URLProtocol moves it into the body stream).
func bodyJSON(_ r: URLRequest) -> [String: Any] {
    var data = r.httpBody ?? Data()
    if data.isEmpty, let stream = r.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}
