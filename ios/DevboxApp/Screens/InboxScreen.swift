import SwiftUI

/// Where an inbox row leads on the Inbox tab's stack: a session's thread (a tmux session's is its Chat, the mirror),
/// or a tmux session's detail (its terminal is there) when Terminal is the view remembered for it.
enum InboxRoute: Hashable {
    case thread(String)
    case session(String)
    /// An ended session's read-only transcript, by its transcript id (EndedTranscriptScreen).
    case ended(String)

    /// The id the inbox looks the opened row up by; a transcript's matches no session, so nothing is marked seen.
    var sessionId: String {
        switch self {
        case .thread(let id), .session(let id): return id
        case .ended(let id): return InboxView.endedTag(id)
        }
    }

    /// The session the owner is looking at on the Inbox tab: the top of its stack, and none while another tab shows.
    static func opened(path: [InboxRoute], onInboxTab: Bool) -> String? {
        onInboxTab ? path.last?.sessionId : nil
    }

    /// Every session opens its thread (Chat); a tmux one its detail instead when Terminal is the view last opened for
    /// it on this device (TmuxTabMemory). `createdAt`: the session's, from the live list; nil before it loads.
    @MainActor
    static func row(sessionId: String, runtime: InboxItem.Runtime, createdAt: Int?, memory: TmuxTabMemory = .shared) -> InboxRoute {
        guard runtime != .chat else { return .thread(sessionId) }
        let remembered = createdAt.flatMap { memory.tab(for: TmuxTabMemory.key(sessionId, createdAt: $0)) }
        return remembered == .terminal ? .session(sessionId) : .thread(sessionId)
    }
}

/// Every session in one list (InboxView.list, as the Mac sidebar and the dashboard): what asks for action pinned on
/// top, then the rest newest first, each row with a mark only when it has something to say; under it the Working,
/// Snoozed and Settled shelves, collapsed. A row settles in one gesture: its trailing swipe (a full swipe settles),
/// after which a notice offers Undo for a few seconds (InboxSettler). The leading swipe and the context menu snooze.
/// A tmux session's finish clears when it is looked at (`markSeen`). Live over devd's stream; polled every 5 s while
/// the stream is down.
struct InboxScreen: View {
    @StateObject private var store: InboxStore
    @StateObject private var settler = InboxSettler()
    /// For each session's created_at, which keys its remembered view (InboxRoute.row).
    @EnvironmentObject private var live: LiveStore
    /// Watched, so a row leads to the view chosen a moment ago in the session's detail.
    @ObservedObject private var tabs = TmuxTabMemory.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var actionsFor: InboxItem?
    @State private var openShelves: Set<String> = []
    /// Why a row cannot be settled now, after its "Answer first" swipe; goes on its own.
    @State private var hint: String?
    /// On screen (not under a pushed chat or another tab): only then does coming back reopen the stream.
    @State private var visible = false
    private let client: DevdClient
    /// The session on screen over the inbox (InboxRoute.opened), or nil.
    private let opened: String?

    init(client: DevdClient, opened: String? = nil) {
        self.client = client
        self.opened = opened
        _store = StateObject(wrappedValue: InboxStore(client: client))
    }

