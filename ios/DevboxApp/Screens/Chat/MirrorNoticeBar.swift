import SwiftUI

/// The line above a tmux session's composer (MirrorView.notice, the web's): the agent waiting for an answer in the
/// terminal, or why a message cannot go in now, with Open terminal; a refused send's lock can also be dismissed.
struct MirrorNoticeBar: View {
    let notice: MirrorView.Notice
    let openTerminal: () -> Void
    let dismiss: () -> Void

    private var prompt: Bool { notice.kind == .prompt }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Group {
                if prompt {
                    Text("\(Text(MirrorView.promptLead).fontWeight(.medium)) \(notice.text)")
                } else {
                    Text(notice.text)
                }
            }
            .font(Theme.F.body)
            .foregroundStyle(prompt ? Theme.C.warnText : Theme.C.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            Button("Open terminal", action: openTerminal)
                .font(Theme.F.meta.weight(.medium))
                .foregroundStyle(Theme.C.foreground)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.C.card, in: RoundedRectangle(cornerRadius: Theme.R.md))
                .overlay(RoundedRectangle(cornerRadius: Theme.R.md).strokeBorder(Theme.C.border))
                .iPhoneTapTarget()
                .buttonStyle(.plain)
                .fixedSize()
            if notice.dismissible {
                Button(action: dismiss) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                        .iPhoneTapTarget()
                }
                .buttonStyle(.plain)
                .help("Dismiss")
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
        .background(prompt ? Theme.C.warn.opacity(0.12) : Theme.C.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.R.md))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.md).strokeBorder(prompt ? Theme.C.warn.opacity(0.4) : Theme.C.border))
    }
}
