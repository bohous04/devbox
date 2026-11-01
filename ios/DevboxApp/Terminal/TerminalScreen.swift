import SwiftTerm
import SwiftUI

// SwiftTerm has its own `Color` (ANSI colors, `init(red: UInt16, …)`) — without this typealias
// `Color(red:green:blue:)` below would silently (WITHOUT an "ambiguous use" error) pick SwiftTerm's overload
// instead of SwiftUI's, because integer division fits its `UInt16` init just as well as
// SwiftUI's `Double` init — it only surfaces as an odd error on a following View modifier.
private typealias Color = SwiftUI.Color

/// Dark terminal background — same value as the web (`Terminal.tsx`: `bg-[#0b0e14]`).
private let terminalBackground = Color(red: 0x0b / 255, green: 0x0e / 255, blue: 0x14 / 255)
private let terminalBackgroundUIColor = UIColor(red: 0x0b / 255, green: 0x0e / 255, blue: 0x14 / 255, alpha: 1)

/// `TerminalView` with a controlled read-only lock. `canBecomeFirstResponder` returns `false` until
/// `isInputEnabled` is `true` — so in read-only mode the soft keyboard on the phone never
/// appears (the web handles read-only only by not forwarding `onData`, keyboard/focus are not
/// affected — on the phone the whole point is that the keyboard does not slide up by itself).
private final class DevboxTerminalView: TerminalView {
    var isInputEnabled = false

    override var canBecomeFirstResponder: Bool { isInputEnabled }

    /// tmux (`mouse on`) enables mouse reporting and SwiftTerm would then add its own pan gesture,
    /// which sends a drag as a mouse drag (in tmux = text selection) and would fight our scrolling
    /// (`TerminalScrollController`). Taps for mouse reporting remain.
    override func mouseModeChanged(source: Terminal) {}
}

/// Controller state of one terminal screen — owns the `TerminalSession` (WS) and holds a weak
/// reference to the live `DevboxTerminalView` (created and managed by `TerminalHostView`) so it can
/// write incoming data and forward size/input. `@MainActor` like the rest of the app's Store
/// layer (`LiveStore`, `AppModel`).
@MainActor
final class TerminalScreenModel: ObservableObject {
    @Published private(set) var connectionState: TerminalSession.State = .connecting
    @Published private(set) var granted = false
    /// "↓ Jump to end" — after scrolling into history; hidden by a tap or by typing after taking control.
    @Published private(set) var showsBottomButton = false

    fileprivate let session: TerminalTransport
    private weak var terminalView: DevboxTerminalView?

    /// Last known size from `sizeChanged` (SwiftTerm, see `handleSizeChanged`). The server
    /// spawns the pty hard-coded at 80×24 and waits for the client's resize (the web sends it in `ws.onopen`) — this
    /// state does the same on EVERY (re)connect, not just on the first layout (see `onStateChange`
    /// below). `nil` until SwiftTerm performs the first layout.
    private var lastCols: Int?
    private var lastRows: Int?

    convenience init(sessionId: String, client: DevdClient) {
        self.init(session: TerminalSession(makeRequest: {
            try await client.wsRequest("/api/sessions/\(sessionId)/terminal")
        }))
    }

    /// Designated init — takes a `TerminalTransport` directly so tests (see
    /// `TerminalScreenModelTests`) can substitute a fake implementation without a real WS.
    ///
    /// CAUTION: the closures below may read `session` only as `self.session`, NEVER capture the
    /// `session` parameter directly — `session.onStateChange = { … session.send(…) … }` (without `self.`) would
    /// make `TerminalSession` hold a closure that holds a strong reference to itself
    /// (self-retain cycle), and `finish()`/`invalidateAndCancel()` (the leak fix, see
    /// `TerminalSessionTests.testCancelInvalidatesURLSessionAllowingDeallocation`) would then never
    /// take effect.
    init(session: TerminalTransport) {
        self.session = session
        session.onStateChange = { [weak self] state in
            guard let self else { return }
            connectionState = state
            // Read-only by default even after a reconnect — one rule ("every transition to .open drops
            // granted") covers the initial connection and every later reconnect alike, see the docstring of
            // `TerminalSession`.
            if state == .open {
                granted = false
                terminalView?.isInputEnabled = false
                _ = terminalView?.resignFirstResponder() // the keyboard must not stay up in read-only
                if let cols = lastCols, let rows = lastRows {
                    self.session.send(TerminalProto.encodeResize(cols: cols, rows: rows))
                }
            }
        }
        session.onText = { [weak self] text in
            self?.terminalView?.feed(text: text)
        }
    }

    func connect() {
        session.connect()
    }

    func disconnect() {
        session.cancel()
    }

    func takeControl() {
        guard !granted else { return }
        granted = true
        terminalView?.isInputEnabled = true
        session.send(TerminalProto.encodeUnlock())
        _ = terminalView?.becomeFirstResponder()
    }

    func sendKey(_ key: String) {
        guard granted, let seq = TerminalProto.keySeq[key] else { return }
        sendInput(seq)
        _ = terminalView?.becomeFirstResponder()
    }

