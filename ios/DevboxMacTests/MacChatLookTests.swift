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

    override func tearDown() {
        MockURLProtocol.handler = nil
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
        becameKey(chat) // its opening
        spin(0.5)
        XCTAssertEqual(seenPosts, 1, "becoming key on opening is not a second look")
        becameKey(other)
        spin(0.5)
        XCTAssertEqual(seenPosts, 1, "another window becoming key is no look here")
        for expected in [2, 3] {
            becameKey(chat)
            spin(5) { seenPosts == expected }
            spin(0.3)
            XCTAssertEqual(seenPosts, expected, "each return posts once")
        }
    }
}
