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
    /// The Mac header's changes chip: each new value scrolls the thread to the changes card.
    private let revealChanges: Int

    init(sessionId: String, client: DevdClient) {
        self.sessionId = sessionId
        self.client = client
        openTerminal = nil
        closeWindow = nil
        revealChanges = 0
        _store = StateObject(wrappedValue: ThreadStore(sessionId: sessionId, client: client))
    }

    /// The Mac keeps the store outside the screen: its window restores it and saves its seq at quit.
    init(store: ThreadStore, client: DevdClient, openTerminal: (() -> Void)?, closeWindow: (() -> Void)?, revealChanges: Int = 0) {
        self.sessionId = store.sessionId
        self.client = client
        self.openTerminal = openTerminal
        self.closeWindow = closeWindow
        self.revealChanges = revealChanges
        _store = StateObject(wrappedValue: store)
    }

    private var title: String {
        guard let s = live.live?.sessions.first(where: { $0.id == sessionId }) else { return sessionId }
        if let name = s.name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        return "\(s.project)/\(s.repo)"
    }

    /// The header names the thread like the web's: its nickname, else a short title from its first message, with
    /// where it runs under it. nil until the thread and the session are known.
    private var heading: (title: String, place: String?) {
        let s = live.live?.sessions.first(where: { $0.id == sessionId })
        let place = s.map { "\($0.project) / \($0.repo)" }
        if let name = s?.name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return (name, place) }
        if let t = store.title { return (t, place) }
        return (place ?? sessionId, nil)
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
        .navigationTitle(heading.title)
        .inlineNavigationTitle()
        .solidNavigationBar()
        .hidesTabBar()
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .principal) {
                // Title and place share one left edge, next to the back button.
                VStack(alignment: .leading, spacing: 0) {
                    Text(heading.title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                    if let place = heading.place {
                        Text(place).font(.system(size: 12)).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
            #endif
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
                LazyVStack(alignment: .leading, spacing: 16) {
                    banners
                    if t.items.isEmpty {
                        EmptyState("No messages yet — write the first message below.", systemImage: "bubble.left")
                    }
                    ForEach(store.display) { row in
                        switch row {
                        case .work(let w): WorkGroupView(work: w).equatable()
                        case .item(let r, _):
                            MessageRow(row: r, sessionId: sessionId, client: client,
                                       onAnswer: { try await store.answer(requestId: $0, answer: $1) })
                                .equatable()
                            if let anchor = store.changesAnchor, anchor.rowId == r.id {
                                ChangesCard(sessionId: sessionId, client: client, refreshKey: anchor.endedSeq)
                                    .id(Self.changesId)
                            }
                        }
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
                .padding(.top, ChatLayout.top)
                // The Mac reads in a centred column; the iPhone's is the screen.
                .frame(maxWidth: ChatLayout.column)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            // lastSeq moves with events; a notice adds an item without one.
            .onChange(of: [t.lastSeq, t.items.count]) { _, _ in
                if atEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: revealChanges) { _, _ in withAnimation(.snappy) { proxy.scrollTo(Self.changesId, anchor: .top) } }
            .safeAreaInset(edge: .bottom) {
                ChatSwitchers(sessionId: sessionId, thread: t, targetKey: store.switchKey, client: client) { chip, status in
                    VStack(alignment: .leading, spacing: 6) {
                        status
                        ComposerView(running: ThreadView.activeRun(t) != nil, chip: chip,
                                     onSend: { try await store.send(text: $0, images: $1) },
                                     onStop: { try await store.interrupt() })
                    }
                }
                .padding(.horizontal, Theme.S.screenPadding)
                .frame(maxWidth: ChatLayout.column)
                .frame(maxWidth: .infinity)
                .padding(.top, 8).padding(.bottom, 6)
                // Opaque: the thread scrolls under the composer, not through it, and fades out just above it
                // instead of being cut at a hard line. The fill runs on under the home indicator and the keyboard,
                // so no strip of the thread shows below the keyboard's rounded corners.
                .background(Theme.C.background.ignoresSafeArea(.all, edges: .bottom))
                .background(alignment: .top) {
                    LinearGradient(colors: [Theme.C.background.opacity(0), Theme.C.background], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24).offset(y: -24).allowsHitTesting(false)
                }
            }
            // Links in agent text open only on the web: a devbox:// deep link, file:, tel: or sms: in an answer or a
            // request prompt does nothing (the text renders them unlinked too; this also covers RequestFormView).
            .environment(\.openURL, OpenURLAction { url in
                ChatMarkdownParse.isWebLink(url) ? .systemAction : .discarded
            })
            // The header's bottom edge: a hairline the thread scrolls under.
            .overlay(alignment: .top) {
                VStack(spacing: 0) {
                    Rectangle().fill(Theme.C.border).frame(height: 1 / 3)
                    #if os(macOS)
                    // The Mac's header is opaque: the thread fades out under it instead of a line cut through its
                    // glyphs, as it does above the composer.
                    LinearGradient(colors: [Theme.C.background, Theme.C.background.opacity(0)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                    #endif
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    private static let changesId = "changes"

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
