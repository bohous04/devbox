import SwiftUI
import XCTest
@testable import DevboxApp

/// Layout B2 (header with counts, waiting ones with a reason, footer with the rest) and the build 7 regression
/// (ios-corners-fix.md): the content fits the Lock Screen height (160 pt).
@MainActor
final class AgentActivityRenderingTests: XCTestCase {
    private typealias A = DevboxAgentActivityAttributes
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(_ id: String, _ status: A.Status, reason: String? = nil, agent: String = "claude") -> A.Session {
        A.Session(id: id, title: id.uppercased(), agent: agent, project: "p", status: status,
                  reason: reason, since: now.addingTimeInterval(-180))
    }

    private func state(_ counts: A.Counts, _ sessions: [A.Session], overflow: Int = 0) -> A.ContentState {
        A.ContentState(counts: counts, dot: counts.waiting > 0 ? .waiting : .working, sessions: sessions,
                       overflow: overflow, changedAt: now.addingTimeInterval(-12), updatedAt: now)
    }

    /// Mockup B2: 2 waiting, 8 working, 3 done — the server sends the waiting ones and some of the working ones.
    private var mockup: A.ContentState {
        state(A.Counts(waiting: 2, working: 8, done: 3), [
            session("notes", .waiting, reason: "Should I delete the old migrations or keep them?"),
            session("web", .waiting, reason: "Approve SSH key: infra-root", agent: "codex"),
            session("w1", .working), session("w2", .working), session("w3", .working),
        ], overflow: 5)
    }

    // MARK: - rows

    func testRowsShowOnlyWaitingSessionsWithReason() {
        let rows = B2Layout.rows(mockup, maxRows: 3)
        XCTAssertEqual(rows.map(\.id), ["notes", "web"])
        XCTAssertEqual(rows.map(\.status), [.waiting, .waiting])
        // A question in quotes (as in the mockup), approvals without them.
        XCTAssertEqual(rows.map(\.detail), ["“Should I delete the old migrations or keep them?”", "Approve SSH key: infra-root"])
    }

    func testRowsFallBackToThreeWorkingWhenNothingWaitsOrStalls() {
        let s = state(A.Counts(working: 5), (1...5).map { session("w\($0)", .working) })
        let rows = B2Layout.rows(s, maxRows: 3)
        XCTAssertEqual(rows.map(\.id), ["w1", "w2", "w3"])
        XCTAssertEqual(rows.map(\.status), [.working, .working, .working])
        XCTAssertEqual(rows.map(\.detail), [nil, nil, nil])
        XCTAssertEqual(rows.first?.agentLabel, "Claude")
    }

    func testRowsPutStalledAfterWaitingAndRespectMaxRows() {
        let s = state(A.Counts(waiting: 1, working: 2, stalled: 3), [
            session("wait", .waiting, reason: "Command approval"),
            session("s1", .stalled, reason: "Agent exited with an error"), session("s2", .stalled), session("s3", .stalled),
            session("w1", .working),
        ])
        XCTAssertEqual(B2Layout.rows(s, maxRows: 3).map(\.id), ["wait", "s1", "s2"])
        XCTAssertEqual(B2Layout.rows(s, maxRows: 3).map(\.detail), ["Command approval", "Agent exited with an error", "Not responding"])
        XCTAssertEqual(B2Layout.rows(s, maxRows: 2).map(\.id), ["wait", "s1"])
    }

    func testRowsShowAtMostThreeWaiting() {
        let s = state(A.Counts(waiting: 5), (1...5).map { session("q\($0)", .waiting, reason: "?") })
        XCTAssertEqual(B2Layout.rows(s, maxRows: 4).map(\.id), ["q1", "q2", "q3"])
    }

    // MARK: - header

    func testHeaderOmitsZerosInSpecOrder() {
        let header = B2Layout.header(mockup)
        XCTAssertEqual(header.map(\.label), ["2 waiting", "8 working", "3 done"])
        XCTAssertEqual(header.map(\.tone), [.waiting, .working, .done])

        let all = B2Layout.header(state(A.Counts(waiting: 1, working: 3, done: 1, stalled: 2, unknown: 6), []))
        XCTAssertEqual(all.map(\.label), ["1 waiting", "3 working", "1 done", "2 stalled", "6 ?"])
        XCTAssertEqual(all.map(\.tone), [.waiting, .working, .done, .stalled, .unknown])
    }

    // MARK: - footer

    func testFooterCountsWhatDidNotFit() {
        XCTAssertEqual(B2Layout.footer(mockup, shown: 3), "+ 8 working · 3 done")
    }

