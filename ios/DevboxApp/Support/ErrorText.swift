import Foundation

/// Text that `errorText` returns for the offline state (`URLError.notConnectedToInternet`/
/// `.dataNotAllowed`, directly or via `DevdClientError.underlying`). `OfflineBanner`
/// (Support/OfflineBanner.swift) uses it so Sessions/Overview can tell when to show the banner
/// instead of a raw error message over the data.
let offlineErrorText = "You're not connected to the internet"

/// Unified error text for the UI (stores/screens) — replaces raw descriptions (`URLError`
/// `Domain=NSURLErrorDomain Code=-1001 …`, `DevdClientError`'s technical details of both network
/// paths) with one of several short messages depending on the error type/code. Other errors
/// (`BiometricError`, `VaultUnlockError`, `ConfigSaveError`, …) have their own English
/// `CustomStringConvertible.description`, which `String(describing:)` handles well on its own — so it
/// stays as the final fallback (`.localizedDescription` would return a generic NSError
/// description for them, not their own text — verified by a runtime test, not just in theory).
func errorText(_ error: Error) -> String {
    if let urlError = error as? URLError {
        return urlErrorText(urlError)
    }
    if error is DecodingError {
        return "The server sent unexpected data"
    }
    if let httpError = error as? DevdHTTPError {
        if httpError.statusCode == 401 || httpError.statusCode == 403 {
            return "Access denied (HTTP \(httpError.statusCode))"
        }
        // `serverMessage` (see `DevdClient.perform`) carries the specific reason from devd (e.g. terminal
        // sharing: "session is not running", "sharing requires DEVD_DIND=1…") — more precise than a generic
        // sentence, show it directly, not just the code.
        if let serverMessage = httpError.serverMessage, !serverMessage.isEmpty {
            return serverMessage
        }
        return "Server error (HTTP \(httpError.statusCode))"
    }
    if let clientError = error as? DevdClientError {
        // Both network paths failed (`DevdClient.request`) — the error is picked by priority
        // offline > timeout > unreachable > other, and `errorText` is called recursively on it.
        // An empty `underlying` (e.g. "not configured"/"CF path missing service token") falls
        // back to the error's own `description`, not to a generic NSError description.
        if let picked = pickByPriority(clientError.underlying) {
            return errorText(picked)
        }
        return clientError.description
    }
    return String(describing: error)
}

/// `URLError` (network layer) has its own message for selected codes; for anything else
/// (`.cancelled`, `.badServerResponse`, …) the system's readable `localizedDescription` stays
/// ("The request timed out." etc.) — definitely not a raw `String(describing:)` dump.
private func urlErrorText(_ error: URLError) -> String {
    switch error.code {
    case .notConnectedToInternet, .dataNotAllowed:
        return offlineErrorText
    case .timedOut:
        return "The server is not responding"
    case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost:
        return "The server is unreachable"
    case .networkConnectionLost:
        return "The connection was lost"
    case .secureConnectionFailed:
        return "The secure connection failed"
    default:
        return error.localizedDescription
    }
}

/// Priority for picking from `DevdClientError.underlying` — the lower the value, the sooner the error
/// is shown to the user (offline is more useful to know than "timeout on a specific path").
private enum FailureCategory {
    case offline, timeout, unreachable, other
}

private func failureCategory(of error: Error) -> FailureCategory {
    guard let urlError = error as? URLError else { return .other }
    switch urlError.code {
    case .notConnectedToInternet, .dataNotAllowed: return .offline
    case .timedOut: return .timeout
    case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost: return .unreachable
    default: return .other
    }
}

/// `nil` only for an empty array (`DevdClient`'s errors without `underlying`, see `errorText`); otherwise
/// it always returns some element — the "other" category also covers whatever hit no priority
/// category.
private func pickByPriority(_ errors: [Error]) -> Error? {
    for category: FailureCategory in [.offline, .timeout, .unreachable] {
        if let match = errors.first(where: { failureCategory(of: $0) == category }) {
            return match
        }
    }
    return errors.first
}
