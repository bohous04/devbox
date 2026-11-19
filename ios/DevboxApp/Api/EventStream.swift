import Foundation

/// Splits a byte stream into SSE lines: LF, CRLF and a lone CR end a line (the EventSource rules). Own splitter
/// because `URLSession.AsyncBytes.lines` drops blank lines, and a blank line is what ends an SSE frame.
struct LineSplitter {
    private var buffer: [UInt8] = []
    private var afterCR = false

    mutating func feed(_ byte: UInt8) -> String? {
        if afterCR {
            afterCR = false
            if byte == 0x0A { return nil } // the LF of a CRLF
        }
        switch byte {
        case 0x0A, 0x0D:
            afterCR = byte == 0x0D
            defer { buffer.removeAll(keepingCapacity: true) }
            return String(decoding: buffer, as: UTF8.self)
        default:
            buffer.append(byte)
            return nil
        }
    }
}

/// One SSE frame at a time (the WHATWG EventSource parsing rules): `event:`, `data:` (several lines joined with a
/// newline), `id:` (kept across frames, like `EventSource.lastEventId`), `:` comments; a blank line dispatches.
struct SSEParser {
    struct Event: Equatable {
        let name: String
        let data: String
        /// The last event id at dispatch (this frame's, or an earlier one's).
        let id: String?
    }

    private(set) var lastEventId: String?
    private var name = ""
    private var data: [String] = []
    private var hasData = false

    mutating func feed(_ line: String) -> Event? {
        if line.isEmpty {
            defer { name = ""; data = []; hasData = false }
            guard hasData else { return nil }
            return Event(name: name.isEmpty ? "message" : name, data: data.joined(separator: "\n"), id: lastEventId)
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "event": name = String(value)
        case "data": data.append(String(value)); hasData = true
        case "id" where !value.contains("\0"): lastEventId = String(value)
        default: break // `retry` and unknown fields: ignored, as EventSource does
        }
        return nil
    }
}

/// devd's event stream (`GET /api/stream`) with EventSource's reconnect: when the connection ends or fails it
/// reconnects after `retryDelay`, sending the last event id it saw (`Last-Event-ID`), from which devd replays.
/// Callbacks run on the main actor. Every drop is reported (`onDrop`, nil = devd closed the stream), never hidden.
@MainActor
final class EventStream {
    typealias Connect = (_ lastEventId: String?) async throws -> AsyncThrowingStream<String, Error>

    private let connect: Connect
    private let retryDelay: Duration
    private let onOpen: () -> Void
    private let onEvent: (SSEParser.Event) -> Void
    private let onDrop: (Error?) -> Void
    private var task: Task<Void, Never>?

    init(connect: @escaping Connect, retryDelay: Duration = .seconds(5), onOpen: @escaping () -> Void,
         onEvent: @escaping (SSEParser.Event) -> Void, onDrop: @escaping (Error?) -> Void) {
        self.connect = connect
        self.retryDelay = retryDelay
        self.onOpen = onOpen
        self.onEvent = onEvent
        self.onDrop = onDrop
    }

    var isRunning: Bool { task != nil }

    // The task does not hold the stream: when its owner lets go of it (a screen's store released without stop()),
    // the connection ends here rather than reconnecting forever for nobody.
    // A deinit is nonisolated, so reading the main-actor `task` here only compiles in Swift 5 mode (SWIFT_VERSION
    // 5.0); it relies on the owners (main-actor stores) releasing it on the main actor. Under Swift 6 make it
    // `isolated deinit` (iOS 18 / macOS 15+; until those are the minimum, keep the task in a `nonisolated(unsafe)`
    // or lock-protected property and cancel that).
    deinit {
        task?.cancel()
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self, connect, retryDelay, onOpen, onEvent, onDrop] in
            await Self.run(connect: connect, retryDelay: retryDelay, onOpen: onOpen, onEvent: onEvent, onDrop: onDrop)
            if !Task.isCancelled { self?.task = nil }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private static func run(connect: Connect, retryDelay: Duration, onOpen: () -> Void,
                            onEvent: (SSEParser.Event) -> Void, onDrop: (Error?) -> Void) async {
        var parser = SSEParser()
        while !Task.isCancelled {
            do {
                let lines = try await connect(parser.lastEventId)
                if Task.isCancelled { return }
                onOpen()
                for try await line in lines {
                    if Task.isCancelled { return }
                    if let e = parser.feed(line) { onEvent(e) }
                }
                if Task.isCancelled { return }
                onDrop(nil)
            } catch is CancellationError {
                return // the owner is gone (its connect says so): nothing to reconnect for
            } catch {
                if Task.isCancelled { return }
                onDrop(error)
            }
            // A frame cut by the drop is incomplete: start the next connection clean, keeping only the id.
            parser = SSEParser(lastEventId: parser.lastEventId)
            do { try await Task.sleep(for: retryDelay) } catch { return }
        }
    }
}
