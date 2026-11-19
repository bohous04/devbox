import SwiftUI

/// A chat session's conversation (dashboard/src/pages/SessionPage.tsx): the thread live over devd's stream, the
/// composer with the model, account and agent switchers, and the session's terminal from the toolbar. iOS drops
/// the stream in the background; coming back catches up from the thread's seq (`ThreadStore.resume`).
struct ChatScreen: View {
    @StateObject private var store: ThreadStore
    @EnvironmentObject private var live: LiveStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var showTerminal = false
    @State private var atEnd = true
    @State private var wentAway = false
    /// On screen (not under a pushed screen or another tab): only then does coming back reopen the stream.
    @State private var visible = false
    private let sessionId: String
    private let client: DevdClient

    /// The Mac shows the terminal in a tab of the thread's window; it passes how to switch to it. nil: a full-screen
    /// terminal from the toolbar (iPhone).
    private let openTerminal: (() -> Void)?
    /// The Mac closes the thread's window when its session ended; nil on iPhone (back navigation does it).
    private let closeWindow: (() -> Void)?

    init(sessionId: String, client: DevdClient) {
        self.sessionId = sessionId
        self.client = client
        openTerminal = nil
        closeWindow = nil
        _store = StateObject(wrappedValue: ThreadStore(sessionId: sessionId, client: client))
    }

    /// The Mac keeps the store outside the screen: its window restores it and saves its seq at quit.
    init(store: ThreadStore, client: DevdClient, openTerminal: (() -> Void)?, closeWindow: (() -> Void)?) {
        self.sessionId = store.sessionId
        self.client = client
        self.openTerminal = openTerminal
        self.closeWindow = closeWindow
        _store = StateObject(wrappedValue: store)
    }

    private var title: String {
        guard let s = live.live?.sessions.first(where: { $0.id == sessionId }) else { return sessionId }
        if let name = s.name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        return "\(s.project)/\(s.repo)"
    }

    var body: some View {
        Group {
            if store.ended {
                ContentUnavailableView {
                    Label("Session ended", systemImage: "checkmark.circle")
                } description: {
                    Text("devd no longer has this session.")
                } actions: {
                    if let closeWindow { Button("Close window", action: closeWindow) }
                }
            } else if store.isTmux {
                ContentUnavailableView {
                    Label("This is a tmux session", systemImage: "terminal")
                } description: {
                    Text("It has no chat thread; its agent runs in the terminal.")
                } actions: {
                    Button("Open the terminal") { if let openTerminal { openTerminal() } else { showTerminal = true } }
                }
            } else if let thread = store.thread {
                conversation(thread)
            } else if let error = store.loadError {
                ContentUnavailableView("Could not load the thread", systemImage: "bubble.left.and.exclamationmark.bubble.right", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.C.background)
        .navigationTitle(title)
        .inlineNavigationTitle()
        .toolbar {
            if openTerminal == nil {
                ToolbarItem(placement: .primaryAction) {
                    Button { showTerminal = true } label: { Label("Terminal", systemImage: "terminal") }
                }
            }
        }
        .fullScreenOrSheet(isPresented: $showTerminal) {
            TerminalScreen(sessionId: sessionId, title: title, client: client)
        }
        .task { await store.start() }
        .onAppear { visible = true }
        .onDisappear {
            visible = false
            store.stop()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                wentAway = true
                store.stop()
            } else if phase == .active, wentAway, visible {
                wentAway = false
                Task { await store.resume() }
            }
        }
    }

    private func conversation(_ t: ThreadSnapshot) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    banners
                    if t.items.isEmpty {
                        EmptyState("No messages yet — write the first message below.", systemImage: "bubble.left")
                    }
                    ForEach(store.rows) { row in
                        MessageRow(row: row, sessionId: sessionId, client: client,
                                   onAnswer: { try await store.answer(requestId: $0, answer: $1) })
                            .equatable()
                    }
                    if !t.background.isEmpty {
                        Text("background: \(t.background.map(\.label).joined(separator: ", "))")
                            .font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    // Follow the conversation while the user is at its end; leave them alone when they scrolled up.
                    Color.clear.frame(height: 1).id("end")
                        .onAppear { atEnd = true }
                        .onDisappear { atEnd = false }
                }
                .padding(Theme.S.screenPadding)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            // lastSeq moves with events; a notice adds an item without one.
            .onChange(of: [t.lastSeq, t.items.count]) { _, _ in
                if atEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 6) {
                    ChatSwitchers(sessionId: sessionId, thread: t, targetKey: store.switchKey, client: client)
                    ComposerView(running: ThreadView.activeRun(t) != nil,
                                 onSend: { try await store.send(text: $0, images: $1) },
                                 onStop: { try await store.interrupt() })
                }
                .padding(.horizontal, Theme.S.screenPadding)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
    }

    @ViewBuilder
    private var banners: some View {
        if store.ending {
            Text("Session is ending…")
                .font(Theme.F.meta).foregroundStyle(Theme.C.warnText)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.C.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.R.md))
        } else if store.paused || store.badFrame != nil {
            Text(store.paused ? "Live updates paused — reconnecting" : "Live update dropped: \(store.badFrame ?? "") — reopen the thread to catch up")
                .font(Theme.F.meta).foregroundStyle(Theme.C.warnText)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.C.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.R.md))
        }
        if let seen = store.seenError {
            Text("Could not mark the thread as seen: \(seen)").font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
        }
    }
}
