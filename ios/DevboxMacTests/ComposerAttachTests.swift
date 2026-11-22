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
