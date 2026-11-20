import SwiftUI

/// Where an inbox row leads on the Inbox tab's stack: a chat session's thread, or a tmux session's detail (its
/// terminal is there), as the dashboard opens `/s/<id>` or `/terminal/<id>`.
enum InboxRoute: Hashable {
    case thread(String)
    case session(String)
}

/// Every session by what it needs (dashboard/src/pages/Inbox.tsx): needs you, working, idle, then the snoozed and
/// settled shelves (collapsed). Live over devd's stream; polled every 5 s while the stream is down.
struct InboxScreen: View {
    @StateObject private var store: InboxStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var actionsFor: InboxItem?
    @State private var openShelves: Set<String> = []
    /// On screen (not under a pushed chat or another tab): only then does coming back reopen the stream.
    @State private var visible = false
    private let client: DevdClient

    init(client: DevdClient) {
        self.client = client
        _store = StateObject(wrappedValue: InboxStore(client: client))
    }

    var body: some View {
        Group {
            if let items = store.items {
                content(InboxView.group(items))
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
        .onAppear { visible = true }
        .onDisappear {
            visible = false
            store.stop()
        }
        // iOS drops the stream in the background; the inbox reloads when the stream reopens.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, visible { store.start() } else if phase == .background { store.stop() }
        }
        .sheet(item: $actionsFor) { item in
            InboxRowActions(item: item, store: store)
                .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder
    private func content(_ g: InboxView.Groups) -> some View {
        let split = InboxView.splitNeedsYou(g.needsYou)
        ScrollViewReader { proxy in
        ScrollView {
            // Relative times tick every 15 s, as the dashboard's.
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let now = InboxView.ms(context.date)
                LazyVStack(alignment: .leading, spacing: 0) {
                    if store.paused || store.badFrame != nil {
                        Text(store.paused ? "Live updates paused — refreshing every 5 s\(store.loadError.map { " (last refresh failed: \($0))" } ?? "")"
                             : "Live update dropped: \(store.badFrame ?? "")")
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.warnText)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.C.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.R.md))
                            .padding(.horizontal, 4)
                            .padding(.bottom, 12)
                    }
                    if split.action.isEmpty {
                        Label { Text("Nothing waiting for you") } icon: { Image(systemName: "checkmark.circle").foregroundStyle(InboxTone.doneIcon) }
                            .font(.subheadline)
                            .foregroundStyle(Theme.C.mutedForeground)
                            .frame(minHeight: 44)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                    }
                    group("Needs you", split.action, now: now, preview: true)
                    group("Finished", split.finished, now: now, preview: false, cap: 5)
                    group("Idle", g.idle, now: now, preview: false)
                    if g.working.count + g.snoozed.count + g.settled.count > 0 {
                        Divider().padding(.horizontal, 12).padding(.bottom, 4)
                        shelf("Working", g.working, now: now, preview: true)
                        shelf("Snoozed", g.snoozed, now: now, preview: true)
                        shelf("Settled", g.settled, now: now, preview: false)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 8)
            }
            Color.clear.frame(height: 1).id(Self.bottomId)
        }
        .background(Theme.C.background)
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

    /// An open group, not shown while empty. With `cap`, rows past it hide behind a counted "N more" toggle.
    @ViewBuilder
    private func group(_ label: String, _ items: [InboxItem], now: Int, preview: Bool, cap: Int? = nil) -> some View {
        if !items.isEmpty {
            let all = openShelves.contains(label)
            let shown = cap.map { all ? items : Array(items.prefix($0)) } ?? items
            VStack(alignment: .leading, spacing: 2) {
                InboxGroupHead(label: label, count: items.count)
                rows(shown, now: now, preview: preview)
                if let cap, items.count > cap {
                    Button { toggle(label) } label: {
                        HStack(spacing: 4) {
                            Text(all ? "Show fewer" : "\(items.count - cap) more")
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).rotationEffect(.degrees(all ? 180 : 0))
                        }
                        .font(.subheadline)
                        .foregroundStyle(Theme.C.mutedForeground)
                        .frame(minHeight: 44)
                        .padding(.horizontal, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(all ? "expanded" : "collapsed")
                }
            }
            .padding(.bottom, 16)
        }
    }

    /// A group that starts collapsed (Working, Snoozed, Settled); not shown while empty.
    @ViewBuilder
    private func shelf(_ label: String, _ items: [InboxItem], now: Int, preview: Bool) -> some View {
        if !items.isEmpty {
            let open = openShelves.contains(label)
            VStack(alignment: .leading, spacing: 2) {
                Button { toggle(label) } label: {
                    InboxGroupHead(label: label, count: items.count, open: open)
                }
                .buttonStyle(InboxPressStyle())
                .accessibilityAddTraits(.isHeader)
                .accessibilityLabel("\(label), \(items.count)")
                .accessibilityValue(open ? "expanded" : "collapsed")
                .accessibilityHint(open ? "Hides these sessions" : "Shows these sessions")
                if open { rows(items, now: now, preview: preview).padding(.bottom, 8) }
            }
        }
    }

    private func toggle(_ label: String) {
        if openShelves.contains(label) { openShelves.remove(label) } else { openShelves.insert(label) }
    }

    private func rows(_ items: [InboxItem], now: Int, preview: Bool) -> some View {
        VStack(spacing: 2) {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 0) {
                    NavigationLink(value: item.runtime == .chat ? InboxRoute.thread(item.sessionId) : InboxRoute.session(item.sessionId)) {
                        InboxRow(item: item, now: now, preview: preview)
                    }
                    .buttonStyle(InboxPressStyle())
                    Button { actionsFor = item } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 44, height: 44)
                            .foregroundStyle(Theme.C.mutedForeground)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Actions for \(InboxView.rowTitle(item).text)")
                }
            }
        }
    }
}

