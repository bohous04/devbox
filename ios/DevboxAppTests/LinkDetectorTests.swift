import XCTest
@testable import DevboxApp

final class LinkDetectorTests: XCTestCase {
    private func found(_ s: String) -> [String] {
        LinkDetector.ranges(in: s).map { (s as NSString).substring(with: $0) }
    }

    func testQueryStringIsKeptAndTheSentencePeriodIsNot() {
        XCTAssertEqual(found("look https://youtu.be/abc?si=x&t=21."), ["https://youtu.be/abc?si=x&t=21"])
        XCTAssertEqual(found("a https://x.y/z, b"), ["https://x.y/z"])
    }

    func testSeveralAddressesAndAnUnopenedBracket() {
        XCTAssertEqual(found("(see https://x.y/z) and http://a.b/c_(d)"), ["https://x.y/z", "http://a.b/c_(d)"])
    }

    func testOnlyWebAddressesWithAScheme() {
        XCTAssertEqual(found("README.md example.com ftp://x.y https://"), [])
    }

    func testRangesAreUTF16WithEmojiBefore() {
        let s = "😀 https://x.y/z"
        XCTAssertEqual(LinkDetector.ranges(in: s), [NSRange(location: 3, length: 13)])
    }

    func testAttributedKeepsTheTextAndLinksTheAddress() {
        let s = "go to https://x.y/z?a=1. now"
        let a = LinkDetector.attributed(s)
        XCTAssertEqual(String(a.characters), s)
        XCTAssertEqual(a.runs.compactMap(\.link), [URL(string: "https://x.y/z?a=1")!])
    }
}
