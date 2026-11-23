import XCTest
@testable import DevboxApp

/// The thread's layout logic (WorkGroups.swift, ChatMarkdownParse.swift), the same rules as the dashboard's
/// workGroups.test.ts, threadTitle.test.ts and markdown.test.ts.
final class ChatLayoutTests: XCTestCase {
    private func item(_ seq: Int, _ run: String?, _ kind: ThreadItem.Kind, text: String = "", tool: String? = nil,
                      input: JSONValue? = nil, isError: Bool? = nil) -> ThreadItem {
        ThreadItem(seq: seq, runId: run, itemId: "\(seq)", kind: kind, text: text, tool: tool, input: input, output: nil,
                   isError: isError, status: .done, attachments: nil, ts: seq)
    }

    private func run(_ id: String, _ status: RunRow.Status, start: Int? = 1_000, end: Int? = 135_000) -> RunRow {
        RunRow(runId: id, origin: .user, status: status, harness: nil, nativeThreadId: nil, model: nil, queuedAt: nil,
               startedAt: start, endedAt: end, endedSeq: nil, usage: nil, error: nil)
    }

    private func chatRows(_ items: [ThreadItem]) -> [ChatRow] {
        items.enumerated().map { ChatRow(id: $0, item: $1, pending: nil, queued: false, critic: false) }
    }

    private func shape(_ rows: [ThreadDisplayRow]) -> [String] {
        rows.map {
            switch $0 {
            case .item(let r, let answer): return "\(r.item.seq)\(answer ? "*" : "")"
            case .work(let w): return "work[\(w.items.map { String($0.item.seq) }.joined(separator: ","))]"
            }
        }
    }

    /// A run only partly loaded (ThreadView.tailView) stays expanded; the others still fold (workGroups.test.ts).
    func testPartlyLoadedRunDoesNotFold() {
        let items = [item(1, "a", .tool, tool: "Bash"), item(2, "a", .assistant), item(3, "b", .user), item(4, "b", .tool, tool: "Bash"),
                     item(5, "b", .assistant)]
        let rows = WorkGroups.rows(chatRows(items), runs: [run("a", .completed), run("b", .completed)], partialRun: "a")
        XCTAssertEqual(shape(rows), ["1", "2", "3", "work[4]", "5*"])
    }

    /// threadView.test.ts "tailView": a cut thread starts at its first whole run; a run that fills the page stays.
    func testTailViewStartsAtTheFirstWholeRun() {
        let rows = chatRows([item(1, "r1", .tool), item(2, nil, .notice), item(3, "r1", .assistant), item(4, "r2", .user), item(5, "r2", .tool)])
        XCTAssertEqual(ThreadView.tailView(rows, hasOlder: true).rows.map(\.item.seq), [4, 5])
        XCTAssertNil(ThreadView.tailView(rows, hasOlder: true).partialRun)
        XCTAssertEqual(ThreadView.tailView(rows, hasOlder: false).rows.map(\.item.seq), [1, 2, 3, 4, 5])
        let one = chatRows([item(1, "r1", .tool), item(2, "r1", .tool)])
        XCTAssertEqual(ThreadView.tailView(one, hasOlder: true).rows.map(\.item.seq), [1, 2])
        XCTAssertEqual(ThreadView.tailView(one, hasOlder: true).partialRun, "r1")
        XCTAssertNil(ThreadView.tailView(chatRows([item(1, nil, .notice)]), hasOlder: true).partialRun)
    }

