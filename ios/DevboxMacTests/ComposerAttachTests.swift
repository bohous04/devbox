import AppKit
import UniformTypeIdentifiers
import XCTest
@testable import DevboxApp

/// ⌘V in the composer on the Mac: the field editor pastes only text, so an image on the pasteboard is taken by the
/// composer before Edit > Paste sees the key (ComposerPaste). A private pasteboard: the user's clipboard stays as it is.
final class ComposerAttachTests: XCTestCase {
    private var pb: NSPasteboard!

    override func setUp() { pb = NSPasteboard(name: NSPasteboard.Name("devbox-tests-\(UUID().uuidString)")) }
    override func tearDown() { pb.releaseGlobally() }

    func testOnlyPlainCommandVIsThePasteKey() {
        XCTAssertTrue(ComposerPaste.isPasteKey(flags: [.command], key: "v"))
        XCTAssertTrue(ComposerPaste.isPasteKey(flags: [.command, .capsLock], key: "v"), "Caps Lock is not a modifier here")
        XCTAssertFalse(ComposerPaste.isPasteKey(flags: [.command, .shift], key: "v"), "⇧⌘V keeps its own meaning")
        XCTAssertFalse(ComposerPaste.isPasteKey(flags: [.command, .option], key: "v"))
        XCTAssertFalse(ComposerPaste.isPasteKey(flags: [], key: "v"))
        XCTAssertFalse(ComposerPaste.isPasteKey(flags: [.command], key: "c"))
    }

    /// A screenshot copied to the clipboard is image data; text alone is left to the field.
    func testThePasteboardsImagesAreFoundTextIsNot() {
        pb.clearContents()
        pb.setString("hello", forType: .string)
        XCTAssertTrue(ImagePasteboard.providers(in: pb).isEmpty)

        pb.clearContents()
        pb.setData(Data([0x89, 0x50, 0x4e, 0x47]), forType: .png)
        let found = ImagePasteboard.providers(in: pb)
        XCTAssertEqual(found.count, 1)
        XCTAssertTrue(found[0].hasItemConformingToTypeIdentifier(UTType.image.identifier))
    }

    /// ⌘V takes image data only when no text comes with it (a spreadsheet's cells, a rich selection paste as text);
    /// image files copied in Finder, which put their names as text too, are still taken.
    func testCommandVTakesImagesOnlyWithoutText() throws {
        let png = Data([0x89, 0x50, 0x4e, 0x47])
        pb.clearContents()
        pb.setData(png, forType: .png)
        XCTAssertEqual(ComposerPaste.images(in: pb).count, 1, "an image alone")

        pb.clearContents()
        pb.setString("hello", forType: .string)
        XCTAssertTrue(ComposerPaste.images(in: pb).isEmpty, "text alone")

        pb.clearContents()
        pb.declareTypes([.string, .png], owner: nil)
        pb.setString("A1\tB1", forType: .string)
        pb.setData(png, forType: .png)
        XCTAssertTrue(ComposerPaste.images(in: pb).isEmpty, "text and an image: the text")

        pb.clearContents()
        pb.declareTypes([.rtf, .tiff], owner: nil)
        pb.setData(Data("{\\rtf1 x}".utf8), forType: .rtf)
        pb.setData(png, forType: .tiff)
        XCTAssertTrue(ComposerPaste.images(in: pb).isEmpty, "rich text and an image: the text")

        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appending(path: "shot.png")
        try png.write(to: shot)
        pb.clearContents()
        pb.writeObjects([shot as NSURL, "shot.png" as NSString])
        XCTAssertEqual(ComposerPaste.images(in: pb).count, 1, "a Finder copy is an image, its name notwithstanding")
    }

    /// Only an editor inside the composer's area is the composer's focus: not one elsewhere in the window (the
    /// toolbar's search), not a view that is no editor (the terminal), not none.
    @MainActor
    func testOnlyAnEditorInsideTheComposerOwnsTheFocus() {
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let editor = NSTextView(frame: NSRect(x: 10, y: 10, width: 200, height: 30))
        window.contentView!.addSubview(editor)
        XCTAssertTrue(ComposerPaste.ownsFocus(editor, area: NSRect(x: 0, y: 0, width: 400, height: 60)))
        XCTAssertFalse(ComposerPaste.ownsFocus(editor, area: NSRect(x: 0, y: 200, width: 400, height: 60)))
        XCTAssertFalse(ComposerPaste.ownsFocus(window.contentView, area: NSRect(x: 0, y: 0, width: 400, height: 300)))
        XCTAssertFalse(ComposerPaste.ownsFocus(nil, area: NSRect(x: 0, y: 0, width: 400, height: 300)))
    }

    /// Image files copied in Finder are found by their names; a copied pdf is not an image.
    func testCopiedImageFilesAreFoundOtherFilesAreNot() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appending(path: "shot.png"), notes = dir.appending(path: "notes.pdf")
        try Data([1]).write(to: shot)
        try Data([1]).write(to: notes)
        pb.clearContents()
        pb.writeObjects([shot as NSURL, notes as NSURL])
        XCTAssertEqual(ImagePasteboard.providers(in: pb).count, 1)
    }
}
