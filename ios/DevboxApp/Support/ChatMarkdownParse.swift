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
    // Compiled once: a streaming answer is parsed again on every update.
    private static func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }
    private static func match(_ s: String, _ re: NSRegularExpression) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
    private static func strip(_ s: String, _ re: NSRegularExpression) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
    }
    private static let bullet = regex(#"^\s*[-*+]\s+"#)
    private static let number = regex(#"^\s*\d+[.)]\s+"#)
    private static let tableRule = regex(#"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$"#)
    /// A markdown link `[text](target)`: a bare URL inside one is already linked (or is its text).
    private static let mdLink = regex(#"\[[^\]]*\]\([^)]*\)"#)
    private static let scheme = regex(#"^https?://"#)

    /// Blocks per message text, so a re-render (or the streaming row's neighbours) does not parse again.
    private static let blockCache: NSCache<NSString, BlocksBox> = {
        let c = NSCache<NSString, BlocksBox>()
        c.countLimit = 400
        return c
    }()
    private final class BlocksBox { let blocks: [MdBlock]; init(_ b: [MdBlock]) { blocks = b } }

    static func cachedBlocks(_ text: String) -> [MdBlock] {
        if let hit = blockCache.object(forKey: text as NSString) { return hit.blocks }
        let b = blocks(text)
        blockCache.setObject(BlocksBox(b), forKey: text as NSString)
        return b
    }

    /// Only web links open from an agent's text: any other scheme (the app's own devbox:// deep links, file:, tel:,
    /// sms:, javascript:) is shown as plain text (dashboard/src/markdown.ts).
    static func isWebLink(_ url: URL) -> Bool {
        guard let s = url.scheme?.lowercased() else { return false }
        return s == "http" || s == "https"
    }

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
                        items.append(strip(l, marker))
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
            let whole = NSRange(location: 0, length: ns.length)
            let links = mdLink.matches(in: part, range: whole).map(\.range)
            var result = part
            for m in LinkDetector.ranges(in: part).reversed()
            where !links.contains(where: { NSIntersectionRange($0, m).length > 0 })
                && !(m.location > 0 && "(<[".contains(ns.character(at: m.location - 1).asCharacter)) {
                let url = ns.substring(with: m)
                let r = Range(m, in: result)!
                result.replaceSubrange(r, with: "[\(shortURL(url))](\(url))")
            }
            return result
        }.joined(separator: "`")
    }

    /// A long bare URL shown without its scheme and with its middle cut, so the host and the end (often the page's
    /// name) both stay; the link itself keeps the full address. A Mac window has the room to show it from the start:
    /// cut only at its tail, past 60 characters.
    #if os(macOS)
    static let defaultMax = 60, cutsTail = true
    #else
    static let defaultMax = 34, cutsTail = false
    #endif
    static func shortURL(_ url: String, max: Int = defaultMax, tail: Bool = cutsTail) -> String {
        guard url.count > max else { return url }
        let bare = strip(url, scheme)
        guard bare.count > max else { return bare }
        if tail { return String(bare.prefix(max - 1)) + "…" }
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

private extension unichar {
    var asCharacter: Character { Character(Unicode.Scalar(self) ?? " ") }
}
