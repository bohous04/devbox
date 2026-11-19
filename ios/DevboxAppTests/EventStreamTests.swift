import XCTest
@testable import DevboxApp

/// devd's SSE stream (`GET /api/stream`, devd/src/threadApi.ts): line splitting, frame parsing and the reconnect
/// with `Last-Event-ID`.
@MainActor
final class EventStreamTests: XCTestCase {
    private func parse(_ lines: [String]) -> (events: [SSEParser.Event], parser: SSEParser) {
        var p = SSEParser()
        var out: [SSEParser.Event] = []
        for l in lines { if let e = p.feed(l) { out.append(e) } }
        return (out, p)
    }

    func testFramesWithEventIdAndDataAreDispatchedOnTheBlankLine() {
        let r = parse([": open", "", "event: thread", "id: 7", "data: {\"seq\":7}", "", "event: inbox", "data: {}", ""])
        XCTAssertEqual(r.events, [
            .init(name: "thread", data: "{\"seq\":7}", id: "7"),
            // An event without its own id keeps the last one (EventSource semantics).
            .init(name: "inbox", data: "{}", id: "7"),
        ])
        XCTAssertEqual(r.parser.lastEventId, "7")
    }

    func testMultiLineDataIsJoinedWithNewlines() {
        let r = parse(["event: thread-notice", "data: first", "data:second", "data:  third", ""])
        XCTAssertEqual(r.events, [.init(name: "thread-notice", data: "first\nsecond\n third", id: nil)])
    }

    func testCommentsAndFramesWithoutDataDispatchNothing() {
        let r = parse([": open", "", "event: ping", "", ":keepalive", ""])
        XCTAssertEqual(r.events, [])
        XCTAssertNil(r.parser.lastEventId)
    }

    func testDefaultEventNameIsMessageAndAFieldWithoutColonHasAnEmptyValue() {
        let r = parse(["data", "", "data: x", "id", ""])
        // "data" alone = an empty data line; "id" alone resets the id to empty.
        XCTAssertEqual(r.events, [.init(name: "message", data: "", id: nil), .init(name: "message", data: "x", id: "")])
    }

    func testLineSplitterHandlesLfCrlfAndLoneCr() {
        var s = LineSplitter()
        var lines: [String] = []
        for b in Array("a\nb\r\n\r\nc\rd\n".utf8) { if let l = s.feed(b) { lines.append(l) } }
        XCTAssertEqual(lines, ["a", "b", "", "c", "d"])
    }

    func testLineSplitterDecodesUtf8AcrossBytes() {
        var s = LineSplitter()
        var lines: [String] = []
        for b in Array("data: Žluťoučký kůň\n".utf8) { if let l = s.feed(b) { lines.append(l) } }
        XCTAssertEqual(lines, ["data: Žluťoučký kůň"])
    }

    /// After the stream drops, the next connect carries the last id it saw (devd replays from there).
    func testReconnectSendsTheLastEventId() async throws {
        var connects: [String?] = []
        var events: [SSEParser.Event] = []
        let reconnected = expectation(description: "second connect")
        var opens = 0
        var drops = 0
        let stream = EventStream(
            connect: { lastId in
                connects.append(lastId)
                if connects.count == 1 {
                    return AsyncThrowingStream { c in
                        for l in [": open", "", "event: thread-snapshot", "id: 5", "data: {}", "", "event: thread", "id: 7", "data: {}", ""] { c.yield(l) }
                        c.finish()
                    }
                }
                reconnected.fulfill()
                return AsyncThrowingStream { _ in } // stays open
            },
            retryDelay: .zero,
            onOpen: { opens += 1 },
            onEvent: { events.append($0) },
            onDrop: { _ in drops += 1 }
        )
        stream.start()
        await fulfillment(of: [reconnected], timeout: 2)
        stream.stop()
        XCTAssertEqual(connects, [nil, "7"])
        XCTAssertEqual(events.map(\.name), ["thread-snapshot", "thread"])
        XCTAssertEqual(opens, 2)
        XCTAssertEqual(drops, 1)
    }

    /// A failed connect is reported and retried; the id survives it.
    func testFailedConnectIsReportedAndRetried() async throws {
        var connects = 0
        var dropErrors: [String] = []
        let third = expectation(description: "third connect")
        let stream = EventStream(
            connect: { _ in
                connects += 1
                if connects == 2 { throw DevdHTTPError(statusCode: 502) }
                if connects == 3 { third.fulfill(); return AsyncThrowingStream { _ in } }
                return AsyncThrowingStream { c in c.finish() }
            },
            retryDelay: .zero,
            onOpen: {},
            onEvent: { _ in },
            onDrop: { e in dropErrors.append(e.map { String(describing: $0) } ?? "closed") }
        )
        stream.start()
        await fulfillment(of: [third], timeout: 2)
        stream.stop()
        XCTAssertEqual(dropErrors, ["closed", "HTTP 502"])
    }

