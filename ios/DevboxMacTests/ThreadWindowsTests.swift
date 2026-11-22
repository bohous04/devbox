import XCTest
@testable import DevboxApp

/// The Mac app's restart behaviour: the windows open at quit come back on the next launch and each thread streams on
/// from its saved seq.
@MainActor
final class ThreadWindowsTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""
    private var directory: URL!

    override func setUp() {
        super.setUp()
        suite = "ThreadWindowsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        MockURLProtocol.capturedRequests = []
        // Opening a thread posts a look (thread/seen) even when nothing is new; a request left unanswered (no handler)
        // makes URLSession trap, so every test answers 204 unless it says otherwise.
        MockURLProtocol.handler = { _ in .init(statusCode: 204) }
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test")!),
                          session: URLSession(configuration: config))
    }

    private func snapshot(_ lastSeq: Int) -> Data {
        Data(#"{"lastSeq":\#(lastSeq),"seenSeq":\#(lastSeq),"runs":[],"items":[{"seq":\#(lastSeq),"runId":"r1","itemId":"m1","kind":"assistant","text":"at \#(lastSeq)","status":"done","ts":1}],"pending":[],"background":[],"native":null}"#.utf8)
    }

    /// A stream that never ends; `paths` records what each connect asked for.
    private final class Streams {
        var paths: [String] = []
        var connect: ThreadStore.Connect {
            { [self] path, _ in
                paths.append(path)
                return AsyncThrowingStream { _ in }
            }
        }
    }

    /// First run: two windows with threads at seq 10 and 20, then quit.
    private func runAndQuit() async throws {
        MockURLProtocol.handler = { req in
            switch req.url?.path {
            case "/api/sessions/a/thread": return .init(statusCode: 200, data: self.snapshot(10))
            case "/api/sessions/b/thread": return .init(statusCode: 200, data: self.snapshot(20))
            default: return .init(statusCode: 204)
            }
        }
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        let streams = Streams()
        windows.show(window: "w1", thread: "a")
        windows.show(window: "w2", thread: "b")
        let a = windows.store(for: "a", client: client(), connect: streams.connect)
        let b = windows.store(for: "b", client: client(), connect: streams.connect)
        await a.start()
        await b.start()
        XCTAssertEqual(a.thread?.lastSeq, 10)
        XCTAssertEqual(b.thread?.lastSeq, 20)
        windows.willTerminate()
        // Quitting closes the windows too: they must stay listed.
        windows.close(window: "w1")
        windows.close(window: "w2")
        windows.dropStores()
    }

    func testRestoredWindowsReconnect() async throws {
        try await runAndQuit()
        MockURLProtocol.capturedRequests = []

        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        let plan = relaunched.restorePlan(current: nil)
        XCTAssertEqual(plan.adopt, "a", "the launch window shows the first thread")
        XCTAssertEqual(plan.open, ["b"], "the other thread gets a window of its own")

        let streams = Streams()
        for (window, thread) in [("n1", "a"), ("n2", "b")] {
            relaunched.show(window: window, thread: thread)
            await relaunched.store(for: thread, client: client(), connect: streams.connect).start()
        }
        try await waitUntil { streams.paths.count == 2 }
        XCTAssertEqual(streams.paths, ["/api/stream?session=a&afterSeq=10", "/api/stream?session=b&afterSeq=20"])
        XCTAssertFalse(MockURLProtocol.capturedRequests.contains { $0.url?.path.hasSuffix("/thread") == true },
                       "a restored thread is not loaded again")
        XCTAssertEqual(relaunched.store(for: "a", client: client()).thread?.items.map(\.text), ["at 10"])
        relaunched.dropStores()
    }

    func testRestoreHappensOnceAndSkipsAWindowSystemRestored() async throws {
        try await runAndQuit()
        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        let plan = relaunched.restorePlan(current: "b")
        XCTAssertNil(plan.adopt)
        XCTAssertEqual(plan.open, ["a"])
        XCTAssertEqual(relaunched.restorePlan(current: nil).open, [])
    }

    func testAClosedWindowIsNotRestoredAndItsThreadIsForgotten() async throws {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "a")
        windows.show(window: "w2", thread: "b")
        windows.close(window: "w1")
        windows.show(window: "w2", thread: "c") // w2 moved on from b

        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        XCTAssertEqual(relaunched.restorePlan(current: nil).adopt, "c")
    }

    func testAWindowWithoutAThreadRestoresNothing() {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: nil)
        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        let plan = relaunched.restorePlan(current: nil)
        XCTAssertNil(plan.adopt)
        XCTAssertEqual(plan.open, [])
    }

    func testTwoWindowsOnOneThreadShareItsStore() {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "a")
        windows.show(window: "w2", thread: "a")
        let first = windows.store(for: "a", client: client())
        windows.close(window: "w1")
        XCTAssertTrue(windows.store(for: "a", client: client()) === first, "w2 still shows a")
        windows.close(window: "w2")
        XCTAssertFalse(windows.store(for: "a", client: client()) === first, "nobody shows a: its store went")
        windows.dropStores()
    }

    private func loadedStore(_ windows: ThreadWindows, _ id: String, seq: Int) async throws -> ThreadStore {
        MockURLProtocol.handler = { _ in .init(statusCode: 200, data: self.snapshot(seq)) }
        let store = windows.store(for: id, client: client(), connect: Streams().connect)
        await store.start()
        XCTAssertEqual(store.thread?.lastSeq, seq)
        return store
    }

    /// Losing focus saves the threads too: after a crash (no quit) the next launch still streams from that seq.
    func testThreadsSavedOnResignActiveSurviveACrash() async throws {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "a")
        _ = try await loadedStore(windows, "a", seq: 10)
        windows.saveOpenThreads()
        windows.dropStores() // the process dies here: no willTerminate

        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        XCTAssertEqual(relaunched.restorePlan(current: nil).adopt, "a")
        relaunched.show(window: "n1", thread: "a")
        XCTAssertEqual(relaunched.store(for: "a", client: client()).thread?.lastSeq, 10)
        relaunched.dropStores()
    }

    /// Switching a window away from a thread or closing it keeps its content: opening it again streams from its seq.
    func testSwitchingAwayAndClosingSaveTheThread() async throws {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "a")
        _ = try await loadedStore(windows, "a", seq: 10)
        windows.show(window: "w1", thread: "b")
        windows.show(window: "w1", thread: "a")
        XCTAssertEqual(windows.store(for: "a", client: client()).thread?.lastSeq, 10, "reopened from its saved copy")
        windows.show(window: "w2", thread: "c")
        _ = try await loadedStore(windows, "c", seq: 30)
        windows.close(window: "w2")
        windows.show(window: "w3", thread: "c")
        XCTAssertEqual(windows.store(for: "c", client: client()).thread?.lastSeq, 30)
        windows.dropStores()
    }

    /// A tmux session's mirror is not saved: restored, it would stream from the chat thread's route, which refuses
    /// it and ends the window. The relaunch loads it again through the mirror.
    func testATmuxMirrorIsNotSaved() async throws {
        MockURLProtocol.handler = { req in
            if req.url?.path == "/api/sessions/t/thread" { return .init(statusCode: 409, data: Data(#"{"error":"not-a-chat-session"}"#.utf8)) }
            let info = #"{"state":"live","agent":"Claude Code","conversationId":"c","activity":"idle","terminalPrompt":null,"sendBlock":null}"#
            return .init(statusCode: 200, data: Data(#"{"mirror":\#(info),"snapshot":\#(String(decoding: self.snapshot(5), as: UTF8.self))}"#.utf8))
        }
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "t")
        let store = windows.store(for: "t", client: client(), connect: Streams().connect)
        await store.start()
        XCTAssertTrue(store.isTmux)
        XCTAssertEqual(store.thread?.lastSeq, 5)
        windows.willTerminate()
        windows.dropStores()

        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        relaunched.show(window: "n1", thread: "t")
        XCTAssertNil(relaunched.store(for: "t", client: client()).thread, "no saved copy: it loads again")
        relaunched.dropStores()
    }

    /// An ended session is not restored and its saved thread goes.
    func testAnEndedThreadIsForgotten() async throws {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "a")
        windows.show(window: "w2", thread: "b")
        _ = try await loadedStore(windows, "a", seq: 10)
        windows.saveOpenThreads()
        windows.ended("a")
        windows.willTerminate()
        windows.dropStores()

        let relaunched = ThreadWindows(defaults: defaults, directory: directory)
        let plan = relaunched.restorePlan(current: nil)
        XCTAssertEqual(plan.adopt, "b")
        XCTAssertEqual(plan.open, [])
        relaunched.show(window: "n1", thread: "a")
        XCTAssertNil(relaunched.store(for: "a", client: client()).thread, "no saved copy left")
        relaunched.dropStores()
    }

    /// An unreadable window list is said once and kept aside, not silently replaced.
    func testACorruptWindowListIsReportedAndKept() {
        defaults.set(Data("not json".utf8), forKey: "openWindows")
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        XCTAssertNotNil(windows.restoreProblem)
        XCTAssertEqual(defaults.data(forKey: "openWindows.unreadable"), Data("not json".utf8))
        windows.show(window: "w1", thread: "a")
        XCTAssertNotNil(ThreadWindows(defaults: defaults, directory: directory).restorePlan(current: nil).adopt)
        XCTAssertNil(ThreadWindows(defaults: defaults, directory: directory).restoreProblem, "said once")
    }

    /// After an ended thread, opening it again builds a fresh store (it may live again, e.g. a reused id) instead of
    /// handing back the ended one; until then the window that showed it keeps the ended store.
    func testReopeningAnEndedThreadGetsAFreshStore() async throws {
        let windows = ThreadWindows(defaults: defaults, directory: directory)
        windows.show(window: "w1", thread: "a")
        let old = try await loadedStore(windows, "a", seq: 10)
        windows.ended("a")
        XCTAssertTrue(windows.store(for: "a", client: client()) === old, "the window still showing it keeps saying ended")
        windows.close(window: "w1")
        windows.show(window: "w2", thread: "a")
        let fresh = windows.store(for: "a", client: client())
        XCTAssertFalse(fresh === old)
        XCTAssertNil(fresh.thread, "no saved copy")
        windows.dropStores()
    }
}
