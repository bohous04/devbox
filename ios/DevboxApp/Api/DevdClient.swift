import Foundation

/// Addresses and credentials for both network paths to devd. `cfBase`/`cfId`/`cfSecret` are missing
/// until the user sets up Cloudflare Access in Settings — until then the app uses only the tailnet.
struct DevdEndpoints {
    var cfBase: URL?
    var cfId: String?
    var cfSecret: String?
    var tailnetBase: URL?
}

/// Non-2xx HTTP response. A 403 on the CF path triggers the fallback (see `DevdClient`); other codes are
/// propagated straight to the caller.
///
/// `serverMessage`: for many validation/conflict errors (400/404/409 — e.g. terminal sharing,
/// see `shares.ts`/`api.ts`) devd sends a `{error: "…"}` body with the specific reason. `perform`
/// tries to decode it here (silently falls back to `nil` when the body is missing/not JSON — an old or different route that
/// does not send that shape); `errorText` then shows it to the user instead of the generic "Server error (HTTP …)".
/// Default `nil`, so existing `DevdHTTPError(statusCode:)` calls keep working (tests and
/// production code).
struct DevdHTTPError: Error, CustomStringConvertible {
    let statusCode: Int
    let serverMessage: String?
    /// The body's `message` next to the `error` code (chat routes: `command-failed`, `bridge-too-old`,
    /// `request-open`…, devd/src/threadApi.ts). Read by `chatErrorText`; `errorText` keeps showing the code.
    let serverDetail: String?
    var description: String { "HTTP \(statusCode)" }

    init(statusCode: Int, serverMessage: String? = nil, serverDetail: String? = nil) {
        self.statusCode = statusCode
        self.serverMessage = serverMessage
        self.serverDetail = serverDetail
    }
}

/// Both network paths failed — carries a description of both attempts so the UI/log shows exactly what failed.
/// `underlying` carries both errors themselves (not just their concatenated description) — `errorText` picks among them
/// by priority offline > timeout > unreachable > other, so the UI reports the most useful one.
/// Empty (default) for errors where no network attempt was made at all ("not configured" etc.).
struct DevdClientError: Error, CustomStringConvertible {
    let description: String
    let underlying: [Error]

    init(description: String, underlying: [Error] = []) {
        self.description = description
        self.underlying = underlying
    }
}

/// Adapter for `JSONEncoder`: `any Encodable` on its own does not satisfy the generic requirement
/// `T: Encodable` (Swift limitation), so we wrap the `encode(to:)` call in a concrete type.
private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void

    init(_ value: any Encodable) {
        encodeClosure = { encoder in try value.encode(to: encoder) }
    }

    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}

