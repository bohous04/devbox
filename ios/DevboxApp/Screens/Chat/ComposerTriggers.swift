import Foundation

/// What the composer offers at the caret (dashboard/src/composerTrigger.ts; shared/fixtures/composer-triggers.json
/// holds the cases both run): `/` the agent's commands, only at the start of the message (an agent reads a command
/// only there); `@` the session repo's files, on any word that starts with it. `start`..`end` is the word a pick
/// replaces (to its end, also when the caret is inside it); `query` is the part before the caret. Offsets are UTF-16
/// code units, as on the web.
struct ComposerTrigger: Equatable {
    enum Kind: String { case slash = "/", at = "@" }
    var kind: Kind
    var query: String
    var start: Int
    var end: Int
}

/// The open menu as the keys see it: `options` shown, `searching` (the file results are on their way: none yet, or an
/// older query's), `exact` (what is typed already is the highlighted option).
struct TriggerMenuState: Equatable {
    var options: Int
    var searching: Bool
    var exact: Bool
}

struct TriggerKey: Equatable {
    /// The web's KeyboardEvent.key names: "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown"; others as typed.
    var key: String
    var shift = false
    var alt = false
    var ctrl = false
    var meta = false
    /// An input method is composing (marked text): its keys are its own.
    var composing = false
}

/// `hold`: swallow the key (nothing happens); `fieldDefault`: the field's own behaviour (newline, focus, caret).
enum TriggerKeyAction: String { case pick, next, prev, dismiss, send, hold, fieldDefault = "default" }

enum ComposerTriggers {
    private static func isSpace(_ u: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(u) else { return false }
        return Character(scalar).isWhitespace
    }

    static func active(_ text: String, caret: Int) -> ComposerTrigger? {
        let u = Array(text.utf16)
        let caret = min(max(caret, 0), u.count)
        var start = caret
        while start > 0, !isSpace(u[start - 1]) { start -= 1 }
        var end = caret
        while end < u.count, !isSpace(u[end]) { end += 1 }
        guard start < u.count else { return nil }
        // Empty with the caret before the word's first character, as the web's slice is.
        func query(_ from: Int) -> String { from < caret ? String(decoding: u[from..<caret], as: UTF16.self) : "" }
        if u[start] == UInt16(UInt8(ascii: "/")), start == 0 { return ComposerTrigger(kind: .slash, query: query(1), start: start, end: end) }
        if u[start] == UInt16(UInt8(ascii: "@")) { return ComposerTrigger(kind: .at, query: query(start + 1), start: start, end: end) }
        return nil
    }

    /// Commands matching `query` (case-insensitive): names starting with it, then names containing it, then (from
    /// three characters on, where a description match stops being noise) descriptions containing it; the agent's
    /// order within each.
    static func filter(_ commands: [AgentCommand], _ query: String) -> [AgentCommand] {
        let q = query.lowercased()
        func rank(_ c: AgentCommand) -> Int? {
            let name = c.name.lowercased()
            if name.hasPrefix(q) { return 0 }
            if name.contains(q) { return 1 }
            if q.utf16.count >= 3, c.description?.lowercased().contains(q) == true { return 2 }
            return nil
        }
        return commands.enumerated().compactMap { i, c in rank(c).map { (i, $0, c) } }
            .sorted { ($0.1, $0.0) < ($1.1, $1.0) }.map(\.2)
    }

    /// The text with the trigger word replaced by the pick (`/name` or `@path`, a path with spaces quoted so the agent
    /// reads it as one), and the caret after it and one space (the one already there, else a new one): past the word,
    /// so the menu does not open on it again.
    static func pick(_ text: String, _ t: ComposerTrigger, _ value: String) -> (text: String, caret: Int) {
        let u = Array(text.utf16)
        let quoted = t.kind == .at && value.contains { $0.isWhitespace } ? "\"\(value)\"" : value
        let word = t.kind.rawValue + quoted
        let rest = String(decoding: u[t.end...], as: UTF16.self)
        let sep = rest.first?.isWhitespace == true ? "" : " "
        let next = String(decoding: u[..<t.start], as: UTF16.self) + word + sep + rest
        return (next, t.start + word.utf16.count + 1)
    }