    /// The owner (a screen's store) went away without stop(): the open connection ends with it.
    func testReleasedStreamEndsItsConnection() async throws {
        let ended = expectation(description: "connection ended")
        var opened = false
        var stream: EventStream? = EventStream(
            connect: { _ in
                opened = true
                return AsyncThrowingStream { c in c.onTermination = { _ in ended.fulfill() } }
            },
            retryDelay: .zero, onOpen: {}, onEvent: { _ in }, onDrop: { _ in }
        )
        stream?.start()
        try await waitUntil { opened }
        stream = nil
        await fulfillment(of: [ended], timeout: 2)
    }

    /// A connect that throws CancellationError (its owner is gone) ends the loop instead of retrying.
    func testCancellationFromConnectEndsTheLoop() async throws {
        var connects = 0
        var drops = 0
        let stream = EventStream(
            connect: { _ in connects += 1; throw CancellationError() },
            retryDelay: .zero, onOpen: {}, onEvent: { _ in }, onDrop: { _ in drops += 1 }
        )
        stream.start()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(connects, 1)
        XCTAssertEqual(drops, 0)
        XCTAssertFalse(stream.isRunning)
    }
}

/// `DevdClient.streamLines`: the stream request carries the CF headers, Last-Event-ID and a timeout above devd's
/// 25 s ping; the body arrives as lines, blank ones included.
final class DevdClientStreamTests: XCTestCase {
    private let cfBase = URL(string: "https://cf.example.com")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        config.timeoutIntervalForRequest = 8
        return DevdClient(endpoints: DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1", tailnetBase: nil),
                          session: URLSession(configuration: config))
    }

    func testStreamLinesSendsHeadersAndYieldsBlankLines() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(": open\n\nevent: inbox\ndata: {}\n\n".utf8)) }
        var lines: [String] = []
        for try await l in try await client().streamLines("/api/stream?session=s1&afterSeq=3", lastEventId: "9") { lines.append(l) }
        XCTAssertEqual(lines, [": open", "", "event: inbox", "data: {}", ""])
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.url?.absoluteString, "https://cf.example.com/api/stream?session=s1&afterSeq=3")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Last-Event-ID"), "9")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(req.value(forHTTPHeaderField: "CF-Access-Client-Id"), "id-1")
        XCTAssertEqual(req.timeoutInterval, 60)
    }

    func testStreamLinesWithoutLastEventIdSendsNoHeader() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data()) }
        for try await _ in try await client().streamLines("/api/stream", lastEventId: nil) {}
        XCTAssertNil(MockURLProtocol.capturedRequests.first?.value(forHTTPHeaderField: "Last-Event-ID"))
    }

    func testStreamLinesWithEmptyLastEventIdSendsNoHeader() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data()) }
        for try await _ in try await client().streamLines("/api/stream", lastEventId: "") {}
        XCTAssertNil(MockURLProtocol.capturedRequests.first?.value(forHTTPHeaderField: "Last-Event-ID"))
    }

    /// A dead active path while a chat is open: the connect tries the other path once and keeps it active.
    func testStreamConnectFallsBackToTheOtherPathOnce() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.host == "cf.example.com" { return .init(statusCode: 0, error: URLError(.cannotConnectToHost)) }
            return .init(statusCode: 200, data: Data(": open\n\n".utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = DevdClient(endpoints: DevdEndpoints(cfBase: cfBase, cfId: "id-1", cfSecret: "secret-1",
                                                         tailnetBase: URL(string: "http://tailnet.test")!),
                                session: URLSession(configuration: config))
        var lines: [String] = []
        for try await l in try await client.streamLines("/api/stream", lastEventId: nil) { lines.append(l) }
        XCTAssertEqual(lines, [": open", ""])
        let _: InboxList = try await { () async throws -> InboxList in
            MockURLProtocol.handler = { _ in .init(statusCode: 200, data: Data(#"{"items":[]}"#.utf8)) }
            return try await client.get("/api/inbox")
        }()
        XCTAssertEqual(MockURLProtocol.capturedRequests.map { $0.url!.host! }, ["cf.example.com", "tailnet.test", "tailnet.test"])
    }

    func testStreamErrorStatusThrowsWithDevdsMessage() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8)) }
        do {
            _ = try await client().streamLines("/api/stream?session=s1", lastEventId: nil)
            XCTFail("expected an error")
        } catch let e as DevdHTTPError {
            XCTAssertEqual(e.statusCode, 409)
            XCTAssertEqual(e.serverMessage, "not-a-chat-session")
        }
    }

    func testErrorBodyMessageIsKeptNextToTheCode() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 409, data: Data(#"{"error":"bridge-too-old","message":"recreate the container"}"#.utf8)) }
        do {
            try await client().postVoid("/api/sessions/s1/thread/messages", body: ["text": "hi"])
            XCTFail("expected an error")
        } catch let e as DevdHTTPError {
            XCTAssertEqual(e.serverMessage, "bridge-too-old")
            XCTAssertEqual(e.serverDetail, "recreate the container")
        }
    }

    func testUploadSendsOctetStream() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 201, data: Data(#"{"path":"/inbox/s1/a.jpg","size":3}"#.utf8)) }
        let r: ThreadUpload = try await client().upload("/api/sessions/s1/inbox?for=thread", data: Data([1, 2, 3]))
        XCTAssertEqual(r.path, "/inbox/s1/a.jpg")
        let req = try XCTUnwrap(MockURLProtocol.capturedRequests.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
    }
}
