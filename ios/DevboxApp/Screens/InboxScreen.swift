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
        .onDisappear { store.stop() }
        // iOS drops the stream in the background; the inbox reloads when the stream reopens.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start() } else if phase == .background { store.stop() }
        }
        .sheet(item: $actionsFor) { item in
            InboxRowActions(item: item, store: store)
                .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder
    private func content(_ g: InboxView.Groups) -> some View {
        ScreenScroll {
            if store.paused || store.badFrame != nil {
                Text(store.paused ? "Live updates paused — refreshing every 5 s\(store.loadError.map { " (last refresh failed: \($0))" } ?? "")"
                     : "Live update dropped: \(store.badFrame ?? "")")
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.warnText)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.C.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.R.md))
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Needs you · \(g.needsYou.count)")
                if g.needsYou.isEmpty {
                    EmptyState("Nothing waiting for you", systemImage: "checkmark.circle")
                } else {
                    rows(g.needsYou)
                }
            }
            shelf("Working", g.working)
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Idle · \(g.idle.count)")
                if !g.idle.isEmpty { rows(g.idle) }
            }
            shelf("Snoozed", g.snoozed)
            shelf("Settled", g.settled)
        }
        .refreshable { await store.load() }
    }

    /// A section that starts collapsed (Working, Snoozed, Settled).
    @ViewBuilder
    private func shelf(_ label: String, _ items: [InboxItem]) -> some View {
        let open = openShelves.contains(label)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionHeader("\(label) · \(items.count)")
                if !items.isEmpty {
                    Button(open ? "hide" : "show") {
                        if open { openShelves.remove(label) } else { openShelves.insert(label) }
                    }
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
                    .accessibilityLabel(open ? "Hide \(label)" : "Show \(label)")
                }
            }
            if open && !items.isEmpty { rows(items) }
        }
    }

    private func rows(_ items: [InboxItem]) -> some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 0) {
                    NavigationLink(value: item.runtime == .chat ? InboxRoute.thread(item.sessionId) : InboxRoute.session(item.sessionId)) {
                        InboxRow(item: item)
                    }
                    .buttonStyle(.plain)
                    Button { actionsFor = item } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 44, height: 44)
                            .foregroundStyle(Theme.C.mutedForeground)
                    }
                    .accessibilityLabel("Actions for \(item.title)")
                }
                if item.id != items.last?.id { Divider() }
            }
        }
        .background(Theme.C.card, in: RoundedRectangle(cornerRadius: Theme.R.xl))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.xl).strokeBorder(Theme.C.border))
    }
}

private struct InboxRow: View {
    let item: InboxItem

    private var tone: StatusTone {
        if InboxView.isProblem(item.attention.reason) { return .danger }
        switch item.attention.section {
        case .needsYou: return .warn
        case .working: return .ok
        case .idle, .snoozed, .settled: return .idle
        }
    }

    private var meta: String {
        let a = item.attention
        let repo = "\(item.project)/\(item.repo)"
        return [a.until.map { "snoozed until \(InboxRow.untilLabel($0))" } ?? "", InboxView.reasonLabel(a.reason), item.title == repo ? "" : repo]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func untilLabel(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusDot(tone, pulse: item.attention.section == .working).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title).font(Theme.F.body.weight(.medium)).lineLimit(1)
                    Badge(AgentProfiles.profile(for: AgentName(rawValue: item.agent)).short, variant: .secondary)
                    if item.runtime == .tmux { Badge("tmux", variant: .outline) }
                }
                if !meta.isEmpty {
                    Text(meta).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                }
                if let last = item.lastText {
                    Text(last).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground.opacity(0.9)).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if item.attention.since > 0 {
                Text(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(item.attention.since)))
                    .font(Theme.F.meta.monospacedDigit())
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 16)
        .contentShape(Rectangle())
    }
}

/// Settle, unsettle and snooze for one row. "Until the limit resets" asks devd when the sheet opens; it stays
/// disabled with devd's reason when there is no active limit. devd's refusals (409 request-open…) are shown.
private struct InboxRowActions: View {
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
            .navigationBarTitleDisplayMode(.inline)
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
