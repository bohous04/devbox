import XCTest
@testable import DevboxApp

/// Contract with devd (Task 3): the `agent-live-activity-v2*.json` fixtures are produced directly by
/// `deriveActivityV2` (devd/test/liveActivities.test.ts keeps them pinned).
final class AgentActivityAttributesTests: XCTestCase {
    private typealias Attributes = DevboxAgentActivityAttributes

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"))
        return try Data(contentsOf: url)
    }

    private func iso(_ text: String) -> Date { Attributes.date(text)! }

    func testV2FixtureDecodesAllFiveStatusesWithISODates() throws {
        let state = try JSONDecoder().decode(Attributes.ContentState.self, from: fixture("agent-live-activity-v2"))
        XCTAssertEqual(state.version, 2)
        XCTAssertEqual(state.counts, .init(waiting: 2, working: 2, done: 1, stalled: 2, unknown: 6))
        XCTAssertEqual(state.dot, .waiting)
        XCTAssertEqual(state.overflow, 5)
        XCTAssertEqual(Set(state.sessions.map(\.status)), Set(Attributes.Status.allCases))
        XCTAssertEqual(state.changedAt, iso("2026-10-19T09:59:00Z"))
        XCTAssertEqual(state.updatedAt, iso("2026-10-19T10:00:00Z"))

        let first = try XCTUnwrap(state.sessions.first)
        XCTAssertEqual(first.id, "dev-wait-old")
        XCTAssertEqual(first.agent, "codex")
        XCTAssertEqual(first.project, "portal/web")
        XCTAssertEqual(first.reason, "Approve SSH key: infra-root · root@1.2.3.4:22")
        XCTAssertEqual(first.since, iso("2026-10-19T09:51:00Z"))
        XCTAssertEqual(first.deepLink?.absoluteString, "devbox://session/dev-wait-old")
        XCTAssertEqual(state.sessions.first { $0.id == "dev-stalled" }?.reason, "May be stuck")
        XCTAssertEqual(state.sessions.first { $0.id == "dev-failed" }?.reason, "Failed with an error")
        XCTAssertTrue(state.hasActiveWork)
    }

    func testIdleFixtureHasNoActiveWork() throws {
        let state = try JSONDecoder().decode(Attributes.ContentState.self, from: fixture("agent-live-activity-v2-idle"))
        XCTAssertEqual(state.dot, .idle)
        XCTAssertEqual(state.counts.done, 2)
        XCTAssertEqual(state.counts.unknown, 1)
        XCTAssertTrue(state.sessions.allSatisfy { $0.reason == nil }, "reason: null decodes as nil")
        XCTAssertFalse(state.hasActiveWork, "Done and unknown sessions do not keep the activity alive on their own")
    }

    func testRoundTripKeepsWireShapeAndFitsAPNsBudget() throws {
        let data = try fixture("agent-live-activity-v2")
        let state = try JSONDecoder().decode(Attributes.ContentState.self, from: data)
        let encoded = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(Attributes.ContentState.self, from: encoded), state)
        // Same shape as devd: ISO strings, `reason: null`, exact keys.
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
        let reencoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
        XCTAssertEqual(reencoded, original)
        XCTAssertLessThan(encoded.count + 512, 4096)
    }

    func testUnknownValuesFromNewerServerDecodeTolerantly() throws {
        let json = """
        {"version":2,"counts":{"waiting":0,"working":1},"dot":"sparkly",
         "sessions":[{"id":"dev-x","title":"X","agent":"claude","project":"p/r","status":"teleporting",
                      "reason":null,"since":"2026-10-19T09:51:00Z"}],
         "overflow":0,"changedAt":"2026-10-19T09:51:00.000Z","updatedAt":"2026-10-19T10:00:00.000Z"}
        """
        let state = try JSONDecoder().decode(Attributes.ContentState.self, from: Data(json.utf8))
        XCTAssertEqual(state.sessions.first?.status, .unknown)
        XCTAssertEqual(state.dot, .idle)
        XCTAssertEqual(state.counts.working, 1)
        XCTAssertEqual(state.counts.stalled, 0)
    }

    func testActivityKitDefaultDateEncodingAlsoDecodes() throws {
        // ActivityKit decodes content-state with its own JSONDecoder — a number (seconds since 2001)
        // must pass just like an ISO string.
        let json = """
        {"version":2,"counts":{"waiting":1,"working":0,"done":0,"stalled":0,"unknown":0},"dot":"waiting",
         "sessions":[],"overflow":0,"changedAt":700000000,"updatedAt":700000060.5}
        """
        let state = try JSONDecoder().decode(Attributes.ContentState.self, from: Data(json.utf8))
        XCTAssertEqual(state.changedAt, Date(timeIntervalSinceReferenceDate: 700_000_000))
        XCTAssertEqual(state.updatedAt, Date(timeIntervalSinceReferenceDate: 700_000_060.5))
    }

    func testInvalidDateFailsInsteadOfInventingTime() {
        let json = """
        {"version":2,"counts":{},"dot":"idle","sessions":[],"overflow":0,"changedAt":"not-a-date","updatedAt":"2026-10-19T10:00:00Z"}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(Attributes.ContentState.self, from: Data(json.utf8)))
    }

    func testSessionLinkDoesNotAcceptAnArbitraryURLOrPath() {
        for id in ["", "../x", "x/y", "x?tab=terminal", "https://example.com", String(repeating: "x", count: 256)] {
            XCTAssertNil(Attributes.sessionURL(id))
        }
        XCTAssertEqual(Attributes.sessionURL("dev-test_1.2")?.host, "session")
        XCTAssertNotNil(Attributes.date("2026-09-11T22:00:00Z"))
        XCTAssertNotNil(Attributes.date("2026-09-11T22:00:00.123Z"))
        XCTAssertNil(Attributes.date("not-a-date"))
    }
}
