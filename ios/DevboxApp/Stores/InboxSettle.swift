import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The inbox as one list, as the Mac sidebar, the iPhone inbox and the dashboard show it (dashboard/src/inboxSettle.ts).
extension InboxView {
    /// A collapsed shelf under the list.
    struct Shelf {
        let label: String
        let items: [InboxItem]
        /// Whether the rows show the latest message.
        let preview: Bool
        /// Settled only: ended sessions' transcripts, among the settled sessions.
        var ended: [EndedSession] = []

        var count: Int { items.count + ended.count }

        /// The shelf's rows: its sessions, with the ended transcripts among them newest first (endedView.ts settledShelf).
        var rows: [ShelfRow] {
            guard !ended.isEmpty else { return items.map(ShelfRow.session) }
            return (items.map(ShelfRow.session) + ended.map(ShelfRow.ended)).sorted { $0.at > $1.at }
        }
    }

    enum ShelfRow: Identifiable {
        case session(InboxItem)
        case ended(EndedSession)

        var id: String {
            switch self {
            case .session(let i): return i.sessionId
            case .ended(let e): return InboxView.endedTag(e.id)
            }
        }

        var at: Int {
            switch self {
            case .session(let i): return i.attention.since
            case .ended(let e): return e.endedAt
            }
        }
    }

    /// The one list: what asks for action (a request or a failure) pinned on top, the longest wait first, as devd
    /// orders it; then the finished and the idle rows together, newest first. The owner chose this over T3 Code's
    /// pure recency, so a question never sinks under newer finishes.
    static func list(_ g: Groups) -> [InboxItem] {
        let split = splitNeedsYou(g.needsYou)
        return split.action + (split.finished + g.idle).sorted { $0.attention.since > $1.attention.since }
    }

    /// The shelves under the list, in order, the empty ones left out.
    static func shelves(_ g: Groups, ended: [EndedSession] = []) -> [Shelf] {
        [Shelf(label: "Working", items: g.working, preview: true),
         Shelf(label: "Snoozed", items: g.snoozed, preview: true),
         Shelf(label: "Settled", items: g.settled, preview: false, ended: ended)].filter { $0.count > 0 }
    }

    /// A row that asks something (a request or a failure) says what in its second line; the others say where they run.
    static func asks(_ i: InboxItem) -> Bool { i.attention.section == .needsYou && i.attention.reason != .completed }

    /// The second line, after the project's badge. A row that needs you says what it asks (the message, or the
    /// reason without one): that is the point of the row. Any other row says where it runs: the repo and what
    /// distinguishes its branch (branchLabel), else the latest message on a row that shows it.
    static func secondLine(_ i: InboxItem, detail: String) -> String {
        if i.attention.section == .needsYou, !detail.isEmpty { return "\(i.repo)  ·  \(detail)" }
        let place = i.repo
        if let branch = branchLabel(i) { return "\(place)  ·  \(branch)" }
        return detail.isEmpty ? place : "\(place)  ·  \(detail)"
    }
}

/// Settling a row in one gesture and the "Settled" notice with its undo that follows it, and the tmux seen marker.
/// Failures are kept in `problem` for the list to show, never dropped.
@MainActor
class InboxSettler: ObservableObject {
    struct Notice: Equatable {
        let sessionId: String
        let title: String
        let id = UUID()
    }

    enum Seen: Equatable { case posted, skipped, failed }

    /// When the iPhone marks an open tmux session seen: it was opened, left, or the app came back while it is open.
    enum Moment { case opened, left, foreground }

    /// The last settle, while it can still be undone.
    @Published private(set) var notice: Notice?
    /// The last settle, undo or seen that failed, with why; shown until dismissed (`dismissProblem`).
    @Published private(set) var problem: String?

    private let lifetime: Duration
    private let voiceOver: @MainActor () -> Bool
    /// How the announcement says to undo (the Mac names ⌘Z).
    let undoHint: String
    /// Seen posts per finish ("id@since"): one at a time (several triggers fire together), a done one never again,
    /// a failed one tried once more.
    private var seenInFlight: Set<String> = []
    private var seenDone: Set<String> = []
    private var seenFailures: [String: Int] = [:]
    /// The finish whose failure `problem` shows, and the finishes whose failure the owner dismissed (not raised again).
    private var problemSeenKey: String?
    private var dismissedSeen: Set<String> = []
    /// When each session's last look was posted: triggers that fire together (the Mac window appearing and becoming
    /// key at launch) post one look.
    private var lastLook: [String: ContinuousClock.Instant] = [:]
    private let lookGap: Duration

    /// `voiceOver`: whether VoiceOver runs; the notice then stays until the next action, as a spoken notice cannot
    /// be timed to be acted on. `undoHint`: how the announcement says to undo.
    init(lifetime: Duration = .seconds(5), voiceOver: @escaping @MainActor () -> Bool = InboxSettler.voiceOverRuns, undoHint: String = "Undo available",
         lookGap: Duration = .seconds(1)) {
        self.lifetime = lifetime
        self.lookGap = lookGap
        self.voiceOver = voiceOver
        self.undoHint = undoHint
    }

    static func voiceOverRuns() -> Bool {
        #if os(macOS)
        NSWorkspace.shared.isVoiceOverEnabled
        #else
        UIAccessibility.isVoiceOverRunning
        #endif
    }

