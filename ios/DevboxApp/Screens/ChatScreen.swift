import SwiftUI

/// A chat session's conversation (dashboard/src/pages/SessionPage.tsx): the thread live over devd's stream, the
/// composer with the model, account and agent switchers, and the session's terminal from the toolbar. A tmux session
/// shows its pane's transcript instead (devd's mirror), with a plain composer that types into the pane and the
/// reason when it cannot. iOS drops the stream in the background; coming back catches up from the thread's seq
/// (`ThreadStore.resume`).
struct ChatScreen: View {
    @StateObject private var store: ThreadStore
    @EnvironmentObject private var live: LiveStore
    @Environment(\.scenePhase) private var scenePhase
    /// The iPhone's full-screen terminal; the user's open and close are remembered for a tmux session's inbox row.
    @State private var terminalSheet = TerminalSheet()
    /// The user's switch made before the mirror and the live list said which tmux session this is; stored once they do.
    @State private var pendingTab: TmuxTabMemory.Tab?
    #if os(macOS)
    /// macOS does not move `scenePhase` when the owner switches to another app or window and back; the window becomes
    /// key again. That is the look, but only after he really left (`away`): the window also becomes key again when a
    /// sheet, alert or popover of its own closes, and on its opening (which start() marks).
    @State private var hostWindow: NSWindow?
    /// Another app came to the front, or another window (not one of this window's own) became key.
    @State private var away = false
    #endif
    @State private var atEnd = true
    @State private var wentAway = false
    /// On screen (not under a pushed screen or another tab): only then does coming back reopen the stream.
    @State private var visible = false
    /// Room under the thread's end that keeps a sliver of a row from showing at the top edge (ThreadEdge, Mac).
    @State private var edgePad: CGFloat = 0
    @State private var rowFrames = ThreadEdge.Frames()
    @State private var viewportTop: CGFloat = 0
    /// The thread's height without that room: a change (a card that loaded, a row that grew) measures the edge again.
    @State private var contentHeight = 0
    private let sessionId: String
    private let client: DevdClient

    /// The Mac shows the terminal in a tab of the thread's window; it passes how to switch to it. nil: a full-screen
    /// terminal from the toolbar (iPhone).
    private let openTerminal: (() -> Void)?
    /// The Mac closes the thread's window when its session ended; nil on iPhone (back navigation does it).
    private let closeWindow: (() -> Void)?
    /// The Mac header's changes chip: each new value scrolls the thread to the changes card and opens it.
    private let revealChanges: Int
    /// The same from the iPhone's own header chip.
    @State private var ownReveal = 0
    /// The changes card's list. It starts shut each time the thread opens: the card is one row until asked.
    @State private var changesOpen = false

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

