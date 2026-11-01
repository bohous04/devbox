import XCTest
@testable import DevboxApp

/// `TerminalSession` is mostly WS I/O (untestable without a real socket) — what is purely
/// testable is the reconnect backoff progression and that `cancel()` lets the instance
/// deallocate (leak fix — `URLSession` holds its delegate strongly until invalidation).
@MainActor
final class TerminalSessionTests: XCTestCase {
    func testBackoffProgressionDoublesUpToMax() {
        var backoff = TerminalSession.initialBackoff
        XCTAssertEqual(backoff, 1)

        backoff = TerminalSession.nextBackoff(backoff)
        XCTAssertEqual(backoff, 2)

        backoff = TerminalSession.nextBackoff(backoff)
        XCTAssertEqual(backoff, 4)

        backoff = TerminalSession.nextBackoff(backoff)
        XCTAssertEqual(backoff, 8)

        backoff = TerminalSession.nextBackoff(backoff)
        XCTAssertEqual(backoff, 15, "8*2=16 should be clamped to the 15 s ceiling")

        backoff = TerminalSession.nextBackoff(backoff)
        XCTAssertEqual(backoff, 15, "must stay at the ceiling, not keep growing")
    }

    func testMaxBackoffConstantIsFifteenSeconds() {
        XCTAssertEqual(TerminalSession.maxBackoff, 15)
    }

    func testInitialBackoffIsOneSecond() {
        XCTAssertEqual(TerminalSession.initialBackoff, 1)
    }

    // MARK: - Leak fix — cancel() must invalidate URLSession

    /// `URLSession(configuration:delegate:delegateQueue:)` holds its delegate (`self`) STRONGLY until
    /// invalidation — without `urlSession.invalidateAndCancel()` in `cancel()`/`finish()`,
    /// `TerminalSession` could never deallocate, not even after the last outside strong reference is released.
    ///
    /// A trap verified outside XCTest (standalone Swift repro): `invalidateAndCancel()` releases the
    /// delegate via an Objective-C AUTORELEASE, not an immediate `release`. `XCTNSPredicateExpectation`/
    /// `wait(for:timeout:)` is not enough for this, even with tens of seconds of timeout — without an explicit
    /// `autoreleasepool` tick the object does not go away AT ALL (verified up to 60 s). Hence: (1) creation + cancel
    /// + release of the last outside reference wrapped in its own `autoreleasepool`, (2) a short loop of
    /// further empty `autoreleasepool {}` ticks (one was always enough in the repro), not relying
    /// on `XCTestExpectation`. `makeRequest` is never called (cancel() right after creation, without
    /// `connect()`) — the test checks purely the `URLSession`↔delegate lifecycle, not WS I/O.
    func testCancelInvalidatesURLSessionAllowingDeallocation() {
        weak var weakSession: TerminalSession?

        autoreleasepool {
            var session: TerminalSession? = TerminalSession(makeRequest: {
                throw DevdClientError(description: "unused")
            })
            weakSession = session
            session?.cancel()
            session = nil
        }

        for _ in 0..<20 {
            if weakSession == nil { break }
            autoreleasepool {}
            Thread.sleep(forTimeInterval: 0.1)
        }

        XCTAssertNil(weakSession, "cancel() must release the delegate (via invalidateAndCancel) — otherwise TerminalSession never deallocates")
    }
}
