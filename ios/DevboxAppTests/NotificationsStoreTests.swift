import XCTest
@testable import DevboxApp

/// `MockURLProtocol` is defined in `DevdClientTests.swift` (same test target). The pure functions
/// are a 1:1 port of `dashboard/src/notificationsView.ts` (`groupByTurn`/`promptExcerpt`).
@MainActor
final class NotificationsStoreTests: XCTestCase {
    private let tailnetBase = URL(string: "http://100.100.100.100:4300")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.capturedRequests = []
        MockURLProtocol.handler = nil
    }

    private func makeStore(handler: @escaping (URLRequest) -> MockURLProtocol.Stub) -> NotificationsStore {
        MockURLProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let endpoints = DevdEndpoints(cfBase: nil, cfId: nil, cfSecret: nil, tailnetBase: tailnetBase)
        return NotificationsStore(client: DevdClient(endpoints: endpoints, session: session))
    }

    private func row(
        id: Int, ts: Int = 1000, session: String = "dev-x-y", event: String, decision: NotifyDecision = .none,
        detail: String? = nil, verdict: NotifyVerdict? = nil
    ) -> NotifyLogRow {
        NotifyLogRow(
            id: id, ts: ts, session_id: session, event: event, decision: decision, reason: nil,
            inflight: 0, teammates: 0, agent_session_id: nil, detail: detail,
            verdict: verdict, verdict_note: nil, verdict_at: nil
        )
    }

    // MARK: - groupByTurn

    func testGroupByTurnSplitsOnUserPromptSubmit() {
        let rows = [
            row(id: 3, event: "subagent_stop"),
            row(id: 2, event: "user_prompt_submit"),
            row(id: 1, event: "sweep_done"),
        ]
        let groups = NotificationsStore.groupByTurn(rows)
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].key, "turn-2")
        XCTAssertEqual(groups[0].header?.id, 2)
        XCTAssertEqual(groups[0].rows.map(\.id), [3])
        XCTAssertEqual(groups[1].key, "tail-1")
        XCTAssertNil(groups[1].header)
        XCTAssertEqual(groups[1].rows.map(\.id), [1])
    }

    func testGroupByTurnSplitsOnSessionChangeWithoutPromptDivider() {
        // Two concurrent sessions without a separating prompt — the app must not merge them into one block.
        let rows = [
            row(id: 2, session: "dev-a", event: "subagent_stop"),
            row(id: 1, session: "dev-b", event: "subagent_stop"),
        ]
        let groups = NotificationsStore.groupByTurn(rows)
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].rows.map(\.id), [2])
        XCTAssertEqual(groups[1].rows.map(\.id), [1])
    }

    func testGroupByTurnEmptyRowsIsEmpty() {
        XCTAssertTrue(NotificationsStore.groupByTurn([]).isEmpty)
    }

    // MARK: - promptExcerpt

    func testPromptExcerptReadsPromptField() {
        let r = row(id: 1, event: "user_prompt_submit", detail: #"{"prompt":"do the thing"}"#)
        XCTAssertEqual(NotificationsStore.promptExcerpt(r), "do the thing")
    }

    func testPromptExcerptNilOnMissingOrInvalidDetail() {
        XCTAssertNil(NotificationsStore.promptExcerpt(row(id: 1, event: "x", detail: nil)))
        XCTAssertNil(NotificationsStore.promptExcerpt(row(id: 1, event: "x", detail: "")))
        XCTAssertNil(NotificationsStore.promptExcerpt(row(id: 1, event: "x", detail: "not json")))
        XCTAssertNil(NotificationsStore.promptExcerpt(row(id: 1, event: "x", detail: #"{"other":1}"#)))
    }

    // MARK: - eventLabel / verdictLabels

    func testEventLabelKnownAndUnknown() {
        XCTAssertEqual(NotificationsStore.eventLabel("stop"), "Stop")
        XCTAssertEqual(NotificationsStore.eventLabel("mystery"), "mystery")
    }

    func testVerdictLabelsCoverAllCases() {
        XCTAssertEqual(NotificationsStore.verdictLabels[.falsePositive], "Fired but shouldn't have")
        XCTAssertEqual(NotificationsStore.verdictLabels[.missing], "Should have fired")
        XCTAssertEqual(NotificationsStore.verdictLabels[.ok], "Correct")
    }

    // MARK: - load (cesta + query dle filtru)

    func testLoadAllFilterOmitsVerdictAndDecisionQueryParams() async {
        let store = makeStore { _ in .init(statusCode: 200, data: "[]".data(using: .utf8)!) }
        await store.load(filter: .all)
        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/notify-log")
        let query = req.url?.query ?? ""
        XCTAssertTrue(query.contains("limit=300"))
        XCTAssertFalse(query.contains("verdict="))
        XCTAssertFalse(query.contains("decision="))
    }

    func testLoadSentFilterAddsDecisionSent() async {
        let store = makeStore { _ in .init(statusCode: 200, data: "[]".data(using: .utf8)!) }
        await store.load(filter: .sent)
        let query = MockURLProtocol.capturedRequests[0].url?.query ?? ""
        XCTAssertTrue(query.contains("decision=sent"))
    }

    func testLoadFlaggedFilterAddsVerdictFlagged() async {
        let store = makeStore { _ in .init(statusCode: 200, data: "[]".data(using: .utf8)!) }
        await store.load(filter: .flagged)
        let query = MockURLProtocol.capturedRequests[0].url?.query ?? ""
        XCTAssertTrue(query.contains("verdict=flagged"))
    }

    // MARK: - setVerdict (POST path/body)

    private func bodyJSON(_ request: URLRequest) -> [String: Any] {
        guard let stream = request.httpBodyStream else {
            guard let data = request.httpBody else { return [:] }
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func testSetVerdictPostsIdInPathAndVerdictNoteInBody() async throws {
        let store = makeStore { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }

        try await store.setVerdict(42, verdict: .ok, note: "looked fine")

        let req = MockURLProtocol.capturedRequests[0]
        XCTAssertEqual(req.url?.path, "/api/notify-log/42/verdict")
        XCTAssertEqual(req.httpMethod, "POST")
        let body = bodyJSON(req)
        XCTAssertEqual(body["verdict"] as? String, "ok")
        XCTAssertEqual(body["note"] as? String, "looked fine")
    }

    func testSetVerdictNilClearsFlagAndOmitsNote() async throws {
        let store = makeStore { _ in .init(statusCode: 200, data: "{\"ok\":true}".data(using: .utf8)!) }

        try await store.setVerdict(42, verdict: nil, note: nil)

        let body = bodyJSON(MockURLProtocol.capturedRequests[0])
        XCTAssertNil(body["verdict"])
        XCTAssertNil(body["note"])
    }
}