    /// The header names the thread as the inbox and the Mac do (InboxView.sessionTitle): its nickname, else a short
    /// title from its first message, else the repo and session number, with where it runs under it.
    private var heading: (title: String, place: String?) {
        guard let s = live.live?.sessions.first(where: { $0.id == sessionId }) else { return (sessionId, nil) }
        return (InboxView.sessionTitle(sessionId: s.id, name: s.name, project: s.project, repo: s.repo, topic: store.title), "\(s.project) / \(s.repo)")
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
            } else if store.noLongerTmux {
                ContentUnavailableView(MirrorView.noLongerTmux, systemImage: "terminal")
            } else if let reason = store.mirror.flatMap(MirrorView.unsupported) {
                ContentUnavailableView {
                    Label(reason, systemImage: "terminal")
                } description: {
                    Text("Its agent runs in the terminal.")
                } actions: {
                    Button("Open terminal", action: toTerminal)
                }
            } else if let thread = store.thread {
                conversation(thread)
            } else if let error = store.loadError {
                ContentUnavailableView {
                    Label(store.isTmux ? "Could not load the terminal's conversation" : "Could not load the thread",
                          systemImage: "bubble.left.and.exclamationmark.bubble.right")
                } description: {
                    Text(error)
                } actions: {
                    // The way out a tmux session always had.
                    if store.isTmux { Button("Open terminal", action: toTerminal) }
                }
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
                    // Where it runs and what it is doing ("Working…", "Finished 3m ago"), as the inbox row says.
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let state = runState(now: context.date)
                        let line = [heading.place, state].compactMap { $0 }.joined(separator: " · ")
                        if !line.isEmpty {
                            Text(line).font(.caption).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // One element read as "title, place, state", whatever the layout.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel([heading.title, heading.place, runState(now: Date())]
                    .compactMap { $0 }.joined(separator: ", "))
            }
            #endif
            if openTerminal == nil {
                ToolbarItem(placement: .primaryAction) {
                    // As the Mac's header: the worktree's +/−, a tap away from anywhere in the thread.
                    ChangesChip(store: store, client: client) { ownReveal += 1 }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { remember(terminalSheet.userOpens()) } label: { Label("Terminal", systemImage: "terminal") }
                }
            }
        }
        .fullScreenOrSheet(isPresented: Binding(get: { terminalSheet.shown },
                                                set: { if !$0 { remember(terminalSheet.closed()) } })) {
            TerminalScreen(sessionId: sessionId, title: title, client: client, notice: chatUnavailable)
        }
        // A Chat that cannot be shown opens the terminal, once, saying why; closing it leaves the reason here with
        // Open terminal. The Mac switches its own tab instead (MacThreadDetail).
        .onChange(of: chatUnavailable) { _, reason in
            if openTerminal == nil { terminalSheet.chatUnavailable(reason) }
        }
        .onChange(of: store.isTmux) { storePendingTab() }
        .onChange(of: sessionCreatedAt) { storePendingTab() }
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
                // On the Mac the window becoming key is the look (below), once.
                #if os(macOS)
                Task { await store.resume(look: false) }
                #else
                Task { await store.resume() }
                #endif
            } else if phase == .active, visible {
                // Back to the app without it going to the background (Control Center, a call): a look, which restarts
                // devd's auto-settle clock. resume() above looks on its own.
                #if os(iOS)
                store.markSeen(look: true)
                #endif
            }
        }
        #if os(macOS)
        .background(WindowConfigurator { w in
            DispatchQueue.main.async { hostWindow = w }
        })
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { n in
            guard let w = n.object as? NSWindow, let host = hostWindow else { return }
            if w === host {
                if away, visible { store.markSeen(look: true) }
                away = false
            } else if w.sheetParent !== host, w.parent !== host {
                away = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in away = true }
        #endif
    }

    /// The header's state. A tmux session's comes from devd's look at the pane, as the web's: its transcript has no
    /// turn yet while the agent waits for an answer only the terminal can give.
    private func runState(now: Date) -> String? {
        switch store.mirror?.activity {
        case "busy": return "Working…"
        case "waiting": return "Needs you"
        default: return store.thread.flatMap { ThreadView.runState($0, now: InboxView.ms(now)) }
        }
    }

    private var chatUnavailable: String? {
        MirrorView.chatUnavailable(mirror: store.mirror, loadError: store.loadError, isTmux: store.isTmux)
    }

    /// Open terminal: the Mac's tab, else the full-screen terminal. A refused send's lock goes with it, as on the web.
    private func toTerminal() {
        store.sendLock = nil
        if let openTerminal { openTerminal() } else { remember(terminalSheet.userOpens()) }
    }

    /// The user's switch, for a tmux session's inbox row (InboxRoute.row); nil (an automatic one) stores nothing.
    private func remember(_ tab: TmuxTabMemory.Tab?) {
        guard let tab else { return }
        pendingTab = tab
        storePendingTab()
    }

    /// Waits for the mirror (`isTmux`) and the live list's row (its created_at keys the memory); a chat session's
    /// switch is never stored, its row always opening the thread.
    private func storePendingTab() {
        guard let tab = pendingTab, store.isTmux, let createdAt = sessionCreatedAt else { return }
        TmuxTabMemory.shared.remember(tab, for: TmuxTabMemory.key(sessionId, createdAt: createdAt))
        pendingTab = nil
    }

    private var sessionCreatedAt: Int? { live.live?.sessions.first(where: { $0.id == sessionId })?.created_at }

    private func conversation(_ t: ThreadSnapshot) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    banners
                    if t.items.isEmpty {
                        EmptyState(store.isTmux ? "No messages yet — the agent's conversation in the terminal shows up here."
                                   : "No messages yet — write the first message below.", systemImage: "bubble.left")
                    }
                    let turnStarts = WorkGroups.turnStarts(store.display)
                    ForEach(store.display) { row in
                        switch row {
                        case .work(let w): WorkGroupView(work: w).equatable().modifier(ThreadEdge.Track(id: row.id, frames: rowFrames))
                        case .item(let r, _):
                            MessageRow(row: r, sessionId: sessionId, client: client,
                                       onAnswer: { try await store.answer(requestId: $0, answer: $1) })
                                .equatable()
                                .modifier(ThreadEdge.Track(id: row.id, frames: rowFrames, quiet: r.item.kind == .notice && !r.failedRun && !r.item.warns))
                                // A prompt opens a turn: a little more room above it, so prompt, work and answer read
                                // as one group.
                                .padding(.top, turnStarts.contains(row.id) ? ChatLayout.turnGap : 0)
                            if let anchor = store.changesAnchor, anchor.rowId == r.id {
                                ChangesCard(sessionId: sessionId, client: client, refreshKey: anchor.endedSeq, open: $changesOpen)
                                    .id(Self.changesId)
                                    .modifier(ThreadEdge.Track(id: Self.changesId, frames: rowFrames))
                            }
                        }
                    }
                    if !t.background.isEmpty {
                        Text("background: \(t.background.map(\.label).joined(separator: ", "))")
                            .font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    if edgePad > 0 { Color.clear.frame(height: edgePad).accessibilityHidden(true) }
                    // Follow the conversation while the user is at its end; leave them alone when they scrolled up.
                    Color.clear.frame(height: 1).id("end")
                        .onAppear { atEnd = true }
                        .onDisappear { atEnd = false }
                }
                .padding(Theme.S.screenPadding)
                .padding(.top, ChatLayout.top)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                    if ChatLayout.trimTopEdge { contentHeight = Int(($0 - edgePad).rounded()) }
                }
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
            .onChange(of: revealChanges + ownReveal) { _, _ in
                // The card sits in its answer's ForEach row: a lazy stack scrolls to that row's identity even when it
                // is not built yet, and to the card itself only once it is.
                guard let anchor = store.changesAnchor else { return }
                changesOpen = true
                proxy.scrollTo(ThreadDisplayRow.itemId(anchor.rowId), anchor: .top)
                DispatchQueue.main.async { withAnimation(.snappy) { proxy.scrollTo(Self.changesId, anchor: .top) } }
            }
            // Once the thread settles at its end, push a cut row's sliver up past the edge.
            .task(id: [t.lastSeq, t.items.count, contentHeight]) {
                // Only at the end: resetting the pad while the user reads further up would shift what they read.
                guard ChatLayout.trimTopEdge, atEnd else { return }
                edgePad = 0
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled, atEnd, let pad = ThreadEdge.pad(Array(rowFrames.rows.values), top: viewportTop) else { return }
                edgePad = pad
                proxy.scrollTo("end", anchor: .bottom)
            }
            .safeAreaInset(edge: .bottom) {
                Group {
                    if let mirror = store.mirror {
                        mirrorComposer(mirror)
                    } else {
                        ChatSwitchers(sessionId: sessionId, thread: t, targetKey: store.switchKey, client: client) { chip, status in
                            VStack(alignment: .leading, spacing: 6) {
                                status
                                ComposerView(running: ThreadView.activeRun(t) != nil, chip: chip,
                                             onSend: { try await store.send(text: $0, images: $1); return true },
                                             onStop: { try await store.interrupt() },
                                             // A chat session always runs on the VPS (devd's chatRuntimeBlock), where devd lists files.
                                             commands: t.commands,
                                             searchFiles: { [client, sessionId] in try await searchSessionFiles(client, sessionId: sessionId, query: $0) })
                            }
                        }
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
                #if os(iOS)
                // The thread fades out just under the header, as it does above the composer, instead of a line of
                // text cut at the hairline (the Mac rests clear of the edge instead, ThreadEdge).
                LinearGradient(colors: [Theme.C.background, Theme.C.background.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(height: ChatLayout.top).allowsHitTesting(false).accessibilityHidden(true)
                #endif
            }
            .overlay(alignment: .top) {
                Rectangle().fill(Theme.C.border).frame(height: 1 / 3).accessibilityHidden(true)
                    // The header's edge, where a row would show cut (ThreadEdge), in the rows' space.
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: {
                        if ChatLayout.trimTopEdge { viewportTop = $0 }
                    }
            }
        }
    }

    private static let changesId = "changes"

    /// The terminal's agent: what is typed here goes into its pane. No model or effort chip, no `/` commands (devd
    /// refuses them: they belong in the terminal) and no `@` files; images go as files (ThreadStore.sendToPane).
    private func mirrorComposer(_ mirror: MirrorInfo) -> some View {
        let notice = MirrorView.notice(mirror, lock: store.sendLock)
        return VStack(alignment: .leading, spacing: 6) {
            if let notice {
                MirrorNoticeBar(notice: notice, openTerminal: toTerminal, dismiss: { store.sendLock = nil })
            }
            ComposerView(running: false, chip: nil,
                         onSend: { try await store.sendToPane(text: $0, images: $1) },
                         onStop: {},
                         placeholder: MirrorView.placeholder, fieldOff: MirrorView.fieldOff(mirror))
        }
        // VoiceOver hears each new line once, as the web's live region says it: the one there on opening too.
        .onAppear { if let text = notice?.announcement { AccessibilityNotification.Announcement(text).post() } }
        .onChange(of: notice?.announcement) { _, text in
            if let text { AccessibilityNotification.Announcement(text).post() }
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

/// Resting at the thread's end, the top edge can cut a row, leaving a sliver of a line under the header, or a quiet
/// notice ("Agent bridge restarted") can be the first thing in view. When the sliver and the notices right under it
/// take at most `maxSliver`, the thread gets that much room under its end, so they scroll out of view; a taller part
/// of a row stays (it is readable, and hiding it would hide content). Mac only (ChatLayout.trimTopEdge).
enum ThreadEdge {
    static let maxSliver: CGFloat = 80

    struct Row: Equatable {
        var rect: CGRect
        /// A notice that may scroll away with a sliver (not a failed run's, which stays prominent).
        var quiet = false
    }

    /// Row frames by row id, in the window's space (as the header's edge). A class: rows write while scrolling, and no write may
    /// redraw the thread.
    final class Frames { var rows: [String: Row] = [:] }

    struct Track: ViewModifier {
        let id: String
        let frames: Frames
        var quiet = false

        func body(content: Content) -> some View {
            if ChatLayout.trimTopEdge {
                content
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        frames.rows[id] = Row(rect: $0, quiet: quiet)
                    }
                    // A lazy row out of view keeps no stale frame that could pass for a cut one.
                    .onDisappear { frames.rows[id] = nil }
            } else {
                content
            }
        }
    }

    /// The room that lifts a cut sliver and the quiet notices under it out of view at the edge `top`, or nil when
    /// there is none or it would take more than `maxSliver`.
    static func pad(_ rows: [Row], top: CGFloat) -> CGFloat? {
        let visible = rows.filter { $0.rect.maxY > top + 0.5 }.sorted { $0.rect.minY < $1.rect.minY }
        var pad: CGFloat = 0
        for (n, row) in visible.enumerated() {
            let cut = n == 0 && row.rect.minY < top - 0.5
            guard cut || row.quiet else { break }
            let next = row.rect.maxY - top
            guard next <= maxSliver else { break }
            pad = next
        }
        return pad > 0 ? pad.rounded(.up) : nil
    }
}