/// A quiet group heading: name, count, and for the shelves a chevron.
private struct InboxGroupHead: View {
    let label: String
    let count: Int
    var open: Bool?

    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.C.foreground.opacity(0.9))
            Text("\(count)").font(.subheadline.monospacedDigit()).foregroundStyle(Theme.C.mutedForeground)
            if let open {
                Spacer()
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.C.mutedForeground)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
        }
        // A shelf's head is its toggle: a full touch target.
        .frame(minHeight: open == nil ? 36 : 44)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A pressed row tints like the dashboard's hovered row.
private struct InboxPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Theme.C.muted.opacity(configuration.isPressed ? 0.9 : 0), in: RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous))
    }
}

/// The dashboard's status tones (inboxView.ts `StatusTone`, Inbox.tsx `TONE`) and project-badge tints.
enum InboxTone {
    static let action = Color(light: 0xB45309, dark: 0xFCD34D)
    static let danger = Color(light: 0xDC2626, dark: 0xF87171)
    static let doneIcon = Color(light: 0x059669, dark: 0x34D399)
    static let busy = Color(light: 0x0369A1, dark: 0x7DD3FC)

    static func text(_ t: InboxView.Tone) -> Color {
        switch t {
        case .action: return action
        case .danger: return danger
        case .busy: return busy
        case .done, .quiet: return Theme.C.mutedForeground
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

    /// Badge slots: rose, amber, emerald, sky, violet, fuchsia (500 at 15% behind 800 / 300 text).
    static let badge: [(fill: Color, text: Color)] = [
        (Color(light: 0xF43F5E, dark: 0xF43F5E), Color(light: 0xBE123C, dark: 0xFDA4AF)),
        (Color(light: 0xF59E0B, dark: 0xF59E0B), Color(light: 0x92400E, dark: 0xFCD34D)),
        (Color(light: 0x10B981, dark: 0x10B981), Color(light: 0x065F46, dark: 0x6EE7B7)),
        (Color(light: 0x0EA5E9, dark: 0x0EA5E9), Color(light: 0x075985, dark: 0x7DD3FC)),
        (Color(light: 0x8B5CF6, dark: 0x8B5CF6), Color(light: 0x5B21B6, dark: 0xC4B5FD)),
        (Color(light: 0xD946EF, dark: 0xD946EF), Color(light: 0x86198F, dark: 0xF0ABFC)),
    ]
}

/// One row, the dashboard's shape: a meta line (project badge and path, state, time, agent), the title, and in
/// groups where the latest message is the point (Needs you, Working, Snoozed) a dimmer preview line.
struct InboxRow: View {
    let item: InboxItem
    let now: Int
    let preview: Bool
    /// The project badge's letters: small, but they grow with Dynamic Type.
    @ScaledMetric(relativeTo: .caption2) private var badgeText: CGFloat = 9

    static func untilLabel(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    var body: some View {
        let a = item.attention
        let title = InboxView.rowTitle(item)
        let message = item.lastText.flatMap { title.fromMessage ? nil : InboxView.plainPreview($0) } ?? ""
        let detail = message.isEmpty ? InboxView.reasonLabel(a.reason) : message
        let parts = InboxView.statusParts(item, now: now, compact: !preview)
        let badge = InboxView.projectBadge(item.project)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Text(badge.letters)
                    .font(.system(size: badgeText, weight: .bold))
                    .tracking(0.3)
                    .foregroundStyle(InboxTone.badge[badge.slot].text)
                    .frame(minWidth: badgeText * 2.2, minHeight: badgeText * 1.8)
                    .padding(.horizontal, 2)
                    .background(InboxTone.badge[badge.slot].fill.opacity(0.15), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                (Text(item.project) + Text(" / ").foregroundColor(Theme.C.mutedForeground.opacity(0.6)) + Text(item.repo))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
                dot
                if let parts {
                    status(parts)
                    dot
                }
                ForEach(Array(InboxView.metaTail(item).enumerated()), id: \.offset) { n, part in
                    if n > 0 { dot }
                    Text(part).fixedSize()
                }
            }
            .font(.caption)
            .foregroundStyle(Theme.C.mutedForeground)
            Text(title.text)
                .font(.subheadline.weight(preview && !title.fromMessage ? .medium : .regular))
                .foregroundStyle(title.fromMessage ? Theme.C.mutedForeground : preview ? Theme.C.foreground : Theme.C.foreground.opacity(0.85))
                .lineLimit(1)
            if preview && !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.C.mutedForeground.opacity(0.8))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9)
        .padding(.leading, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(title: title.text, detail: preview ? detail : ""))
    }

    private var dot: some View { Text("·").opacity(0.5).accessibilityHidden(true) }

    @ViewBuilder
    private func status(_ parts: InboxView.StatusParts) -> some View {
        let when = parts.until.map { "until \(Self.untilLabel($0))" } ?? parts.ago
        HStack(spacing: 3) {
            if let mark = parts.mark {
                Image(systemName: InboxTone.icon(mark.tone))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(mark.tone == .done ? InboxTone.doneIcon : InboxTone.text(mark.tone))
                if parts.showLabel {
                    Text(mark.label).fontWeight(.medium).foregroundStyle(InboxTone.text(mark.tone))
                }
            }
            if !when.isEmpty {
                Text(when).monospacedDigit()
                    .foregroundStyle(parts.mark.map { InboxTone.text($0.tone).opacity(0.75) } ?? Theme.C.mutedForeground)
            }
        }
        .fixedSize()
    }

    /// One spoken line per row: title, state in words, when, where, which agent.
    private func accessibilityText(title: String, detail: String) -> String {
        let a = item.attention
        let state = InboxView.reasonLabel(a.reason)
        let when = a.until.map { "snoozed until \(Self.untilLabel($0))" } ?? (a.since > 0 ? Format.agoLabel(Double(now - a.since)) : "")
        let agent = AgentProfiles.profile(for: AgentName(rawValue: item.agent)).short
        return [title, state, when, "\(item.project)/\(item.repo)", agent, item.runtime == .tmux ? "tmux" : "", detail == state ? "" : detail]
            .filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// Settle, unsettle and snooze for one row. "Until the limit resets" asks devd when the sheet opens; it stays
/// disabled with devd's reason when there is no active limit. devd's refusals (409 request-open…) are shown.
struct InboxRowActions: View {
    let item: InboxItem
    @ObservedObject var store: InboxStore
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
                    if let blocked {
                        Text(blocked).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    Section {
                        Button("Settle") { run { try await store.settle(item.sessionId) } }.disabled(blocked != nil)
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
