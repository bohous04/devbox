import XCTest
@testable import DevboxApp

/// `MirrorView`, the cases of `dashboard/src/mirrorView.test.ts`: the apps lock a tmux session's composer for the same
/// reasons as the web.
final class MirrorViewTests: XCTestCase {
    private let live = MirrorInfo(state: "live", agent: "Claude Code", conversationId: "c", activity: "idle", terminalPrompt: nil, sendBlock: nil)
    private let codexMessage = "Sending from chat isn't available for Codex yet; reply in the terminal."

    private func with(_ i: MirrorInfo, state: String? = nil, agent: String? = nil, activity: String? = nil, prompt: String? = nil,
                      block: MirrorInfo.SendBlock?? = nil) -> MirrorInfo {
        MirrorInfo(state: state ?? i.state, agent: agent ?? i.agent, conversationId: i.conversationId, activity: activity ?? i.activity,
                   terminalPrompt: prompt.map(MirrorInfo.TerminalPrompt.init) ?? i.terminalPrompt, sendBlock: block ?? i.sendBlock)
    }

    /// Images reach the terminal's agent as their container paths after the text; no line starts with `/` (devd refuses
    /// a command at the start of any line).
    func testImagesGoAsTheirPathsAfterTheText() {
        XCTAssertEqual(MirrorView.messageText("hi", imagePaths: []), "hi")
        let text = MirrorView.messageText("look\nhere", imagePaths: ["/inbox/s/a.png", "/inbox/s/b.jpg"])
        XCTAssertEqual(text, "look\nhere\n\nAttached image: /inbox/s/a.png\nAttached image: /inbox/s/b.jpg")
        XCTAssertFalse(text.split(separator: "\n").contains { $0.hasPrefix("/") })
    }

    func testARefusedSendBecomesTheLockOtherFailuresStayErrors() {
        let draft = DevdHTTPError(statusCode: 409, serverMessage: "terminal-has-draft", serverDetail: "Text is already typed.")
        XCTAssertEqual(MirrorView.sendLock(draft), MirrorLock(code: "terminal-has-draft", message: "Text is already typed."))
        let codex = DevdHTTPError(statusCode: 409, serverMessage: "codex-send-unsupported", serverDetail: codexMessage)
        XCTAssertEqual(MirrorView.sendLock(codex), MirrorLock(code: "codex-send-unsupported", message: codexMessage))
        XCTAssertNil(MirrorView.sendLock(DevdHTTPError(statusCode: 400, serverMessage: "Commands can't be sent")))
        XCTAssertEqual(MirrorView.sendLock(DevdHTTPError(statusCode: 409, serverMessage: "session-ending")),
                       MirrorLock(code: "session-ending", message: "This session is ending; nothing more can be sent to it."))
        XCTAssertEqual(MirrorView.sendLock(DevdHTTPError(statusCode: 404, serverMessage: "unknown-session")),
                       MirrorLock(code: "unknown-session", message: "devd no longer has this session."))
        XCTAssertEqual(MirrorView.sendLock(DevdHTTPError(statusCode: 409, serverMessage: "not-a-tmux-session"))?.code, "not-a-tmux-session")
        XCTAssertNil(MirrorView.sendLock(DevdHTTPError(statusCode: 409, serverMessage: "something-new")))
        XCTAssertNil(MirrorView.sendLock(URLError(.notConnectedToInternet)))
        // The first path never connected, the fallback reached devd and was refused: the lock, not the combined text.
        let viaFallback = DevdClientError(description: "Tailscale: …; Cloudflare: …", underlying: [URLError(.cannotConnectToHost), draft])
        XCTAssertEqual(MirrorView.sendLock(viaFallback), MirrorLock(code: "terminal-has-draft", message: "Text is already typed."))
        XCTAssertNil(MirrorView.sendLock(DevdClientError(description: "both", underlying: [draft, URLError(.timedOut)])),
                     "the attempt made last decides, as for mayHaveArrived")
    }

