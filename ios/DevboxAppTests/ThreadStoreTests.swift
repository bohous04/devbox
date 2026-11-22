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

    /// The Mac app saves open threads as JSON and reads them back after a relaunch: every fixture thread survives.
    func testThreadSnapshotRoundTripsThroughJSON() throws {
        for c in try fixture().cases {
            let back = try JSONDecoder().decode(ThreadSnapshot.self, from: JSONEncoder().encode(c.expect))
            XCTAssertEqual(back, c.expect, c.name)
        }
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

    func testSnapshotMergeTakesItsEffort() throws {
        let json = #"{"afterSeq":0,"snapshot":{"lastSeq":0,"seenSeq":0,"runs":[],"items":[],"pending":[],"background":[],"native":null,"effort":{"model":"m","supported":["low"],"effective":null,"chosen":"low"}}}"#
        let frame = try JSONDecoder().decode(ThreadSnapshotFrame.self, from: Data(json.utf8))
        XCTAssertEqual(ThreadView.mergeSnapshot(.empty, frame).effort, ThreadEffort(model: "m", supported: ["low"], effective: nil, chosen: "low"))
    }

    /// shared/fixtures/housekeeping-notices.json (dashboard/src/workGroups.test.ts runs the same lines).
    func testBridgeHousekeepingStaysOutOfTheThread() throws {
        struct Cases: Decodable { let hidden: [String]; let shown: [String] }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "housekeeping-notices", withExtension: "json"))
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: url))
        for text in cases.hidden { XCTAssertTrue(ThreadView.isHousekeeping(ThreadItem(seq: 1, runId: nil, itemId: nil, kind: .notice, text: text, ts: 1)), text) }
        for text in cases.shown { XCTAssertFalse(ThreadView.isHousekeeping(ThreadItem(seq: 1, runId: nil, itemId: nil, kind: .notice, text: text, ts: 1)), text) }
        // Only notices: a message with the same words is the conversation.
        XCTAssertFalse(ThreadView.isHousekeeping(ThreadItem(seq: 1, runId: "r", itemId: "i", kind: .assistant, text: cases.hidden[0], ts: 1)))
        let snapshot = ThreadSnapshot(lastSeq: 2, seenSeq: 0, runs: [], items: (cases.hidden + cases.shown).enumerated().map {
            ThreadItem(seq: $0.offset, runId: nil, itemId: "notice:\($0.offset)", kind: .notice, text: $0.element, ts: 1)
        }, pending: [], background: [], native: nil)
        XCTAssertEqual(ThreadView.shownItems(snapshot).map(\.text), cases.shown)
        // A hidden notice is no switch: the target is not refetched for it; a shown one still counts.
        var more = snapshot
        more.items.append(ThreadItem(seq: 99, runId: nil, itemId: "notice:99", kind: .notice, text: cases.hidden[0], ts: 1))
        XCTAssertEqual(ThreadView.switchKey(more), ThreadView.switchKey(snapshot))
        more.items.append(ThreadItem(seq: 100, runId: nil, itemId: "notice:100", kind: .notice, text: cases.shown[0], ts: 1))
        XCTAssertNotEqual(ThreadView.switchKey(more), ThreadView.switchKey(snapshot))
    }

    /// The iPhone header's state after the place: working, or how the last run ended and when; nothing before a run.
    func testHeaderRunState() throws {
        func thread(_ runs: String, pending: String = "[]", background: String = "[]") throws -> ThreadSnapshot {
            try JSONDecoder().decode(ThreadSnapshot.self, from: Data(#"{"lastSeq":1,"seenSeq":0,"runs":\#(runs),"items":[],"pending":\#(pending),"background":\#(background),"native":null}"#.utf8))
        }
        func run(_ id: String, _ status: String, ended: Int?) -> String {
            #"{"runId":"\#(id)","origin":"user","status":"\#(status)","harness":"claude","nativeThreadId":null,"model":null,"queuedAt":null,"startedAt":1,"endedAt":\#(ended.map(String.init) ?? "null"),"endedSeq":null,"usage":null,"error":null}"#
        }
        let now = 10 * 60_000
        XCTAssertNil(ThreadView.runState(try thread("[]"), now: now))
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "completed", ended: 1)),\(run("b", "running", ended: nil))]"), now: now), "Working…")
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "completed", ended: now - 3 * 60_000))]"), now: now), "Finished 3m ago")
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "completed", ended: 1)),\(run("b", "failed", ended: now))]"), now: now), "Failed now")
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "interrupted", ended: 1))]"), now: 2 * 3_600_000 + 1), "Stopped 2h ago")
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "queued", ended: nil))]"), now: now), "Queued")
        // A question waiting on the user wins, as in the inbox.
        let ask = #"[{"requestId":"q","runId":"b","kind":"question","prompt":"Which?","options":null,"multiSelect":null,"openedAt":1}]"#
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("b", "running", ended: nil))]", pending: ask), now: now), "Needs you")
        // No run, but background work going on.
        let bg = #"[{"id":"w","kind":"subagent","label":"reviewer","holding":false,"until":null}]"#
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "completed", ended: 1))]", background: bg), now: now), "Background")
        // The last run decides, even without an end time: its word alone.
        XCTAssertEqual(ThreadView.runState(try thread("[\(run("a", "completed", ended: now)),\(run("b", "failed", ended: nil))]"), now: now), "Failed")
    }

    func testANoticeKeepsItsTone() throws {
        let json = #"{"seq":3,"runId":null,"itemId":"notice:1","kind":"notice","text":"Send it again.","status":"done","ts":1,"tone":"warn"}"#
        XCTAssertTrue(try JSONDecoder().decode(ThreadItem.self, from: Data(json.utf8)).warns)
        let plain = #"{"seq":3,"runId":null,"itemId":"notice:2","kind":"notice","text":"Switched","status":"done","ts":1}"#
        XCTAssertFalse(try JSONDecoder().decode(ThreadItem.self, from: Data(plain.utf8)).warns)
    }

    func testSnapshotReadsTheUncheckedLevels() throws {
        let json = #"{"lastSeq":0,"seenSeq":0,"runs":[],"items":[],"pending":[],"background":[],"native":null,"effort":{"model":null,"supported":null,"effective":null,"chosen":"xhigh","unchecked":["low","xhigh"]}}"#
        XCTAssertEqual(try JSONDecoder().decode(ThreadSnapshot.self, from: Data(json.utf8)).effort,
                       ThreadEffort(model: nil, supported: nil, effective: nil, chosen: "xhigh", unchecked: ["low", "xhigh"]))
    }

    func testSnapshotWithAnUnreadableEffortStillLoadsWithoutIt() throws {
        for effort in [#"{"model":"m","supported":["low",null],"effective":null,"chosen":null}"#, #"{"model":"m","supported":["low"],"effective":3,"chosen":null}"#] {
            let json = #"{"lastSeq":4,"seenSeq":0,"runs":[],"items":[],"pending":[],"background":[],"native":null,"effort":"# + effort + "}"
            let s = try JSONDecoder().decode(ThreadSnapshot.self, from: Data(json.utf8))
            XCTAssertEqual(s.lastSeq, 4)
            XCTAssertNil(s.effort)
        }
        // A devd from before effort: no key at all.
        let old = #"{"lastSeq":1,"seenSeq":0,"runs":[],"items":[],"pending":[],"background":[],"native":null}"#
        XCTAssertNil(try JSONDecoder().decode(ThreadSnapshot.self, from: Data(old.utf8)).effort)
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
        // The agent's effort: its own event, no seq; null clears it.
        let effort = #"{"model":"gpt-6.1-sol","supported":["low","high"],"effective":"high","chosen":"high"}"#
        for l in ["event: thread-effort", "data: \(effort)", ""] { feed?.yield(l) }
        try await waitUntil { store.thread?.effort != nil }
        XCTAssertEqual(store.thread?.effort, ThreadEffort(model: "gpt-6.1-sol", supported: ["low", "high"], effective: "high", chosen: "high"))
        XCTAssertEqual(store.thread?.lastSeq, 6)
        for l in ["event: thread-effort", "data: null", ""] { feed?.yield(l) }
        try await waitUntil { store.thread?.effort == nil }
        for l in ["event: thread", "data: {not json", ""] { feed?.yield(l) }
        try await waitUntil { store.badFrame != nil }
        store.stop()
    }

    /// A session that ended (or was removed) while the Mac app was closed: devd answers the stream with 404 (or 409
    /// not-a-chat-session). That is final: the store says ended and does not reconnect every 5 s.
    func testStreamRefusedWith404EndsTheThreadWithoutReconnecting() async throws {
        for status in [404, 409] {
            let saved = try JSONDecoder().decode(ThreadSnapshot.self, from: snapshot(lastSeq: 10, seenSeq: 10))
            var connects = 0
            let store = ThreadStore(sessionId: "s1", client: client(), restored: saved, connect: { _, _ in
                connects += 1
                throw DevdHTTPError(statusCode: status, serverMessage: status == 404 ? "unknown session" : "not-a-chat-session")
            })
            await store.start()
            try await waitUntil { store.ended }
            try await Task.sleep(for: .milliseconds(50))
            XCTAssertEqual(connects, 1, "HTTP \(status)")
            XCTAssertFalse(store.paused, "HTTP \(status)")
            store.stop()
        }
    }

    /// 409 session-ending is not the end: a failed end releases the lock and the session lives on. The store says
    /// "ending", retries on the slow interval, and streams normally once devd accepts.
    func testSessionEndingRetriesAndResumesOn200() async throws {
        let saved = try JSONDecoder().decode(ThreadSnapshot.self, from: snapshot(lastSeq: 10, seenSeq: 10))
        var paths: [String] = []
        let store = ThreadStore(sessionId: "s1", client: client(), restored: saved, endingRetry: .milliseconds(20),
                                connect: { path, _ in
            paths.append(path)
            if paths.count < 3 { throw DevdHTTPError(statusCode: 409, serverMessage: "session-ending") }
            return AsyncThrowingStream { _ in }
        })
        await store.start()
        try await waitUntil { store.ending }
        XCTAssertFalse(store.ended)
        try await waitUntil { paths.count == 3 && !store.ending }
        XCTAssertFalse(store.ended)
        XCTAssertFalse(store.paused)
        XCTAssertEqual(paths.last, "/api/stream?session=s1&afterSeq=10")
        store.stop()
    }

    /// A screen let go of its store while the session is ending: the 20 s wait must not keep the store alive.
    func testAStoreWaitingOnAnEndingSessionIsReleased() async throws {
        let saved = try JSONDecoder().decode(ThreadSnapshot.self, from: snapshot(lastSeq: 10, seenSeq: 10))
        var store: ThreadStore? = ThreadStore(sessionId: "s1", client: client(), restored: saved, endingRetry: .seconds(30),
                                              connect: { _, _ in throw DevdHTTPError(statusCode: 409, serverMessage: "session-ending") })
        weak let released = store
        await store?.start()
        try await waitUntil { released?.ending == true }
        try await Task.sleep(for: .milliseconds(20)) // into the wait
        store = nil
        try await waitUntil { released == nil }
    }

    /// The end went through while the store waited: the next try gets 404 and that is final.
    func testSessionEndingThen404Ends() async throws {
        let saved = try JSONDecoder().decode(ThreadSnapshot.self, from: snapshot(lastSeq: 10, seenSeq: 10))
        var connects = 0
        let store = ThreadStore(sessionId: "s1", client: client(), restored: saved, endingRetry: .milliseconds(20),
                                connect: { _, _ in
            connects += 1
            if connects == 1 { throw DevdHTTPError(statusCode: 409, serverMessage: "session-ending") }
            throw DevdHTTPError(statusCode: 404, serverMessage: "unknown session")
        })
        await store.start()
        try await waitUntil { store.ended }
        XCTAssertFalse(store.ending)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(connects, 2)
        store.stop()
    }

    /// The Mac reopens a window's thread from its saved copy: no full reload, the stream asks from the saved seq
    /// (devd answers with a thread-snapshot of what changed after it).
    func testRestoredThreadStreamsFromItsSeqWithoutAReload() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 204) }
        let saved = try JSONDecoder().decode(ThreadSnapshot.self, from: snapshot(lastSeq: 10, seenSeq: 10))
        var paths: [String] = []
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = ThreadStore(sessionId: "s1", client: client(), restored: saved, connect: { path, _ in
            paths.append(path)
            return AsyncThrowingStream { feed = $0 }
        })
        XCTAssertEqual(store.thread, saved)
        await store.start()
        try await waitUntil { feed != nil }
        XCTAssertEqual(paths, ["/api/stream?session=s1&afterSeq=10"])
        XCTAssertFalse(requests.contains { $0.hasPrefix("GET /api/sessions/s1/thread") }, "\(requests)")
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

    /// The screen left while resume() was still fetching: the stream must not open behind its back.
    func testStopDuringResumeFetchOpensNoStream() async throws {
        let gate = DispatchSemaphore(value: 0)
        MockURLProtocol.handler = { req in
            switch (req.url?.path, req.url?.query) {
            case ("/api/sessions/s1/thread", nil): return .init(statusCode: 200, data: self.snapshot(lastSeq: 5, seenSeq: 5))
            case ("/api/sessions/s1/thread", "afterSeq=5"):
                _ = gate.wait(timeout: .now() + 3)
                return .init(statusCode: 200, data: self.snapshot(lastSeq: 5, seenSeq: 5))
            default: return .init(statusCode: 204)
            }
        }
        var connects = 0
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in
            connects += 1
            return AsyncThrowingStream { _ in }
        })
        await store.start()
        try await waitUntil { connects == 1 }
        let resuming = Task { await store.resume() }
        try await waitUntil { self.requests.contains("GET /api/sessions/s1/thread?afterSeq=5") }
        store.stop()
        gate.signal()
        await resuming.value
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(connects, 1)
    }

    func testStopDuringFirstLoadOpensNoStream() async throws {
        let gate = DispatchSemaphore(value: 0)
        MockURLProtocol.handler = { _ in
            _ = gate.wait(timeout: .now() + 3)
            return .init(statusCode: 200, data: self.snapshot(lastSeq: 5, seenSeq: 5))
        }
        var connects = 0
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in
            connects += 1
            return AsyncThrowingStream { _ in }
        })
        let starting = Task { await store.start() }
        try await waitUntil { !MockURLProtocol.capturedRequests.isEmpty }
        store.stop()
        gate.signal()
        await starting.value
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNotNil(store.thread)
        XCTAssertEqual(connects, 0)
    }

    /// The view reads rows with their flags precomputed per update, not re-derived on every render.
    func testRowsCarryTheirRunFlagsAndOpenRequest() async throws {
        let runs = #"[{"runId":"r1","origin":"user","status":"completed","endedSeq":3},{"runId":"r2","origin":"critic","status":"queued"}]"#
        let items = #"[{"seq":1,"runId":"r1","itemId":"u1","kind":"user","text":"hi","status":"done","ts":1},"# +
            #"{"seq":2,"runId":"r1","itemId":"q1","kind":"request","text":"ok?","status":"open","ts":2},"# +
            #"{"seq":4,"runId":"r2","itemId":"u2","kind":"user","text":"again","status":"done","ts":3}]"#
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/s1/thread" {
                var body = String(decoding: self.snapshot(lastSeq: 4, seenSeq: 4, items: items, runs: runs), as: UTF8.self)
                body = body.replacingOccurrences(of: #""pending":[]"#,
                    with: #""pending":[{"requestId":"q1","runId":"r1","kind":"question","prompt":"ok?","options":[],"openedAt":2}]"#)
                return .init(statusCode: 200, data: Data(body.utf8))
            }
            return .init(statusCode: 204)
        }
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in AsyncThrowingStream { _ in } })
        await store.start()
        XCTAssertEqual(store.rows.map(\.id), [0, 1, 2])
        XCTAssertEqual(store.rows.map(\.queued), [false, false, true])
        XCTAssertEqual(store.rows.map(\.critic), [false, false, true])
        XCTAssertEqual(store.rows.map { $0.pending?.requestId }, [nil, "q1", nil])
        XCTAssertEqual(store.switchKey, ThreadView.switchKey(try XCTUnwrap(store.thread)))
        store.stop()
    }

    private func mirrorBody(lastSeq: Int, sendBlock: String = "null", activity: String = "idle") -> Data {
        let info = #"{"state":"live","agent":"Claude Code","conversationId":"c1","activity":"\#(activity)","terminalPrompt":null,"sendBlock":\#(sendBlock)}"#
        return Data(#"{"mirror":\#(info),"snapshot":\#(String(decoding: snapshot(lastSeq: lastSeq), as: UTF8.self))}"#.utf8)
    }

    /// A tmux session: /thread refuses it, so the store reads devd's mirror of the pane, streams the mirror's own
    /// stream, applies its `mirror` frames, and never marks it seen.
    func testTmuxSessionLoadsAndStreamsTheMirror() async throws {
        MockURLProtocol.handler = { req in
            switch req.url?.path {
            case "/api/sessions/s1/thread": return .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8))
            case "/api/sessions/s1/mirror": return .init(statusCode: 200, data: self.mirrorBody(lastSeq: 4))
            default: return .init(statusCode: 204)
            }
        }
        var paths: [String] = []
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { path, _ in
            paths.append(path)
            return AsyncThrowingStream { feed = $0 }
        })
        await store.start()
        try await waitUntil { feed != nil }
        XCTAssertTrue(store.isTmux)
        XCTAssertEqual(store.thread?.lastSeq, 4)
        XCTAssertEqual(store.mirror?.agent, "Claude Code")
        XCTAssertEqual(paths, ["/api/sessions/s1/mirror/stream?afterSeq=4"])
        let codex = #"{"state":"live","agent":"Codex","conversationId":"t1","activity":"idle","terminalPrompt":null,"sendBlock":{"code":"codex-send-unsupported","message":"Sending from chat isn't available for Codex yet; reply in the terminal."}}"#
        for l in ["event: mirror", "data: \(codex)", ""] { feed?.yield(l) }
        try await waitUntil { store.mirror?.agent == "Codex" }
        XCTAssertEqual(store.mirror?.sendBlock?.code, "codex-send-unsupported")
        store.markSeenIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(requests.contains { $0.contains("/seen") }, "a mirror has no seen marker")
        store.stop()

        // Back from the background: the mirror's own catch-up route.
        await store.resume()
        XCTAssertTrue(requests.contains("GET /api/sessions/s1/mirror?afterSeq=4"))
        store.stop()
    }

    /// A refused send becomes the lock and keeps the text (false); devd repeating the same info keeps it; a sent
    /// message or a real change of the pane takes it away; a failure devd does not explain throws.
    func testSendToPaneLocksOnARefusal() async throws {
        var post = (status: 409, body: #"{"error":"terminal-has-draft","message":"Text is already typed."}"#)
        MockURLProtocol.handler = { req in
            switch req.url?.path {
            case "/api/sessions/s1/thread": return .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8))
            case "/api/sessions/s1/mirror": return .init(statusCode: 200, data: self.mirrorBody(lastSeq: 1))
            case "/api/sessions/s1/mirror/messages": return .init(statusCode: post.status, data: Data(post.body.utf8))
            default: return .init(statusCode: 204)
            }
        }
        var feed: AsyncThrowingStream<String, Error>.Continuation?
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in AsyncThrowingStream { feed = $0 } })
        await store.start()
        try await waitUntil { feed != nil }
        let refused = try await store.sendToPane(text: "hi")
        XCTAssertFalse(refused)
        XCTAssertEqual(store.sendLock, MirrorLock(code: "terminal-has-draft", message: "Text is already typed."))
        let body = MockURLProtocol.capturedRequests.last { $0.url?.path == "/api/sessions/s1/mirror/messages" }.map(bodyJSON)
        XCTAssertEqual(body as NSDictionary?, ["text": "hi"] as NSDictionary)
        let same = #"{"state":"live","agent":"Claude Code","conversationId":"c1","activity":"idle","terminalPrompt":null,"sendBlock":null}"#
        for l in ["event: mirror", "data: \(same)", "", "event: ping", "data: {}", ""] { feed?.yield(l) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertNotNil(store.sendLock, "the same info again keeps the lock")
        for l in ["event: mirror", "data: \(same.replacingOccurrences(of: "idle", with: "busy"))", ""] { feed?.yield(l) }
        try await waitUntil { store.sendLock == nil }

        post = (409, #"{"error":"codex-send-unsupported","message":"Sending from chat isn't available for Codex yet; reply in the terminal."}"#)
        _ = try await store.sendToPane(text: "hi")
        XCTAssertEqual(store.sendLock?.code, "codex-send-unsupported")
        post = (202, #"{"sent":true}"#)
        let sent = try await store.sendToPane(text: "hi")
        XCTAssertTrue(sent)
        XCTAssertNil(store.sendLock)
        post = (400, #"{"error":"Commands (a line starting with /, ! or #) can't be sent from the chat; type them in the terminal."}"#)
        do {
            _ = try await store.sendToPane(text: "/clear")
            XCTFail("a 400 is the composer's error, not a lock")
        } catch {
            XCTAssertNil(store.sendLock)
        }
        store.stop()
    }

    /// A tmux session's images go up as a chat's do (the session's own inbox dir, `/inbox/<id>` in the container), then
    /// their container paths are typed after the text, each on its own line: the terminal's agent reads them as files.
    func testSendToPaneUploadsImagesAndTypesTheirPaths() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/s1/inbox" { return .init(statusCode: 201, data: Data(#"{"path":"/inbox/s1/x.jpg","size":3}"#.utf8)) }
            return .init(statusCode: 202, data: Data(#"{"sent":true}"#.utf8))
        }
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in AsyncThrowingStream { _ in } })
        let sent = try await store.sendToPane(text: "look", images: [Data([1]), Data([2])])
        XCTAssertTrue(sent)
        XCTAssertEqual(requests, ["POST /api/sessions/s1/inbox?for=thread", "POST /api/sessions/s1/inbox?for=thread",
                                  "POST /api/sessions/s1/mirror/messages"])
        let body = MockURLProtocol.capturedRequests.last { $0.url?.path == "/api/sessions/s1/mirror/messages" }.map(bodyJSON)
        XCTAssertEqual(body as NSDictionary?, ["text": "look\n\nAttached image: /inbox/s1/x.jpg\nAttached image: /inbox/s1/x.jpg"] as NSDictionary)
    }

    /// An upload devd refuses is the composer's error, as it is: nothing was typed, so it is neither a lock nor
    /// "may have reached the terminal".
    func testSendToPaneWithARefusedImageTypesNothing() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/s1/inbox" { return .init(statusCode: 415, data: Data(#"{"error":"Only png, jpeg, webp or gif images can be attached"}"#.utf8)) }
            return .init(statusCode: 202, data: Data(#"{"sent":true}"#.utf8))
        }
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in AsyncThrowingStream { _ in } })
        do {
            _ = try await store.sendToPane(text: "look", images: [Data([1])])
            XCTFail("a refused upload sends nothing")
        } catch {
            XCTAssertEqual(chatErrorText(error), "Only png, jpeg, webp or gif images can be attached")
        }
        XCTAssertEqual(requests, ["POST /api/sessions/s1/inbox?for=thread"])
        XCTAssertNil(store.sendLock)
    }

    /// A send devd never answered (a timeout, a dropped connection) may have reached the pane: the composer says so,
    /// and no lock stands in for it.
    func testSendToPaneWithoutAnAnswerSaysItMayHaveArrived() async throws {
        MockURLProtocol.handler = { _ in .init(statusCode: 0, error: URLError(.timedOut)) }
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in AsyncThrowingStream { _ in } })
        do {
            _ = try await store.sendToPane(text: "hi")
            XCTFail("no answer is not a sent message")
        } catch {
            XCTAssertEqual(chatErrorText(error), "The message may have reached the terminal — check it before sending again.")
        }
        XCTAssertNil(store.sendLock)
    }

    /// The mirror stream refusing a session that is no longer a tmux session: final, but not "Session ended" (the
    /// session lives on), and the Mac does not forget its window.
    func testMirrorStreamRefusedAsNoLongerTmuxIsNotEnded() async throws {
        MockURLProtocol.handler = { req in
            switch req.url?.path {
            case "/api/sessions/s1/thread": return .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8))
            case "/api/sessions/s1/mirror": return .init(statusCode: 200, data: self.mirrorBody(lastSeq: 1))
            default: return .init(statusCode: 204)
            }
        }
        var connects = 0
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in
            connects += 1
            throw DevdHTTPError(statusCode: 409, serverMessage: "not-a-tmux-session")
        })
        await store.start()
        try await waitUntil { store.noLongerTmux }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(store.ended)
        XCTAssertEqual(connects, 1)
        store.stop()
    }

    /// /mirror itself failing leaves the load error (the screen offers Open terminal), not a silent empty thread.
    func testMirrorLoadFailureIsShown() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/s1/thread" { return .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8)) }
            return .init(statusCode: 500, data: Data(#"{"error":"boom"}"#.utf8))
        }
        var connects = 0
        let store = ThreadStore(sessionId: "s1", client: client(), connect: { _, _ in connects += 1; return AsyncThrowingStream { _ in } })
        await store.start()
        XCTAssertTrue(store.isTmux)
        XCTAssertNil(store.thread)
        XCTAssertEqual(store.loadError, "boom")
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
