import Foundation

/// Must exactly match the server's `ClientMsg` (`devd/src/terminal.ts`) and the web version
/// `dashboard/src/terminalProto.ts` — hand-built JSON (NOT `JSONEncoder`, which could
/// reorder keys), so the app sends bit-for-bit the same as the web.
enum TerminalProto {
    /// `{"t":"i","d":"…"}` — `d` is the JSON-escaped input (quotes/newline/unicode) just like
    /// `JSON.stringify` on the web, see `jsonString`.
    static func encodeInput(_ s: String) -> String {
        "{\"t\":\"i\",\"d\":\(jsonString(s))}"
    }

    static func encodeResize(cols: Int, rows: Int) -> String {
        "{\"t\":\"r\",\"cols\":\(cols),\"rows\":\(rows)}"
    }

    static func encodeUnlock() -> String {
        "{\"t\":\"unlock\"}"
    }

    /// Direction of tmux history scrolling: `up` = older lines (wheel up).
    enum ScrollDirection: String {
        case up, down
    }

    /// The server will not perform more than 20 steps in one message anyway (`MAX_SCROLL_STEPS` in devd).
    static let maxScrollSteps = 20

    /// `{"t":"s","d":"up","n":3}` — n wheel steps; devd sends them to tmux even in read-only.
    static func encodeScroll(_ direction: ScrollDirection, n: Int) -> String {
        "{\"t\":\"s\",\"d\":\"\(direction.rawValue)\",\"n\":\(min(max(n, 1), maxScrollSteps))}"
    }

    /// `{"t":"b"}` — "↓ Jump to end": devd exits tmux copy-mode.
    static func encodeBottom() -> String {
        "{\"t\":\"b\"}"
    }

    /// Keys the phone's soft keyboard does not offer — the bar under the terminal after taking
    /// control (see `TerminalScreen`). 1:1 copy of `KEY_SEQ` from the web (`terminalProto.ts`).
    static let keySeq: [String: String] = [
        "Esc": "\u{1b}", "Tab": "\t",
        "Up": "\u{1b}[A", "Down": "\u{1b}[B", "Right": "\u{1b}[C", "Left": "\u{1b}[D",
        "⇧←": "\u{1b}[1;2D",
        "Ctrl-C": "\u{03}", "Ctrl-D": "\u{04}", "Enter": "\r",
    ]

    /// Button order in the bar. `⇧←` is extra for the phone app, where the software keyboard
    /// does not offer a modifier + arrow combination.
    static let keyBar: [String] = ["Esc", "Tab", "Ctrl-C", "Up", "Down", "Left", "⇧←", "Right", "Enter"]

    // MARK: - Private

    /// JSON-escapes a string into the form `"…"`. Wrapping in an array and trimming the brackets
    /// avoids uncertainty around `.fragmentsAllowed` across Foundation versions. `JSONSerialization`
    /// unlike `JSON.stringify` escapes `/` as `\/` BY DEFAULT — `.withoutEscapingSlashes`
    /// turns that off so the output matches the web byte for byte (verified by the test
    /// `testEncodeInputDoesNotEscapeForwardSlash`).
    private static func jsonString(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes]),
              let wrapped = String(data: data, encoding: .utf8),
              wrapped.count >= 2
        else {
            return "\"\""
        }
        return String(wrapped.dropFirst().dropLast())
    }
}
