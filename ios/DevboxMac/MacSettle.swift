import AppKit
import SwiftUI

/// Settling from the sidebar in one gesture (the row's ✓, ⌘⇧S), the "Settled · ⌘Z to undo" notice that follows it,
/// and the tmux seen marker (InboxSettler, shared with the iPhone). One for the app, as the inbox is: every window's
/// sidebar shows the same notice.
@MainActor
final class MacSettler: InboxSettler {
    /// The windows whose sidebar shows the notice now: ⌘Z is taken in those only. By identity, as a window's number
    /// is -1 until it is ordered in.
    private(set) var sidebarWindows: Set<ObjectIdentifier> = []

    init(lifetime: Duration = .seconds(5), voiceOver: @escaping @MainActor () -> Bool = InboxSettler.voiceOverRuns) {
        super.init(lifetime: lifetime, voiceOver: voiceOver, undoHint: "⌘Z to undo")
    }

    /// ⌘Z undoes the settle while the key window's sidebar shows its notice, unless what has the keyboard has an undo
    /// or a ⌘Z of its own (a text field being edited, the terminal).
    static func claimsUndo(flags: NSEvent.ModifierFlags, key: String, noticeShown: Bool, focusOwnsUndo: Bool) -> Bool {
        noticeShown && !focusOwnsUndo && key.lowercased() == "z"
            && flags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function]) == .command
    }

    func showingSidebar(window: ObjectIdentifier) { sidebarWindows.insert(window) }
    func leftSidebar(window: ObjectIdentifier) { sidebarWindows.remove(window) }
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
            Text("Settled · ending").foregroundStyle(Theme.C.foreground)
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
        .accessibilityLabel("Settled \(notice.title), the session ends")
    }
}

/// ⌘⇧S in the key window: settles its sidebar's selected row. `block`: why it cannot now (the menu item is disabled).
struct MacSettleAction {
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
