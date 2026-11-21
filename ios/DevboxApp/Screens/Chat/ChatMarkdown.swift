import SwiftUI

/// An answer's markdown as blocks (dashboard/src/components/chat/Markdown.tsx): paragraphs, lists with bold lead
/// words, tables, code, headings and quotes; links, inline code and status emoji (✅ ❌ ⚠️ as the app's icons) inside
/// them. `quiet`: the smaller, muted prose of a folded run's narration.
struct ChatMarkdown: View {
    let text: String
    var quiet = false

    private var font: Font { quiet ? .system(size: ChatType.s(14)) : .system(size: ChatType.s(16)) }

    var body: some View {
        VStack(alignment: .leading, spacing: quiet ? 6 : 12) {
            ForEach(Array(ChatMarkdownParse.cachedBlocks(text).enumerated()), id: \.offset) { _, b in block(b) }
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
        case .paragraph(let s): ChatInline.text(s).cutLinkHelp(s)
        case .heading(let level, let s): ChatInline.text(s).cutLinkHelp(s).font(.system(size: ChatType.s(level <= 2 ? 18 : 16), weight: .semibold))
        case .quote(let s):
            ChatInline.text(s).cutLinkHelp(s).foregroundStyle(Theme.C.mutedForeground)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.C.border).frame(width: 3) }
        case .bullets(let items): list(items.map { ("•", $0) })
        case .numbered(let start, let items): list(items.enumerated().map { ("\(start + $0).", $1) })
        case .code(let s):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(s).font(.system(size: ChatType.s(13), design: .monospaced)).lineSpacing(2).fixedSize()
                    .padding(12)
            }
            .plainScrollEdges()
            .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: Theme.R.lg))
        case .table(let header, let rows):
            #if os(macOS)
            grid(header, rows)
            #else
            table(header, rows)
            #endif
        }
    }

    private func list(_ items: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: quiet ? 2 : 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(it.0).foregroundStyle(Theme.C.mutedForeground).frame(minWidth: 10, alignment: .leading)
                    ChatInline.text(it.1).cutLinkHelp(it.1).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    #if os(macOS)
    /// A Mac window has room for columns: plain rules, no box (the header over a hairline, rows apart by hairlines),
    /// within the thread's column. Columns share the width by their content (TableColumns); a prose cell that has to
    /// give way wraps. A lone command or path stays on one line, cut at its end with the whole in its tooltip, so it
    /// does not push its row out of line with the others.
    private func grid(_ header: [String], _ rows: [[String]]) -> some View {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        let hasHeader = !header.allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty }
        @ViewBuilder func cell(_ s: String) -> some View {
            if ChatMarkdownParse.isCodeOnly(s) {
                ChatInline.text(s).lineLimit(1).truncationMode(.tail).help(Self.codeText(s))
                    .padding(.trailing, 16).padding(.vertical, 6)
            } else {
                ChatInline.text(s).cutLinkHelp(s).padding(.trailing, 16).padding(.vertical, 6)
            }
        }
        return TableColumns(columns: columns, hasHeader: hasHeader) {
            if hasHeader {
                ForEach(0..<columns, id: \.self) { j in
                    // The column names read as strongly as the cells, a step heavier.
                    ChatInline.text(j < header.count ? header[j] : "").font(font.weight(.semibold))
                        .foregroundStyle(Theme.C.foreground)
                        .padding(.trailing, 16).padding(.vertical, 6)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Rectangle().fill(Theme.C.border).frame(height: 1 / 3)
                ForEach(0..<columns, id: \.self) { j in cell(j < row.count ? row[j] : "") }
            }
        }
    }
    #endif

    /// A code-only cell's command, without its backticks.
    private static func codeText(_ cell: String) -> String {
        String(cell.trimmingCharacters(in: .whitespaces).dropFirst().dropLast())
    }

    #if !os(macOS)
    /// A phone has no room for columns: each row stacks its cells (the first, the check, above the result) inside one
    /// bordered group headed by the column names, rows apart by hairlines, so it reads as a table, not as a list of
    /// buttons. A table of more than two columns labels the later cells with their header.
    private func table(_ header: [String], _ rows: [[String]]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !header.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
                Text(header.prefix(2).joined(separator: " · "))
                    .font(font.weight(.semibold)).foregroundStyle(Theme.C.foreground)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background { Rectangle().fill(Theme.C.muted.opacity(0.6)) }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                VStack(alignment: .leading, spacing: 4) {
                    if let first = row.first {
                        if ChatMarkdownParse.isCodeOnly(first) {
                            // A command or path on one line, cut at its end where it does not fit; a long press shows
                            // the whole and copies it.
                            ChatInline.text(first).lineLimit(1).truncationMode(.tail)
                                .contextMenu {
                                    Text(Self.codeText(first))
                                    Button { UIPasteboard.general.string = Self.codeText(first) } label: { Label("Copy", systemImage: "doc.on.doc") }
                                }
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
    #endif
}

/// One line or paragraph of inline markdown as a single `Text`, so it wraps and selects as one.
enum ChatInline {
    /// The text parsed as one piece first, so bold, code and links around a status emoji stay intact; then each run's
    /// ✅ ❌ ⚠️ become the app's icons, the run's own attributes kept on the text beside them. Code is left as typed.
    static func text(_ s: String) -> Text {
        let a = attributed(s)
        var out = Text("")
        for run in a.runs {
            let piece = AttributedString(a[run.range])
            if run.inlinePresentationIntent?.contains(.code) == true {
                out = out + Text(piece)
                continue
            }
            for part in ChatMarkdownParse.statusParts(String(piece.characters)) {
                switch part {
                case .text(let t): out = out + Text(AttributedString(t, attributes: run.attributes))
                case .status(let st): out = out + icon(st)
                }
            }
        }
        return out
    }

    /// Inline markdown with bare URLs linked, code a size smaller, web links in the accent colour and every other
    /// link scheme dropped (see `ChatMarkdownParse.isWebLink`): its text stays, plain.
    static func attributed(_ s: String) -> AttributedString {
        // Unparseable markdown (a stray bracket mid-stream) is shown as typed rather than not at all.
        var a = (try? AttributedString(markdown: ChatMarkdownParse.linkBareURLs(s), options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        // Code a size under the prose: monospace at the same size reads larger and makes the line lumpy.
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = .system(size: ChatType.s(14), design: .monospaced)
        }
        dropNonWebLinks(&a)
        // Links in the accent colour, no underline: the colour alone marks them, as in the rest of iOS.
        for run in a.runs where run.link != nil {
            a[run.range].foregroundColor = Theme.C.link
        }
        return a
    }

    /// Agent text must not open the app's own deep links or local schemes: only http(s) links keep their link.
    static func dropNonWebLinks(_ a: inout AttributedString) {
        for run in a.runs {
            if let url = run.link, !ChatMarkdownParse.isWebLink(url) { a[run.range].link = nil }
        }
    }

    private static func icon(_ s: ChatMarkdownParse.Inline.Status) -> Text {
        let m = StatusMark(s)
        return Text(Image(systemName: m.symbol)).foregroundColor(m.color)
    }
}

extension View {
    /// A Mac tooltip with the full address of every link the text shows cut (`ChatMarkdownParse.shortURL`). A run of
    /// text has no tooltip of its own, so the paragraph carries it.
    @ViewBuilder
    func cutLinkHelp(_ s: String) -> some View {
        #if os(macOS)
        if let urls = ChatInline.cutLinks(s) { help(urls) } else { self }
        #else
        self
        #endif
    }
}

extension ChatInline {
    /// The full addresses of the links whose shown text is cut, one per line; nil when none is.
    static func cutLinks(_ s: String) -> String? {
        guard s.contains("://") else { return nil }
        let a = attributed(s)
        var urls: [String] = []
        for run in a.runs {
            if let url = run.link?.absoluteString, String(a[run.range].characters).contains("…"), !urls.contains(url) {
                urls.append(url)
            }
        }
        return urls.isEmpty ? nil : urls.joined(separator: "\n")
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

#if os(macOS)
/// A table's layout: subviews are the header's cells (when there is one), then per row a rule and its cells. Each
/// column wants its widest cell's one-line width; when they all fit, the last column takes the rest. When they do
/// not, the width is filled water-like: a column narrower than an even share keeps its width, the others split what
/// is left evenly (and wrap, or cut a command). So a short column never stays wide while another wraps a lone word,
/// and the table never runs past its column.
struct TableColumns: Layout {
    let columns: Int
    let hasHeader: Bool

    static func widths(natural: [CGFloat], available: CGFloat) -> [CGFloat] {
        guard !natural.isEmpty else { return [] }
        if natural.reduce(0, +) <= available {
            var w = natural
            w[w.count - 1] += available - natural.reduce(0, +)
            return w
        }
        var w = natural.map { _ in CGFloat(0) }
        var open = Set(natural.indices)
        var left = available
        while true {
            let share = left / CGFloat(max(open.count, 1))
            let fits = open.filter { natural[$0] <= share }
            if fits.isEmpty {
                for j in open { w[j] = share }
                return w
            }
            for j in fits { w[j] = natural[j]; left -= natural[j]; open.remove(j) }
            if open.isEmpty { return w }
        }
    }

    private struct Plan { var widths: [CGFloat]; var heights: [CGFloat]; var rules: [CGFloat] }

    /// Rows of subview indices (cells) and the rule before each body row.
    private func rows(_ count: Int) -> (cells: [[Int]], rules: [Int?]) {
        var cells: [[Int]] = []
        var rules: [Int?] = []
        var i = 0
        if hasHeader {
            cells.append(Array(i..<min(i + columns, count))); rules.append(nil); i += columns
        }
        while i < count {
            rules.append(i); i += 1
            cells.append(Array(i..<min(i + columns, count))); i += columns
        }
        return (cells, rules)
    }

    private func plan(_ proposal: ProposedViewSize, _ subviews: Subviews) -> Plan {
        let (cells, rules) = rows(subviews.count)
        var natural = Array(repeating: CGFloat(0), count: columns)
        for row in cells {
            for (j, i) in row.enumerated() { natural[j] = max(natural[j], subviews[i].sizeThatFits(.unspecified).width) }
        }
        // An unbounded proposal (.infinity, as when measuring the ideal size) means: as wide as the content.
        let available = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? natural.reduce(0, +)
        let widths = Self.widths(natural: natural, available: available)
        let heights = cells.map { row in
            row.enumerated().map { j, i in subviews[i].sizeThatFits(ProposedViewSize(width: widths[j], height: nil)).height }.max() ?? 0
        }
        let ruleHeights = rules.map { r in r.map { subviews[$0].sizeThatFits(ProposedViewSize(width: available, height: nil)).height } ?? 0 }
        return Plan(widths: widths, heights: heights, rules: ruleHeights)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let p = plan(proposal, subviews)
        return CGSize(width: p.widths.reduce(0, +), height: p.heights.reduce(0, +) + p.rules.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let p = plan(ProposedViewSize(width: bounds.width, height: nil), subviews)
        let (cells, rules) = rows(subviews.count)
        var y = bounds.minY
        for (n, row) in cells.enumerated() {
            if let r = rules[n] {
                subviews[r].place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: bounds.width, height: p.rules[n]))
                y += p.rules[n]
            }
            var x = bounds.minX
            for (j, i) in row.enumerated() {
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: p.widths[j], height: p.heights[n]))
                x += p.widths[j]
            }
            y += p.heights[n]
        }
    }
}
#endif
