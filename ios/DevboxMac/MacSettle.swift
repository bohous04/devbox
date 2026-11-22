import AppKit
import SwiftUI

/// Settling from the sidebar in one gesture (the row's ✓, ⌘⇧S), the "Settled · ⌘Z to undo" notice that follows it,
/// and the tmux seen marker. One for the app, as the inbox is: every window's sidebar shows the same notice. Failures
/// are kept in `problem` for the sidebar to show, never dropped.
@MainActor
final class MacSettler: ObservableObject {
    struct Notice: Equatable {
        let sessionId: String
        let title: String
        let id = UUID()
    }

    enum Seen: Equatable { case posted, skipped, failed }

    /// The last settle, while it can still be undone.
    @Published private(set) var notice: Notice?
    /// The last settle, undo or seen that failed, with why; the sidebar shows it until dismissed (`dismissProblem`).
    @Published private(set) var problem: String?
    /// The windows whose sidebar shows the notice now (window numbers): ⌘Z is taken in those only.
    private(set) var sidebarWindows: Set<Int> = []

    private let lifetime: Duration
    private let voiceOver: () -> Bool
    /// Seen posts per finish ("id@since"): a failed one is tried once more, a done one never again.
    private var seenAttempts: [String: Int] = [:]
    /// The finish whose failure `problem` shows, and the finishes whose failure the owner dismissed (not raised again).
    private var problemSeenKey: String?
    private var dismissedSeen: Set<String> = []

    /// `voiceOver`: whether VoiceOver runs; the notice then stays until the next action, as a spoken notice cannot
    /// be timed to be acted on.
    init(lifetime: Duration = .seconds(5), voiceOver: @escaping () -> Bool = { NSWorkspace.shared.isVoiceOverEnabled }) {
        self.lifetime = lifetime
        self.voiceOver = voiceOver
    }

    /// Why the row cannot be settled now (devd refuses it with 409 request-open), or nil.
    static func block(_ i: InboxItem) -> String? { InboxView.shelfBlock(i) }

    /// Whether the row offers Settle at all: not when it is already on the settled or snoozed shelf.
    static func canSettle(_ i: InboxItem) -> Bool { ![.settled, .snoozed].contains(i.attention.section) }

    /// ⌘Z undoes the settle while the key window's sidebar shows its notice, unless what has the keyboard has an undo
    /// or a ⌘Z of its own (a text field being edited, the terminal).
    static func claimsUndo(flags: NSEvent.ModifierFlags, key: String, noticeShown: Bool, focusOwnsUndo: Bool) -> Bool {
        noticeShown && !focusOwnsUndo && key.lowercased() == "z"
            && flags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function]) == .command
    }

    /// A tmux session's finish or failure clears once the owner has looked at it (POST /seen). A chat session marks
    /// its thread seen itself (ThreadStore), and waiting, working or idle sessions have nothing to clear.
    static func wantsSeen(_ i: InboxItem?) -> Bool {
        guard let i, i.runtime == .tmux, i.attention.section == .needsYou else { return false }
        return i.attention.reason != .request
    }

    /// Whether marking the selected row seen now would move it from under the pointer: a failure is pinned on top and
    /// would drop into the newest-first part; a finish keeps its time there (devd keeps `since`) and stays put.
    static func seenMoves(_ i: InboxItem) -> Bool { MacSidebarLayout.asks(i) }

    func showingSidebar(window: Int) { sidebarWindows.insert(window) }
    func leftSidebar(window: Int) { sidebarWindows.remove(window) }

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
        AccessibilityNotification.Announcement("Settled \(title), ⌘Z to undo").post()
        guard !voiceOver() else { return }
        Task { [weak self, lifetime] in
            try? await Task.sleep(for: lifetime)
            if self?.notice?.id == next.id { self?.notice = nil }
        }
    }

    /// The owner did something else (picked another row): a notice kept up for VoiceOver goes now.
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
        let attempts = seenAttempts[key, default: 0]
        guard Self.wantsSeen(item), attempts < 2 else { return .skipped }
        seenAttempts[key] = attempts + 1
        do {
            try await store.seen(item.sessionId)
            seenAttempts[key] = 2
            return .posted
        } catch {
            if !dismissedSeen.contains(key) {
                report("Couldn't mark “\(InboxView.rowTitle(item))” seen: \(chatErrorText(error))", seen: key)
            }
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

/// Under the list, over the footer: the undo notice after a settle, or the last failure with a way to dismiss it.
struct MacSettleNotice: View {
    @ObservedObject var settler: MacSettler
    let undo: () -> Void

    var body: some View {
        if settler.problem != nil || settler.notice != nil {
            VStack(alignment: .leading, spacing: 6) {
                if let problem = settler.problem { failure(problem) }
                if let notice = settler.notice { settled(notice) }
            }
            .font(.system(size: 11.5))
            .padding(.horizontal, 14).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MacTone.sidebar)
            .overlay(alignment: .top) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3).accessibilityHidden(true) }
        }
    }

    private func failure(_ problem: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(InboxTone.danger).accessibilityHidden(true)
            Text(problem).foregroundStyle(Theme.C.foreground).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button { settler.dismissProblem() } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).foregroundStyle(Theme.C.mutedForeground)
                .accessibilityLabel("Dismiss")
        }
        .accessibilityElement(children: .combine)
    }

    private func settled(_ notice: MacSettler.Notice) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(InboxTone.doneIcon)
                .accessibilityHidden(true)
            Text("Settled").foregroundStyle(Theme.C.foreground)
            Text(notice.title).foregroundStyle(Theme.C.mutedForeground).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 6)
            Button(action: undo) {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.uturn.backward").font(.system(size: 10, weight: .semibold))
                    Text("⌘Z to undo")
                }
                .foregroundStyle(Theme.C.foreground.opacity(0.85))
                .padding(.horizontal, 7).frame(height: 20)
                .background(Theme.C.foreground.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help("Undo the settle (⌘Z)")
            .accessibilityLabel("Undo settle")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Settled \(notice.title)")
    }
}

/// ⌘⇧S in the key window: settles its sidebar's selected row. `block`: why it cannot now (the menu item is disabled).
struct MacSettleAction {
    let block: String?
    let settle: () -> Void
}

private struct MacSettleKey: FocusedValueKey { typealias Value = MacSettleAction }

extension FocusedValues {
    var macSettle: MacSettleAction? {
        get { self[MacSettleKey.self] }
        set { self[MacSettleKey.self] = newValue }
    }
}

/// Publishes the key window's "Undo Settle" (the Session menu) while its sidebar shows the notice.
struct MacSettleFocus: ViewModifier {
    @ObservedObject var settler: MacSettler
    let undo: () -> Void

    func body(content: Content) -> some View {
        content.focusedSceneValue(\.macUndoSettle, settler.notice == nil ? nil : MacUndoSettle(undo: undo))
    }
}

struct MacUndoSettle {
    let undo: () -> Void
}

private struct MacUndoSettleKey: FocusedValueKey { typealias Value = MacUndoSettle }

extension FocusedValues {
    var macUndoSettle: MacUndoSettle? {
        get { self[MacUndoSettleKey.self] }
        set { self[MacUndoSettleKey.self] = newValue }
    }
}
