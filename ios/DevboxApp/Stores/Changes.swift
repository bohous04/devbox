import Foundation

// The changed-files card under the thread's latest answer (dashboard ChangesCard, changesView.ts, diffView.ts): the
// session worktree's state against devd's base, not one turn's diff, so its label names the base. Types follow
// shared/changes.ts.

enum ChangeStatus: String, Codable {
    case added, modified, deleted, renamed, untracked
}

struct ChangedFile: Codable, Equatable {
    var path: String
    var status: ChangeStatus
    /// nil = not counted (binary, or an untracked file devd did not read).
    var added: Int?
    var removed: Int?
    var oldPath: String?
    var nameNotUtf8: Bool?
}

struct SessionChanges: Codable, Equatable {
    struct Totals: Codable, Equatable { var files: Int; var added: Int; var removed: Int }
    var base: String
    var files: [ChangedFile]
    var totals: Totals
    var truncated: Bool?
    var countsCapped: Bool?
    var countsUnavailable: Bool?
}

struct SessionFileDiff: Codable, Equatable {
    var path: String
    var status: ChangeStatus
    var base: String
    var binary: Bool
    var truncated: Bool
    var diff: String
}

/// Where the card sits: under the latest finished run's last assistant message, while nothing runs or waits.
struct ChangesAnchor: Equatable {
    /// The `ChatRow.id` of that message.
    let rowId: Int
    /// The run's end seq: a new one refetches the card.
    let endedSeq: Int?
}

enum ChangesView {
    /// "3 changed files" / "1 changed file", from devd's totals (they count every file, also past a cut list).
    static func title(_ c: SessionChanges) -> String {
        "\(c.totals.files) changed \(c.totals.files == 1 ? "file" : "files")"
    }

    /// A file's line counts, or nil when devd has none ("not counted").
    static func stat(_ f: ChangedFile) -> (added: Int, removed: Int)? {
        guard let a = f.added, let r = f.removed else { return nil }
        return (a, r)
    }

    /// devd left some untracked files' lines out of the totals.
    static func countsIncomplete(_ c: SessionChanges) -> Bool { c.countsCapped == true || c.countsUnavailable == true }

    static func letter(_ s: ChangeStatus) -> String {
        switch s {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .untracked: "U"
        }
    }

    /// Directory (with its trailing slash) and name apart.
    static func splitPath(_ path: String) -> (dir: String, name: String) {
        guard let i = path.lastIndex(of: "/") else { return ("", path) }
        return (String(path[...i]), String(path[path.index(after: i)...]))
    }

    struct FolderGroup: Equatable {
        var dir: String
        var added = 0
        var removed = 0
        var files: [ChangedFile] = []
    }

    /// Files under their folder, folders in first-seen order; a folder's +/− sums its counted files.
    static func groupByFolder(_ files: [ChangedFile]) -> [FolderGroup] {
        var order: [String] = []
        var groups: [String: FolderGroup] = [:]
        for f in files {
            let dir = splitPath(f.path).dir
            if groups[dir] == nil { order.append(dir); groups[dir] = FolderGroup(dir: dir) }
            groups[dir]!.files.append(f)
            groups[dir]!.added += f.added ?? 0
            groups[dir]!.removed += f.removed ?? 0
        }
        return order.map { groups[$0]! }
    }

    /// The row the card sits under, or nil for no card (a run is running or queued, or none has ended).
    static func anchor(_ rows: [ChatRow], runs: [RunRow]) -> ChangesAnchor? {
        if runs.contains(where: { $0.status == .running || $0.status == .queued }) { return nil }
        guard let last = runs.filter({ $0.endedAt != nil }).max(by: { ($0.endedSeq ?? 0) < ($1.endedSeq ?? 0) }) else { return nil }
        guard let row = rows.last(where: { $0.item.kind == .assistant && $0.item.runId == last.runId }) else { return nil }
        return ChangesAnchor(rowId: row.id, endedSeq: last.endedSeq)
    }

