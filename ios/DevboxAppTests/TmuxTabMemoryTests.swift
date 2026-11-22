import Combine
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
        XCTAssertNil(memory.tab(for: "a@1"))
        memory.remember(.chat, for: "a@1")
        memory.remember(.terminal, for: "b@1")
        XCTAssertEqual(memory.tab(for: "a@1"), .chat)
        XCTAssertEqual(memory.tab(for: "b@1"), .terminal)
        memory.remember(.terminal, for: "a@1")
        XCTAssertEqual(memory.tab(for: "a@1"), .terminal)
        XCTAssertEqual(TmuxTabMemory(defaults: defaults).tab(for: "a@1"), .terminal, "kept across launches")
    }

    func testASessionReopenedUnderTheSameIdDoesNotInheritTheOldTab() {
        memory.remember(.chat, for: TmuxTabMemory.key("dev-a", createdAt: 1000))
        XCTAssertEqual(memory.tab(for: TmuxTabMemory.key("dev-a", createdAt: 1000)), .chat)
        XCTAssertNil(memory.tab(for: TmuxTabMemory.key("dev-a", createdAt: 2000)))
        XCTAssertEqual(InboxRoute.row(sessionId: "dev-a", runtime: .tmux, createdAt: 2000, memory: memory), .thread("dev-a"))
        memory.prune(keeping: [TmuxTabMemory.key("dev-a", createdAt: 2000)])
        XCTAssertNil(memory.tab(for: TmuxTabMemory.key("dev-a", createdAt: 1000)))
    }

    func testATmuxRowOpensTheChatUnlessTerminalWasPicked() {
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, createdAt: 5, memory: memory), .thread("t"), "the default is Chat")
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, createdAt: nil, memory: memory), .thread("t"),
                       "before the live list loads: Chat too")
        memory.remember(.terminal, for: TmuxTabMemory.key("t", createdAt: 5))
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, createdAt: 5, memory: memory), .session("t"))
        memory.remember(.chat, for: TmuxTabMemory.key("t", createdAt: 5))
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, createdAt: 5, memory: memory), .thread("t"), "switched back")
        XCTAssertEqual(InboxRoute.row(sessionId: "c", runtime: .chat, createdAt: 5, memory: memory), .thread("c"), "a chat session is unaffected")
    }

    /// Terminal picked in the detail, then the row tapped at once: the inbox watches the memory, so the row it draws
    /// after the pick already leads to the detail.
    func testTerminalPickedInTheDetailMakesTheRowOpenTheDetailAtOnce() {
        let key = TmuxTabMemory.key("t", createdAt: 5)
        var changes = 0
        let watch = memory.objectWillChange.sink { changes += 1 }
        defer { watch.cancel() }
        memory.remember(.terminal, for: key)
        XCTAssertEqual(changes, 1, "the inbox is told to draw its rows again")
        XCTAssertEqual(InboxRoute.row(sessionId: "t", runtime: .tmux, createdAt: 5, memory: memory), .session("t"))
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

    func testAnUnreadableListIsRewrittenEmpty() throws {
        defaults.set(Data("{not json".utf8), forKey: TmuxTabMemory.key)
        let fresh = TmuxTabMemory(defaults: defaults)
        XCTAssertNil(fresh.tab(for: "a"))
        XCTAssertEqual(String(decoding: try XCTUnwrap(defaults.data(forKey: TmuxTabMemory.key)), as: UTF8.self), "[]")
    }
}
