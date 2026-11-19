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
        return ThreadSnapshot(lastSeq: max(t.lastSeq, s.lastSeq), seenSeq: s.seenSeq, runs: runs, items: items,
                              pending: s.pending, background: s.background, native: s.native)
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

    /// Runs waiting behind the active one: their user messages show as queued.
    static func queuedRunIds(_ t: ThreadSnapshot) -> [String] { t.runs.filter { $0.status == .queued }.map(\.runId) }

    /// Runs devd's critic started: their user message is the critic's, not the user's.
    static func criticRunIds(_ t: ThreadSnapshot) -> [String] { t.runs.filter { $0.origin == .critic }.map(\.runId) }

    /// The newest seq at which a run ended: reaching it while the thread is open counts as seen.
    static func lastEndedSeq(_ t: ThreadSnapshot) -> Int { t.runs.compactMap(\.endedSeq).max() ?? 0 }

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

        case let .bridgeStarted(version, resumed):
            if resumed { notice(&n, seq, ts, runId: nil, "Agent bridge restarted (v\(version))") }

        case let .unknown(type):
            logger.error("thread view: unknown event type \(type, privacy: .public) at seq \(seq)")
            notice(&n, seq, ts, runId: nil, "unknown event \(type)")
        }
    }
}
