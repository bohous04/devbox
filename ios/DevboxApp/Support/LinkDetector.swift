import Foundation
import SwiftUI

/// Web addresses in plain text (a message being typed, a sent prompt, tool output). Only text that starts with
/// http:// or https:// counts: NSDataDetector would also link "README.md" (.md is a country domain).
enum LinkDetector {
    private static let url = try! NSRegularExpression(pattern: #"\bhttps?://[^\s<>]+"#)

    /// UTF-16 ranges of the addresses. Sentence punctuation after one ("…&t=21.") and a closing bracket without
    /// its opening one ("(see https://x.y/z)") are not part of it.
    static func ranges(in s: String) -> [NSRange] {
        let ns = s as NSString
        return url.matches(in: s, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            var end = m.range.location + m.range.length
            while end > m.range.location {
                let last = ns.character(at: end - 1)
                let piece = ns.substring(with: NSRange(location: m.range.location, length: end - m.range.location))
                if let c = Unicode.Scalar(last).map(Character.init), ".,;:!?\"'".contains(c) { end -= 1; continue }
                if last == 0x29, piece.filter({ $0 == "(" }).count < piece.filter({ $0 == ")" }).count { end -= 1; continue }
                break
            }
            let r = NSRange(location: m.range.location, length: end - m.range.location)
            // "https://" alone is not an address.
            return URL(string: ns.substring(with: r))?.host == nil ? nil : r
        }
    }

    /// The text as typed with its addresses linked, in the link colour.
    static func attributed(_ s: String) -> AttributedString {
        var a = AttributedString(s)
        for r in ranges(in: s) {
            guard let sr = Range(r, in: s), let ar = Range(sr, in: a), let link = URL(string: String(s[sr])) else { continue }
            a[ar].link = link
            a[ar].foregroundColor = Theme.C.link
        }
        return a
    }
}
