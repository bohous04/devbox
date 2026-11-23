import Foundation
import os

/// Pure thread rules: a 1:1 port of `dashboard/src/threadView.ts` (`applyThreadEvent`, `mergeSnapshot`,
/// `applyNotice` and the run helpers), which mirrors devd's ThreadStore. The same cases
/// (`shared/fixtures/thread-events.json`) drive both test suites, so the app, the dashboard and a reload agree.
enum ThreadView {
    private static let logger = Logger(subsystem: "com.example.devbox", category: "Thread")

    /// Applies one bridge event. Events at or below `lastSeq` were already applied and return `t` unchanged.
    static func apply(_ t: ThreadSnapshot, _ e: LoggedEvent) -> ThreadSnapshot {
        if e.seq <= t.lastSeq { return t }
        var n = t
        n.lastSeq = e.seq
        dispatch(&n, e)
        return n
    }

    /// Merges a `thread-snapshot`: every item and run changed after `afterSeq` comes whole and replaces the client's
    /// copy (items keyed by run + item id; an item without an item id never changes, so one in the snapshot is new);
    /// pending, background and native replace wholesale.
    static func mergeSnapshot(_ t: ThreadSnapshot, _ m: ThreadSnapshotFrame) -> ThreadSnapshot {
        let s = m.snapshot
        var items = t.items
        for it in s.items {
            // An item without an item id at or below our seq is already here (a live frame got ahead of the snapshot).
            if it.itemId == nil && it.seq <= t.lastSeq { continue }
            let idx = it.itemId == nil ? nil : items.firstIndex { $0.runId == it.runId && $0.itemId == it.itemId }
            if let idx { items[idx] = it } else { items.append(it) }
        }
        var runs = t.runs
        for r in s.runs {
            if let idx = runs.firstIndex(where: { $0.runId == r.runId }) { runs[idx] = r } else { runs.append(r) }
        }
        // Stream frames carry no topic (GET only), and the first message, which it names, never changes.
        return ThreadSnapshot(lastSeq: max(t.lastSeq, s.lastSeq), seenSeq: s.seenSeq, runs: runs, items: items,
                              pending: s.pending, background: s.background, native: s.native, effort: s.effort, commands: s.commands,
                              topic: t.topic)
    }

