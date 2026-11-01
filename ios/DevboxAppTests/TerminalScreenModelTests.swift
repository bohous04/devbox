import XCTest
@testable import DevboxApp

/// Fake `TerminalTransport` — captures what `TerminalScreenModel` sends and can manually
/// simulate state transitions (`.connecting`/`.open`/`.closed`) without a real WS socket.
@MainActor
private final class FakeTerminalTransport: TerminalTransport {
    var onText: ((String) -> Void)?
    var onStateChange: ((TerminalSession.State) -> Void)?
    private(set) var sent: [String] = []

    func connect() {}
    func send(_ text: String) { sent.append(text) }
    func cancel() {}
}

/// The server spawns the pty hardcoded at 80×24 and waits for the client's resize (the web sends it in `ws.onopen`) —
/// `TerminalScreenModel` must do the same on EVERY transition to `.open`, not just once on the
/// first layout, otherwise after a reconnect the terminal would stay at the wrong size until the user
/// rotates the phone / changes the layout.
@MainActor
final class TerminalScreenModelTests: XCTestCase {
    func testResizeIsResentOnEveryTransitionToOpenWhenSizeIsKnown() {
        let transport = FakeTerminalTransport()
        let model = TerminalScreenModel(session: transport)

        model.handleSizeChanged(cols: 92, rows: 30)
        XCTAssertEqual(transport.sent, [TerminalProto.encodeResize(cols: 92, rows: 30)])

        transport.onStateChange?(.open)
        XCTAssertEqual(
            transport.sent.last, TerminalProto.encodeResize(cols: 92, rows: 30),
            "the first open must send the last known size (otherwise the server stays at a pty of 80x24)"
        )

        // Reconnect — the server spawned a brand-new pty (80x24 again), it needs the resize again.
        transport.onStateChange?(.connecting)
        transport.onStateChange?(.open)
        XCTAssertEqual(transport.sent.last, TerminalProto.encodeResize(cols: 92, rows: 30))
        XCTAssertEqual(transport.sent.count, 3, "handleSizeChanged (1) + 2× transition to .open (2)")
    }

    func testNoResizeSentOnOpenWhenSizeNeverKnown() {
        let transport = FakeTerminalTransport()
        _ = TerminalScreenModel(session: transport)

        transport.onStateChange?(.open)

        XCTAssertTrue(transport.sent.isEmpty, "without a completed layout (no handleSizeChanged) resize(0,0) must not be sent")
    }

    func testPastedTextIsSentOnlyAfterTakingControl() {
        let transport = FakeTerminalTransport()
        let model = TerminalScreenModel(session: transport)

        model.sendText("hello\nworld")
        XCTAssertTrue(transport.sent.isEmpty)

        model.takeControl()
        model.sendText("hello\nworld")
        XCTAssertEqual(transport.sent, [
            TerminalProto.encodeUnlock(),
            TerminalProto.encodeInput("hello\nworld"),
        ])
    }

    // MARK: - History scroll (tmux) + "↓ Jump to end"

    func testScrollWorksReadOnlyAndUpShowsBottomButton() {
        let transport = FakeTerminalTransport()
        let model = TerminalScreenModel(session: transport)

        model.scroll(.down, steps: 2)
        XCTAssertFalse(model.showsBottomButton, "scrolling down alone does not show the button")
        model.scroll(.up, steps: 3)
        XCTAssertTrue(model.showsBottomButton)
        XCTAssertEqual(transport.sent, [
            TerminalProto.encodeScroll(.down, n: 2),
            TerminalProto.encodeScroll(.up, n: 3),
        ], "scroll projde i v read-only (bez takeControl)")
    }

    func testBottomButtonSendsBottomAndHides() {
        let transport = FakeTerminalTransport()
        let model = TerminalScreenModel(session: transport)

        model.scroll(.up, steps: 1)
        model.scrollToBottom()
        XCTAssertFalse(model.showsBottomButton)
        XCTAssertEqual(transport.sent.last, TerminalProto.encodeBottom())
    }

    func testTypingWhileGrantedHidesBottomButton() {
        let transport = FakeTerminalTransport()
        let model = TerminalScreenModel(session: transport)

        model.scroll(.up, steps: 1)
        model.sendKey("Enter")
        XCTAssertTrue(model.showsBottomButton, "in read-only the key is not sent → the button stays")

        model.takeControl()
        model.sendKey("Enter")
        XCTAssertFalse(model.showsBottomButton)

        model.scroll(.up, steps: 1)
        model.sendText("ls")
        XCTAssertFalse(model.showsBottomButton)
    }

    func testZeroStepsSendNothing() {
        let transport = FakeTerminalTransport()
        let model = TerminalScreenModel(session: transport)
        model.scroll(.up, steps: 0)
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertFalse(model.showsBottomButton)
    }
}
