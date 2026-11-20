#if DEBUG
import Foundation
import os

/// DEBUG-only offline mode for screenshots: `-DevboxFixtures <set>` starts the app configured against an in-process
/// devd stand-in (`FixtureURLProtocol`) that serves the named set's canned responses. No Keychain, no network, no
/// push or Live Activity registration. Release builds contain none of this (the whole folder is `#if DEBUG`).
enum FixtureMode {
    typealias Responder = (URLRequest) -> FixtureResponse
    /// A set maps a request ("GET /api/inbox", query ignored) to its response. Sets register here by name.
    static let sets: [String: [String: Responder]] = [
        "demo": InboxFixtures.routes.merging(ThreadFixtures.routes) { _, _ in fatalError("two fixtures for one route") },
    ]

    /// The requested set's name, or nil when the argument is absent. An unknown name stops the app: a screenshot of
    /// the wrong data must not pass for the right one.
    static let requested: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-DevboxFixtures") else { return nil }
        guard i + 1 < args.count, sets[args[i + 1]] != nil else {
            fatalError("-DevboxFixtures needs one of: \(sets.keys.sorted().joined(separator: ", "))")
        }
        return args[i + 1]
    }()

    static var isActive: Bool { requested != nil }

    /// `-DevboxAppearance light|dark` (Mac): the app's appearance whatever the system's, for screenshots of both.
    static let appearance: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-DevboxAppearance") else { return nil }
        guard isActive, i + 1 < args.count, ["light", "dark"].contains(args[i + 1]) else {
            fatalError("-DevboxAppearance takes light or dark and needs -DevboxFixtures")
        }
        return args[i + 1]
    }()

    /// `-DevboxSelect <sessionId>` (Mac): the first window opens on that session.
    static let selected: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-DevboxSelect") else { return nil }
        guard isActive, i + 1 < args.count else { fatalError("-DevboxSelect takes a session id and needs -DevboxFixtures") }
        return args[i + 1]
    }()

    /// `-DevboxWindowSize 1440x900` (Mac): the window's size in points, so screenshots of every run match. Only with
    /// `-DevboxFixtures`; a malformed value stops the app.
    static let windowSize: CGSize? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-DevboxWindowSize") else { return nil }
        let parts = i + 1 < args.count ? args[i + 1].split(separator: "x").compactMap { Double($0) } : []
        guard isActive, parts.count == 2 else { fatalError("-DevboxWindowSize takes WIDTHxHEIGHT and needs -DevboxFixtures") }
        return CGSize(width: parts[0], height: parts[1])
    }()

    /// `-DevboxScrollTo bottom`: a screen that supports it scrolls to its end once loaded, so a screenshot can show
    /// the lower half. Only with `-DevboxFixtures`; any other value stops the app.
    static let scrollToBottom: Bool = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-DevboxScrollTo") else { return false }
        guard isActive, i + 1 < args.count, args[i + 1] == "bottom" else {
            fatalError("-DevboxScrollTo takes \"bottom\" and needs -DevboxFixtures")
        }
        return true
    }()

    /// A client whose every request is answered by `FixtureURLProtocol`. The host is never resolved.
    static func client() -> DevdClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureURLProtocol.self]
        return DevdClient(endpoints: DevdEndpoints(tailnetBase: URL(string: "https://fixtures.invalid")!), session: URLSession(configuration: config))
    }
}

/// A canned response. `stream` keeps the response open after the body (an SSE stream with no further frames).
struct FixtureResponse {
    var status = 200
    var contentType = "application/json"
    var body = Data()
    var stream = false

    static func json(_ value: Any) -> FixtureResponse {
        FixtureResponse(body: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }
    static let openStream = FixtureResponse(contentType: "text/event-stream", body: Data(": fixtures\n\n".utf8), stream: true)
}

final class FixtureURLProtocol: URLProtocol {
    private static let logger = Logger(subsystem: "com.example.devbox", category: "Fixtures")

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let routes = FixtureMode.requested.flatMap { FixtureMode.sets[$0] } ?? [:]
        let response: FixtureResponse
        if let responder = routes[key] {
            response = responder(request)
        } else {
            // No silent stand-in: a request the set does not cover fails visibly, as an unknown devd route would.
            Self.logger.error("no fixture for \(key, privacy: .public)")
            response = FixtureResponse(status: 404, body: Data(#"{"error":"no fixture for \#(key)"}"#.utf8))
        }
        let http = HTTPURLResponse(url: request.url!, statusCode: response.status, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": response.contentType])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        if !response.stream { client?.urlProtocolDidFinishLoading(self) }
    }

    override func stopLoading() {}
}
#endif