    /// A `thread-commands` frame's list; one of an unexpected shape is logged and read as none, as the snapshot reads it.
    static func commands(from data: Data) -> [AgentCommand]? {
        do {
            return try JSONDecoder().decode([AgentCommand]?.self, from: data)
        } catch {
            logger.error("unreadable thread-commands frame, read as none: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// The current harness's commands from the stream (`thread-commands`, devd's parsed list; nil = it sent none).
    static func applyCommands(_ t: ThreadSnapshot, _ commands: [AgentCommand]?) -> ThreadSnapshot {
        var n = t
        n.commands = commands
        return n
    }

    /// The agent's effort from the stream (`thread-effort`, devd's parsed value; no seq of its own).
    static func applyEffort(_ t: ThreadSnapshot, _ effort: ThreadEffort?) -> ThreadSnapshot {
        var n = t
        n.effort = effort
        return n
    }

    /// A devd notice (`thread-notice`): item id `notice:<n>`, no seq of its own, so lastSeq stays; the same notice
    /// again (live and in a replay snapshot) is not added twice.
    static func applyNotice(_ t: ThreadSnapshot, _ item: ThreadItem) -> ThreadSnapshot {
        if t.items.contains(where: { $0.itemId == item.itemId }) { return t }
        var n = t
        n.items.append(item)
        return n
    }

    /// The run the Stop button interrupts.
    static func activeRun(_ t: ThreadSnapshot) -> RunRow? { t.runs.first { $0.status == .running } }

    /// The thread's state for the iPhone header, after the place, in the inbox's order: "Needs you" (a question
    /// waits), "Working…", "Queued", "Background", else how the last run ended and when ("Finished 3m ago"; the word
    /// alone without an end time); nil before any run. devd sends runs in the order they were created.
    static func runState(_ t: ThreadSnapshot, now: Int) -> String? {
        if !t.pending.isEmpty { return "Needs you" }
        if activeRun(t) != nil { return "Working…" }
        if t.runs.contains(where: { $0.status == .queued }) { return "Queued" }
        if !t.background.isEmpty { return "Background" }
        guard let last = t.runs.last else { return nil }
        let word: String
        switch last.status {
        case .completed: word = "Finished"
        case .failed: word = "Failed"
        case .interrupted: word = "Stopped"
        case .queued, .running, .unknown: return nil
        }
        guard let ended = last.endedAt else { return word }
        let ago = InboxView.shortAgo(now - ended)
        return "\(word) \(ago == "now" ? ago : "\(ago) ago")"
    }

    /// Runs waiting behind the active one: their user messages show as queued.
    static func queuedRunIds(_ t: ThreadSnapshot) -> [String] { t.runs.filter { $0.status == .queued }.map(\.runId) }

    /// Runs devd's critic started: their user message is the critic's, not the user's.
    static func criticRunIds(_ t: ThreadSnapshot) -> [String] { t.runs.filter { $0.origin == .critic }.map(\.runId) }

    /// What makes the chat switchers re-read their target (the dashboard's effect dependencies): the native
    /// thread, a run queued or ended, a notice.
    /// shared/thread.ts isHousekeepingNotice: a bridge restart and devd's "older bridge" line, left out of what the
    /// thread shows (stored rows stay). shared/fixtures/housekeeping-notices.json pins both copies.
    static func isHousekeeping(_ i: ThreadItem) -> Bool {
        guard i.kind == .notice else { return false }
        return i.text.wholeMatch(of: #/Agent bridge restarted \(v[^)]*\)/#) != nil
            || i.text.prefixMatch(of: #/this session's agent bridge is .+, older than the current \S+: /#) != nil
    }

    /// The items the thread shows: all but bridge housekeeping.
    static func shownItems(_ t: ThreadSnapshot) -> [ThreadItem] { t.items.filter { !isHousekeeping($0) } }

    static func switchKey(_ t: ThreadSnapshot) -> String {
        let n = t.native
        return [n?.harness, n?.nativeThreadId, n?.model, n?.account].map { $0 ?? "-" }.joined(separator: "|")
            + "|\(t.runs.filter { $0.endedSeq != nil }.count)|\(t.runs.count)|\(t.items.filter { $0.kind == .notice && !isHousekeeping($0) }.count)"
    }

    /// The newest seq at which a run ended: reaching it while the thread is open counts as seen.
    static func lastEndedSeq(_ t: ThreadSnapshot) -> Int { t.runs.compactMap(\.endedSeq).max() ?? 0 }

    /// The seq to post to /thread/seen, or nil for none. A look (opening the thread, coming back to it) always posts,
    /// even when nothing new arrived: devd restarts the inbox's auto-settle clock on it. A run ending while the thread
    /// is open posts only when it is not seen yet. As the dashboard's `seenToPost`.
    static func seenToPost(_ t: ThreadSnapshot, look: Bool) -> Int? {
        look || t.lastSeq > t.seenSeq ? t.lastSeq : nil
    }

    // MARK: - Paging (dashboard/src/threadView.ts THREAD_PAGE, prependOlder, tailView)

    /// How many items a thread opens with (its newest) and how many each step back adds: a long session's whole
    /// history is megabytes (devd's `limit`/`beforeSeq`).
    static let pageSize = 200

    /// A page devd answered for `limit=pageSize`: a full one may have more before it.
    static func hasOlder(_ page: ThreadSnapshot) -> Bool { page.items.count >= pageSize }

    /// The `beforeSeq` for the page before the oldest loaded item: one past its seq, since a devd notice takes the seq
    /// of the event before it, so two items can share a seq and `beforeSeq = seq` would skip the older one.
    static func olderBeforeSeq(_ t: ThreadSnapshot) -> Int? { t.items.first.map { $0.seq + 1 } }

    /// Live updates of items older than the loaded window, kept until a page back loads those items (threadView.ts
    /// Held). `items`: whole items a stream replay sent that began before the window; `finishes`: tool.finished events
    /// whose tool.started is not loaded. Either would otherwise be appended at the thread's end, out of place
    /// ("(unknown)" for a finish), and come back a second time with the older page.
    struct HeldItem: Equatable {
        var item: ThreadItem
        var atSeq: Int
    }

    struct Held: Equatable {
        /// `atSeq`: the replay's seq, to tell whether a page answered later already has this state or a newer one.
        var items: [String: HeldItem] = [:]
        var finishes: [String: LoggedEvent] = [:]
    }

    private static func heldKey(_ runId: String?, _ itemId: String) -> String { "\(runId ?? "")\u{0}\(itemId)" }

    /// `apply` for a thread that may have older items left (`more`): a tool.finished whose start is not loaded is held
    /// (its seq still counts as applied); everything else applies as usual.
    static func applyLive(_ t: ThreadSnapshot, _ e: LoggedEvent, more: Bool, held: inout Held) -> ThreadSnapshot {
        if more, e.seq > t.lastSeq, case let .toolFinished(runId, itemId, _, _) = e.event, findItem(t, runId, itemId) == nil {
            held.finishes[heldKey(runId, itemId)] = e
            var n = t
            n.lastSeq = e.seq
            return n
        }
        return apply(t, e)
    }

    /// `mergeSnapshot` for a thread that may have older items left (`more`): a replayed item that began before the
    /// loaded window and is not loaded is held, not appended at the end.
    static func mergeLive(_ t: ThreadSnapshot, _ m: ThreadSnapshotFrame, more: Bool, held: inout Held) -> ThreadSnapshot {
        guard more, let edge = t.items.first?.seq else { return mergeSnapshot(t, m) }
        let outside = { (it: ThreadItem) in
            it.itemId != nil && it.seq < edge && !t.items.contains { $0.runId == it.runId && $0.itemId == it.itemId }
        }
        var rest = m.snapshot
        rest.items = []
        for it in m.snapshot.items {
            if outside(it) { held.items[heldKey(it.runId, it.itemId!)] = HeldItem(item: it, atSeq: m.snapshot.lastSeq) } else { rest.items.append(it) }
        }
        return mergeSnapshot(t, ThreadSnapshotFrame(afterSeq: m.afterSeq, snapshot: rest))
    }

    /// Puts a page of older items (asked with `olderBeforeSeq`) in front of the thread; `pageSeq`: the seq the page was
    /// answered at (its lastSeq); `more`: the page says older ones are still left (threadView.ts prependOlder). An item
    /// is never there twice: one already loaded keeps its place and its (live) state, and the page's copy is dropped
    /// (items without an item id: those at the boundary seq, which the page repeats). The newest state of an item wins:
    /// a held item replaces the page's copy only when it was held at a seq after `pageSeq`; held finishes apply to the
    /// items they finish; an item still streaming whose run has ended since is done (as the run's end left it in devd).
    /// Once nothing older is left, a held item or finish whose item is still missing never had its start in the log:
    /// the item is appended, a finish shows as an unknown tool, as `apply` shows one. `held` is only read: applying
    /// the same entries again changes nothing. The rest of the thread stays: the stream keeps it.
    static func prependOlder(_ t: ThreadSnapshot, _ older: [ThreadItem], pageSeq: Int, held: Held = Held(), more: Bool) -> ThreadSnapshot {
        let id = { (x: ThreadItem) in
            // Without an item id, the text tells apart two notices at one seq (a bridge restart's and devd's own).
            x.itemId.map { "id:\(heldKey(x.runId, $0)):\(x.kind)" } ?? "seq:\(x.seq):\(x.runId ?? ""):\(x.kind):\(x.text)"
        }
        let loaded = Set(t.items.map(id))
        let ended = Set(t.runs.filter { isTerminal($0.status) }.map(\.runId))
        let settle = { (it: ThreadItem) -> ThreadItem in
            var it = it
            if it.status == .streaming, let run = it.runId, ended.contains(run) { it.status = .done }
            return it
        }
        let newer = { (it: ThreadItem) -> ThreadItem in
            guard let key = it.itemId.map({ heldKey(it.runId, $0) }), let h = held.items[key], h.atSeq > pageSeq else { return it }
            return h.item
        }
        var items = older.filter { !loaded.contains(id($0)) }.map { settle(newer($0)) } + t.items
        let at = { (items: [ThreadItem], runId: String?, itemId: String) in items.firstIndex { $0.runId == runId && $0.itemId == itemId } }
        if !more {
            for h in held.items.values.sorted(by: { $0.item.seq < $1.item.seq }) where at(items, h.item.runId, h.item.itemId!) == nil {
                items.append(settle(h.item))
            }
        }
        for e in held.finishes.values.sorted(by: { $0.seq < $1.seq }) {
            guard case let .toolFinished(runId, itemId, isError, output) = e.event else { continue }
            if let idx = at(items, runId, itemId) {
                items[idx].output = output
                items[idx].isError = isError
                items[idx].status = .done
            } else if !more {
                items.append(ThreadItem(seq: e.seq, runId: runId, itemId: itemId, kind: .tool, text: "", tool: "(unknown)",
                                        output: output, isError: isError, status: .done, ts: e.ts))
            }
        }
        var n = t
        n.items = items
        return n
    }

    /// What a thread loaded only to some point back shows (threadView.ts tailView). The oldest loaded run (head) may
    /// have begun before that point. It is whole when its prompt (its first item) is loaded. Otherwise, when it ended
    /// with nothing open, it is left out until the user loads further back, with all its rows (a prompt queued while it
    /// ran sits among them, devd inserts it at queue time) and the notices before the next run, so the thread starts at
    /// a whole run. A head run that still runs or waits (queued, an open request: its form must show) or the only run
    /// loaded stays, as `partialRun`: it must not fold (WorkGroups.rows), since a fold of part of it would undercount.
    static func tailView(_ rows: [ChatRow], hasOlder: Bool, runs: [RunRow], pending: [PendingRequest]) -> (rows: [ChatRow], partialRun: String?) {
        guard hasOlder, let first = rows.first(where: { $0.item.runId != nil }), let head = first.item.runId, first.item.kind != .user else {
            return (rows, nil)
        }
        let settled = runs.first { $0.runId == head }.map { isTerminal($0.status) } == true && !pending.contains { $0.runId == head }
        guard settled, let cut = rows.firstIndex(where: { $0.item.runId != nil && $0.item.runId != head }) else { return (rows, head) }
        return (rows.enumerated().filter { $0.offset >= cut && $0.element.item.runId != head }.map(\.element), nil)
    }

    // MARK: - Private

    private static func isTerminal(_ s: RunRow.Status) -> Bool { s == .completed || s == .interrupted || s == .failed }

    private static func findItem(_ n: ThreadSnapshot, _ runId: String, _ itemId: String) -> Int? {
        n.items.firstIndex { $0.runId == runId && $0.itemId == itemId }
    }

    /// A user item's images; nil when the message has none (same rule in devd's ThreadStore).
    private static func attachments(_ a: [String]?) -> [String]? { (a?.isEmpty ?? true) ? nil : a }

    private static func insertRun(_ n: inout ThreadSnapshot, _ runId: String, origin: RunOrigin, status: RunRow.Status,
                                  nativeThreadId: String?, model: String?, queuedAt: Int?, startedAt: Int?) {
        if n.runs.contains(where: { $0.runId == runId }) { return } // INSERT OR IGNORE
        n.runs.append(RunRow(runId: runId, origin: origin, status: status, harness: n.native?.harness, nativeThreadId: nativeThreadId,
                             model: model, queuedAt: queuedAt, startedAt: startedAt, endedAt: nil, endedSeq: nil, usage: nil, error: nil,
                             failureReason: nil))
    }

    private static func notice(_ n: inout ThreadSnapshot, _ seq: Int, _ ts: Int, runId: String?, _ text: String) {
        n.items.append(ThreadItem(seq: seq, runId: runId, itemId: nil, kind: .notice, text: text, status: .done, ts: ts))
    }

    private static func terminal(_ n: inout ThreadSnapshot, _ seq: Int, _ ts: Int, _ runId: String, _ status: RunRow.Status,
                                 nativeThreadId: String? = nil, usage: TokenUsage? = nil, setUsage: Bool = false,
                                 error: String?, failureReason: String? = nil) {
        guard let idx = n.runs.firstIndex(where: { $0.runId == runId }) else {
            notice(&n, seq, ts, runId: runId, "\(status.rawValue) event for unknown run \(runId)")
            return
        }
        var r = n.runs[idx]
        r.status = status
        r.endedAt = ts
        r.endedSeq = seq
        r.error = error
        r.nativeThreadId = nativeThreadId ?? r.nativeThreadId
        if setUsage { r.usage = usage }
        r.failureReason = failureReason
        n.runs[idx] = r
        for i in n.items.indices where n.items[i].runId == runId && n.items[i].status == .streaming {
            n.items[i].status = .done
        }
    }

    private static func dispatch(_ n: inout ThreadSnapshot, _ e: LoggedEvent) {
        let seq = e.seq, ts = e.ts
        switch e.event {
        case let .threadNative(harness, nativeThreadId, account, model):
            // A resumed Claude thread is announced before the CLI names its model: nil keeps the harness's known one.
            let known = n.native?.harness == harness ? n.native?.model : nil
            n.native = NativeThread(harness: harness, nativeThreadId: nativeThreadId, account: account, model: model ?? known)

        case let .runQueued(runId, text, atts, origin):
            insertRun(&n, runId, origin: origin ?? .user, status: .queued, nativeThreadId: nil, model: nil, queuedAt: ts, startedAt: nil)
            n.items.append(ThreadItem(seq: seq, runId: runId, itemId: "user:\(runId)", kind: .user, text: text, status: .done,
                                      attachments: attachments(atts), ts: ts))

        case let .runStarted(runId, origin, nativeThreadId, model):
            if let idx = n.runs.firstIndex(where: { $0.runId == runId }) {
                // A start for a run that already ended or runs is a replay artefact: do not regress it.
                if n.runs[idx].status == .queued {
                    n.runs[idx].origin = origin
                    n.runs[idx].status = .running
                    n.runs[idx].nativeThreadId = nativeThreadId
                    n.runs[idx].model = model
                    n.runs[idx].startedAt = ts
                }
            } else {
                insertRun(&n, runId, origin: origin, status: .running, nativeThreadId: nativeThreadId, model: model, queuedAt: nil, startedAt: ts)
            }

        case let .messageDelta(runId, itemId, text):
            // The harness may keep streaming after an interrupt until its result: the run is over, the item stays done.
            if n.runs.contains(where: { $0.runId == runId && isTerminal($0.status) }) { return }
            if let idx = findItem(n, runId, itemId) {
                n.items[idx].text += text
                n.items[idx].status = .streaming
            } else {
                n.items.append(ThreadItem(seq: seq, runId: runId, itemId: itemId, kind: .assistant, text: text, status: .streaming, ts: ts))
            }

        case let .messageFinal(runId, itemId, role, text, atts):
            if role == "user" {
                // The user's text already came with run.queued; a harness echo must not duplicate it.
                if !n.items.contains(where: { $0.runId == runId && $0.kind == .user }) {
                    n.items.append(ThreadItem(seq: seq, runId: runId, itemId: itemId, kind: .user, text: text, status: .done,
                                              attachments: attachments(atts), ts: ts))
                }
                return
            }
            if let idx = findItem(n, runId, itemId) {
                n.items[idx].text = text
                n.items[idx].status = .done
            } else {
                n.items.append(ThreadItem(seq: seq, runId: runId, itemId: itemId, kind: .assistant, text: text, status: .done, ts: ts))
            }

        case let .toolStarted(runId, itemId, tool, input):
            if findItem(n, runId, itemId) != nil { return } // re-announcement
            n.items.append(ThreadItem(seq: seq, runId: runId, itemId: itemId, kind: .tool, text: "", tool: tool, input: input, status: .streaming, ts: ts))

        case let .toolFinished(runId, itemId, isError, output):
            if let idx = findItem(n, runId, itemId) {
                n.items[idx].output = output
                n.items[idx].isError = isError
                n.items[idx].status = .done
            } else {
                // The start was trimmed from the log: show the result, marked as an unknown tool.
                n.items.append(ThreadItem(seq: seq, runId: runId, itemId: itemId, kind: .tool, text: "", tool: "(unknown)",
                                          output: output, isError: isError, status: .done, ts: ts))
            }

        case let .requestOpened(runId, requestId, kind, prompt, options, multiSelect):
            let known = n.pending.contains { $0.requestId == requestId } || n.items.contains { $0.kind == .request && $0.itemId == requestId }
            if known { return } // re-announcement
            n.pending.append(PendingRequest(requestId: requestId, runId: runId, kind: kind, prompt: prompt, options: options,
                                            multiSelect: multiSelect, openedAt: ts))
            n.items.append(ThreadItem(seq: seq, runId: runId, itemId: requestId, kind: .request, text: prompt, status: .open, ts: ts))

        case let .requestResolved(requestId, answer, by):
            n.pending.removeAll { $0.requestId == requestId }
            for i in n.items.indices where n.items[i].kind == .request && n.items[i].itemId == requestId {
                n.items[i].status = by == "expired" ? .expired : .answered
                n.items[i].output = answer
            }

        case let .backgroundChanged(work):
            n.background = work

        case let .runCompleted(runId, nativeThreadId, usage):
            terminal(&n, seq, ts, runId, .completed, nativeThreadId: nativeThreadId, usage: usage, setUsage: true, error: nil)

        case let .runInterrupted(runId):
            terminal(&n, seq, ts, runId, .interrupted, error: nil)

        case let .runFailed(runId, error, reason):
            // resume-failed or open-failed for a run id never announced is a switch's or the bridge start's: devd's own
            // notice says it.
            if (error == "resume-failed" || error == "open-failed") && !n.runs.contains(where: { $0.runId == runId }) { return }
            // Only known reasons, as in ThreadStore.
            terminal(&n, seq, ts, runId, .failed, error: error, failureReason: reason == "rate-limited" ? reason : nil)
            notice(&n, seq, ts, runId: runId, error)

        case let .bridgeStarted(version, resumed, text):
            if resumed { notice(&n, seq, ts, runId: nil, "Agent bridge restarted (v\(version))") }
            if let text, !text.isEmpty { notice(&n, seq, ts, runId: nil, text) }

        case let .bridgeNotice(text):
            notice(&n, seq, ts, runId: nil, text)

        case let .unknown(type):
            logger.error("thread view: unknown event type \(type, privacy: .public) at seq \(seq)")
            notice(&n, seq, ts, runId: nil, "unknown event \(type)")
        }
    }
}

/// What the chat shows when a chat command failed; mirrors `composerErrorText` (dashboard/src/threadView.ts). devd's
/// `message` (command-failed, bridge-too-old, request-open…) is shown when it sent one. Nothing is retried: after a
/// timeout the message may have been queued anyway.
func chatErrorText(_ error: Error) -> String {
    if let h = error as? DevdHTTPError {
        if h.serverMessage == "agent-disconnected" { return "agent not connected — message not sent" }
        if h.serverMessage == "agent-timeout" { return "no reply from the agent — check the thread before resending" }
        if let detail = h.serverDetail, !detail.isEmpty { return detail }
    }
    return errorText(error)
}

/// One chat session's thread: loaded once, then kept live over devd's stream (`?session=<id>&afterSeq=<seq>`, which
/// replays what changed after that seq as one `thread-snapshot`). iOS drops the stream in the background:
/// `resume()` fetches the thread after its seq, merges it and resubscribes (plan review focus 3).
/// One conversation row as the view shows it, its flags derived once per thread update.
struct ChatRow: Identifiable, Equatable {
    /// The item's position (an item id may repeat across kinds). Items are appended, and older ones put in front
    /// count down from 0 (ThreadStore.loadOlder), so a row keeps its id as the thread grows either way.
    let id: Int
    let item: ThreadItem
    /// The open request this item asks, if any.
    let pending: PendingRequest?
    let queued: Bool
    let critic: Bool
    /// A notice of a run that failed (run.failed); other notices carry a runId too ("event for unknown run").
    var failedRun = false
}

@MainActor
final class ThreadStore: ObservableObject {
    typealias Connect = (_ path: String, _ lastEventId: String?) async throws -> AsyncThrowingStream<String, Error>

    let sessionId: String
    @Published private(set) var thread: ThreadSnapshot?
    @Published private(set) var loadError: String?
    /// devd answered 409 not-a-chat-session: a tmux session, whose thread is its pane's transcript mirrored
    /// (devd/src/mirrorApi.ts), read only through the mirror's routes and never marked seen.
    @Published private(set) var isTmux = false
    /// A tmux session: what devd knows about its pane (who runs there, why a message cannot go in now).
    @Published private(set) var mirror: MirrorInfo?
    /// A tmux session: the last refused send's reason. It goes with a sent message, the dismiss button, Open terminal,
    /// or a real change of the pane (MirrorView.keepsLock).
    @Published var sendLock: MirrorLock?
    /// The stream is down and reconnecting.
    @Published private(set) var paused = false
    /// The last frame that could not be read (also logged); the thread may miss that update until a reload.
    @Published private(set) var badFrame: String?
    @Published private(set) var seenError: String?
    /// Where the changed-files card goes (under the latest finished answer); nil: no card.
    @Published private(set) var changesAnchor: ChangesAnchor?
    /// Only the newest `ThreadView.pageSize` items load at first: true while older ones may be left on devd.
    @Published private(set) var hasOlder = false
    @Published private(set) var loadingOlder = false
    /// The last `loadOlder` failure; the button stays to try again.
    @Published private(set) var olderError: String?
    /// A short title from the first user message (`ThreadTitle`), worked out again only when that message changes.
    private(set) var title: String?
    private var titleSource: String?
    /// devd refused the stream with 404 (or 409 not-a-chat-session): the session is gone. Final: no reconnect.
    @Published private(set) var ended = false
    /// devd answered 409 session-ending: an end is under way, but a failed end leaves the session alive, so the
    /// stream keeps trying every `endingRetry` until devd accepts it (resume) or says 404 (ended).
    @Published private(set) var ending = false
    /// The mirror stream refused a session that is no longer a tmux session (409 not-a-tmux-session): the session
    /// lives on, so this is not "ended", but this screen cannot read it. Final: no reconnect.
    @Published private(set) var noLongerTmux = false
    /// Derived from `thread` once per update (set before it, so a render sees them together), not on every render.
    private(set) var rows: [ChatRow] = []
    /// `rows` laid out: finished runs' work folded (WorkGroups.rows).
    private(set) var display: [ThreadDisplayRow] = []
    private(set) var switchKey = ""

    private static let logger = Logger(subsystem: "com.example.devbox", category: "Thread")
    private let client: DevdClient
    private let connect: Connect
    private let endingRetry: Duration
    /// Owned only here: released with the store, it ends its connection (EventStream's deinit).
    private var stream: EventStream?
    /// The screen wants the stream (between start/resume and stop): an await that ends after stop() opens nothing.
    private var wantsStream = false
    /// The seq last reported seen, so the same seq is not posted again.
    private var postedSeen = 0
    /// The id of the first shown item's row: it goes down as older items go in front (ChatRow.id).
    private var rowBase = 0
    /// What the session list said the session runs (`start`): it picks the route without the /thread probe.
    private var runtime: InboxItem.Runtime?
    /// Live updates of items older than the loaded window, until their page loads (ThreadView.Held).
    private var held = ThreadView.Held()

    /// `restored`: the thread as the Mac app saved it at quit; `start` then streams from its seq instead of loading it.
    init(sessionId: String, client: DevdClient, restored: ThreadSnapshot? = nil, endingRetry: Duration = .seconds(20),
         connect: Connect? = nil) {
        self.sessionId = sessionId
        self.client = client
        self.endingRetry = endingRetry
        self.connect = connect ?? { path, id in try await client.streamLines(path, lastEventId: id) }
        if let restored { setThread(restored) }
    }

    private var base: String { "/api/sessions/\(pathSegment(sessionId))" }

    /// Loads the thread (once) and opens the stream from its seq. `runtime`: what the session list says the session
    /// runs, when it is known; a tmux session then goes to its mirror without asking /thread first.
    func start(runtime: InboxItem.Runtime? = nil) async {
        guard !ended else { return }
        wantsStream = true
        if let runtime { self.runtime = runtime }
        if thread == nil { await load() }
        guard thread != nil, wantsStream else { return }
        openStream()
        markSeen(look: true)
    }

    func stop() {
        wantsStream = false
        stream?.stop()
        stream = nil
        paused = false
    }

    /// Back from the background: what changed after our seq, then the stream again from the new seq.
    /// `look: false` when the caller marks the look itself (the Mac, on the window becoming key).
    func resume(look: Bool = true) async {
        guard !ended else { return }
        stop()
        guard let t = thread else { return await start() }
        wantsStream = true
        do {
            if isTmux {
                let m: MirrorResponse = try await client.get("\(base)/mirror?afterSeq=\(t.lastSeq)")
                applyMirror(m.mirror)
                update(ThreadView.mergeLive(t, ThreadSnapshotFrame(afterSeq: t.lastSeq, snapshot: m.snapshot), more: hasOlder, held: &held))
            } else {
                let s: ThreadSnapshot = try await client.get("\(base)/thread?afterSeq=\(t.lastSeq)")
                update(ThreadView.mergeLive(t, ThreadSnapshotFrame(afterSeq: t.lastSeq, snapshot: s), more: hasOlder, held: &held))
            }
        } catch {
            // The stream's own replay (afterSeq) still catches up; the failure is shown, not hidden.
            Self.logger.error("thread resume fetch failed: \(String(describing: error), privacy: .public)")
            badFrame = "could not catch up after the app was away: \(errorText(error))"
        }
        guard wantsStream else { return }
        openStream()
        if look { markSeen(look: true) }
    }

    /// The newest `ThreadView.pageSize` items (`loadOlder` pages back). A tmux session the list named goes straight to
    /// its mirror; otherwise /thread answers 409 not-a-chat-session for one.
    private func load() async {
        let started = ContinuousClock.now
        defer {
            // Opening speed, from the store's side: the click's request(s) to rows built. Counts only, never content.
            Self.logger.info("thread load: \(self.thread?.items.count ?? -1) items, tmux \(self.isTmux), \(ContinuousClock.now - started, privacy: .public)")
        }
        if runtime == .tmux {
            isTmux = true
            return await loadMirror()
        }
        do {
            loaded(try await client.get("\(base)/thread?limit=\(ThreadView.pageSize)"))
            loadError = nil
            isTmux = false
        } catch let e as DevdHTTPError where e.statusCode == 409 && e.serverMessage == "not-a-chat-session" {
            isTmux = true
            await loadMirror()
        } catch {
            loadError = errorText(error)
        }
    }

    private func loadMirror() async {
        do {
            let m: MirrorResponse = try await client.get("\(base)/mirror?limit=\(ThreadView.pageSize)")
            applyMirror(m.mirror)
            loaded(m.snapshot)
            loadError = nil
        } catch let e as DevdHTTPError where e.statusCode == 409 && e.serverMessage == "not-a-tmux-session" && runtime == .tmux {
            // The list said tmux, devd says otherwise now: ask as for an unknown runtime.
            Self.logger.notice("mirror refused a session the list named tmux; loading it as a chat thread")
            runtime = nil
            isTmux = false
            await load()
        } catch {
            loadError = errorText(error)
        }
    }

    private func loaded(_ s: ThreadSnapshot) {
        held = ThreadView.Held()
        hasOlder = ThreadView.hasOlder(s)
        // A prompt with text is loaded, so the thread has a topic: none means an older devd (it ships with the apps, so a
        // deploy in progress). Said, not hidden: the header names the repo until the thread's start is loaded.
        if hasOlder, s.topic == nil, s.items.contains(where: { $0.kind == .user && !$0.text.isEmpty }) {
            Self.logger.error("devd sent no thread topic: the header names the repo until the thread's start is loaded")
        }
        setThread(s)
    }

    /// The page before the oldest loaded item, put in front. The rows already shown keep their ids (rowBase).
    func loadOlder() async {
        guard hasOlder, !loadingOlder, let t = thread, let before = ThreadView.olderBeforeSeq(t) else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        let query = "beforeSeq=\(before)&limit=\(ThreadView.pageSize)"
        do {
            let page: ThreadSnapshot = isTmux
                ? (try await client.get("\(base)/mirror?\(query)") as MirrorResponse).snapshot
                : try await client.get("\(base)/thread?\(query)")
            guard let cur = thread else { return }
            let more = ThreadView.hasOlder(page)
            // Read here, after the await: the held updates of every frame that arrived meanwhile are in (main actor).
            let next = ThreadView.prependOlder(cur, page.items, pageSeq: page.lastSeq, held: held, more: more)
            if !more { held = ThreadView.Held() } // all applied, or appended as never started
            // Only what went in front moves the ids down (held items or unknown finishes appended at the end do not).
            let front = cur.items.first.flatMap { f in
                next.items.firstIndex { $0.seq == f.seq && $0.runId == f.runId && $0.itemId == f.itemId && $0.kind == f.kind }
            } ?? 0
            rowBase -= next.items.prefix(front).filter { !ThreadView.isHousekeeping($0) }.count
            hasOlder = more
            olderError = nil
            setThread(next)
        } catch {
            Self.logger.error("loading older items failed: \(String(describing: error), privacy: .public)")
            olderError = errorText(error)
        }
    }

    private func applyMirror(_ info: MirrorInfo) {
        if !MirrorView.keepsLock(from: mirror, to: info) { sendLock = nil }
        mirror = info
    }

    private func openStream() {
        guard stream == nil else { return }
        let session = pathSegment(sessionId)
        let s = EventStream(
            connect: { [weak self, endingRetry] id in
                while true {
                    // Only a weak reference across the sleep: a store let go while its session is ending is not kept
                    // alive by its retries. Gone with its screen: no reconnect for nobody (see EventStream).
                    if let lines = try await self?.connectOnce(session: session, lastEventId: id) { return lines }
                    if self == nil { throw CancellationError() }
                    try await Task.sleep(for: endingRetry) // throws CancellationError when the stream is stopped
                }
            },
            onOpen: { [weak self] in self?.paused = false },
            onEvent: { [weak self] e in self?.handle(e) },
            onDrop: { [weak self] error in
                Self.logger.info("thread stream dropped: \(error.map { String(describing: $0) } ?? "closed by devd", privacy: .public)")
                self?.paused = true
            }
        )
        stream = s
        s.start()
    }

    /// One stream connect. nil: the session is ending (409 session-ending), try again later. Throws
    /// CancellationError when the session is gone (404, 409 not-a-chat-session) or is no longer a tmux session (a
    /// mirror's 409 not-a-tmux-session), which ends EventStream's loop.
    private func connectOnce(session: String, lastEventId: String?) async throws -> AsyncThrowingStream<String, Error>? {
        // Each (re)connect asks from the seq the store holds now; devd prefers Last-Event-ID when sent.
        let after = thread?.lastSeq ?? 0
        let path = isTmux ? "/api/sessions/\(session)/mirror/stream?afterSeq=\(after)" : "/api/stream?session=\(session)&afterSeq=\(after)"
        do {
            let lines = try await connect(path, lastEventId)
            ending = false
            return lines
        } catch let e as DevdHTTPError where e.statusCode == 409 && e.serverMessage == "session-ending" {
            Self.logger.info("thread stream: session is ending, retrying")
            ending = true
            return nil
        } catch let e as DevdHTTPError where e.statusCode == 409 && e.serverMessage == "not-a-tmux-session" {
            Self.logger.notice("mirror stream refused: no longer a tmux session")
            ending = false
            noLongerTmux = true
            throw CancellationError()
        } catch let e as DevdHTTPError where e.statusCode == 404 || (e.statusCode == 409 && e.serverMessage == "not-a-chat-session") {
            Self.logger.notice("thread stream refused (HTTP \(e.statusCode) \(e.serverMessage ?? "", privacy: .public)): session ended")
            ending = false
            ended = true
            throw CancellationError()
        }
    }

    private func handle(_ e: SSEParser.Event) {
        guard let t = thread else { return }
        let data = Data(e.data.utf8)
        do {
            switch e.name {
            case "thread-snapshot":
                update(ThreadView.mergeLive(t, try JSONDecoder().decode(ThreadSnapshotFrame.self, from: data), more: hasOlder, held: &held))
            case "thread": update(ThreadView.applyLive(t, try JSONDecoder().decode(LoggedEvent.self, from: data), more: hasOlder, held: &held))
            case "thread-notice": update(ThreadView.applyNotice(t, try JSONDecoder().decode(ThreadItem.self, from: data)))
            case "thread-effort": update(ThreadView.applyEffort(t, try JSONDecoder().decode(ThreadEffort?.self, from: data)))
            case "thread-commands": update(ThreadView.applyCommands(t, ThreadView.commands(from: data)))
            case "mirror": applyMirror(try JSONDecoder().decode(MirrorInfo.self, from: data))
            case "inbox", "ping": break
            default: Self.logger.notice("thread stream: ignoring event \(e.name, privacy: .public)")
            }
        } catch {
            Self.logger.error("unreadable \(e.name, privacy: .public) frame: \(String(describing: error), privacy: .public)")
            badFrame = "unreadable \(e.name) update: \(errorText(error))"
        }
    }

    private func update(_ next: ThreadSnapshot) {
        let endedBefore = thread.map(ThreadView.lastEndedSeq) ?? 0
        setThread(next)
        // A run ending while the thread is open counts as seen.
        if ThreadView.lastEndedSeq(next) != endedBefore { markSeen(look: false) }
    }

    /// The thread's rows as the screen draws them; also an ended session's transcript (EndedTranscriptScreen).
    static func chatRows(_ t: ThreadSnapshot, idBase: Int = 0) -> [ChatRow] {
        let queued = Set(ThreadView.queuedRunIds(t))
        let critic = Set(ThreadView.criticRunIds(t))
        let open = Dictionary(t.pending.map { ($0.requestId, $0) }, uniquingKeysWith: { a, _ in a })
        let failed = Set(t.runs.filter { $0.status == .failed }.map(\.runId))
        return ThreadView.shownItems(t).enumerated().map { i, it in
            ChatRow(id: idBase + i, item: it, pending: it.itemId.flatMap { open[$0] },
                    queued: it.runId.map(queued.contains) ?? false, critic: it.runId.map(critic.contains) ?? false,
                    failedRun: it.kind == .notice && it.runId.map(failed.contains) == true)
        }
    }

    private func setThread(_ t: ThreadSnapshot) {
        let (shown, partialRun) = ThreadView.tailView(Self.chatRows(t, idBase: rowBase), hasOlder: hasOlder, runs: t.runs, pending: t.pending)
        rows = shown
        display = WorkGroups.rows(rows, runs: t.runs, partialRun: partialRun)
        changesAnchor = ChangesView.anchor(rows, runs: t.runs)
        if hasOlder {
            // The first message may not be loaded: devd's topic (from the GET) names the thread; nil from an older devd.
            titleSource = nil
            title = t.topic
        } else {
            // As devd's topic: an attachment-only first message (empty text) names nothing; the next one does.
            let first = t.items.first(where: { $0.kind == .user && !$0.text.isEmpty })?.text
            if first != titleSource {
                titleSource = first
                title = first.flatMap(ThreadTitle.from)
            }
        }
        switchKey = ThreadView.switchKey(t)
        thread = t
    }

    /// Opening the thread and coming back to it (`look`), and a run ending while it is open, mark it seen
    /// (ThreadView.seenToPost). A run ending posts a seq once, until the snapshot says it is seen.
    func markSeen(look: Bool) {
        // A mirror has no seen marker (the inbox shows tmux sessions by their hooks).
        guard !isTmux, let t = thread, let seq = ThreadView.seenToPost(t, look: look), look || seq > postedSeen else { return }
        postedSeen = max(postedSeen, seq)
        Task {
            do {
                try await client.postVoid("\(base)/thread/seen", body: SeenBody(seq: seq))
                seenError = nil
            } catch {
                postedSeen = 0
                seenError = errorText(error)
            }
        }
    }

    // MARK: - Commands (202 once the bridge took them; refusals come back as DevdHTTPError, see chatErrorText)

    private struct SeenBody: Encodable { let seq: Int }
    private struct Attachment: Encodable { let path: String }
    private struct Message: Encodable {
        let text: String
        let attachments: [Attachment]?
    }
    private struct Answer: Encodable { let answer: String }
    private struct Empty: Encodable {}
    private struct Queued: Decodable { let queued: Bool }

    /// Uploads the (already prepared) images into the session's inbox, then sends the message with their paths.
    func send(text: String, images: [Data]) async throws {
        let paths = try await upload(images)
        let _: Queued = try await client.post("\(base)/thread/messages",
                                              body: Message(text: text, attachments: paths.isEmpty ? nil : paths.map(Attachment.init)))
    }

    private struct MirrorMessage: Encodable { let text: String }
    private struct Sent: Decodable { let sent: Bool }

    /// The images into the session's own inbox dir (`/inbox/<id>` in its container); their container paths.
    private func upload(_ images: [Data]) async throws -> [String] {
        var paths: [String] = []
        for image in images {
            let up: ThreadUpload = try await client.upload("\(base)/inbox?for=thread", data: image)
            paths.append(up.path)
        }
        return paths
    }

    /// A tmux session: types the text into its pane's agent, the images uploaded first and typed as their paths
    /// (MirrorView.messageText). A refusal devd explains (409, 404) becomes `sendLock` and returns false, so the composer
    /// keeps the text; other failures throw.
    func sendToPane(text: String, images: [Data] = []) async throws -> Bool {
        // Outside the catch below: a failed upload typed nothing, so it is its own error, not "may have arrived".
        let paths = try await upload(images)
        do {
            let _: Sent = try await client.post("\(base)/mirror/messages", body: MirrorMessage(text: MirrorView.messageText(text, imagePaths: paths)))
            sendLock = nil
            return true
        } catch let e as DevdHTTPError {
            guard let lock = MirrorView.sendLock(e) else { throw e }
            sendLock = lock
            return false
        } catch let e as DecodingError {
            // devd answered, with a body this app does not read: said as such (errorText), not as unconfirmed.
            throw e
        } catch {
            // No answer (a timeout, a dropped connection): devd may have typed it already, and nothing is retried.
            throw MirrorSendUnconfirmed()
        }
    }

    func interrupt() async throws {
        try await client.postVoid("\(base)/thread/interrupt", body: Empty())
    }

    /// Forwarded verbatim: a plan is approved by exactly "Approve", anything else is the user's reply.
    func answer(requestId: String, answer: String) async throws {
        try await client.postVoid("\(base)/thread/requests/\(pathSegment(requestId))", body: Answer(answer: answer))
    }
}