    func sendText(_ text: String) {
        guard granted, !text.isEmpty else { return }
        sendInput(text)
        _ = terminalView?.becomeFirstResponder()
    }

    /// Scrolling tmux history — even in read-only (devd allows it, it writes nothing to the shell).
    func scroll(_ direction: TerminalProto.ScrollDirection, steps: Int) {
        guard steps > 0 else { return }
        session.send(TerminalProto.encodeScroll(direction, n: steps))
        if direction == .up { showsBottomButton = true }
    }

    func scrollToBottom() {
        session.send(TerminalProto.encodeBottom())
        showsBottomButton = false
    }

    /// Typing in copy-mode exits it in tmux for most keys → the "Jump to end" button goes away.
    private func sendInput(_ text: String) {
        session.send(TerminalProto.encodeInput(text))
        showsBottomButton = false
    }

    fileprivate func attach(_ view: DevboxTerminalView) {
        terminalView = view
        view.isInputEnabled = granted
    }

    /// `TerminalViewDelegate.send` — input from the soft/hardware keyboard. The read-only lock
    /// (`canBecomeFirstResponder`) normally prevents it from arising at all, `granted` is a second
    /// safeguard (the same double guard as on the web: focus/grantedRef).
    ///
    /// `String(decoding:as:)` in theory assumes `bytes` carries a WHOLE UTF-8 sequence — if
    /// SwiftTerm ever delivered a multi-byte character (emoji, diacritics from a 3rd-party keyboard) split
    /// across two `send` calls, an invalid fragment would arrive here and `String(decoding:)` would
    /// silently replace it with U+FFFD instead of the correct character. In practice SwiftTerm always calls `send` with one
    /// complete keystroke/paste, so the risk is only theoretical — no logic change here.
    fileprivate func handleTerminalInput(_ bytes: ArraySlice<UInt8>) {
        guard granted else { return }
        sendInput(String(decoding: Array(bytes), as: UTF8.self))
    }

    /// `internal` (not `fileprivate` like the rest of this group) — `TerminalScreenModelTests`
    /// needs to set the size BEFORE a simulated `.open` to verify the resend on (re)connect.
    func handleSizeChanged(cols: Int, rows: Int) {
        lastCols = cols
        lastRows = rows
        session.send(TerminalProto.encodeResize(cols: cols, rows: rows))
    }
}

/// UIKit `TerminalView` wrapped for SwiftUI — feeds incoming data, forwards keys and size
/// changes (SwiftTerm itself calls `sizeChanged` from `layoutSubviews` whenever the bounds change).
private struct TerminalHostView: UIViewRepresentable {
    @ObservedObject var model: TerminalScreenModel

    func makeUIView(context: Context) -> DevboxTerminalView {
        let view = DevboxTerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.nativeBackgroundColor = terminalBackgroundUIColor
        // SwiftTerm's own scrollback is empty under tmux — scrolling goes through tmux.
        view.isScrollEnabled = false
        context.coordinator.scroller.install(on: view)
        model.attach(view)
        return view
    }

    func updateUIView(_ uiView: DevboxTerminalView, context: Context) {
        uiView.isInputEnabled = model.granted
    }

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    /// SwiftTerm calls the delegate methods synchronously from the main thread (keyboard/layout are UIKit
    /// events) — so `@MainActor` on the Coordinator is a safe direct write to `model`, not just
    /// a courtesy annotation as with `TerminalSession`'s `URLSessionWebSocketDelegate` (which is
    /// called from a genuinely different thread).
    @MainActor
    final class Coordinator: NSObject, TerminalViewDelegate {
        let model: TerminalScreenModel
        let scroller: TerminalScrollController
        init(model: TerminalScreenModel) {
            self.model = model
            scroller = TerminalScrollController(model: model)
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            model.handleSizeChanged(cols: newCols, rows: newRows)
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            model.handleTerminalInput(data)
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func clipboardRead(source: TerminalView) -> Data? { nil }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

/// Vertical finger drag → wheel steps for tmux (`TerminalScreenModel.scroll`), after release a coast
/// (`ScrollInertia`) via CADisplayLink. Steps from one event/frame go in a single message.
@MainActor
final class TerminalScrollController: NSObject, UIGestureRecognizerDelegate {
    private weak var model: TerminalScreenModel?
    private weak var view: TerminalView?
    private var stepper = ScrollStepper(lineHeight: 16)
    private var inertia: ScrollInertia?
    private var displayLink: CADisplayLink?
    private var lastTimestamp: CFTimeInterval?

    init(model: TerminalScreenModel) {
        self.model = model
    }

    fileprivate func install(on view: TerminalView) {
        self.view = view
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)
    }

    /// Vertical drag only — horizontal is left to SwiftTerm (selection after long-press etc.).
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard let pan = g as? UIPanGestureRecognizer else { return true }
        let v = pan.velocity(in: pan.view)
        return abs(v.y) > abs(v.x)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    @objc private func handlePan(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            stopInertia()
            // Row height from the current font (SwiftTerm's cellDimension is not public).
            stepper = ScrollStepper(lineHeight: Double(view?.font.lineHeight ?? 16))
            apply(Double(pan.translation(in: pan.view).y))
            pan.setTranslation(.zero, in: pan.view)
        case .changed:
            apply(Double(pan.translation(in: pan.view).y))
            pan.setTranslation(.zero, in: pan.view)
        case .ended:
            startInertia(velocity: Double(pan.velocity(in: pan.view).y))
        default:
            stepper.reset()
        }
    }

