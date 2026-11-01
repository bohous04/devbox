import Foundation

/// Formatting helpers for StatGrid and session detail — 1:1 port of `dashboard/src/format.ts`.
/// Exact inputs/outputs are verified against `dashboard/src/format.test.ts` (see `FormatTests`).
enum Format {
    /// "1.5 GB" · "2.0 kB" — humanized bytes (divides by 1000, not 1024, same as the web).
    static func bytes(_ n: Double) -> String {
        let units = ["B", "kB", "MB", "GB", "TB"]
        var i = 0
        var v = n
        while v >= 1000 && i < units.count - 1 {
            v /= 1000
            i += 1
        }
        return String(format: "%.1f %@", v, units[i])
    }

    /// "$12.50" — price in USD (the dashboard does no currency conversion, just two decimal places).
    static func usd(_ amount: Double) -> String {
        String(format: "$%.2f", amount)
    }

    /// State without emoji (the app draws the LED itself, see StatusDot on the web). `.unknown` (tolerant
    /// decoding fallback — an unknown value from the server) is shown as "idle", the least
    /// alarming variant.
    static func stateLabel(_ s: ClaudeState) -> String {
        switch s {
        case .working: return "working"
        case .waiting: return "waiting"
        case .idle, .unknown: return "idle"
        }
    }

    /// Truncates to one decimal place and drops a needless ".0" — helper for `compactNumber`.
    private static func trimmed(_ v: Double) -> String {
        let s = v >= 100 ? String(Int(v.rounded())) : String(format: "%.1f", v)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }

    /// Compact number: 534 · 12.5 k · 1.2 M · 2.4 B.
    static func compactNumber(_ n: Double) -> String {
        let magnitude = abs(n)
        let sign = n < 0 ? "-" : ""
        if magnitude < 1000 { return sign + String(Int(magnitude.rounded())) }
        if magnitude < 1_000_000 { return "\(sign)\(trimmed(magnitude / 1000)) k" }
        if magnitude < 1_000_000_000 { return "\(sign)\(trimmed(magnitude / 1_000_000)) M" }
        return "\(sign)\(trimmed(magnitude / 1_000_000_000)) B"
    }

    /// Duration in ms → "45 s" · "12 min" · "2 h 14 min" · "26 h" · "3 d 4 h".
    static func durationLabel(_ ms: Double) -> String {
        let s = max(0, Int(floor(ms / 1000)))
        if s < 60 { return "\(s) s" }
        let min = s / 60
        if min < 60 { return "\(min) min" }
        let h = min / 60
        if h < 48 {
            let rem = min % 60
            return rem > 0 && h < 10 ? "\(h) h \(rem) min" : "\(h) h"
        }
        let d = h / 24
        let remH = h % 24
        return remH > 0 ? "\(d) d \(remH) h" : "\(d) d"
    }

    /// Elapsed time in ms → "3 s ago" · "12 min ago" · "2 h ago" · "3 d ago".
    static func agoLabel(_ ms: Double) -> String {
        let s = max(0, Int(floor(ms / 1000)))
        if s < 60 { return "\(s) s ago" }
        let min = s / 60
        if min < 60 { return "\(min) min ago" }
        let h = min / 60
        if h < 24 { return "\(h) h ago" }
        return "\(h / 24) d ago"
    }
}
