import Foundation

// How the chat thread is laid out (dashboard/src/workGroups.ts, threadTitle.ts): a finished run's work (its tool
// calls and the prose between them) folds into one "Worked for …" row above the run's answer (its last assistant
// message). Nothing is dropped: opening the row shows every folded item, and each tool row opens to its full input
// and output.

/// A finished run's folded work.
struct WorkRow: Equatable {
    let runId: String
    let status: RunRow.Status
    let durationMs: Int?
    var items: [ChatRow]
}

enum ThreadDisplayRow: Identifiable, Equatable {
    /// `answer`: the last assistant message of a finished run.
    case item(ChatRow, answer: Bool)
    case work(WorkRow)

    var id: String {
        switch self {
        case .item(let r, _): return Self.itemId(r.id)
        case .work(let w): return "work:\(w.runId)"
        }
    }

    /// The id of the row showing the `ChatRow` with this id.
    static func itemId(_ rowId: Int) -> String { "item:\(rowId)" }
}

enum WorkGroups {
    private static let ended: Set<RunRow.Status> = [.completed, .interrupted, .failed]

    /// The rows that open a turn: a prompt after another row, not right after a notice (which already sets it off).
    /// They get a little more room above them (ChatLayout.turnGap; dashboard workGroups.ts opensTurn).
    static func turnStarts(_ rows: [ThreadDisplayRow]) -> Set<String> {
        var out = Set<String>()
        for (i, row) in rows.enumerated() where i > 0 {
            guard case .item(let r, _) = row, r.item.kind == .user else { continue }
            if case .item(let prev, _) = rows[i - 1], prev.item.kind == .notice { continue }
            out.insert(row.id)
        }
        return out
    }

    /// The thread's rows. A run folds only once it ended and only when it called a tool; a running run stays
    /// expanded (its last message may still turn out to be prose before the next tool). The fold sits where its first
    /// item was; user messages, requests and notices never fold. `partialRun`: a run only partly loaded
    /// (ThreadView.tailView), which stays expanded, since its fold would undercount its work.
    static func rows(_ rows: [ChatRow], runs: [RunRow], partialRun: String? = nil) -> [ThreadDisplayRow] {
        let endedRuns = Dictionary(runs.filter { ended.contains($0.status) && $0.runId != partialRun }.map { ($0.runId, $0) },
                                   uniquingKeysWith: { a, _ in a })
        var answer: [String: Int] = [:]
        var withTools: Set<String> = []
        for (i, r) in rows.enumerated() {
            guard let run = r.item.runId else { continue }
            if r.item.kind == .assistant { answer[run] = i }
            if r.item.kind == .tool { withTools.insert(run) }
        }
        var out: [ThreadDisplayRow] = []
        var groupAt: [String: Int] = [:]
        for (i, r) in rows.enumerated() {
            let run = r.item.runId.flatMap { withTools.contains($0) ? endedRuns[$0] : nil }
            let folds = run != nil && (r.item.kind == .tool || (r.item.kind == .assistant && answer[run!.runId] != i))
            guard let run, folds else {
                let isAnswer = r.item.kind == .assistant && r.item.runId.map { endedRuns[$0] != nil && answer[$0] == i } == true
                out.append(.item(r, answer: isAnswer))
                continue
            }
            if let at = groupAt[run.runId], case .work(var w) = out[at] {
                w.items.append(r)
                out[at] = .work(w)
            } else {
                let duration = run.startedAt.flatMap { s in run.endedAt.map { $0 - s } }
                groupAt[run.runId] = out.count
                out.append(.work(WorkRow(runId: run.runId, status: run.status, durationMs: duration, items: [r])))
            }
        }
        return out
    }

    /// After older items went in front, the row showing what `old` showed: the same row, else the fold its run became
    /// (a run whole only now folds its work). nil when neither is there.
    static func anchor(for old: ThreadDisplayRow, in rows: [ThreadDisplayRow]) -> String? {
        if rows.contains(where: { $0.id == old.id }) { return old.id }
        if case .item(let r, _) = old, let run = r.item.runId, rows.contains(where: { $0.id == "work:\(run)" }) { return "work:\(run)" }
        return nil
    }