    /// Only a request cut off on the way may have been typed; an error raised before anything went out, or a connect
    /// that never reached devd, is said as it is.
    func testOnlyACutOffSendMayHaveArrived() {
        XCTAssertTrue(MirrorView.mayHaveArrived(URLError(.timedOut)))
        XCTAssertTrue(MirrorView.mayHaveArrived(URLError(.networkConnectionLost)))
        XCTAssertTrue(MirrorView.mayHaveArrived(CancellationError()))
        XCTAssertFalse(MirrorView.mayHaveArrived(URLError(.notConnectedToInternet)), "never left the device")
        XCTAssertFalse(MirrorView.mayHaveArrived(URLError(.cannotConnectToHost)))
        XCTAssertFalse(MirrorView.mayHaveArrived(DevdClientError(description: "No network path configured")))
        XCTAssertFalse(MirrorView.mayHaveArrived(DevdClientError(description: "Invalid URL: /x")))
        XCTAssertFalse(MirrorView.mayHaveArrived(DevdClientError(description: "CF path missing service token")))
        XCTAssertFalse(MirrorView.mayHaveArrived(DevdHTTPError(statusCode: 500, serverMessage: "boom")), "devd answered")
        XCTAssertFalse(MirrorView.mayHaveArrived(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x"))))
        // Both paths failed: the fallback's attempt decides.
        XCTAssertTrue(MirrorView.mayHaveArrived(DevdClientError(description: "both", underlying: [URLError(.cannotConnectToHost), URLError(.timedOut)])))
        XCTAssertFalse(MirrorView.mayHaveArrived(DevdClientError(description: "both", underlying: [URLError(.cannotConnectToHost), URLError(.cannotFindHost)])))
    }

    func testTheLineAboveTheComposerPromptFirstThenTheRefusedSendThenDevdsReason() {
        XCTAssertNil(MirrorView.notice(live, lock: nil))
        let exited = with(live, state: "agent-exited", block: .init(code: "agent-not-running", message: "No agent runs."))
        XCTAssertEqual(MirrorView.notice(exited, lock: nil), .init(kind: .lock, text: "No agent runs.", dismissible: false))
        XCTAssertEqual(MirrorView.notice(live, lock: MirrorLock(code: "terminal-has-draft", message: "Draft.")),
                       .init(kind: .lock, text: "Draft.", dismissible: true))
        let waiting = with(live, activity: "waiting", prompt: "Which file?", block: .init(code: "agent-waiting-in-terminal", message: "Answer it there."))
        let n = MirrorView.notice(waiting, lock: MirrorLock(code: "terminal-has-draft", message: "Draft."))
        XCTAssertEqual(n, .init(kind: .prompt, text: "Which file?", dismissible: false))
        XCTAssertEqual(n?.announcement, "Waiting for you in the terminal: Which file?")
    }

    func testOnlyDevdsStandingReasonTurnsTheFieldOff() {
        XCTAssertNil(MirrorView.fieldOff(live))
        XCTAssertEqual(MirrorView.fieldOff(with(live, block: .init(code: "agent-not-running", message: "No agent runs."))), "No agent runs.")
    }

    func testACodexConversationIsReadOnlyLockedWithOpenTerminal() {
        let codex = with(live, agent: "Codex", block: .init(code: "codex-send-unsupported", message: codexMessage))
        XCTAssertEqual(MirrorView.notice(codex, lock: nil), .init(kind: .lock, text: codexMessage, dismissible: false))
        XCTAssertEqual(MirrorView.fieldOff(codex), codexMessage)
        XCTAssertNil(MirrorView.unsupported(codex))
    }

    func testWhyChatCannotShowATmuxSession() {
        let grok = with(live, state: "unsupported", agent: "Grok Build", block: .init(code: "unsupported-agent", message: "Chat view isn't supported for Grok Build yet."))
        XCTAssertEqual(MirrorView.chatUnavailable(mirror: grok, loadError: nil, isTmux: true), "Chat view isn't supported for Grok Build yet.")
        XCTAssertEqual(MirrorView.chatUnavailable(mirror: nil, loadError: "timed out", isTmux: true), "Could not load the terminal's conversation: timed out")
        XCTAssertNil(MirrorView.chatUnavailable(mirror: live, loadError: nil, isTmux: true))
        XCTAssertNil(MirrorView.chatUnavailable(mirror: nil, loadError: nil, isTmux: true), "still loading")
        XCTAssertNil(MirrorView.chatUnavailable(mirror: nil, loadError: "timed out", isTmux: false), "a chat session's thread has no terminal to fall back to")
        let codex = with(live, agent: "Codex", block: .init(code: "codex-send-unsupported", message: codexMessage))
        XCTAssertNil(MirrorView.chatUnavailable(mirror: codex, loadError: nil, isTmux: true), "a locked mirror still shows its Chat, the lock in it")
    }

    func testAnAgentTheMirrorCannotReadSaysSoByName() {
        XCTAssertNil(MirrorView.unsupported(live))
        let grok = with(live, state: "unsupported", agent: "Grok Build", block: .init(code: "unsupported-agent", message: "Chat view isn't supported for Grok Build yet."))
        XCTAssertEqual(MirrorView.unsupported(grok), "Chat view isn't supported for Grok Build yet.")
        XCTAssertEqual(MirrorView.unsupported(with(grok, block: .some(nil))), "Chat view isn't supported for Grok Build yet.")
    }

    func testTheLockStaysUntilThePaneReallyChanges() {
        XCTAssertTrue(MirrorView.keepsLock(from: live, to: live))
        XCTAssertTrue(MirrorView.keepsLock(from: nil, to: live))
        XCTAssertFalse(MirrorView.keepsLock(from: live, to: with(live, activity: "busy")))
        XCTAssertFalse(MirrorView.keepsLock(from: live, to: with(live, block: .init(code: "terminal-scrolled", message: "Scrolled."))))
    }
}
