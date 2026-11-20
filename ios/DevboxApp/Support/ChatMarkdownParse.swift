import Foundation

/// The block markdown agents answer in (dashboard/src/markdown.ts): paragraphs, bullet and numbered lists, tables,
/// fenced code, headings and quotes. Inline syntax (bold, code, links) is left to `AttributedString(markdown:)`.
enum MdBlock: Equatable {
    case paragraph(String)
    case bullets([String])
    case numbered(start: Int, [String])
    case table(header: [String], rows: [[String]])
    case code(String)
    case heading(level: Int, String)
    case quote(String)
}

enum ChatMarkdownParse {
    private static func match(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }
    private static let bullet = #"^\s*[-*+]\s+"#
    private static let number = #"^\s*\d+[.)]\s+"#
    private static let tableRule = #"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$"#

    static func blocks(_ text: String) -> [MdBlock] {
        let lines = text.components(separatedBy: "\n")
        var out: [MdBlock] = []
        var para: [String] = []
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
                out.append(.code(code.joined(separator: "\n")))
                i += 1 // the closing fence (or the end)
            } else if trimmed.hasPrefix("|"), i + 1 < lines.count, match(lines[i + 1], tableRule) {
                flush()
                let header = cells(line)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
                out.append(.table(header: header, rows: rows))
            } else if match(line, bullet) || match(line, number) {
                flush()
                let numbered = match(line, number)
                let marker = numbered ? number : bullet
                let start = numbered ? Int(trimmed.prefix(while: \.isNumber)) ?? 1 : 1
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i]
                    if match(l, marker) {
                        items.append(l.replacingOccurrences(of: marker, with: "", options: .regularExpression))
                    } else if !items.isEmpty, l.hasPrefix("  "), !l.trimmingCharacters(in: .whitespaces).isEmpty {
                        items[items.count - 1] += " " + l.trimmingCharacters(in: .whitespaces) // a wrapped item
                    } else { break }
                    i += 1
                }
                out.append(numbered ? .numbered(start: start, items) : .bullets(items))
            } else if let hashes = trimmed.firstIndex(where: { $0 != "#" }), trimmed.hasPrefix("#"),
                      trimmed[hashes] == " ", trimmed.distance(from: trimmed.startIndex, to: hashes) <= 6 {
                flush()
                out.append(.heading(level: trimmed.distance(from: trimmed.startIndex, to: hashes), String(trimmed[hashes...]).trimmingCharacters(in: .whitespaces)))
                i += 1
            } else if trimmed.hasPrefix(">") {
                flush()
                var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.quote(q.joined(separator: "\n")))
            } else if trimmed.isEmpty {
                flush()
                i += 1
            } else {
                para.append(line)
                i += 1
            }
        }
        flush()
        return out
    }

    /// A table row's cells: outer pipes dropped, split on pipes that are not escaped (`\|`).
    static func cells(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|"), !s.hasSuffix("\\|") { s.removeLast() }
        var cells: [String] = []
        var cur = ""
        var prev: Character = " "
        for ch in s {
            if ch == "|", prev != "\\" { cells.append(cur); cur = "" } else { cur.append(ch) }
            prev = ch
        }
        cells.append(cur)
        return cells.map { $0.replacingOccurrences(of: "\\|", with: "|").trimmingCharacters(in: .whitespaces) }
    }

    /// Bare URLs as markdown links (`AttributedString` does not link them), outside code spans and existing links.
    static func linkBareURLs(_ s: String) -> String {
        let parts = s.components(separatedBy: "`")
        return parts.enumerated().map { i, part in
            guard i % 2 == 0 else { return part } // inside a code span
            let ns = part as NSString
            let re = try! NSRegularExpression(pattern: #"(?<![(<\[])\bhttps?://[^\s<>()\[\]]+"#)
            var result = part
            for m in re.matches(in: part, range: NSRange(location: 0, length: ns.length)).reversed() {
                var url = ns.substring(with: m.range)
                // Sentence punctuation after a link is not part of it.
                while let last = url.last, ".,;:!?\"'".contains(last) { url.removeLast() }
                let r = Range(NSRange(location: m.range.location, length: (url as NSString).length), in: result)!
                result.replaceSubrange(r, with: "[\(shortURL(url))](\(url))")
            }
            return result
        }.joined(separator: "`")
    }

    /// A long bare URL shown without its scheme and with its middle cut, so the host and the end (often the page's
    /// name) both stay; the link itself keeps the full address.
    static func shortURL(_ url: String, max: Int = 34) -> String {
        guard url.count > max else { return url }
        let bare = url.replacing(/^https?:\/\//, with: "")
        guard bare.count > max else { return bare }
        let head = max / 2
        return String(bare.prefix(head)) + "…" + String(bare.suffix(max - head - 1))
    }

    /// A table cell that is one code span and nothing else (a command, a path): shown on one line, never wrapped.
    static func isCodeOnly(_ cell: String) -> Bool {
        let t = cell.trimmingCharacters(in: .whitespaces)
        return t.count > 2 && t.hasPrefix("`") && t.hasSuffix("`") && !t.dropFirst().dropLast().contains("`")
    }

    /// Status emoji in an answer (✅ ❌ ⚠️), drawn as the app's own icons; the text around them stays text.
    enum Inline: Equatable {
        enum Status { case pass, fail, warn }
        case text(String)
        case status(Status)
    }

    static func statusParts(_ s: String) -> [Inline] {
        var out: [Inline] = []
        var cur = ""
        for ch in s {
            let status: Inline.Status?
            switch ch {
            case "✅", "✔️", "✔": status = .pass
            case "❌", "✖️": status = .fail
            case "⚠️", "⚠": status = .warn
            default: status = nil
            }
            if let status {
                if !cur.isEmpty { out.append(.text(cur)); cur = "" }
                out.append(.status(status))
            } else { cur.append(ch) }
        }
        if !cur.isEmpty { out.append(.text(cur)) }
        return out
    }
}
