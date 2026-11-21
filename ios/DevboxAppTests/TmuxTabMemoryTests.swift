import XCTest
@testable import DevboxApp

/// The view each tmux session opens on, as dashboard/src/tmuxTab.test.ts.
@MainActor
final class TmuxTabMemoryTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    private var memory: TmuxTabMemory!

    override func setUp() {
        super.setUp()
        suite = "TmuxTabMemoryTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        memory = TmuxTabMemory(defaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testEachSessionKeepsItsLastTabAndSwitchingBackIsKeptToo() {
        XCTAssertNil(memory.tab(for: "a"))
        memory.remember(.chat, for: "a")
        memory.remember(.terminal, for: "b")
        XCTAssertEqual(memory.tab(for: "a"), .chat)
        XCTAssertEqual(memory.tab(for: "b"), .terminal)
        memory.remember(.terminal, for: "a")
        XCTAssertEqual(memory.tab(for: "a"), .terminal)
        XCTAssertEqual(TmuxTabMemory(defaults: defaults).tab(for: "a"), .terminal, "kept across launches")
    }

    func testATmuxRowLastViewedInChatOpensTheChatOthersTheirDetail() {
        let tmux = InboxRoute.row(sessionId: "t", runtime: .tmux, memory: memory)
        XCTAssertEqual(tmux, .session("t"))
        memory.remember(.chat, for: "t")
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, memory: memory), .thread("t"))
        memory.remember(.terminal, for: "t")
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, memory: memory), .session("t"))
        memory.remember(.terminal, for: "c")
        XCTAssertEqual(InboxRoute.row(sessionId: "c", runtime: .chat, memory: memory), .thread("c"), "a chat session is unaffected")
    }

    func testEndedSessionsArePrunedAndTheListIsCapped() {
        memory.remember(.chat, for: "a")
        memory.remember(.chat, for: "b")
        memory.remember(.terminal, for: "c")
        memory.prune(keeping: ["a", "c", "z"])
        XCTAssertEqual([memory.tab(for: "a"), memory.tab(for: "b"), memory.tab(for: "c")], [.chat, nil, .terminal])

        for i in 0...TmuxTabMemory.maxEntries { memory.remember(.chat, for: "s\(i)") }
        XCTAssertNil(memory.tab(for: "s0"))
        XCTAssertEqual(memory.tab(for: "s1"), .chat)
        // Choosing again makes it the most recent: it outlives the others.
        memory.remember(.terminal, for: "s1")
        memory.remember(.chat, for: "new")
        XCTAssertEqual(memory.tab(for: "s1"), .terminal)
        XCTAssertNil(memory.tab(for: "s2"))
    }

    func testAnUnreadableListStartsOver() {
        defaults.set(Data("{not json".utf8), forKey: TmuxTabMemory.key)
        let fresh = TmuxTabMemory(defaults: defaults)
        XCTAssertNil(fresh.tab(for: "a"))
        fresh.remember(.chat, for: "a")
        XCTAssertEqual(TmuxTabMemory(defaults: defaults).tab(for: "a"), .chat)
    }
}