    func testFooterSubtractsShownRowsFromCounts() {
        let s = state(A.Counts(working: 5, done: 1), (1...5).map { session("w\($0)", .working) })
        XCTAssertEqual(B2Layout.footer(s, shown: 3), "+ 2 working · 1 done")
        let fits = state(A.Counts(working: 2), [session("w1", .working), session("w2", .working)])
        XCTAssertEqual(B2Layout.footer(fits, shown: 3), "")
    }

    // MARK: - tap

    func testTapOpensFirstWaitingSessionOtherwiseSessionList() {
        XCTAssertEqual(B2Layout.tapURL(mockup).absoluteString, "devbox://session/notes")
        let working = state(A.Counts(working: 1), [session("w1", .working)])
        XCTAssertEqual(B2Layout.tapURL(working).absoluteString, "devbox://sessions")
    }

    // MARK: - rendering

    func testLockScreenCardFitsHeight() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "agent-live-activity-v2", withExtension: "json"))
        let fixture = try JSONDecoder().decode(A.ContentState.self, from: Data(contentsOf: url))
        let threeWaiting = state(A.Counts(waiting: 3, working: 8, done: 3, stalled: 1, unknown: 2), [
            session("a", .waiting, reason: "Should I delete the old migrations or keep them? And the seed data?"),
            session("b", .waiting, reason: "Approve SSH key: infra-root · root@1.2.3.4:22"),
            session("c", .waiting, reason: "Command approval rm -rf node_modules"),
        ], overflow: 8)
        for (name, s) in [("fixture", fixture), ("mockup", mockup), ("3 waiting", threeWaiting)] {
            for width in [320.0, 360.0] {
                for stale in [false, true] {
                    let renderer = ImageRenderer(content: AgentActivityCard(state: s, stale: stale)
                        .frame(width: width)
                        .environment(\.colorScheme, .dark))
                    let image = try XCTUnwrap(renderer.uiImage)
                    XCTAssertLessThanOrEqual(image.size.height, 160,
                        "Content must not overflow into the bottom edge clipped by the system (\(name), \(width) pt, stale \(stale))")
                }
            }
        }
    }

    /// Medium widget (build 20): below the title (~21 pt) the card content must fit the widget height
    /// without margins — on smaller iPhones the medium widget is ~148 pt, i.e. ~116 pt of content → ≤ 95.
    func testMediumWidgetContentFitsHeight() throws {
        let threeWaiting = state(A.Counts(waiting: 3, working: 8, done: 3), [
            session("a", .waiting, reason: "Should I delete the old migrations or keep them? And the seed data?"),
            session("b", .waiting, reason: "Approve SSH key: infra-root · root@1.2.3.4:22"),
            session("c", .waiting, reason: "Command approval rm -rf node_modules"),
        ])
        let fourWorking = state(A.Counts(working: 9, done: 1), (1...6).map { session("w\($0)", .working) })
        XCTAssertEqual(B2Layout.rows(fourWorking, maxRows: B2Layout.mediumRows(fourWorking)).count, 4)
        XCTAssertEqual(B2Layout.mediumRows(threeWaiting), B2Layout.mediumWidgetRows)
        for (name, s) in [("mockup", mockup), ("3 waiting", threeWaiting), ("4 working", fourWorking)] {
            for width in [260.0, 306.0] {
                let renderer = ImageRenderer(content: AgentActivityMediumContent(state: s, stale: false)
                    .frame(width: width)
                    .environment(\.colorScheme, .dark))
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertLessThanOrEqual(image.size.height, 95, "Medium widget overflows (\(name), \(width) pt)")
            }
        }
    }

    /// Row with live time: the time has a fixed width (no `.fixedSize()` on a date Text, build 19
    /// test B), so a long name is truncated and the row never overflows the width.
    func testRowWithElapsedKeepsFixedWidth() throws {
        let long = A.Session(id: "x", title: String(repeating: "long_name_", count: 8), agent: "claude", project: "p",
                             status: .waiting, reason: "?", since: now.addingTimeInterval(-3725))
        let row = try XCTUnwrap(B2Layout.rows(state(A.Counts(waiting: 1), [long]), maxRows: 1).first)
        let renderer = ImageRenderer(content: AgentActivityRow(row: row).frame(width: 300).environment(\.colorScheme, .dark))
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, 300)
        XCTAssertLessThanOrEqual(image.size.height, 40)
        XCTAssertEqual(AgentActivityElapsed.width, 76)
    }
}