    /// A repository without commits has nothing to compare: devd refuses with code `no_commits`, and the card is left
    /// out rather than shown as an error.
    static func isNoCommits(_ error: Error) -> Bool {
        (error as? DevdHTTPError)?.serverCode == "no_commits"
    }

    /// The list starts open when it is short enough to read at a glance.
    static let openMax = 6
    /// "Open diffs" is offered up to this many files.
    static let openAllMax = 30
}

/// One rendered line of a unified diff; `old`/`new` are the line numbers on each side (nil where it has none).
struct DiffLine: Equatable {
    enum Kind { case hunk, add, del, ctx, note }
    let kind: Kind
    let text: String
    let old: Int?
    let new: Int?
}

enum DiffView {
    private static let hunkRe = try! NSRegularExpression(pattern: #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)

    /// A diff ready to draw: lines parsed and escaped once (off the main thread, see `ChangesStore.diff`), with the
    /// widths the table needs.
    struct Prepared: Equatable {
        struct Line: Equatable {
            let kind: DiffLine.Kind
            let old: Int?
            let new: Int?
            let parts: [Part]
            /// The raw text, for VoiceOver.
            let text: String
        }
        let binary: Bool
        let truncated: Bool
        let lines: [Line]
        /// The longest line in drawn characters (escapes counted as shown).
        let longest: Int
        /// Digits of the largest line number (at least 2).
        let digits: Int
    }

    static func prepare(_ d: SessionFileDiff) -> Prepared {
        let parsed = d.binary ? [] : parse(d.diff)
        let lines = parsed.map { l in Prepared.Line(kind: l.kind, old: l.old, new: l.new, parts: escapeInvisible(l.text), text: l.text) }
        let longest = lines.map { $0.parts.reduce(0) { $0 + $1.text.count } }.max() ?? 0
        let digits = max(2, String(parsed.compactMap { max($0.old ?? 0, $0.new ?? 0) }.max() ?? 0).count)
        return Prepared(binary: d.binary, truncated: d.truncated, lines: lines, longest: longest, digits: digits)
    }

    /// The lines of a git unified diff for display; the per-file header is dropped (the card names the file).
    static func parse(_ diff: String) -> [DiffLine] {
        var out: [DiffLine] = []
        var inHunk = false, o = 0, n = 0
        var lines = diff.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        for line in lines {
            if line.hasPrefix("@@"),
               let m = hunkRe.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
               let oldStart = Range(m.range(at: 1), in: line), let newStart = Range(m.range(at: 2), in: line) {
                inHunk = true
                o = Int(line[oldStart]) ?? 0
                n = Int(line[newStart]) ?? 0
                out.append(DiffLine(kind: .hunk, text: line, old: nil, new: nil))
            } else if line.hasPrefix("diff ") {
                inHunk = false
            } else if !inHunk {
                continue
            } else if line.hasPrefix("+") {
                out.append(DiffLine(kind: .add, text: String(line.dropFirst()), old: nil, new: n)); n += 1
            } else if line.hasPrefix("-") {
                out.append(DiffLine(kind: .del, text: String(line.dropFirst()), old: o, new: nil)); o += 1
            } else if line.hasPrefix("\\") {
                out.append(DiffLine(kind: .note, text: line, old: nil, new: nil))
            } else {
                out.append(DiffLine(kind: .ctx, text: String(line.dropFirst()), old: o, new: n)); o += 1; n += 1
            }
        }
        return out
    }

    struct Part: Equatable { let text: String; let escaped: Bool }

    /// A diff line split into plain text and `\uXXXX` escapes. Control and format characters (zero-width, bidi
    /// overrides and isolates) hide what a line really contains (Trojan Source), so they are always escaped; a tab
    /// stays. A combining mark renders on a base (NFD accents, variation selectors) but is escaped after a space,
    /// punctuation or the line's start, where it would draw as a stray glyph.
    static func escapeInvisible(_ line: String) -> [Part] {
        var parts: [Part] = []
        var plain = ""
        var prev: Unicode.Scalar?
        for s in line.unicodeScalars {
            let cat = s.properties.generalCategory
            let control = cat == .control || cat == .format
            let mark = cat == .nonspacingMark || cat == .enclosingMark
            let escape = s != "\t" && (control || (mark && !(prev.map(isBase) ?? false)))
            if !escape { plain.unicodeScalars.append(s); prev = s; continue }
            if !plain.isEmpty { parts.append(Part(text: plain, escaped: false)); plain = "" }
            let hex = String(s.value, radix: 16)
            parts.append(Part(text: s.value > 0xFFFF ? "\\u{\(hex)}" : "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex, escaped: true))
        }
        if !plain.isEmpty { parts.append(Part(text: plain, escaped: false)) }
        return parts
    }

    /// Letters, numbers, marks and symbols carry a following combining mark.
    private static func isBase(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber,
             .nonspacingMark, .spacingMark, .enclosingMark,
             .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol: true
        default: false
        }
    }
}

/// The card's data: the changes (refetched by `load`), and each file's diff fetched once per changes result, at most
/// four at a time. A failed diff is not cached, so Retry asks again.
@MainActor
final class ChangesStore: ObservableObject {
    enum State: Equatable { case loading, none, loaded(SessionChanges), failed(String) }

    @Published private(set) var state: State = .loading
    private let base: String
    private let client: DevdClient
    private var cache: [String: Task<DiffView.Prepared, Error>] = [:]
    /// "Open diffs" on a long list fetches through this: at most four requests at once.
    private let limiter = AsyncLimiter(4)
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    init(sessionId: String, client: DevdClient) {
        base = "/api/sessions/\(pathSegment(sessionId))/changes"
        self.client = client
    }

    func load() async {
        do {
            let c: SessionChanges = try await client.get(base)
            cancelDiffs()
            state = c.totals.files == 0 ? .none : .loaded(c)
        } catch is CancellationError {
            return
        } catch {
            cancelDiffs()
            state = ChangesView.isNoCommits(error) ? .none : .failed(errorText(error))
        }
    }

    /// Back to loading, for a result that no longer holds (a new run started).
    func reset() {
        cancelDiffs()
        state = .loading
    }

    /// The file's diff, fetched once per changes result and parsed off the main thread.
    func diff(_ path: String) async throws -> DiffView.Prepared {
        if let t = cache[path] { return try await t.value }
        // Only RFC 3986 unreserved characters stay as they are; "/", "&", "+" and the rest are escaped.
        let query = path.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? path
        let t = Task { [client, base] () async throws -> DiffView.Prepared in
            let d: SessionFileDiff = try await self.limiter.run { try await client.get("\(base)/diff?path=\(query)") }
            try Task.checkCancellation()
            return await Task.detached(priority: .userInitiated) { DiffView.prepare(d) }.value
        }
        cache[path] = t
        do {
            return try await t.value
        } catch {
            if cache[path] == t { cache[path] = nil }
            throw error
        }
    }

    /// Stops every fetch still running (the card left the screen, or a new changes result replaces them) and
    /// forgets them, so the next open asks again.
    func cancelDiffs() {
        for t in cache.values { t.cancel() }
        cache = [:]
    }
}

/// Runs at most `limit` operations at once; the rest wait in call order.
@MainActor
final class AsyncLimiter {
    private let limit: Int
    private var running = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(_ limit: Int) { self.limit = limit }

    func run<T>(_ operation: () async throws -> T) async rethrows -> T {
        if running < limit {
            running += 1
        } else {
            // The slot is handed over by the finishing operation, so `running` stays at the limit.
            await withCheckedContinuation { waiting.append($0) }
        }
        defer {
            if waiting.isEmpty { running -= 1 } else { waiting.removeFirst().resume() }
        }
        return try await operation()
    }
}
