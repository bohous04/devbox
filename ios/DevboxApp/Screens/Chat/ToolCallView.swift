import SwiftUI

/// A tool call as one quiet line (dashboard/src/components/chat/ToolCall.tsx): "Ran `bun test`" with a pass or fail
/// mark; tapping it opens the tool's name, the full command or input (wrapped) and the output.
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
        if case .string(let c)? = item.input { return c }
        return nil
    }

    private var label: ToolLabel { ToolLabel(item.tool, item.input) }

    private var icon: String {
        switch label.kind {
        case .command: return "apple.terminal"
        case .read: return "doc.text"
        case .edit: return "pencil.line"
        case .search: return "magnifyingglass"
        case .web: return "globe"
        case .agent: return "person.crop.circle"
        case .other: return "wrench.adjustable"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Group {
                        if item.status == .streaming {
                            ProgressView().controlSize(.mini).accessibilityLabel("running")
                        } else {
                            Image(systemName: icon).foregroundStyle(Theme.C.mutedForeground).accessibilityHidden(true)
                        }
                    }
                    .frame(width: 18)
                    Text(label.verb).foregroundStyle(Theme.C.mutedForeground).fixedSize()
                    if !label.target.isEmpty {
                        if label.code {
                            Text(label.target).font(.system(size: ChatType.s(13), design: .monospaced)).foregroundStyle(Theme.C.foreground.opacity(0.85))
                                .lineLimit(open ? nil : 1).truncationMode(.middle)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: 5))
                        } else {
                            Text(label.target).foregroundStyle(Theme.C.foreground.opacity(0.85)).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 4)
                    // Pass or fail from the tool's own result flag; the stream carries no exit code or duration.
                    if item.isError == true {
                        StatusMark(.fail).image
                    } else if item.status == .done, item.output != nil {
                        StatusMark(.pass).image
                    }
                    Image(systemName: "chevron.right").font(.system(size: ChatType.s(11), weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
                        .rotationEffect(.degrees(open ? 90 : 0)).accessibilityHidden(true)
                }
                .font(.system(size: ChatType.s(14)))
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Hides the details" : "Shows the input and output")
            // A failed command says why without opening it: the output's first line, under the command.
            if !open, item.isError == true, let line = Self.firstLine(item.output) {
                Text(line).font(.system(size: ChatType.s(12), design: .monospaced)).foregroundStyle(Theme.C.dangerText)
                    .lineLimit(2).truncationMode(.tail)
                    .padding(.leading, 26).padding(.bottom, 6)
            }
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.tool ?? "(unknown)").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    if let command { code(command) } else if let input = item.input { code(input.pretty) }
                    if let output = item.output {
                        code(output.isEmpty ? "(no output)" : output, error: item.isError == true)
                    } else {
                        Text(item.status == .streaming ? "running…" : "no output").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                }
                .padding(.leading, 26).padding(.bottom, 8)
            }
        }
    }

    /// The first non-blank line of a tool's output.
    static func firstLine(_ output: String?) -> String? {
        output?.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
    }

    private func code(_ text: String, error: Bool = false) -> some View {
        ScrollView {
            Text(LinkDetector.attributed(text)).font(.system(size: ChatType.s(12), design: .monospaced)).textSelection(.enabled)
                .foregroundStyle(error ? Theme.C.dangerText : Theme.C.foreground.opacity(0.85))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 240)
        .fixedSize(horizontal: false, vertical: true)
        .padding(10)
        .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: Theme.R.md))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.md).strokeBorder(error ? Theme.C.danger.opacity(0.35) : .clear))
    }
}
