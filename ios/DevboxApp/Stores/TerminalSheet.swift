/// The iPhone chat's full-screen terminal (ChatScreen). Each step returns the view to remember for the session's inbox
/// row (TmuxTabMemory), nil for none: the user's own open and close are remembered; the one automatic opening, for a
/// Chat that cannot be shown (MirrorView.chatUnavailable), and its close never are.
struct TerminalSheet: Equatable {
    private(set) var shown = false
    private var byUser = false
    private var fellBack = false

    mutating func userOpens() -> TmuxTabMemory.Tab? {
        shown = true
        byUser = true
        return .terminal
    }

    /// Opens once, when Chat first cannot show the session; a later reason does not open it again. A terminal the user
    /// already opened stays theirs: closing it still remembers Chat.
    mutating func chatUnavailable(_ reason: String?) {
        guard reason != nil, !fellBack else { return }
        fellBack = true
        guard !shown else { return }
        shown = true
        byUser = false
    }

    mutating func closed() -> TmuxTabMemory.Tab? {
        defer { shown = false; byUser = false }
        return shown && byUser ? .chat : nil
    }
}
