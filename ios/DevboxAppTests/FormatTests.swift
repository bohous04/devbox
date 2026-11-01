import XCTest
@testable import DevboxApp

/// Inputs/outputs copied from `dashboard/src/format.test.ts` — the same inputs must give the same
/// strings as the web.
final class FormatTests: XCTestCase {
    func testBytesHumanizes() {
        XCTAssertEqual(Format.bytes(1_500_000_000), "1.5 GB")
        XCTAssertEqual(Format.bytes(2048), "2.0 kB")
    }

    func testUsd() {
        XCTAssertEqual(Format.usd(12.5), "$12.50")
        XCTAssertEqual(Format.usd(0), "$0.00")
    }

    func testStateLabelWithoutEmoji() {
        XCTAssertEqual(Format.stateLabel(.working), "working")
        XCTAssertEqual(Format.stateLabel(.waiting), "waiting")
        XCTAssertEqual(Format.stateLabel(.idle), "idle")
        XCTAssertEqual(Format.stateLabel(.unknown), "idle")
    }

    func testCompactNumber() {
        XCTAssertEqual(Format.compactNumber(534), "534")
        XCTAssertEqual(Format.compactNumber(12_500), "12.5 k")
        XCTAssertEqual(Format.compactNumber(1_200_000), "1.2 M")
        XCTAssertEqual(Format.compactNumber(2_400_000_000), "2.4 B")
        XCTAssertEqual(Format.compactNumber(150_000), "150 k")
        XCTAssertEqual(Format.compactNumber(1000), "1 k")
    }

    func testDurationLabel() {
        XCTAssertEqual(Format.durationLabel(45_000), "45 s")
        XCTAssertEqual(Format.durationLabel(12 * 60_000), "12 min")
        XCTAssertEqual(Format.durationLabel((2 * 60 + 14) * 60_000), "2 h 14 min")
        XCTAssertEqual(Format.durationLabel(3 * 3_600_000), "3 h")
        XCTAssertEqual(Format.durationLabel((26 * 60 + 10) * 60_000), "26 h")
        XCTAssertEqual(Format.durationLabel((3 * 24 + 4) * 3_600_000), "3 d 4 h")
        XCTAssertEqual(Format.durationLabel(-5), "0 s")
    }

    func testAgoLabel() {
        XCTAssertEqual(Format.agoLabel(3_000), "3 s ago")
        XCTAssertEqual(Format.agoLabel(2 * 60_000), "2 min ago")
        XCTAssertEqual(Format.agoLabel(5 * 3_600_000), "5 h ago")
        XCTAssertEqual(Format.agoLabel(49 * 3_600_000), "2 d ago")
    }
}
