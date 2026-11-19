import SwiftUI

/// A collapsible tool call (dashboard/src/components/chat/ToolCall.tsx): name and command on one line, the full
/// input and output when opened.
struct ToolCallView: View {
    let item: ThreadItem
    @State private var open = false

    /// One line for the input: its command, file or pattern when it has one, otherwise the JSON.
    static func summary(_ input: JSONValue?) -> String {
        guard let input else { return "" }
        if case .object(let o) = input {
            for key in ["command", "file_path", "path", "pattern", "url", "description"] {
                if case .string(let s)? = o[key] { return s }
            }
        }
        return input.pretty.replacingOccurrences(of: "\n", with: " ")
    }

    private var command: String? {
        if case .object(let o)? = item.input, case .string(let c)? = o["command"] { return c }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(open ? 90 : 0)).font(.caption2)
                    if item.status == .streaming {
                        ProgressView().controlSize(.mini).accessibilityLabel("running")
                    } else if item.isError == true {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.C.dangerText).accessibilityLabel("failed")
                    } else {
                        Image(systemName: "wrench").foregroundStyle(Theme.C.mutedForeground)
                    }
                    Text(item.tool ?? "tool").font(Theme.F.body.weight(.medium))
                    Text(Self.summary(item.input)).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Hides the details" : "Shows the input and output")
            if open {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    if let command { code(command) } else if let input = item.input { code(input.pretty) }
                    if let output = item.output {
                        code(output.isEmpty ? "(no output)" : output, error: item.isError == true)
                    } else {
                        Text(item.status == .streaming ? "running…" : "no output").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                }
                .padding(12)
            }
        }
        .background(Theme.C.card, in: RoundedRectangle(cornerRadius: Theme.R.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.lg).strokeBorder(item.isError == true ? Theme.C.danger.opacity(0.4) : Theme.C.border))
    }

    private func code(_ text: String, error: Bool = false) -> some View {
        ScrollView {
            Text(text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                .foregroundStyle(error ? Theme.C.dangerText : Theme.C.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 240)
        .padding(8)
        .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: Theme.R.md))
    }
}