    /// "45s" · "2m 14s" · "1h 5m".
    static func shortDuration(_ ms: Int) -> String {
        let s = max(0, Int((Double(ms) / 1000).rounded()))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m \(s % 60)s" }
        return "\(m / 60)h \(m % 60)m"
    }

    /// The fold's label: how long the run worked and how it ended.
    static func label(_ w: WorkRow) -> String {
        let d = w.durationMs.map(shortDuration)
        switch w.status {
        case .interrupted: return d.map { "Stopped after \($0)" } ?? "Stopped"
        case .failed: return d.map { "Failed after \($0)" } ?? "Failed"
        default: return d.map { "Worked for \($0)" } ?? "Worked"
        }
    }

    /// What a fold holds: "3 commands · 2 edits".
    static func summary(_ items: [ThreadItem]) -> String {
        let kinds = items.filter { $0.kind == .tool }.map { ToolLabel($0.tool, $0.input).kind }
        func n(_ k: ToolLabel.Kind) -> Int { kinds.filter { $0 == k }.count }
        func part(_ c: Int, _ one: String, _ many: String) -> String? { c > 0 ? "\(c) \(c == 1 ? one : many)" : nil }
        let rest = kinds.count - n(.command) - n(.edit) - n(.read) - n(.search)
        return [part(n(.command), "command", "commands"), part(n(.edit), "edit", "edits"), part(n(.read), "file read", "files read"),
                part(n(.search), "search", "searches"), part(rest, "other tool", "other tools")]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// Failed tool calls in a fold, said apart (in red) so a failure is visible while it is closed.
    static func failures(_ items: [ThreadItem]) -> Int { items.filter { $0.kind == .tool && $0.isError == true }.count }
}

/// One line for a tool call: a past-tense verb and what it acted on (`code`: show the target as code).
struct ToolLabel: Equatable {
    enum Kind { case command, read, edit, search, web, agent, other }
    let kind: Kind
    let verb: String
    let target: String
    let code: Bool

    init(kind: Kind, verb: String, target: String, code: Bool) {
        self.kind = kind; self.verb = verb; self.target = target; self.code = code
    }

    /// Claude Code's tool names, Codex's (`command`, `fileChange`) and ACP's tool kinds (`execute`, `read`, …; their
    /// input is `{ title, rawInput }`). An unknown tool keeps its own name and a one-line input summary.
    init(_ tool: String?, _ input: JSONValue?) {
        let name = tool ?? "(unknown)"
        var o: [String: JSONValue] = [:]
        if case .object(let obj)? = input { o = obj }
        func str(_ k: String) -> String? { if case .string(let s)? = o[k], !s.isEmpty { return s }; return nil }
        func base(_ p: String) -> String { p.split(separator: "/").last.map(String.init) ?? p }
        func firstLine(_ s: String) -> String { s.components(separatedBy: "\n").first ?? s }
        let title = str("title")
        switch name {
        case "Bash", "BashOutput": self.init(kind: .command, verb: "Ran", target: firstLine(str("command") ?? ""), code: true)
        case "command":
            var s = ""
            if case .string(let c)? = input { s = c }
            self.init(kind: .command, verb: "Ran", target: firstLine(s), code: true)
        case "execute": self.init(kind: .command, verb: "Ran", target: title ?? "a command", code: title != nil)
        case "Read": self.init(kind: .read, verb: "Read", target: base(str("file_path") ?? ""), code: false)
        case "read": self.init(kind: .read, verb: "Read", target: title ?? "a file", code: false)
        case "Edit", "MultiEdit", "NotebookEdit":
            self.init(kind: .edit, verb: "Edited", target: base(str("file_path") ?? str("notebook_path") ?? ""), code: false)
        case "Write": self.init(kind: .edit, verb: "Wrote", target: base(str("file_path") ?? ""), code: false)
        case "fileChange":
            var paths: [String] = []
            if case .array(let a)? = input {
                for c in a { if case .object(let co) = c, case .string(let p)? = co["path"] { paths.append(p) } }
            }
            self.init(kind: .edit, verb: "Edited", target: paths.count == 1 ? base(paths[0]) : "\(paths.count) files", code: false)
        case "edit", "delete", "move":
            self.init(kind: .edit, verb: name == "edit" ? "Edited" : name == "delete" ? "Deleted" : "Moved", target: title ?? "a file", code: false)
        case "Grep": self.init(kind: .search, verb: "Searched for", target: str("pattern") ?? "", code: true)
        case "Glob": self.init(kind: .search, verb: "Listed", target: str("pattern") ?? "", code: true)
        case "search": self.init(kind: .search, verb: "Searched", target: title ?? "", code: false)
        case "WebFetch", "fetch":
            let host = str("url").flatMap { URL(string: $0)?.host() }
            self.init(kind: .web, verb: "Fetched", target: host ?? str("url") ?? title ?? "", code: false)
        case "WebSearch": self.init(kind: .web, verb: "Searched the web for", target: str("query") ?? "", code: false)
        case "Task", "Agent": self.init(kind: .agent, verb: "Ran agent", target: str("description") ?? "", code: false)
        case "TodoWrite": self.init(kind: .other, verb: "Updated the plan", target: "", code: false)
        default:
            // MCP tools arrive as mcp__<server>__<tool>; show "server · tool".
            let parts = name.components(separatedBy: "__")
            let verb = name.hasPrefix("mcp__") && parts.count >= 3 ? "\(parts[1]) · \(parts[2...].joined(separator: "__"))" : name
            self.init(kind: .other, verb: verb, target: title ?? ToolCallView.summary(input), code: title == nil)
        }
    }
}

/// A short thread title from the first message when the session has no nickname: the first clause that reads as
/// words, not as a command. Presentation only; there is no title generator.
enum ThreadTitle {
    private static let maxWords = 6
    /// A hard cap in code points (shared/threadTitle.ts MAX_CHARS), the ellipsis included.
    private static let maxChars = 60

