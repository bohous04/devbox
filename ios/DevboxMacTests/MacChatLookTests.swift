import AppKit
import SwiftUI
import XCTest
@testable import DevboxApp

/// A chat window the owner comes back to marks its thread seen (a look, which restarts devd's auto-settle clock),
/// once per return. macOS moves no `scenePhase` on that; the window becoming key does.
@MainActor
final class MacChatLookTests: XCTestCase {
    private var seenPosts: Int {
        MockURLProtocol.capturedRequests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/sessions/s1/thread/seen" }.count
    }

    private func spin(_ seconds: TimeInterval, until done: () -> Bool = { false }) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, !done() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    private func window() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled, .resizable],
                         backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        return w
    }

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = { req in
            if req.httpMethod == "GET", req.url?.path == "/api/sessions/s1/thread", req.url?.query == nil {
                return .init(statusCode: 200, data: Data(#"{"lastSeq":5,"seenSeq":5,"runs":[],"items":[],"pending":[],"background":[],"native":null}"#.utf8))
            }
            return .init(statusCode: 204)
        }
    }

    // 204, not nil: a store's late thread/seen arriving with no handler makes URLSession trap in the next test.
    override func tearDown() {
        MockURLProtocol.handler = { _ in .init(statusCode: 204) }
        super.tearDown()
    }

    /// A real activation cannot be done here: the test host app is not allowed to activate itself (macOS cooperative
    /// activation), so none of its windows ever becomes key. The window's own didBecomeKey is posted as AppKit posts it
    /// when the owner comes back to the window or to the app.
    func testComingBackToTheWindowPostsOneSeenEachTime() throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = DevdClient(endpoints: DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: URL(string: "http://devd.test")!),
                                session: URLSession(configuration: config))
        let store = ThreadStore(sessionId: "s1", client: client, connect: { _, _ in AsyncThrowingStream { _ in } })
        let chat = window()
        chat.contentView = NSHostingView(rootView: ChatScreen(store: store, client: client, openTerminal: nil, closeWindow: nil)
            .environmentObject(LiveStore(client: client)))
        let other = window()
        defer { chat.close(); other.close() }
        chat.orderFront(nil)
        spin(5) { seenPosts == 1 }
        XCTAssertEqual(seenPosts, 1, "opening posts the look")

        let becameKey = { (w: NSWindow) in NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w) }
        let settle = { (expected: Int, why: String) in
            self.spin(2) { self.seenPosts == expected }
            self.spin(0.3)
            XCTAssertEqual(self.seenPosts, expected, why)
        }
        becameKey(chat) // its opening
        settle(1, "becoming key on opening is not a second look")

        // Its own sheet and a child window (a popover) take key and give it back: he never left.
        let sheet = window()
        chat.beginSheet(sheet)
        spin(0.3)
        XCTAssertTrue(sheet.sheetParent === chat, "the sheet is attached")
        becameKey(sheet)
        chat.endSheet(sheet)
        becameKey(chat)
        settle(1, "a sheet closing is no return")
        let popover = window()
        chat.addChildWindow(popover, ordered: .above)
        becameKey(popover)
        becameKey(chat)
        chat.removeChildWindow(popover)
        settle(1, "a child window closing is no return")

        // Another window of the app, then back: one look; becoming key again without leaving is none.
        becameKey(other)
        becameKey(chat)
        settle(2, "coming back from another window posts once")
        becameKey(chat)
        settle(2, "key again without leaving is no look")

        // Another app in front, then back.
        NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
        becameKey(chat)
        settle(3, "coming back to the app posts once")
        sheet.close(); popover.close()
    }
}
