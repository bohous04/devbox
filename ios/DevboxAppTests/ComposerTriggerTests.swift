import XCTest
@testable import DevboxApp

/// shared/fixtures/composer-triggers.json: the cases the web composer (dashboard/src/composerTrigger.ts) runs too.
final class ComposerTriggerTests: XCTestCase {
    private struct Trig: Decodable, Equatable { let kind: String; let query: String; let start: Int; let end: Int }
    private struct Key: Decodable { let key: String; let shiftKey, altKey, ctrlKey, metaKey, isComposing: Bool; let keyCode: Int }
    private struct Menu: Decodable { let options: Int; let searching: Bool; let exact: Bool }
    private struct Fixture: Decodable {
        struct Active: Decodable { let text: String; let caret: Int; let expected: Trig? }
        struct Filter: Decodable { let commands: [AgentCommand]; let cases: [FilterCase] }
        struct FilterCase: Decodable { let query: String; let expected: [String] }
        struct Pick: Decodable { struct Out: Decodable { let text: String; let caret: Int }; let text: String; let trigger: Trig; let value: String; let expected: Out }
        struct Placeholder: Decodable { let running, commands, files: Bool; let expected: String }
        struct KeyCase: Decodable { let menu: Menu?; let key: Key; let enterSends: Bool; let expected: String }
        let active: [Active]
        let filter: Filter
        let pick: [Pick]
        let placeholder: [Placeholder]
        let keyAction: [KeyCase]
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "composer-triggers", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private static func trig(_ t: ComposerTrigger?) -> Trig? { t.map { Trig(kind: $0.kind.rawValue, query: $0.query, start: $0.start, end: $0.end) } }

    func testActiveTrigger() throws {
        for c in try fixture().active {
            XCTAssertEqual(Self.trig(ComposerTriggers.active(c.text, caret: c.caret)), c.expected, "\(c.text) @\(c.caret)")
        }
    }

    func testFilterCommands() throws {
        let f = try fixture().filter
        for c in f.cases { XCTAssertEqual(ComposerTriggers.filter(f.commands, c.query).map(\.name), c.expected, c.query) }
    }

    func testPick() throws {
        for c in try fixture().pick {
            let t = ComposerTrigger(kind: try XCTUnwrap(.init(rawValue: c.trigger.kind)), query: c.trigger.query, start: c.trigger.start, end: c.trigger.end)
            let r = ComposerTriggers.pick(c.text, t, c.value)
            XCTAssertEqual(r.text, c.expected.text, c.text)
            XCTAssertEqual(r.caret, c.expected.caret, c.text)
        }
    }

    func testPlaceholder() throws {
        for c in try fixture().placeholder {
            XCTAssertEqual(ComposerTriggers.placeholder(running: c.running, commands: c.commands, files: c.files), c.expected)
        }
    }

    /// The web's keyCode 229 (an IME's key) is the apps' `composing`, like isComposing.
    func testKeyAction() throws {
        for c in try fixture().keyAction {
            let k = TriggerKey(key: c.key.key, shift: c.key.shiftKey, alt: c.key.altKey, ctrl: c.key.ctrlKey, meta: c.key.metaKey,
                               composing: c.key.isComposing || c.key.keyCode == 229)
            let m = c.menu.map { TriggerMenuState(options: $0.options, searching: $0.searching, exact: $0.exact) }
            XCTAssertEqual(ComposerTriggers.keyAction(m, k, enterSends: c.enterSends).rawValue, c.expected, "\(String(describing: c.menu)) \(c.key)")
        }
    }