    private func apply(_ dy: Double) {
        if let r = stepper.feed(dy) { model?.scroll(r.direction, steps: r.steps) }
    }

    private func startInertia(velocity: Double) {
        inertia = ScrollInertia(velocity: velocity)
        lastTimestamp = nil
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        let dt = lastTimestamp.map { link.timestamp - $0 } ?? link.duration
        lastTimestamp = link.timestamp
        guard let dy = inertia?.step(dt: dt) else { stopInertia(); return }
        apply(dy)
    }

    private func stopInertia() {
        displayLink?.invalidate()
        displayLink = nil
        inertia = nil
    }
}

/// Native terminal over the devd WS — behavior 1:1 with `dashboard/src/components/Terminal.tsx`: default
/// READ-ONLY (keyboard/key bar send nothing until the user taps "Take control", which
/// sends `unlock` and only then enables input), read-only/control taken badge, status text
/// connecting…/empty/disconnected, key bar (`KEY_BAR`) only after taking control, dark background
/// `#0b0e14`. Unlike the web, the app reconnects by itself (see `TerminalSession`); after every
/// (re)connect control reverts to read-only.
struct TerminalScreen: View {
    let title: String
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: TerminalScreenModel

    init(sessionId: String, title: String, client: DevdClient) {
        self.title = title
        _model = StateObject(wrappedValue: TerminalScreenModel(sessionId: sessionId, client: client))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            TerminalHostView(model: model)
                .padding(6)
                .overlay(alignment: .bottomTrailing) {
                    if model.showsBottomButton {
                        Button("↓ Jump to end") { model.scrollToBottom() }
                            .font(.system(size: 14, weight: .medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Color(red: 0x1c / 255, green: 0x22 / 255, blue: 0x30 / 255), in: Capsule())
                            .foregroundStyle(.white)
                            .shadow(radius: 6)
                            .padding(14)
                    }
                }
            if model.granted {
                keyBar
            }
        }
        .background { terminalBackground.ignoresSafeArea() }
        .onAppear { model.connect() }
        .onDisappear { model.disconnect() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(.body, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            statusBadge
            Spacer(minLength: 8)
            Text(statusText)
                .font(.caption)
                .foregroundStyle(Color(white: 0.62))
            if !model.granted {
                Button("Take control") { model.takeControl() }
                    .buttonStyle(.bordered)
                    .tint(.white)
                    .disabled(model.connectionState != .open)
            }
            Button("Close") { dismiss() }
                .buttonStyle(.borderless)
                .tint(Color(white: 0.62))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Divider().background(Color(white: 0.14))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Terminal \(title)")
    }

    private var statusBadge: some View {
        Text(model.granted ? "control taken" : "read-only")
            .font(.system(size: 11, weight: .semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                (model.granted ? Color(red: 0x1f / 255, green: 0x3a / 255, blue: 0x24 / 255)
                    : Color(red: 0x26 / 255, green: 0x30 / 255, blue: 0x3f / 255)),
                in: Capsule()
            )
            .foregroundStyle(model.granted ? Color(red: 0x79 / 255, green: 0xd8 / 255, blue: 0x8b / 255)
                : Color(red: 0x9f / 255, green: 0xb0 / 255, blue: 0xc3 / 255))
    }

    private var statusText: String {
        switch model.connectionState {
        case .open: return ""
        case .connecting: return "connecting…"
        case .closed: return "disconnected"
        }
    }

    private var keyBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                PasteButton(payloadType: String.self) { strings in
                    model.sendText(strings.joined())
                }
                .labelStyle(.titleOnly)
                .font(.system(size: 13, weight: .medium))
                .frame(minWidth: 56, minHeight: 40)
                .tint(Color(red: 0x1c / 255, green: 0x22 / 255, blue: 0x30 / 255))

                ForEach(TerminalProto.keyBar, id: \.self) { key in
                    Button(key) { model.sendKey(key) }
                        .font(.system(size: 13, weight: .medium))
                        .frame(minWidth: 44, minHeight: 40)
                        .background(Color(red: 0x1c / 255, green: 0x22 / 255, blue: 0x30 / 255), in: RoundedRectangle(cornerRadius: 8))
                        .foregroundStyle(.white)
                }
            }
            .padding(.horizontal, 10)
        }
        .padding(.vertical, 8)
        .padding(.bottom, 4)
        .overlay(alignment: .top) {
            Divider().background(Color(white: 0.14))
        }
    }
}