    var body: some View {
        Group {
            if let items = store.items {
                content(InboxView.group(items))
                    .environment(\.inboxShowsAgent, InboxView.mixedAgents(items))
                    .environment(\.inboxBadgeSlots, store.badgeSlots)
            } else if let error = store.loadError {
                ContentUnavailableView("Can't load the inbox", systemImage: "tray", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.background)
        .navigationTitle("Inbox")
        .task { store.start() }
        .task { await store.loadBadgeSlots() }
        .onAppear { visible = true }
        .onDisappear {
            visible = false
            store.stop()
        }
        // iOS drops the stream in the background; the inbox reloads when the stream reopens. Back in the foreground
        // with a session open, that session has been looked at again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, visible { store.start() } else if phase == .background { store.stop() }
            if phase == .active, let opened { Task { await markSeen(opened, .foreground, reload: true) } }
        }
        // Opening a session is a look at it; leaving it is another (the stream was stopped meanwhile, so the row is
        // read fresh first: it may have finished again while open).
        .onChange(of: opened, initial: true) { old, new in
            settler.actionTaken()
            if let old, old != new { Task { await markSeen(old, .left, reload: true) } }
            if let new, new != old { Task { await markSeen(new, .opened, reload: false) } }
        }
        .sheet(item: $actionsFor) { item in
            InboxRowActions(item: item, store: store) { Task { await settler.settle(item, in: store) } }
                .presentationDetents([.medium, .large])
        }
        .modifier(SettleConfirmation(settler: settler, store: store))
    }

    private func markSeen(_ id: String, _ moment: InboxSettler.Moment, reload: Bool) async {
        if reload { await store.load() }
        guard let item = store.items?.first(where: { $0.sessionId == id }) else { return }
        if InboxSettler.marksSeen(item, on: moment) { await settler.seen(item, in: store) }
        else if InboxSettler.looks(item, on: moment) { await settler.look(item, in: store) }
    }

    @ViewBuilder
    private func content(_ g: InboxView.Groups) -> some View {
        let list = InboxView.list(g)
        ScrollViewReader { proxy in
            // Relative times tick every 15 s, as the dashboard's.
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let now = InboxView.ms(context.date)
                List {
                    if store.paused || store.badFrame != nil {
                        Text(store.paused ? "Live updates paused — refreshing every 5 s\(store.loadError.map { " (last refresh failed: \($0))" } ?? "")"
                             : "Live update dropped: \(store.badFrame ?? "")")
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.warnText)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.C.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.R.md))
                            .plainRow()
                    }
                    if list.isEmpty {
                        Label { Text("Nothing waiting for you") } icon: { Image(systemName: "checkmark.circle").foregroundStyle(InboxTone.doneIcon) }
                            .font(.subheadline)
                            .foregroundStyle(Theme.C.mutedForeground)
                            .frame(minHeight: 44)
                            .plainRow()
                    }
                    rows(list, now: now, inList: true) { InboxView.asks($0) }
                    let shelves = InboxView.shelves(g, ended: store.ended, endedError: store.endedError)
                    if !shelves.isEmpty {
                        Rectangle().fill(Theme.C.border).frame(height: 1).padding(.vertical, 8).plainRow().accessibilityHidden(true)
                        ForEach(shelves, id: \.label) { shelf in
                            if shelf.count > 0 { shelfHead(shelf) }
                            if let note = shelf.note {
                                Text(note).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText).plainRow()
                            }
                            if openShelves.contains(shelf.label) {
                                ForEach(shelf.rows) { r in
                                    switch r {
                                    case .session(let item): row(item, now: now, inList: false, preview: shelf.preview, createdAt: createdAt)
                                    case .ended(let e): endedRow(e, now: now)
                                    }
                                }
                            }
                        }
                    }
                    Color.clear.frame(height: 1).plainRow().id(Self.bottomId)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                // On the List itself, so its content scrolls clear of the notice as it does of the tab bar.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    InboxSettleNotice(settler: settler, hint: hint) { Task { await settler.undo(in: store) } }
                        .animation(.snappy(duration: 0.25), value: settler.notice)
                        .animation(.snappy(duration: 0.25), value: settler.problem)
                        .animation(.snappy(duration: 0.25), value: hint)
                }
                .environment(\.defaultMinListRowHeight, 1)
            }
            .refreshable { await store.load() }
            #if DEBUG
            .task {
                // Screenshot mode only (Support/Fixtures): show the end of the list, once per launch.
                guard FixtureMode.scrollToBottom, !Self.scrolledToBottom else { return }
                Self.scrolledToBottom = true
                try? await Task.sleep(for: .milliseconds(300))
                proxy.scrollTo(Self.bottomId, anchor: .bottom)
            }
            #endif
        }
    }

    private static let bottomId = "inbox-bottom"
    #if DEBUG
    @MainActor private static var scrolledToBottom = false
    #endif

    /// A shelf's head: its name, count and a chevron; the whole row toggles it.
    private func shelfHead(_ shelf: InboxView.Shelf) -> some View {
        let open = openShelves.contains(shelf.label)
        return Button {
            if open { openShelves.remove(shelf.label) } else { openShelves.insert(shelf.label) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.C.mutedForeground)
                    .rotationEffect(.degrees(open ? 90 : 0))
                Text(shelf.label).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Text("\(shelf.count)").font(.subheadline.monospacedDigit()).foregroundStyle(Theme.C.mutedForeground)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .plainRow()
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel("\(shelf.label), \(shelf.count)")
        .accessibilityValue(open ? "expanded" : "collapsed")
        .accessibilityHint(open ? "Hides these sessions" : "Shows these sessions")
    }

    /// For each session's created_at, which keys its remembered view (InboxRoute.row).
    private var createdAt: [String: Int] {
        Dictionary((live.live?.sessions ?? []).map { ($0.id, $0.created_at) }, uniquingKeysWith: { _, last in last })
    }

    @ViewBuilder
    /// `inList`: a full swipe settles only in the list; on a shelf it would act on rows read less closely.
    private func rows(_ items: [InboxItem], now: Int, inList: Bool, preview: @escaping (InboxItem) -> Bool) -> some View {
        let createdAt = createdAt
        ForEach(items) { item in row(item, now: now, inList: inList, preview: preview(item), createdAt: createdAt) }
    }

    /// An ended session's transcript on the Settled shelf: it opens read-only and only hides, never back to the inbox.
    private func endedRow(_ e: EndedSession, now: Int) -> some View {
        InboxEndedRow(ended: e, now: now)
            .background {
                NavigationLink(value: InboxRoute.ended(e.id)) { EmptyView() }.opacity(0)
            }
            .plainRow()
            .swipeActions(edge: .trailing) {
                Button { hide(e) } label: { Label("Hide", systemImage: "eye.slash") }.tint(InboxTone.backSwipe)
            }
            .contextMenu {
                Button { hide(e) } label: { Label("Hide", systemImage: "eye.slash") }
            }
    }

    private func hide(_ e: EndedSession) {
        Task {
            do { try await store.hideEnded(e.id) } catch {
                settler.report("Couldn't hide “\(InboxView.endedTitle(e))”: \(chatErrorText(error))")
            }
        }
    }

    @ViewBuilder
    private func row(_ item: InboxItem, now: Int, inList: Bool, preview: Bool, createdAt: [String: Int]) -> some View {
        InboxRow(item: item, now: now, preview: preview)
            // The link fills the row without its disclosure chevron: rows read as T3 Code's, not as a settings list.
            .background {
                NavigationLink(value: InboxRoute.row(sessionId: item.sessionId, runtime: item.runtime, createdAt: createdAt[item.sessionId], memory: tabs)) {
                    EmptyView()
                }
                .opacity(0)
            }
            .plainRow()
            .swipeActions(edge: .trailing, allowsFullSwipe: inList && InboxSettler.canSettle(item)) {
                trailingAction(item)
            }
            .swipeActions(edge: .leading) {
                if InboxSettler.canSettle(item) && InboxView.shelfBlock(item) == nil {
                    Button { actionsFor = item } label: { Label("Snooze", systemImage: "alarm") }
                        .tint(InboxTone.snoozeSwipe)
                }
            }
            .contextMenu { menu(item) }
    }

    /// Settle, or for a row with an open request the reason it cannot be (devd refuses it); on a shelf, back to the inbox.
    @ViewBuilder
    private func trailingAction(_ item: InboxItem) -> some View {
        if !InboxSettler.canSettle(item) {
            Button { unsettle(item) } label: { Label("Back", systemImage: "arrow.uturn.backward") }
                .tint(InboxTone.backSwipe)
        } else {
            // Settling ends the session; one that waits or works asks first (SettleConfirmation).
            Button { Task { await settler.settle(item, in: store) } } label: { Label("Settle", systemImage: "checkmark") }
                .tint(InboxTone.settleSwipe)
                .accessibilityLabel("Settle and end")
        }
    }

    @ViewBuilder
    private func menu(_ item: InboxItem) -> some View {
        if InboxSettler.canSettle(item) {
            Button { Task { await settler.settle(item, in: store) } } label: { Label("Settle and End", systemImage: "checkmark") }
            Button { actionsFor = item } label: { Label("Snooze…", systemImage: "alarm") }
                .disabled(InboxView.shelfBlock(item) != nil)
        } else {
            Button { unsettle(item) } label: { Label("Back to the inbox", systemImage: "arrow.uturn.backward") }
        }
    }

    private func explain(_ why: String) {
        hint = why
        AccessibilityNotification.Announcement(why).post()
        Task {
            try? await Task.sleep(for: .seconds(3))
            if hint == why { hint = nil }
        }
    }

    private func unsettle(_ item: InboxItem) {
        Task {
            do { try await store.unsettle(item.sessionId) } catch {
                settler.report("Couldn't bring back “\(InboxView.rowTitle(item))”: \(chatErrorText(error))")
            }
        }
    }
}