    /// threadView.test.ts "prependOlder": the page goes in front, the boundary items already here are dropped.
    func testPrependOlderDropsTheBoundaryItemsAlreadyHere() {
        var notice = item(5, nil, .notice)
        notice.itemId = "notice:1"
        var t = ThreadSnapshot(lastSeq: 9, seenSeq: 0, runs: [], items: [notice, item(6, "r2", .user)], pending: [], background: [], native: nil)
        t.topic = "Fix it"
        XCTAssertEqual(ThreadView.olderBeforeSeq(t), 6)
        XCTAssertNil(ThreadView.olderBeforeSeq(.empty))
        let n = ThreadView.prependOlder(t, [item(3, "r1", .user), item(5, "r1", .tool), notice])
        XCTAssertEqual(n.items.map { "\($0.seq):\($0.itemId ?? "-")" }, ["3:3", "5:5", "5:notice:1", "6:6"])
        XCTAssertEqual(n.lastSeq, 9)
        XCTAssertEqual(n.topic, "Fix it")
        XCTAssertFalse(ThreadView.hasOlder(t))
        XCTAssertTrue(ThreadView.hasOlder(ThreadSnapshot(lastSeq: 0, seenSeq: 0, runs: [], items: (1...ThreadView.pageSize).map { item($0, "r", .tool) },
                                                         pending: [], background: [], native: nil)))
        // Stream frames carry no topic: a merge keeps the one the GET named.
        let merged = ThreadView.mergeSnapshot(t, ThreadSnapshotFrame(afterSeq: 9, snapshot: .empty))
        XCTAssertEqual(merged.topic, "Fix it")
    }

    func testFinishedRunFoldsItsToolsAndProseAboveTheAnswer() {
        let items = [
            item(1, "a", .user), item(2, "a", .assistant), item(3, "a", .tool, tool: "Bash"),
            item(4, nil, .notice), item(5, "a", .tool, tool: "Bash"), item(6, "a", .assistant),
        ]
        let rows = WorkGroups.rows(chatRows(items), runs: [run("a", .completed)])
        XCTAssertEqual(shape(rows), ["1", "work[2,3,5]", "4", "6*"])
        guard case .work(let w) = rows[1] else { return XCTFail() }
        XCTAssertEqual(WorkGroups.label(w), "Worked for 2m 14s")
    }

    func testRunningRunAndRunWithoutToolsStayExpanded() {
        let items = [item(1, "a", .user), item(2, "a", .assistant), item(3, "b", .user), item(4, "b", .tool, tool: "Bash"), item(5, "b", .assistant)]
        let rows = WorkGroups.rows(chatRows(items), runs: [run("a", .completed), run("b", .running, end: nil)])
        XCTAssertEqual(shape(rows), ["1", "2*", "3", "4", "5"])
    }

    /// A prompt opens a turn (more room above it) unless it is the first row or follows a notice.
    func testTurnStarts() {
        let items = [item(1, "a", .user), item(2, "a", .assistant), item(3, "b", .user), item(4, nil, .notice), item(5, "c", .user)]
        let rows = WorkGroups.rows(chatRows(items), runs: [run("a", .completed), run("b", .completed), run("c", .completed)])
        XCTAssertEqual(WorkGroups.turnStarts(rows), [ThreadDisplayRow.itemId(2)])
    }

    func testLabelsAndSummary() {
        XCTAssertEqual(WorkGroups.shortDuration(45_000), "45s")
        XCTAssertEqual(WorkGroups.shortDuration(3_900_000), "1h 5m")
        XCTAssertEqual(WorkGroups.label(WorkRow(runId: "a", status: .interrupted, durationMs: 5_000, items: [])), "Stopped after 5s")
        XCTAssertEqual(WorkGroups.label(WorkRow(runId: "a", status: .failed, durationMs: nil, items: [])), "Failed")
        let tools = [
            item(1, "a", .tool, tool: "Bash", input: .object(["command": .string("bun test")])),
            item(2, "a", .tool, tool: "Bash", isError: true), item(3, "a", .tool, tool: "Edit"), item(4, "a", .tool, tool: "mcp__docs__search"),
        ]
        XCTAssertEqual(WorkGroups.summary(tools), "2 commands · 1 edit · 1 other tool")
        XCTAssertEqual(WorkGroups.failures(tools), 1)
    }