    private static func codeLike(_ clause: String) -> Bool {
        if clause.range(of: #"[$=|&<>{}()\[\]\\`#*~^]"#, options: .regularExpression) != nil { return true }
        let words = clause.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return false }
        let numeric = words.filter { $0.range(of: #"^[\d.,:/-]+$"#, options: .regularExpression) != nil }.count
        return Double(numeric) / Double(words.count) >= 0.3
    }

    private static func clip(_ words: [Substring]) -> String {
        var t = words.prefix(maxWords).joined(separator: " ")
        while let last = t.last, ",;:–—-".contains(last) { t.removeLast() }
        var cut = words.count > maxWords
        let scalars = Array(t.unicodeScalars)
        if scalars.count + (cut ? 1 : 0) > maxChars {
            var kept = String.UnicodeScalarView()
            kept.append(contentsOf: scalars.prefix(maxChars - 1))
            t = String(kept)
            while t.last?.isWhitespace == true { t.removeLast() }
            cut = true
        }
        return cut ? t + "…" : t
    }

    /// The first non-empty line outside a ``` fence.
    private static func firstProseLine(_ message: String) -> String {
        var fenced = false
        for raw in message.components(separatedBy: "\n") {
            let l = raw.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("```") { fenced.toggle(); continue }
            if !fenced, !l.isEmpty { return l }
        }
        return ""
    }

    private static func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    static func from(_ firstMessage: String) -> String? {
        let text = firstProseLine(firstMessage)
            .replacingOccurrences(of: #"^#+\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\*\*(.+?)\*\*"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "`[^`]*`", with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"https?://\S+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        // Clauses end at sentence punctuation, a colon or semicolon, or a dash between spaces.
        let marked = text.replacingOccurrences(of: #"[.!?;:](\s|$)|;|\s[—–-]\s"#, with: "\u{1}", options: .regularExpression)
        let clauses = marked.components(separatedBy: "\u{1}").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if let pick = clauses.first(where: { $0.split(whereSeparator: \.isWhitespace).count >= 2 && !codeLike($0) }) {
            return capitalized(clip(pick.split(whereSeparator: \.isWhitespace)))
        }
        let words = text.split(whereSeparator: \.isWhitespace).filter { !codeLike(String($0)) }
        return words.isEmpty ? nil : capitalized(clip(words))
    }
}
