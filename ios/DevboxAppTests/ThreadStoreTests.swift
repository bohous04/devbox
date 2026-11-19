import XCTest
@testable import DevboxApp

/// `ThreadView` against the shared cases in `shared/fixtures/thread-events.json` — the same file drives
/// `dashboard/src/threadView.test.ts`, so the app and the dashboard apply a thread identically.
final class ThreadStoreTests: XCTestCase {
    private struct Derived: Decodable {
        let activeRun: String?
        let queued: [String]
        let critic: [String]
    }

    private enum Step: Decodable {
        case event(LoggedEvent)
        case snapshot(ThreadSnapshotFrame)
        case notice(ThreadItem)

        private enum K: String, CodingKey { case event, snapshot, notice }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            if let e = try c.decodeIfPresent(LoggedEvent.self, forKey: .event) { self = .event(e) }
            else if let s = try c.decodeIfPresent(ThreadSnapshotFrame.self, forKey: .snapshot) { self = .snapshot(s) }
            else { self = .notice(try c.decode(ThreadItem.self, forKey: .notice)) }
        }
    }

    private struct Case: Decodable {
        let name: String
        let steps: [Step]
        let expect: ThreadSnapshot
        let derived: Derived?
    }

    private struct Fixture: Decodable { let cases: [Case] }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "thread-events", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testSharedFixtureCases() throws {
        let cases = try fixture().cases
        XCTAssertGreaterThan(cases.count, 20)
        for c in cases {
            var t = ThreadSnapshot.empty
            for step in c.steps {
                switch step {
                case .event(let e): t = ThreadView.apply(t, e)
                case .snapshot(let s): t = ThreadView.mergeSnapshot(t, s)
                case .notice(let i): t = ThreadView.applyNotice(t, i)
                }
            }
            XCTAssertEqual(t, c.expect, c.name)
            if let d = c.derived {
                XCTAssertEqual(ThreadView.activeRun(t)?.runId, d.activeRun, c.name)
                XCTAssertEqual(ThreadView.queuedRunIds(t), d.queued, c.name)
                XCTAssertEqual(ThreadView.criticRunIds(t), d.critic, c.name)
            }
        }
    }

    func testToolInputNullIsKeptAsAValue() throws {
        let json = #"{"seq":1,"ts":5,"event":{"type":"tool.started","runId":"r","itemId":"t","tool":"X","input":null}}"#
        let e = try JSONDecoder().decode(LoggedEvent.self, from: Data(json.utf8))
        let t = ThreadView.apply(.empty, e)
        XCTAssertEqual(t.items.first?.input, .null)
    }
}
