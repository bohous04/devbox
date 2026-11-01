import Foundation

/// Abstraction over `TerminalSession` only for testability of `TerminalScreenModel` (resize after
/// (re)connect, see `TerminalScreenModelTests`) — the app has a single concrete implementation.
protocol TerminalTransport: AnyObject {
    var onText: ((String) -> Void)? { get set }
    var onStateChange: ((TerminalSession.State) -> Void)? { get set }
    func connect()
    func send(_ text: String)
    func cancel()
}

/// Wrapper over `URLSessionWebSocketTask` for `/api/sessions/:id/terminal` — connect/reconnect with
/// exponential backoff (1 → 15 s, see `nextBackoff`), incoming TEXT messages (the devd terminal
/// sends only text frames) via `onText`, `send(_:)` is a no-op outside the `.open` state (removes the race
/// between the socket closing and the last key from the key bar). Unlike the web (`Terminal.tsx`, where
/// `ws.onclose` only sets "closed" and does nothing else) the app reconnects by itself until
/// the user closes it (`cancel()`) or the server closes it permanently (close code 1008/1013, see
/// `didCloseWith`) — that is why `TerminalScreenModel` after every transition to `.open` (first connect and
/// reconnect) drops "control taken" back to read-only.
///
/// One instance = one terminal presentation (1:1 with `TerminalScreenModel`/`TerminalScreen`),
/// NOT a reusable object: `cancel()` (and a permanent close from the server) invalidates `urlSession` and
/// the instance is not used again (`connect()` after `cancel()` is a no-op) — `URLSession` holds its
/// delegate (`self`) strongly until invalidation; without it `TerminalSession` could never be deallocated.
///
/// State and callbacks run on the MainActor — `TerminalScreen`/`TerminalScreenModel` read them directly without
/// further synchronization. `URLSessionWebSocketDelegate` is called by UIKit/Foundation from the delegate queue
/// (not necessarily the main thread), so those methods are `nonisolated` and hop over via `Task { @MainActor in }` themselves.
@MainActor
final class TerminalSession: NSObject {
    enum State: Equatable {
        case connecting
        case open
        case closed
    }

    private(set) var state: State = .connecting {
        didSet {
            guard state != oldValue else { return }
            onStateChange?(state)
        }
    }

    /// Incoming text message from the server (raw terminal output, not JSON — the server sends
    /// terminal data directly as a WS text frame, with no envelope as for outgoing messages).
    var onText: ((String) -> Void)?
    var onStateChange: ((State) -> Void)?

    // `nonisolated` — pure values/functions with no dependency on instance state, so the test
    // (`TerminalSessionTests.testBackoffProgressionDoublesUpToMax`) can call them synchronously without
    // the MainActor (the class itself is `@MainActor` because of instance state/callbacks, not because of this
    // arithmetic).
    nonisolated static let initialBackoff: TimeInterval = 1
    nonisolated static let maxBackoff: TimeInterval = 15

    /// Pure backoff progression (1, 2, 4, 8, 15, 15, …), without needing a real socket/timer.
    nonisolated static func nextBackoff(_ current: TimeInterval) -> TimeInterval {
        min(current * 2, maxBackoff)
    }

    private let makeRequest: () async throws -> URLRequest
    private var urlSession: URLSession!
    private var task: URLSessionWebSocketTask?
    private var backoff = TerminalSession.initialBackoff
    private var reconnectWorkItem: DispatchWorkItem?
    private var stopped = false

    init(makeRequest: @escaping () async throws -> URLRequest) {
        self.makeRequest = makeRequest
        super.init()
        urlSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    /// Starts the connection — one-shot (see the class docstring). No effect if the socket is already running,
    /// or if the instance has been `cancel()`ed in the meantime.
    func connect() {
        guard !stopped, task == nil else { return }
        open()
    }

    /// No-op outside `.open` — the caller (`TerminalScreenModel`) additionally gates on "control taken", this
    /// is a second safeguard against sending into a dead/closing socket.
    func send(_ text: String) {
        guard state == .open, let task else { return }
        task.send(.string(text)) { _ in }
    }

    /// Ends the session permanently (the user pressed Close / the screen is going away) — no further reconnect.
    func cancel() {
        finish()
    }

    // MARK: - Private

    private func open() {
        state = .connecting
        Task {
            do {
                let request = try await makeRequest()
                guard !stopped else { return }
                let newTask = urlSession.webSocketTask(with: request)
                task = newTask
                newTask.resume()
                receive(on: newTask)
            } catch {
                scheduleReconnect()
            }
        }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                // `self.task` may have been swapped in the meantime (reconnect) — we do not want to
                // extend the old loop or let it reset the new state.
                guard self.task === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message {
                        self.onText?(text)
                    }
                    self.receive(on: task)
                case .failure:
                    self.handleDisconnect()
                }
            }
        }
    }

    private func handleDisconnect() {
        guard !stopped else { return }
        task = nil
        scheduleReconnect()
    }

    /// Permanent shutdown — shared between `cancel()` (user/screen going away) and a permanent close
    /// code from the server (1008/1013, see `didCloseWith`). `invalidateAndCancel()` cancels the last
    /// task AND releases `URLSession`'s strong reference to the delegate (`self`) — without this call
    /// `TerminalSession` could never be deallocated (see `TerminalSessionTests.
    /// testCancelInvalidatesURLSessionAllowingDeallocation`). Guarded on `!stopped` so a double
    /// call (e.g. the server sends 1008 right after the user's Close) does not call `invalidateAndCancel()`
    /// a second time.
    private func finish() {
        guard !stopped else { return }
        stopped = true
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        task = nil
        state = .closed
        urlSession.invalidateAndCancel()
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        state = .connecting
        let delay = backoff
        backoff = Self.nextBackoff(backoff)
        let workItem = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.open() }
        }
        reconnectWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }
}

extension TerminalSession: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in
            guard self.task === webSocketTask else { return }
            self.backoff = Self.initialBackoff // a successful connection resets the countdown for the next outage
            self.state = .open
        }
    }

    nonisolated func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        Task { @MainActor in
            guard self.task === webSocketTask else { return }
            // 1008 (policy violation) / 1013 (try again later) — devd sends these when the server
            // has ended the terminal/session for good (not a transient network outage) — this behaves
            // like the web "disconnected", no further reconnect attempt. Compared via `.rawValue`,
            // not a named case — Foundation's `CloseCode` has no case for 1013.
            if closeCode.rawValue == 1008 || closeCode.rawValue == 1013 {
                self.finish()
                return
            }
            self.handleDisconnect()
        }
    }
}

extension TerminalSession: TerminalTransport {}
