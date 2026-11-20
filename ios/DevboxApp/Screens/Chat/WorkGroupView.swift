import SwiftUI

/// A finished run's work folded to one line, "Worked for 2m 14s · 3 commands" (failures apart in red); open, it
/// lists every tool call (each with its pass or fail mark) and the narration between them.
struct WorkGroupView: View, Equatable {
    let work: WorkRow
    @State private var open = false

    static func == (a: WorkGroupView, b: WorkGroupView) -> Bool { a.work == b.work }

    private var items: [ThreadItem] { work.items.map(\.item) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    labelText.lineLimit(1)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0)).accessibilityHidden(true)
                    Spacer(minLength: 0)
                }
                .font(.system(size: 14))
                .foregroundStyle(open ? Theme.C.foreground : Theme.C.mutedForeground)
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Hides the run's commands" : "Shows the run's commands and notes")
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(work.items) { r in
                        if r.item.kind == .tool {
                            ToolCallView(item: r.item)
                        } else {
                            ChatMarkdown(text: r.item.text, quiet: true).padding(.vertical, 4)
                        }
                    }
                }
                .padding(.bottom, 6)
            }
        }
        .padding(.bottom, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3) }
    }

    private var labelText: Text {
        var t = Text(WorkGroups.label(work))
        let summary = WorkGroups.summary(items)
        if !summary.isEmpty { t = t + Text(" · ").foregroundColor(Theme.C.mutedForeground.opacity(0.6)) + Text(summary) }
        let failed = WorkGroups.failures(items)
        if failed > 0 { t = t + Text(" · ").foregroundColor(Theme.C.mutedForeground.opacity(0.6)) + Text("\(failed) failed").foregroundColor(Theme.C.dangerText) }
        return t
    }
}