    /// What the open menu shows for each state of the file search, and the commands' rows.
    func testMenuModel() {
        let at = ComposerTrigger(kind: .at, query: "ma", start: 0, end: 3)
        let files = SessionFiles(files: ["src/main.ts"], more: nil, listingCapped: nil)
        XCTAssertEqual(TriggerMenuModel.make(at, commands: [], files: nil).status, "Searching…")
        let stale = TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "m", files: files))
        XCTAssertTrue(stale.searching)
        XCTAssertEqual(stale.options.map(\.value), ["src/main.ts"], "an older answer stays listed")
        XCTAssertFalse(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "ma", files: files)).searching)
        XCTAssertNil(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "ma", files: files)).status)
        XCTAssertEqual(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "ma", error: "boom")).status, "File search failed: boom")
        XCTAssertEqual(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "ma", files: SessionFiles(files: []))).status, "No matching file")
        var more = files; more.more = true
        XCTAssertEqual(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "ma", files: more)).status, "More files match: type more of the name")
        var capped = files; capped.listingCapped = true
        XCTAssertEqual(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "ma", files: capped)).status,
                       "Only part of this large repository was searched")
        let slash = ComposerTrigger(kind: .slash, query: "x", start: 0, end: 2)
        XCTAssertEqual(TriggerMenuModel.make(slash, commands: [AgentCommand(name: "review")], files: nil).status, "No matching command")
        let rows = TriggerMenuModel.make(ComposerTrigger(kind: .slash, query: "", start: 0, end: 1),
                                         commands: [AgentCommand(name: "review", description: nil, hint: "[pr]")], files: nil)
        XCTAssertEqual(rows.options, [TriggerOption(value: "review", label: "/review", detail: "[pr]")])
    }

    /// The snapshot reads the commands, and a list of the wrong shape is none, not a thread that fails to load.
    func testSnapshotCommands() throws {
        let base = #"{"lastSeq":1,"seenSeq":1,"runs":[],"items":[],"pending":[],"background":[],"native":null"#
        let ok = try JSONDecoder().decode(ThreadSnapshot.self, from: Data((base + #","commands":[{"name":"review","description":"Review"}]}"#).utf8))
        XCTAssertEqual(ok.commands, [AgentCommand(name: "review", description: "Review", hint: nil)])
        let bad = try JSONDecoder().decode(ThreadSnapshot.self, from: Data((base + #","commands":"review"}"#).utf8))
        XCTAssertNil(bad.commands)
        XCTAssertNil(try JSONDecoder().decode(ThreadSnapshot.self, from: Data((base + "}").utf8)).commands)
        // A later snapshot keeps the commands it brings.
        XCTAssertEqual(ThreadView.mergeSnapshot(.empty, ThreadSnapshotFrame(afterSeq: 0, snapshot: ok)).commands, ok.commands)
        XCTAssertNil(ThreadView.applyCommands(ok, nil).commands)
    }

    /// Without the system's caret: an edit at the end keeps it there, any other makes it unknown (no menu).
    func testCaretAfterEdit() {
        XCTAssertEqual(ComposerTriggers.caretAfterEdit(from: "", to: "/"), 1)
        XCTAssertEqual(ComposerTriggers.caretAfterEdit(from: "see @sy", to: "see @syn"), 8)
        XCTAssertEqual(ComposerTriggers.caretAfterEdit(from: "see @syn", to: "see @sy"), 7, "a deletion at the end")
        XCTAssertEqual(ComposerTriggers.caretAfterEdit(from: "hi 👋", to: "hi 👋 @"), 7, "UTF-16")
        XCTAssertNil(ComposerTriggers.caretAfterEdit(from: "see @sy", to: "xsee @sy"), "typed at the start")
        XCTAssertEqual(ComposerTriggers.caretAfterEdit(from: "/co", to: "/compact "), 9, "a pick at the end")
        XCTAssertNil(ComposerTriggers.caretAfterEdit(from: "/co rest", to: "/compact rest"), "a pick before more text")
        XCTAssertNil(ComposerTriggers.caretAfterEdit(from: "@a and", to: "@ab and"), "typed in the middle")
    }

    func testAnnouncement() {
        let slash = ComposerTrigger(kind: .slash, query: "", start: 0, end: 1)
        XCTAssertEqual(ComposerTriggers.announcement(TriggerMenuModel.make(slash, commands: [AgentCommand(name: "a"), AgentCommand(name: "b")], files: nil)),
                       "2 commands")
        let at = ComposerTrigger(kind: .at, query: "x", start: 0, end: 2)
        XCTAssertNil(ComposerTriggers.announcement(TriggerMenuModel.make(at, commands: [], files: nil)),
                     "a search on its way says nothing: it would talk over each typed letter")
        XCTAssertNil(ComposerTriggers.announcement(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "", files: SessionFiles(files: ["x.ts"])))),
                     "an older query's results while the next one runs")
        XCTAssertEqual(ComposerTriggers.announcement(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "x", files: SessionFiles(files: ["x.ts"])))),
                       "1 file")
        XCTAssertEqual(ComposerTriggers.announcement(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "x", files: SessionFiles(files: ["x.ts", "y.ts"])))),
                       "2 files")
        XCTAssertEqual(ComposerTriggers.announcement(TriggerMenuModel.make(slash, commands: [AgentCommand(name: "a")], files: nil)), "1 command")
        XCTAssertEqual(ComposerTriggers.announcement(TriggerMenuModel.make(at, commands: [], files: FileSearchResult(query: "x", files: SessionFiles(files: [])))),
                       "No matching file")
    }

    /// A `thread-commands` frame of the wrong shape is none, as in the snapshot, not an unreadable-update error.
    func testCommandsFrame() {
        XCTAssertEqual(ThreadView.commands(from: Data(#"[{"name":"review"}]"#.utf8)), [AgentCommand(name: "review")])
        XCTAssertNil(ThreadView.commands(from: Data("null".utf8)))
        XCTAssertNil(ThreadView.commands(from: Data(#"{"name":"review"}"#.utf8)))
    }

    #if os(iOS)
    /// Marked text in the focused field (an input method composing) is what keyAction's `composing` reads.
    @MainActor
    func testComposingReadsTheFirstRespondersMarkedText() throws {
        // In the host app's scene, as the composer is: a window outside it is not on the responder chain's way.
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene, "the test host has no scene")
        let window = UIWindow(windowScene: scene)
        let field = UITextField(frame: CGRect(x: 0, y: 0, width: 300, height: 40))
        window.addSubview(field)
        window.makeKeyAndVisible()
        defer { field.resignFirstResponder(); window.isHidden = true }
        XCTAssertTrue(field.becomeFirstResponder())
        XCTAssertFalse(ComposerView.composing)
        field.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
        XCTAssertTrue(ComposerView.composing)
        field.unmarkText()
        XCTAssertFalse(ComposerView.composing)
    }
    #endif
}
