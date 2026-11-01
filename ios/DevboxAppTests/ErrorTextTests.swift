import XCTest
@testable import DevboxApp

/// `errorText` is the only place where a network/server error is turned into a short user-facing
/// message — these tests check the mapping of individual types/codes, not the behavior of a specific screen
/// (that is up to `LiveStoreTests`/`DevdClientTests`).
final class ErrorTextTests: XCTestCase {
    // MARK: - URLError

    func testNotConnectedToInternetIsCzechOfflineText() {
        XCTAssertEqual(errorText(URLError(.notConnectedToInternet)), "You're not connected to the internet")
    }

    func testDataNotAllowedIsCzechOfflineText() {
        XCTAssertEqual(errorText(URLError(.dataNotAllowed)), "You're not connected to the internet")
    }

    func testTimedOutIsCzechText() {
        XCTAssertEqual(errorText(URLError(.timedOut)), "The server is not responding")
    }

    func testCannotFindHostIsCzechUnreachableText() {
        XCTAssertEqual(errorText(URLError(.cannotFindHost)), "The server is unreachable")
    }

    func testDnsLookupFailedIsCzechUnreachableText() {
        XCTAssertEqual(errorText(URLError(.dnsLookupFailed)), "The server is unreachable")
    }

    func testCannotConnectToHostIsCzechUnreachableText() {
        XCTAssertEqual(errorText(URLError(.cannotConnectToHost)), "The server is unreachable")
    }

    func testNetworkConnectionLostIsCzechText() {
        XCTAssertEqual(errorText(URLError(.networkConnectionLost)), "The connection was lost")
    }

    func testSecureConnectionFailedIsCzechText() {
        XCTAssertEqual(errorText(URLError(.secureConnectionFailed)), "The secure connection failed")
    }

    /// A code that none of the app's own messages covers (the app kills it itself via `stop()`, see
    /// `LiveStoreTests.testCancellationDuringTickDoesNotSetLastError`) — the fallback stays the
    /// system's readable `localizedDescription`, not a raw `String(describing:)` dump.
    func testUncoveredURLErrorCodeFallsBackToLocalizedDescription() {
        let error = URLError(.cancelled)
        XCTAssertEqual(errorText(error), error.localizedDescription)
    }

    // MARK: - DecodingError

    func testDecodingErrorIsCzechText() {
        let error = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad json"))
        XCTAssertEqual(errorText(error), "The server sent unexpected data")
    }

    // MARK: - DevdHTTPError

    func testHttp401IsCzechAccessDeniedText() {
        XCTAssertEqual(errorText(DevdHTTPError(statusCode: 401)), "Access denied (HTTP 401)")
    }

    func testHttp403IsCzechAccessDeniedText() {
        XCTAssertEqual(errorText(DevdHTTPError(statusCode: 403)), "Access denied (HTTP 403)")
    }

    func testOtherHttpStatusIsCzechServerErrorText() {
        XCTAssertEqual(errorText(DevdHTTPError(statusCode: 503)), "Server error (HTTP 503)")
    }

    // MARK: - DevdClientError (both network paths failed, see `DevdClient.request`)

    /// Example from the spec: offline has priority over timeout, even though timeout is second in the array.
    func testBothPathsFailingPicksOfflineOverTimeout() {
        let error = DevdClientError(
            description: "x",
            underlying: [URLError(.notConnectedToInternet), URLError(.timedOut)]
        )
        XCTAssertEqual(errorText(error), "You're not connected to the internet")
    }

    func testBothPathsFailingPicksTimeoutOverUnreachable() {
        let error = DevdClientError(
            description: "x",
            underlying: [URLError(.cannotConnectToHost), URLError(.timedOut)]
        )
        XCTAssertEqual(errorText(error), "The server is not responding")
    }

    func testBothPathsFailingPicksUnreachableOverOther() {
        let error = DevdClientError(
            description: "x",
            underlying: [DevdHTTPError(statusCode: 500), URLError(.cannotFindHost)]
        )
        XCTAssertEqual(errorText(error), "The server is unreachable")
    }

    /// None of the errors in `underlying` falls into a priority category — the first one is taken and `errorText`
    /// is called on it recursively (here: `DevdHTTPError` 500 → "Server error").
    func testBothPathsFailingWithNoPriorityMatchRecursesIntoFirstError() {
        let error = DevdClientError(
            description: "x",
            underlying: [DevdHTTPError(statusCode: 500), DevdHTTPError(statusCode: 501)]
        )
        XCTAssertEqual(errorText(error), "Server error (HTTP 500)")
    }

    /// Errors without `underlying` (e.g. "not configured", `SessionDetailView`'s own messages) —
    /// the fallback is their own `description`, not a generic NSError description (`.localizedDescription`
    /// would return something like "The operation couldn't be completed." for them).
    func testEmptyUnderlyingFallsBackToOwnDescription() {
        let error = DevdClientError(description: "no route to host")
        XCTAssertEqual(errorText(error), "no route to host")
    }
}
