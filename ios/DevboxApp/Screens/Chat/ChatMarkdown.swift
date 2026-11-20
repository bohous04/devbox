import SwiftUI

/// An answer's markdown as blocks (dashboard/src/components/chat/Markdown.tsx): paragraphs, lists with bold lead
/// words, tables, code, headings and quotes; links, inline code and status emoji (✅ ❌ ⚠️ as the app's icons) inside
/// them. `quiet`: the smaller, muted prose of a folded run's narration.
struct ChatMarkdown: View {
    let text: String
    var quiet = false

    private var font: Font { quiet ? .system(size: 14) : .system(size: 16) }

    var body: some View {
        VStack(alignment: .leading, spacing: quiet ? 6 : 12) {
            ForEach(Array(ChatMarkdownParse.blocks(text).enumerated()), id: \.offset) { _, b in block(b) }
        }
        .font(font)
        .lineSpacing(quiet ? 2 : 4)
        .foregroundStyle(quiet ? Theme.C.mutedForeground : Theme.C.foreground)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func block(_ b: MdBlock) -> some View {
        switch b {
        case .paragraph(let s): ChatInline.text(s)
        case .heading(let level, let s): ChatInline.text(s).font(.system(size: level <= 2 ? 18 : 16, weight: .semibold))
        case .quote(let s):
            ChatInline.text(s).foregroundStyle(Theme.C.mutedForeground)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.C.border).frame(width: 3) }
        case .bullets(let items): list(items.map { ("•", $0) })
        case .numbered(let start, let items): list(items.enumerated().map { ("\(start + $0).", $1) })
        case .code(let s):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(s).font(.system(size: 13, design: .monospaced)).lineSpacing(2).fixedSize()
                    .padding(12)
            }
            .plainScrollEdges()
            .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: Theme.R.lg))
        case .table(let header, let rows): table(header, rows)
        }
    }

    private func list(_ items: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: quiet ? 2 : 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(it.0).foregroundStyle(Theme.C.mutedForeground).frame(minWidth: 10, alignment: .leading)
                    ChatInline.text(it.1).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// A phone has no room for columns: each row stacks its cells (the first, the check, above the result) inside one
    /// bordered group headed by the column names, rows apart by hairlines, so it reads as a table, not as a list of
    /// buttons. A table of more than two columns labels the later cells with their header.
    private func table(_ header: [String], _ rows: [[String]]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !header.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
                Text(header.prefix(2).joined(separator: " · "))
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.C.mutedForeground)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background { Rectangle().fill(Theme.C.muted.opacity(0.6)) }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                VStack(alignment: .leading, spacing: 4) {
                    if let first = row.first {
                        if ChatMarkdownParse.isCodeOnly(first) {
                            // A command or path on one line, cut in the middle where it does not fit: never wrapped
                            // mid-path, never clipped at the edge.
                            ChatInline.text(first).lineLimit(1).truncationMode(.middle)
                        } else {
                            ChatInline.text(first).font(font.weight(.medium))
                        }
                    }
                    ForEach(Array(row.dropFirst().enumerated()), id: \.offset) { j, cell in
                        if header.count > 2, j + 1 < header.count {
                            (Text(header[j + 1] + ": ").foregroundColor(Theme.C.mutedForeground) + ChatInline.text(cell))
                        } else {
                            ChatInline.text(cell)
                        }
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3) }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.R.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.lg).strokeBorder(Theme.C.border))
    }
}

/// One line or paragraph of inline markdown as a single `Text`, so it wraps and selects as one.
enum ChatInline {
    static func text(_ s: String) -> Text {
        var out = Text("")
        for part in ChatMarkdownParse.statusParts(s) {
            switch part {
            case .text(let t): out = out + Text(attributed(t))
            case .status(let st): out = out + icon(st)
            }
        }
        return out
    }

    private static func attributed(_ s: String) -> AttributedString {
        // Unparseable markdown (a stray bracket mid-stream) is shown as typed rather than not at all.
        var a = (try? AttributedString(markdown: ChatMarkdownParse.linkBareURLs(s), options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        // Code a size under the prose: monospace at the same size reads larger and makes the line lumpy.
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = .system(size: 14, design: .monospaced)
        }
        // Links in the accent colour, no underline: the colour alone marks them, as in the rest of iOS.
        for run in a.runs where run.link != nil {
            a[run.range].foregroundColor = Theme.C.link
        }
        return a
    }

    private static func icon(_ s: ChatMarkdownParse.Inline.Status) -> Text {
        let m = StatusMark(s)
        return Text(Image(systemName: m.symbol)).foregroundColor(m.color)
    }
}

/// The one set of pass / fail / warning marks, used by answers (✅ ❌ ⚠️) and by command rows alike.
struct StatusMark {
    let symbol: String
    let color: Color
    let label: String

    init(_ s: ChatMarkdownParse.Inline.Status) {
        switch s {
        case .pass: (symbol, color, label) = ("checkmark.circle", Theme.C.okText, "succeeded")
        case .fail: (symbol, color, label) = ("xmark.circle", Theme.C.dangerText, "failed")
        case .warn: (symbol, color, label) = ("exclamationmark.triangle", Theme.C.warnText, "warning")
        }
    }

    var image: some View {
        Image(systemName: symbol).foregroundStyle(color).accessibilityLabel(label)
    }
}