private extension View {
    /// A list row without the plain list's separator, inset or background: the inbox draws its own.
    func plainRow() -> some View {
        listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
            .listRowBackground(Theme.C.background)
    }
}

/// Over the tab bar: "Settled · Undo" after a settle, and the last failure with a way to dismiss it.
struct InboxSettleNotice: View {
    @ObservedObject var settler: InboxSettler
    /// A short, neutral explanation (a blocked settle), shown while set.
    var hint: String?
    let undo: () -> Void

    var body: some View {
        if settler.problem != nil || settler.notice != nil || hint != nil {
            VStack(spacing: 8) {
                if let hint {
                    card {
                        Image(systemName: "questionmark.bubble").foregroundStyle(InboxTone.action).accessibilityHidden(true)
                        Text(hint).font(.subheadline).foregroundStyle(Theme.C.foreground).padding(.vertical, 10)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let problem = settler.problem { failure(problem) }
                if let notice = settler.notice { settled(notice) }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 10) { content() }
            .padding(.leading, 16).padding(.trailing, 8)
            .frame(minHeight: 52)
            .background(Theme.C.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.C.border))
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    private func failure(_ problem: String) -> some View {
        card {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(InboxTone.danger).accessibilityHidden(true)
            Text(problem).font(.subheadline).foregroundStyle(Theme.C.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 10)
            Spacer(minLength: 4)
            Button { settler.dismissProblem() } label: {
                Image(systemName: "xmark").font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.C.mutedForeground)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .accessibilityElement(children: .combine)
    }

    private func settled(_ notice: InboxSettler.Notice) -> some View {
        card {
            Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(InboxTone.doneIcon)
                .accessibilityHidden(true)
            Text("Settled · ending").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.C.foreground)
            Text(notice.title).font(.subheadline).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
            Spacer(minLength: 4)
            Button(action: undo) {
                Text("Undo").font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.C.link)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Undo settle")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Settled \(notice.title), the session ends")
    }
}

/// The dashboard's status tones (inboxView.ts `StatusTone`, Inbox.tsx `TONE`) and project-badge tints.
enum InboxTone {
    static let action = Color(light: 0xB45309, dark: 0xFCD34D)
    static let danger = Color(light: 0xDC2626, dark: 0xF87171)
    static let doneIcon = Color(light: 0x059669, dark: 0x34D399)
    static let busy = Color(light: 0x0369A1, dark: 0x7DD3FC)
    /// The title of a row with nothing to say: a step under the others, still well over AA (about 6.5:1 light,
    /// 8:1 dark on the background).
    static let quietTitle = Theme.C.foreground.opacity(0.66)
    /// The swipe actions' fills, under white labels (AA for the label in both modes).
    static let settleSwipe = Color(light: 0x047857, dark: 0x047857)
    static let snoozeSwipe = Color(light: 0x4F46E5, dark: 0x4F46E5)
    static let backSwipe = Color(light: 0x0369A1, dark: 0x0369A1)
    static let blockedSwipe = Color(light: 0x71717A, dark: 0x52525B)

    static func text(_ t: InboxView.Tone) -> Color {
        switch t {
        case .action: return action
        case .danger: return danger
        // Work that waits on something, a finish, a snooze: information, said quietly.
        case .busy, .done, .quiet: return Theme.C.mutedForeground
        }
    }

    static func icon(_ t: InboxView.Tone) -> String {
        switch t {
        case .action: return "questionmark.bubble"
        case .danger: return "exclamationmark.circle"
        case .done: return "checkmark.circle"
        case .busy: return "circle.dotted"
        case .quiet: return "alarm"
        }
    }

    /// Badge colours by InboxView.badgeSlots' slot, the dashboard's Inbox.tsx BADGE: sky, violet, emerald, teal, indigo,
    /// fuchsia, lime, cyan (the 500 hue at 15% as the fill, the 800 hue as light text and 300 as dark). No rose or
    /// amber: they would read as the danger and Answer chips.
    static let badge: [(fill: Color, text: Color)] = [
        (Color(light: 0x0EA5E9, dark: 0x0EA5E9), Color(light: 0x075985, dark: 0x7DD3FC)),
        (Color(light: 0x8B5CF6, dark: 0x8B5CF6), Color(light: 0x5B21B6, dark: 0xC4B5FD)),
        (Color(light: 0x10B981, dark: 0x10B981), Color(light: 0x065F46, dark: 0x6EE7B7)),
        (Color(light: 0x14B8A6, dark: 0x14B8A6), Color(light: 0x115E59, dark: 0x5EEAD4)),
        (Color(light: 0x6366F1, dark: 0x6366F1), Color(light: 0x3730A3, dark: 0xA5B4FC)),
        (Color(light: 0xD946EF, dark: 0xD946EF), Color(light: 0x86198F, dark: 0xF0ABFC)),
        (Color(light: 0x84CC16, dark: 0x84CC16), Color(light: 0x3F6212, dark: 0xBEF264)),
        (Color(light: 0x06B6D4, dark: 0x06B6D4), Color(light: 0x155E75, dark: 0x67E8F9)),
    ]
    /// A badge before its colour is known (InboxStore.badgeSlots not loaded yet).
    static let badgeNeutral = (fill: Color(light: 0x71717A, dark: 0xA1A1AA), text: Theme.C.mutedForeground)
}

/// A project as two letters on its colour (InboxView.projectBadge), in front of a row's second line. The name itself is
/// in the row's spoken label and tooltip.
struct ProjectBadge: View {
    let project: String
    var size: CGFloat = 9
    @Environment(\.inboxBadgeSlots) private var slots

    var body: some View {
        // Neutral until devd's project list has arrived (or for a project not in it): no colour is guessed.
        let tint = slots?[project].map { InboxTone.badge[$0] } ?? InboxTone.badgeNeutral
        return Text(InboxView.projectBadge(project))
            .font(.system(size: size, weight: .semibold))
            .tracking(0.3)
            .foregroundStyle(tint.text)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 3)
            .frame(minWidth: size * 2, minHeight: size + 5)
            .background(tint.fill.opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
            .accessibilityHidden(true)
    }
}

/// Whether inbox rows name their agent (InboxView.mixedAgents: the inbox mixes agents), set where the list is built.
/// True by default on purpose: a row outside such a list names its agent rather than hide which one runs.
private struct InboxShowsAgentKey: EnvironmentKey { static let defaultValue = true }

/// Each project's badge colour (InboxStore.badgeSlots), set where the list is built; nil until it has loaded.
private struct InboxBadgeSlotsKey: EnvironmentKey { static let defaultValue: [String: Int]? = nil }

extension EnvironmentValues {
    var inboxShowsAgent: Bool {
        get { self[InboxShowsAgentKey.self] }
        set { self[InboxShowsAgentKey.self] = newValue }
    }

    var inboxBadgeSlots: [String: Int]? {
        get { self[InboxBadgeSlotsKey.self] }
        set { self[InboxBadgeSlotsKey.self] = newValue }
    }
}

/// One row, the Mac sidebar's shape: the title with its state on the right (a chip when the row has something to say,
/// InboxView.statusParts, otherwise how long ago) and one muted line: the project's badge, InboxView.secondLine, and
/// the agent and "tmux" (InboxView.metaTail) after the agent's glyph while the inbox mixes agents. A row with nothing
/// to say has a quieter title, so the eye lands on the marked ones; danger and asks are loud, the rest quiet.
struct InboxRow: View {
    let item: InboxItem
    let now: Int
    let preview: Bool
    @Environment(\.inboxShowsAgent) private var showAgent
    @Environment(\.dynamicTypeSize) private var typeSize

    static func untilLabel(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    /// A chip's words: a snooze says when it ends, the time on the same day, else the short weekday and the time
    /// (inboxView.ts snoozeEnd).
    static func chipLabel(_ mark: InboxView.Mark, until: Int?, now: Int, locale: Locale = .current) -> String {
        guard let until else { return mark.label }
        let end = Date(timeIntervalSince1970: Double(until) / 1000)
        let today = Calendar.current.isDate(end, inSameDayAs: Date(timeIntervalSince1970: Double(now) / 1000))
        let style: Date.FormatStyle = today ? .dateTime.hour().minute() : .dateTime.weekday(.abbreviated).hour().minute()
        return "\(mark.label) until \(end.formatted(style.locale(locale)))"
    }

    var body: some View {
        let title = InboxView.rowTitle(item)
        let message = item.lastText.map(InboxView.plainPreview) ?? ""
        let detail = preview ? (message.isEmpty ? InboxView.reasonLabel(item.attention.reason) : message) : ""
        let parts = InboxView.statusParts(item, now: now)
        let tail = InboxView.metaTail(item, showAgent: showAgent)
        // The largest accessibility sizes leave a word or two per line: two lines keep a title readable.
        let lines = typeSize > .accessibility1 ? 2 : 1
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(parts?.mark == nil ? InboxTone.quietTitle : Theme.C.foreground)
                    .lineLimit(lines)
                Spacer(minLength: 0)
                state(parts)
            }
            HStack(spacing: 6) {
                ProjectBadge(project: item.project)
                Text(InboxView.secondLine(item, detail: detail))
                    .font(.subheadline)
                    .foregroundStyle(Theme.C.mutedForeground)
                    .lineLimit(lines)
                Spacer(minLength: 0)
                if showAgent {
                    AgentLogo(mark: AgentLogo.Mark(agent: item.agent), size: 13)
                        .foregroundStyle(Theme.C.mutedForeground.opacity(0.8))
                        .accessibilityHidden(true)
                }
                if !tail.isEmpty {
                    Text(tail.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(Theme.C.mutedForeground)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            // A settle whose end failed: devd brought the session back.
            if let error = item.endError {
                Text(InboxView.endErrorText(error)).font(.footnote).foregroundStyle(Theme.C.dangerText).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(Self.spoken(item, now: now, title: title, detail: detail, showAgent: showAgent))
    }

    @ViewBuilder
    private func state(_ parts: InboxView.StatusParts?) -> some View {
        if let parts, let mark = parts.mark {
            let loud = mark.tone == .action || mark.tone == .danger
            HStack(spacing: 4) {
                Image(systemName: InboxTone.icon(mark.tone))
                    .foregroundStyle(mark.tone == .done ? InboxTone.doneIcon : InboxTone.text(mark.tone))
                Text(Self.chipLabel(mark, until: parts.until, now: now)).monospacedDigit()
            }
            .font(loud ? .footnote.weight(.semibold) : .footnote)
            .foregroundStyle(InboxTone.text(mark.tone))
            .fixedSize()
        } else if let parts {
            Text(parts.ago)
                .font(.footnote).monospacedDigit()
                .foregroundStyle(item.attention.section == .working ? InboxTone.busy : Theme.C.mutedForeground)
                .fixedSize()
        }
    }

    /// One spoken line per row: title, state in words, when, where, which agent. The Mac's sidebar row also shows it
    /// as its tooltip.
    static func spokenLabel(_ item: InboxItem, now: Int, title: String, detail: String, showAgent: Bool) -> String {
        let a = item.attention
        let state = InboxView.reasonLabel(a.reason)
        let when = a.until.map { "snoozed until \(Self.untilLabel($0))" } ?? (a.since > 0 ? Format.agoLabel(Double(now - a.since)) : "")
        let agent = showAgent ? AgentProfiles.profile(for: AgentName(rawValue: item.agent)).short : ""
        return [title, state, when, "\(item.project)/\(item.repo)", agent, item.runtime == .tmux ? "tmux" : "", detail == state ? "" : detail]
            .filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// What VoiceOver (and the Mac's tooltip) says. A row with a chip says it first and not again as the state
    /// ("Answer, …", not also "waiting for your answer"); the others say their state.
    static func spoken(_ i: InboxItem, now: Int, title: String, detail: String, showAgent: Bool) -> String {
        let branch = (i.branch.map { $0.isEmpty ? "" : ", branch \($0)" } ?? "") + (i.endError.map { ". \(InboxView.endErrorText($0))" } ?? "")
        guard let mark = InboxView.rowStatus(i) else { return spokenLabel(i, now: now, title: title, detail: detail, showAgent: showAgent) + branch }
        let when = i.attention.until.map { "until \(Self.untilLabel($0))" } ?? (i.attention.since > 0 ? Format.agoLabel(Double(now - i.attention.since)) : "")
        let agent = showAgent ? AgentProfiles.profile(for: AgentName(rawValue: i.agent)).short : ""
        return [mark.label, title, when, "\(i.project)/\(i.repo)", agent, i.runtime == .tmux ? "tmux" : "",
                detail == InboxView.reasonLabel(i.attention.reason) ? "" : detail]
            .filter { !$0.isEmpty }.joined(separator: ", ") + branch
    }
}

/// An ended session's transcript on the Settled shelf: its title, an "Ended" mark with how long ago, and where it ran.
struct InboxEndedRow: View {
    let ended: EndedSession
    let now: Int
    @Environment(\.inboxShowsAgent) private var showAgent

    var body: some View {
        let title = InboxView.endedTitle(ended)
        let ago = InboxView.shortAgo(now - ended.endedAt)
        let tail = InboxView.endedMetaTail(ended, showAgent: showAgent)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.body).foregroundStyle(InboxTone.quietTitle).lineLimit(1)
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    Text("Ended").font(.caption2.weight(.medium)).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: 4))
                    Text(ago).font(.footnote).monospacedDigit()
                }
                .foregroundStyle(Theme.C.mutedForeground)
                .fixedSize()
            }
            HStack(spacing: 6) {
                ProjectBadge(project: ended.project)
                Text(InboxView.endedSecondLine(ended)).font(.subheadline).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                Spacer(minLength: 0)
                if showAgent {
                    AgentLogo(mark: AgentLogo.Mark(agent: ended.agent), size: 13)
                        .foregroundStyle(Theme.C.mutedForeground.opacity(0.8))
                        .accessibilityHidden(true)
                }
                if !tail.isEmpty {
                    Text(tail.joined(separator: " · ")).font(.footnote).foregroundStyle(Theme.C.mutedForeground).lineLimit(1).fixedSize()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(InboxView.endedSpoken(ended, now: now, showAgent: showAgent))
    }
}

/// Settle, unsettle and snooze for one row. "Until the limit resets" asks devd when the sheet opens; it stays
/// disabled with devd's reason when there is no active limit. devd's refusals (409 request-open…) are shown.
/// `settle`: the inbox's own settle (InboxSettler), which asks first for a session that waits or works.
struct InboxRowActions: View {
    let item: InboxItem
    @ObservedObject var store: InboxStore
    let settle: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reset: Result<SnoozeReset, Error>?
    @State private var error: String?
    @State private var busy = false

    private var shelved: Bool { item.attention.section == .settled || item.attention.section == .snoozed }

    var body: some View {
        let blocked = InboxView.shelfBlock(item)
        let times = InboxView.snoozeTimes(now: Date())
        NavigationStack {
            List {
                if shelved {
                    Button("Back to the inbox") { run { try await store.unsettle(item.sessionId) } }
                } else {
                    Section {
                        Button("Settle and End") { dismiss(); settle() }
                    }
                    if let blocked {
                        Text(blocked).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    Section("Snooze") {
                        Button("1 hour") { run { try await store.snooze(item.sessionId, until: times.hour) } }.disabled(blocked != nil)
                        Button(times.morningLabel) { run { try await store.snooze(item.sessionId, until: times.morningAt) } }.disabled(blocked != nil)
                        Button { run { try await store.snoozeUntilReset(item.sessionId) } } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Until the limit resets")
                                Text(resetDetail).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                            }
                        }
                        .disabled(blocked != nil || !resetAvailable)
                    }
                }
                if let error {
                    Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
                }
            }
            .disabled(busy)
            .navigationTitle(item.title)
            .inlineNavigationTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .task {
            guard !shelved, InboxView.shelfBlock(item) == nil else { return }
            do { reset = .success(try await store.snoozeReset(item.sessionId)) } catch { reset = .failure(error) }
        }
    }

    private var resetAvailable: Bool {
        if case .success(.resetsAt) = reset { return true }
        return false
    }

    private var resetDetail: String {
        switch reset {
        case nil: return "Checking…"
        case .success(.resetsAt(let at)): return InboxRow.untilLabel(at)
        case .success(.reason(let why)): return why
        case .failure(let e): return "could not ask devd: \(chatErrorText(e))"
        }
    }

    private func run(_ op: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do {
                try await op()
                dismiss()
            } catch {
                self.error = chatErrorText(error)
            }
            busy = false
        }
    }
}
