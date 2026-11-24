import SwiftUI

/// The thread header's changes (the Mac window's toolbar, the iPhone's navigation bar): the worktree's +/− against
/// its base, when it has any; a click or tap shows the changes card, opened. Loads with the thread and again when a
/// run ends, as the card does.
struct ChangesChip: View {
    @ObservedObject var thread: ThreadStore
    @StateObject private var changes: ChangesStore
    let show: () -> Void
    /// Whether the chip shows anything: the iPhone's toolbar hides the item's glass while it does not, or the bar
    /// drew an empty capsule beside the terminal button.
    let shown: (Bool) -> Void
    @State private var hover = false

    init(store: ThreadStore, client: DevdClient, shown: @escaping (Bool) -> Void = { _ in }, show: @escaping () -> Void) {
        thread = store
        _changes = StateObject(wrappedValue: ChangesStore(sessionId: store.sessionId, client: client))
        self.shown = shown
        self.show = show
    }

    private var loaded: SessionChanges? {
        guard thread.changesAnchor != nil, case .loaded(let c) = changes.state else { return nil }
        return c
    }

    var body: some View {
        Group {
            if let c = loaded {
                Button(action: show) {
                    #if os(macOS)
                    totals(c)
                        .font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 8).frame(height: 26)
                        // A button, not a label: an outline, filled on hover.
                        .background(Theme.C.foreground.opacity(hover ? 0.08 : 0.03), in: RoundedRectangle(cornerRadius: 7))
                        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.C.border))
                        .contentShape(Rectangle())
                    #else
                    // The navigation bar's own glass is the button; numbers only and tight, so the title keeps its room.
                    totals(c).font(.system(size: 13, weight: .medium)).fixedSize()
                    #endif
                }
                .buttonStyle(.plain)
                .onHover { hover = $0 }
                .help("\(ChangesView.title(c)) — show the changes")
                .accessibilityLabel("\(ChangesView.title(c)), \(c.totals.added) lines added, \(c.totals.removed) removed")
            } else {
                // Not empty: an empty view never appears, so its task (the fetch) would never run.
                Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
        .onChange(of: loaded != nil, initial: true) { _, visible in shown(visible) }
        // A run that starts takes the anchor away: the chip goes, without a fetch, until the run ends.
        .task(id: thread.changesAnchor) {
            guard thread.changesAnchor != nil else { return changes.reset() }
            await changes.load()
        }
    }

    #if os(macOS)
    private static let gap: CGFloat = 6
    #else
    private static let gap: CGFloat = 3
    #endif

    @ViewBuilder
    private func totals(_ c: SessionChanges) -> some View {
        HStack(spacing: Self.gap) {
            #if os(macOS)
            Image(systemName: "doc.badge.plus").foregroundStyle(Theme.C.mutedForeground)
            #endif
            Text("+\(c.totals.added)").foregroundStyle(InboxTone.doneIcon)
            Text("−\(c.totals.removed)").foregroundStyle(c.totals.removed > 0 ? InboxTone.danger : Theme.C.mutedForeground)
        }
        .monospacedDigit()
    }
}
