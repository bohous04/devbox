import Foundation

/// A mirror send with no answer from devd (a timeout, a dropped connection): it may have been typed into the pane.
struct MirrorSendUnconfirmed: Error, CustomStringConvertible {
    var description: String { MirrorView.sendUnconfirmed }
}

/// A refused send's reason, shown as the composer's lock next to Open terminal.
struct MirrorLock: Equatable {
    let code: String
    let message: String
}

/// The Chat view of a tmux session (devd/src/transcriptMirror.ts): a port of `dashboard/src/mirrorView.ts`, so the
/// apps and the web lock the composer for the same reasons (devd's words; the apps say "reopen" where the web says
/// "reload the page").
enum MirrorView {
    static let placeholder = "Message the agent in the terminal"
    static let promptLead = "Waiting for you in the terminal:"
    static let noLongerTmux = "This is no longer a terminal session; reopen it."
    static let sendUnconfirmed = "The message may have reached the terminal — check it before sending again."

    /// The text typed into the pane: the images, uploaded as a chat's are (`/inbox/<id>/…`, mounted in the container),
    /// follow as their paths, one per line, for the agent to read. A line may not start with `/`: devd refuses commands.
    static func messageText(_ text: String, imagePaths: [String]) -> String {
        imagePaths.isEmpty ? text : text + "\n\n" + imagePaths.map { "Attached image: \($0)" }.joined(separator: "\n")
    }

    /// devd's session-level refusals (devd/src/mirrorApi.ts) come as bare codes: what they mean for the user.
    static let sessionRefusals: [String: String] = [
        "session-ending": "This session is ending; nothing more can be sent to it.",
        "unknown-session": "devd no longer has this session.",
        "not-a-tmux-session": noLongerTmux,
    ]

    /// The lock a refused send (404/409) puts on the composer; nil for any other failure, which the composer shows as
    /// its error.
    static func sendLock(_ error: Error) -> MirrorLock? {
        guard let e = error as? DevdHTTPError, e.statusCode == 409 || e.statusCode == 404, let code = e.serverMessage else { return nil }
        if let message = e.serverDetail { return MirrorLock(code: code, message: message) }
        return sessionRefusals[code].map { MirrorLock(code: code, message: $0) }
    }

    struct Notice: Equatable {
        enum Kind { case prompt, lock }
        let kind: Kind
        let text: String
        /// Only a refused send's lock: devd's own reason stays until the pane changes.
        let dismissible: Bool

        /// What VoiceOver hears when the line appears or changes.
        var announcement: String { kind == .prompt ? "\(MirrorView.promptLead) \(text)" : text }
    }

    /// The one line above the composer, with an Open terminal button: the agent waiting for an answer only the
    /// terminal can give, or why a message cannot go in now (the last refused send wins over devd's own reason).
    static func notice(_ info: MirrorInfo, lock: MirrorLock?) -> Notice? {
        if let p = info.terminalPrompt { return Notice(kind: .prompt, text: p.text, dismissible: false) }
        if let lock { return Notice(kind: .lock, text: lock.message, dismissible: true) }
        return info.sendBlock.map { Notice(kind: .lock, text: $0.message, dismissible: false) }
    }

    /// Why the composer's field is off while empty: only devd's standing reason. A refused send leaves the text in the
    /// field, so it can be sent again once the terminal is sorted out.
    static func fieldOff(_ info: MirrorInfo) -> String? { info.sendBlock?.message }

    /// The Chat view of an agent the mirror cannot read yet (Grok, Antigravity) or of an InstaBox session.
    static func unsupported(_ info: MirrorInfo) -> String? {
        guard info.state == "unsupported" else { return nil }
        return info.sendBlock?.message ?? (info.agent.map { "Chat view isn't supported for \($0) yet." } ?? "Chat view isn't supported for this session yet.")
    }

    /// devd repeats the info on every (re)connect: a refused send's lock goes only when the pane really changed.
    static func keepsLock(from old: MirrorInfo?, to new: MirrorInfo) -> Bool {
        guard let old else { return true }
        return old.sendBlock?.code == new.sendBlock?.code && old.activity == new.activity
    }
}