    /// Why the row cannot be settled now (devd refuses it with 409 request-open), or nil.
    static func block(_ i: InboxItem) -> String? { InboxView.shelfBlock(i) }

    /// Whether the row offers Settle at all: not when it is already on the settled or snoozed shelf.
    static func canSettle(_ i: InboxItem) -> Bool { ![.settled, .snoozed].contains(i.attention.section) }

    /// A tmux session's finish or failure clears once the owner has looked at it (POST /seen). A chat session marks
    /// its thread seen itself (ThreadStore), and waiting, working or idle sessions have nothing to clear.
    static func wantsSeen(_ i: InboxItem?) -> Bool {
        guard let i, i.runtime == .tmux, i.attention.section == .needsYou else { return false }
        return i.attention.reason != .request
    }

    /// Whether marking the row seen while it is open would move it: a failure is pinned on top and would drop into the
    /// newest-first part; a finish keeps its time there (devd keeps `since`) and stays put.
    static func seenMoves(_ i: InboxItem) -> Bool { InboxView.asks(i) }

    /// Whether the iPhone marks the session seen at this moment: a failure only once it is left, so it never jumps.
    static func marksSeen(_ i: InboxItem?, on moment: Moment) -> Bool {
        guard let i, wantsSeen(i) else { return false }
        return moment == .left || !seenMoves(i)
    }

    /// Whether opening an idle tmux session or coming back to it is a look to record (POST /seen): there is nothing to
    /// clear, but devd restarts the inbox's auto-settle clock on it, so the row does not settle while it is open.
    /// Leaving is no look; a finish or failure goes through `marksSeen`/`seen`, a chat session through its thread.
    static func looks(_ i: InboxItem?, on moment: Moment) -> Bool {
        guard let i, moment != .left else { return false }
        return i.runtime == .tmux && i.attention.section == .idle
    }

    /// `checked: false` skips the client's own refusal, so a test can see devd's.
    func settle(_ item: InboxItem, in store: InboxStore, checked: Bool = true) async {
        let title = InboxView.rowTitle(item)
        if checked, let why = Self.block(item) {
            report("Couldn't settle “\(title)”: \(why)")
            return
        }
        do {
            try await store.settle(item.sessionId)
        } catch {
            report("Couldn't settle “\(title)”: \(chatErrorText(error))")
            return
        }
        let next = Notice(sessionId: item.sessionId, title: title)
        notice = next
        AccessibilityNotification.Announcement("Settled \(title), \(undoHint)").post()
        guard !voiceOver() else { return }
        Task { [weak self, lifetime] in
            try? await Task.sleep(for: lifetime)
            if self?.notice?.id == next.id { self?.notice = nil }
        }
    }

    /// The owner did something else (opened or picked another row): a notice kept up for VoiceOver goes now.
    func actionTaken() {
        if voiceOver() { notice = nil }
    }

    /// Unsettles the session of the notice; false when there is no notice (it went, or was undone already).
    @discardableResult
    func undo(in store: InboxStore) async -> Bool {
        guard let undone = notice else { return false }
        notice = nil
        do {
            try await store.unsettle(undone.sessionId)
        } catch {
            report("Couldn't undo the settle of “\(undone.title)”: \(chatErrorText(error))")
        }
        return true
    }

    /// Marks a finished or failed tmux session seen: once per finish, a failed post tried once more. A failure the
    /// owner dismissed is not raised again.
    @discardableResult
    func seen(_ item: InboxItem, in store: InboxStore) async -> Seen {
        let key = "\(item.sessionId)@\(item.attention.since)"
        guard Self.wantsSeen(item), !seenDone.contains(key), !seenInFlight.contains(key), seenFailures[key, default: 0] < 2
        else { return .skipped }
        seenInFlight.insert(key)
        defer { seenInFlight.remove(key) }
        do {
            try await store.seen(item.sessionId)
            seenDone.insert(key)
            return .posted
        } catch {
            seenFailures[key, default: 0] += 1
            if !dismissedSeen.contains(key) {
                report("Couldn't mark “\(InboxView.rowTitle(item))” seen: \(chatErrorText(error))", seen: key)
            }
            return .failed
        }
    }

    /// Records a look at an idle tmux session (`looks`): one post per look, a second within `lookGap` is the same look;
    /// a failed one is shown.
    @discardableResult
    func look(_ item: InboxItem, in store: InboxStore) async -> Seen {
        guard Self.looks(item, on: .foreground) else { return .skipped }
        let now = ContinuousClock.now
        if let last = lastLook[item.sessionId], now - last < lookGap { return .skipped }
        lastLook[item.sessionId] = now
        do {
            try await store.seen(item.sessionId)
            return .posted
        } catch {
            report("Couldn't mark “\(InboxView.rowTitle(item))” seen: \(chatErrorText(error))")
            return .failed
        }
    }

    func dismissProblem() {
        if let key = problemSeenKey { dismissedSeen.insert(key) }
        problem = nil
        problemSeenKey = nil
    }

    /// Shows a failure under the list; `seen` names the finish it is about.
    func report(_ text: String, seen key: String? = nil) {
        problem = text
        problemSeenKey = key
    }
}