/// Multipath network layer over the devd REST API: a request goes to the active path (CF by default when it is
/// configured; otherwise tailnet). For GET, a network error/timeout/HTTP 403 triggers ONE attempt on
/// the other path; for POST/postVoid (mutations!) the attempt is limited to cases where it is certain the
/// server never received the request — HTTP 403 or a connect-phase `URLError` (see `shouldFallback`)
/// — so the fallback never performs the same action twice. A successful fallback becomes the active path
/// (cached until the next failure). If both fail, the error carries a description of both attempts. Other non-2xx codes
/// (apart from the 403 fallback) are reported directly, without fallback.
actor DevdClient {
    private enum Path {
        case cf, tailnet
    }

    private let endpoints: DevdEndpoints
    private let session: URLSession
    private var active: Path

    init(endpoints: DevdEndpoints, session: URLSession = .shared) {
        self.endpoints = endpoints
        self.session = session
        active = endpoints.cfBase != nil ? .cf : .tailnet
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await request(path: path, method: "GET", body: nil)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func post<T: Decodable>(_ path: String, body: (any Encodable)?) async throws -> T {
        let data = try await request(path: path, method: "POST", body: body)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func postVoid(_ path: String, body: (any Encodable)?) async throws {
        _ = try await request(path: path, method: "POST", body: body)
    }

    /// PUT — so far only `updateSchedule` (dashboard/src/api.ts) needs it (partial patch, the server
    /// returns the updated record). Same fallback/timeout logic as `post` (the `method != "GET"`
    /// branches in `shouldFallback`/`perform` treat PUT no differently than POST).
    func put<T: Decodable>(_ path: String, body: (any Encodable)?) async throws -> T {
        let data = try await request(path: path, method: "PUT", body: body)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// DELETE without a body — `deleteSchedule` is the only caller so far.
    func deleteVoid(_ path: String) async throws {
        _ = try await request(path: path, method: "DELETE", body: nil)
    }

    // MARK: - Terminal share (Task 7 — sharing the terminal from the session detail)
    //
    // Unlike the other session actions (see `SessionActions`), sharing lives directly here:
    // `GET /api/shares`/`DELETE /api/shares/:id` are not paths under `/api/sessions/:id/…` (sharing
    // is cross-session), so it would fit into `SessionActions` no better than here — and two of the three
    // methods are just one-line redirects to `post`/`get`/`deleteVoid`, which the actor already has.

    private struct CreateShareBody: Encodable { let minutes: Int }

    /// `POST /api/sessions/:id/shares` — creates a short-lived link. The server returns the token in `url` ONLY
    /// in this response (it is not stored anywhere afterwards). Errors (400 bad `minutes`, 404 unknown session,
    /// 409 not running/InstaBox/no DIND) carry `{error}` in the body — `perform` maps it into
    /// `DevdHTTPError.serverMessage`, `errorText` shows it to the caller unchanged.
    func createShare(sessionId: String, minutes: Int) async throws -> TerminalShare {
        try await post("/api/sessions/\(sessionId)/shares", body: CreateShareBody(minutes: minutes))
    }

    /// `GET /api/shares` — all live shares across sessions; the caller (`SessionDetailView`)
    /// picks only those belonging to its session.
    func shares() async throws -> [ActiveShare] {
        try await get("/api/shares")
    }

    /// `DELETE /api/shares/:id` — revokes one share. Idempotent on the server (404 for an
    /// already revoked/unknown id), the app lets a 404 fall through as a regular error.
    func revokeShare(_ id: String) async throws {
        try await deleteVoid("/api/shares/\(id)")
    }

    private struct EmptyBody: Encodable {}

    /// `POST /api/sessions/:id/recreate` — rebuilds the container (new docker id). The only thing that
    /// lifts the session restriction after a finished share (`SessionLive.tainted`).
    func recreateSession(_ id: String) async throws {
        try await postVoid("/api/sessions/\(id)/recreate", body: EmptyBody())
    }

    /// WS URL over the active path — the http(s) scheme is translated to ws(s). Throws if
    /// the app has no configured path yet (pre-onboarding state — `DevdEndpoints`
    /// with both bases nil is a valid value, not a broken invariant).
    func wsURL(_ path: String) throws -> URL {
        guard let base = baseURL(for: active) else {
            // User-visible (Settings renders it) — must be in English.
            throw DevdClientError(description: "No network path configured")
        }
        let httpURL = try Self.resolve(path, against: base)
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            throw DevdClientError(description: "Invalid URL: \(path)")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        guard let url = components.url else {
            throw DevdClientError(description: "Invalid URL: \(path)")
        }
        return url
    }

    /// `URL(string:relativeTo:)` returns nil for a path with characters that are not valid in a URL (e.g. an
    /// unexpected session id) — an error instead of a force-unwrap that would crash the whole app.
    private static func resolve(_ path: String, against base: URL) throws -> URL {
        guard let url = URL(string: path, relativeTo: base) else {
            // User-visible — must be in English.
            throw DevdClientError(description: "Invalid URL: \(path)")
        }
        return url.absoluteURL
    }

    /// Handshake request for `URLSessionWebSocketTask(with:)` over the active path — same URL as
    /// `wsURL`, plus CF headers when the active path is CF. `URLSessionWebSocketTask` sends
    /// the headers from `URLRequest` during the WS upgrade handshake (verified in Stage 0: CF Access lets the
    /// upgrade to 101 through with a service token) — without them CF would not let the terminal through at all.
    /// The terminal (the only place in the app with WS) needs no fallback — switching paths while
    /// a socket is open would only complicate it needlessly, unlike REST requests in `perform`.
    func wsRequest(_ path: String) throws -> URLRequest {
        let url = try wsURL(path)
        var request = URLRequest(url: url)
        if active == .cf {
            // Same guard as `perform` — a CF path without a token would attempt the handshake without
            // logging in and get a silent error instead of a clear "missing token".
            guard let cfId = endpoints.cfId, let cfSecret = endpoints.cfSecret else {
                // User-visible — must be in English.
                throw DevdClientError(description: "CF path missing service token")
            }
            request.setValue(cfId, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(cfSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        return request
    }

    // MARK: - Chat (devd/src/threadApi.ts)

    /// devd's SSE stream as lines, blank ones included (`EventStream` parses them). On the active path only: a
    /// long-lived stream gets no fallback; `EventStream` reconnects, and by then a REST call may have moved the
    /// active path. Returns once devd answered 2xx; a non-2xx answer throws `DevdHTTPError` with its `{error}`.
    func streamLines(_ path: String, lastEventId: String?) async throws -> AsyncThrowingStream<String, Error> {
        guard let base = baseURL(for: active) else {
            // User-visible — must be in English.
            throw DevdClientError(description: "No network path configured")
        }
        var request = URLRequest(url: try Self.resolve(path, against: base))
        // The session's 8 s request timeout is the longest gap between bytes; devd pings every 25 s.
        request.timeoutInterval = 60
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventId { request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID") }
        try addCfHeaders(&request, on: active)
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DevdClientError(description: "invalid response (\(label(active)))")
        }
        guard (200..<300).contains(http.statusCode) else {
            var body = Data()
            for try await b in bytes {
                body.append(b)
                if body.count > 4096 { break }
            }
            let parsed = try? JSONDecoder().decode(ErrorBody.self, from: body)
            throw DevdHTTPError(statusCode: http.statusCode, serverMessage: parsed?.error, serverDetail: parsed?.message)
        }
        return AsyncThrowingStream { continuation in
            let reader = Task {
                var splitter = LineSplitter()
                do {
                    for try await b in bytes {
                        if let line = splitter.feed(b) { continuation.yield(line) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
    }

    /// Raw bytes (a chat image for its thumbnail); GET fallback as `get`.
    func getData(_ path: String) async throws -> Data {
        try await request(path: path, method: "GET", body: nil)
    }

    /// A raw upload (`POST /api/sessions/:id/inbox?for=thread`: a chat image as octet-stream). Same path fallback
    /// as `post`.
    func upload<T: Decodable>(_ path: String, data: Data) async throws -> T {
        let raw = try await request(path: path, method: "POST", body: nil, rawBody: data)
        return try JSONDecoder().decode(T.self, from: raw)
    }

    // MARK: - Private

    private func addCfHeaders(_ request: inout URLRequest, on path: Path) throws {
        guard path == .cf else { return }
        guard let cfId = endpoints.cfId, let cfSecret = endpoints.cfSecret else {
            // User-visible — must be in English.
            throw DevdClientError(description: "CF path missing service token")
        }
        request.setValue(cfId, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(cfSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }

    private func baseURL(for path: Path) -> URL? {
        switch path {
        case .cf: return endpoints.cfBase
        case .tailnet: return endpoints.tailnetBase
        }
    }

    private func label(_ path: Path) -> String {
        switch path {
        case .cf: return "cf"
        case .tailnet: return "tailnet"
        }
    }

    private func otherPath(than path: Path) -> Path {
        path == .cf ? .tailnet : .cf
    }

    /// GET: a network error/timeout and HTTP 403 justify one attempt on the other path; other
    /// non-2xx codes (`DevdHTTPError` with another status) are reported directly.
    ///
    /// POST/postVoid: fallback may happen ONLY when it is certain the server never received the
    /// request — HTTP 403 (the CF Access gate rejected the app before reaching devd) or a connect-phase
    /// `URLError` (the connection was never established). `.timedOut` and anything else (the request may have
    /// arrived and only the response got lost/delayed) MUST NOT trigger the fallback — a second attempt could
    /// perform the action twice (double mutation, see review).
    private func shouldFallback(_ error: Error, method: String) -> Bool {
        if let httpError = error as? DevdHTTPError {
            return httpError.statusCode == 403
        }
        guard method != "GET" else { return true }
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet:
            return true
        default:
            return false
        }
    }

    private func request(path: String, method: String, body: (any Encodable)?, rawBody: Data? = nil) async throws -> Data {
        do {
            return try await perform(on: active, urlPath: path, method: method, body: body, rawBody: rawBody)
        } catch let firstError {
            let fallback = otherPath(than: active)
            guard shouldFallback(firstError, method: method), baseURL(for: fallback) != nil else {
                throw firstError
            }
            do {
                let data = try await perform(on: fallback, urlPath: path, method: method, body: body, rawBody: rawBody)
                active = fallback
                return data
            } catch let secondError {
                throw DevdClientError(
                    description: "\(label(active)): \(firstError); \(label(fallback)): \(secondError)",
                    underlying: [firstError, secondError]
                )
            }
        }
    }

    private func perform(on path: Path, urlPath: String, method: String, body: (any Encodable)?, rawBody: Data? = nil) async throws -> Data {
        guard let base = baseURL(for: path) else {
            // User-visible (Settings renders it) — must be in English.
            throw DevdClientError(description: "\(label(path)) not configured", underlying: [])
        }
        var urlRequest = URLRequest(url: try Self.resolve(urlPath, against: base))
        urlRequest.httpMethod = method
        if urlPath.hasPrefix("/api/live-activities/") {
            // Live Activity token registration/unregistration is idempotent and must not delay a
            // configuration change behind the long timeout reserved for agent actions.
            urlRequest.timeoutInterval = 8
        } else if method != "GET" {
            // Action POSTs (switchAgent/ccUpkeepRun/…) restart panels on devd and can run for
            // tens of seconds — the session default (8 s, see AppModel) would cut them off midway. The per-request
            // `timeoutInterval` overrides the session config only for this request; GET stays at 8 s.
            urlRequest.timeoutInterval = 150
        }
        if path == .cf {
            // A CF hostname without a service token would go to the Access gate unauthenticated and
            // get a silent (possibly non-403) error — better to report right away what is missing.
            guard let cfId = endpoints.cfId, let cfSecret = endpoints.cfSecret else {
                // User-visible (Settings renders it) — must be in English.
                throw DevdClientError(description: "CF path missing service token")
            }
            urlRequest.setValue(cfId, forHTTPHeaderField: "CF-Access-Client-Id")
            urlRequest.setValue(cfSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        } else if let rawBody {
            urlRequest.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = rawBody
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse else {
            // User-visible (Settings renders it) — must be in English.
            throw DevdClientError(description: "invalid response (\(label(path)))")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            // `try?` — the body may not be JSON at all (empty 404 from CF Access, an HTML error page
            // etc.); a silent `nil` in that case, not a failed request because of an undecodable error.
            let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw DevdHTTPError(statusCode: httpResponse.statusCode, serverMessage: parsed?.error, serverDetail: parsed?.message)
        }
        return data
    }
}

/// Shape of the error body devd sends for 400/404/409 (`c.json({ error: "…" }, code)`,
/// see `devd/src/api.ts`) — `perform` tries to decode it on every non-2xx response.
private struct ErrorBody: Decodable {
    let error: String?
    let message: String?

    private enum CodingKeys: String, CodingKey { case error, message }

    /// Each field on its own: a `message` of another shape must not cost the `error` code.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
    }
}