    /// Where the caret is after an edit, for a field that does not say (iOS 17, macOS 14): text added or removed at the
    /// end leaves it at the end; any other edit (in the middle, a paste over a range, a pick) puts it somewhere unknown,
    /// nil, and then no menu opens until the next edit at the end.
    static func caretAfterEdit(from old: String, to new: String) -> Int? {
        new.hasPrefix(old) || old.hasPrefix(new) ? new.utf16.count : nil
    }

    /// What VoiceOver says of the open menu (the web's live region): its status, else how many options it shows. Nil
    /// while a file search runs: "Searching…" on every key of an `@` word would talk over the echo of the typed letters.
    static func announcement(_ m: TriggerMenuModel) -> String? {
        if m.searching { return nil }
        if let status = m.status { return status }
        let noun = m.title == "Commands" ? "command" : "file"
        return "\(m.options.count) \(noun)\(m.options.count == 1 ? "" : "s")"
    }

    /// The empty composer names the triggers this session has (a Codex chat runs no slash commands, so no `/`).
    static func placeholder(running: Bool, commands: Bool, files: Bool) -> String {
        if running { return "Queue a message for after this run" }
        return (["Ask anything"] + (files ? ["@ for files"] : []) + (commands ? ["/ for commands"] : [])).joined(separator: " · ")
    }

    /// What a key in the composer does. `menu` nil = no menu open; `enterSends`: Enter sends there.
    static func keyAction(_ menu: TriggerMenuState?, _ e: TriggerKey, enterSends: Bool) -> TriggerKeyAction {
        if e.composing { return .fieldDefault }
        let enter = e.key == "Enter" && !e.shift
        let plainEnter: TriggerKeyAction = enter && enterSends ? .send : .fieldDefault
        guard let menu else { return plainEnter }
        if e.key == "Escape" { return .dismiss }
        let modified = e.shift || e.alt || e.ctrl || e.meta
        let tab = e.key == "Tab" && !modified
        if menu.searching { return enter || tab ? .hold : .fieldDefault }
        if menu.options == 0 { return plainEnter }
        if e.key == "ArrowDown" || e.key == "ArrowUp", !modified { return e.key == "ArrowDown" ? .next : .prev }
        if tab { return .pick }
        if enter { return menu.exact ? plainEnter : .pick }
        return .fieldDefault
    }
}

/// One row of the menu: what a pick inserts (`value`), what it shows (`label`, and `detail` next to it).
struct TriggerOption: Equatable, Identifiable {
    var value: String
    var label: String
    var detail: String?
    var id: String { value }
}

/// The last answer of the file search, for the query it answered.
struct FileSearchResult: Equatable {
    var query: String
    var files: SessionFiles?
    var error: String?
}

/// What the open menu shows (the web's Composer): options, the line under them, and whether its file results are an
/// older query's (shown dimmed, not pickable).
struct TriggerMenuModel: Equatable {
    var title: String
    var options: [TriggerOption]
    var status: String?
    var statusIsError = false
    var searching = false

    static func make(_ t: ComposerTrigger, commands: [AgentCommand], files r: FileSearchResult?) -> TriggerMenuModel {
        if t.kind == .slash {
            let options = ComposerTriggers.filter(commands, t.query).map { TriggerOption(value: $0.name, label: "/\($0.name)", detail: $0.description ?? $0.hint) }
            return TriggerMenuModel(title: "Commands", options: options, status: options.isEmpty ? "No matching command" : nil)
        }
        // The last answer stays listed (dimmed, not pickable) while the next query is on its way.
        var m = TriggerMenuModel(title: "Files", options: (r?.files?.files ?? []).map { TriggerOption(value: $0, label: $0) })
        if r == nil || r!.query != t.query {
            m.searching = true
            m.status = "Searching…"
        } else if let error = r!.error {
            m.status = "File search failed: \(error)"
            m.statusIsError = true
        } else if m.options.isEmpty {
            m.status = "No matching file"
        } else if r!.files?.more == true {
            m.status = "More files match: type more of the name"
        } else if r!.files?.listingCapped == true {
            m.status = "Only part of this large repository was searched"
        }
        return m
    }
}