    func testToolLabels() {
        XCTAssertEqual(ToolLabel("Bash", .object(["command": .string("bun test\nmore")])), ToolLabel(kind: .command, verb: "Ran", target: "bun test", code: true))
        XCTAssertEqual(ToolLabel("Read", .object(["file_path": .string("src/sync/queue.ts")])).target, "queue.ts")
        XCTAssertEqual(ToolLabel("command", .string("ls -la")).target, "ls -la")
        XCTAssertEqual(ToolLabel("fileChange", .array([.object(["path": .string("a/b.ts")]), .object(["path": .string("c.ts")])])).target, "2 files")
        XCTAssertEqual(ToolLabel("mcp__docs__search", .object(["q": .string("x")])).verb, "docs · search")
    }

    /// shared/fixtures/thread-titles.json: the cases devd's inbox `topic` (shared/threadTitle.ts) runs too.
    func testThreadTitle() throws {
        struct Case: Decodable { let message: String; let title: String? }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "thread-titles", withExtension: "json"))
        for c in try JSONDecoder().decode([Case].self, from: Data(contentsOf: url)) {
            XCTAssertEqual(ThreadTitle.from(c.message), c.title, c.message)
        }
    }

    func testMarkdownBlocks() {
        let md = "Did it.\n\n- **Order:** oldest first\n- **Empty:** nothing\n  wrapped\n\n| Check | Result |\n| --- | --- |\n| `a \\| b` | ✅ ok |\n| c | ❌ no |\n\n```\nlet x = 1\n```\n## Next\n1. one\n2. two"
        XCTAssertEqual(ChatMarkdownParse.blocks(md), [
            .paragraph("Did it."),
            .bullets(["**Order:** oldest first", "**Empty:** nothing wrapped"]),
            .table(header: ["Check", "Result"], rows: [["`a | b`", "✅ ok"], ["c", "❌ no"]]),
            .code("let x = 1"),
            .heading(level: 2, "Next"),
            .numbered(start: 1, ["one", "two"]),
        ])
    }

    func testBareLinksAndStatusIcons() {
        XCTAssertEqual(ChatMarkdownParse.linkBareURLs("See https://example.com/docs/sync. Or `https://x.y/z` or [d](https://e.f)"),
                       "See [https://example.com/docs/sync](https://example.com/docs/sync). Or `https://x.y/z` or [d](https://e.f)")
        XCTAssertEqual(ChatMarkdownParse.statusParts("✅ 6 pass, ❌ 1"), [.status(.pass), .text(" 6 pass, "), .status(.fail), .text(" 1")])
        XCTAssertEqual(ChatMarkdownParse.statusParts("⚠️ slow"), [.status(.warn), .text(" slow")])
    }
}

extension ChatLayoutTests {
    func testModelLabel() {
        XCTAssertEqual(ChatSwitch.modelLabel("claude-opus-5-5"), "Opus 5.5")
        // The iPhone's one-row chip: the family alone; an unknown id stays whole (the chip cuts it).
        XCTAssertEqual(ChatSwitch.shortModelLabel("claude-opus-5-5-high"), "Opus")
        XCTAssertEqual(ChatSwitch.shortModelLabel("gpt-6.1-sol"), "GPT-6.1")
        XCTAssertEqual(ChatSwitch.shortModelLabel("mistral-medium-latest"), "Mistral")
        XCTAssertEqual(ChatSwitch.shortModelLabel("my custom model"), "my custom model")
        XCTAssertEqual(ChatSwitch.modelLabel("claude-opus-5-5-high"), "Opus 5.5 High")
        XCTAssertEqual(ChatSwitch.modelLabel("claude-sonnet-4-20250514"), "Sonnet 4")
        XCTAssertEqual(ChatSwitch.modelLabel("gpt-6.1-sol"), "GPT-6.1 Sol")
        XCTAssertEqual(ChatSwitch.modelLabel("mistral-medium-latest"), "Mistral Medium 3.5")
        XCTAssertEqual(ChatSwitch.modelLabel("llama-x"), "llama-x")
    }
}
