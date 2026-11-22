#if DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import DevboxApp

/// The tab a tmux window opens on (TmuxTabMemory), in the Mac window on the DEBUG fixtures: only the user's switch is
/// stored; the automatic one to Terminal, for an agent the mirror cannot read, leaves the stored choice alone.
@MainActor
final class MacThreadTabTests: XCTestCase {
    private let memory = TmuxTabMemory.shared

    override func setUp() {
        super.setUp()
        FixtureMode.requested = "demo"
    }

    override func tearDown() {
        FixtureMode.requested = nil
        super.tearDown()
    }

    func testARememberedChatTheMirrorCannotReadOpensTerminalAndStaysRemembered() throws {
        let key = TmuxTabMemory.key(MirrorFixtures.unreadableId, createdAt: MirrorFixtures.createdAt)
        memory.remember(.chat, for: key)
        let window = try open(MirrorFixtures.unreadableId) { state in
            state.windows.store(for: MirrorFixtures.unreadableId, client: state.appModel.client!).mirror != nil
        }
        defer { window.close() }
        XCTAssertFalse(Self.terminals(in: window).isEmpty, "the window switched to its terminal")
        XCTAssertEqual(memory.tab(for: key), .chat, "the automatic switch did not overwrite the user's choice")
    }

    func testARememberedChatOpensTheChat() throws {
        let key = TmuxTabMemory.key(MirrorFixtures.claudeId, createdAt: MirrorFixtures.createdAt)
        memory.remember(.chat, for: key)
        let window = try open(MirrorFixtures.claudeId) { state in
            state.windows.store(for: MirrorFixtures.claudeId, client: state.appModel.client!).thread != nil
        }
        defer { window.close() }
        XCTAssertTrue(Self.terminals(in: window).isEmpty, "the window stayed on Chat")
        XCTAssertEqual(memory.tab(for: key), .chat)
    }

    func testOnlyTheUsersSwitchIsStored() {
        let key = TmuxTabMemory.key("dev-x", createdAt: 1)
        XCTAssertEqual(MacThreadDetail.chosen(.chat, memoryKey: key, memory: memory), .chat)
        XCTAssertEqual(memory.tab(for: key), .chat)
        XCTAssertEqual(MacThreadDetail.chosen(.terminal, memoryKey: key, memory: memory), .terminal)
        XCTAssertEqual(memory.tab(for: key), .terminal)
        // A chat session (no key): the switch shows, nothing is stored.
        XCTAssertEqual(MacThreadDetail.chosen(.chat, memoryKey: nil, memory: memory), .chat)
        XCTAssertEqual(memory.tab(for: key), .terminal)
    }

    private func open(_ thread: String, until loaded: (MacAppState) -> Bool) throws -> NSWindow {
        let state = MacAppState(isTestRun: false, isFixtureRun: true)
        state.appModel.reloadConfiguration()
        let root = MacWindowContent(thread: .constant(thread), page: .constant(nil), newSession: .constant(false), findPending: .constant(false))
            .environmentObject(state)
            .environmentObject(state.appModel)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: root)
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        window.orderFront(nil)
        // The window opens on Chat until the inbox and the live list say it is a tmux session; then on the remembered tab.
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, !(state.inbox?.items != nil && state.live?.live != nil && loaded(state)) {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertTrue(loaded(state), "the fixtures did not load")
        RunLoop.main.run(until: Date().addingTimeInterval(1))
        return window
    }

    private static func terminals(in window: NSWindow) -> [NSView] {
        func walk(_ v: NSView) -> [NSView] {
            (String(describing: type(of: v)).hasPrefix("DevboxTerminalView") ? [v] : []) + v.subviews.flatMap(walk)
        }
        return walk(window.contentView!)
    }
}
#endif
