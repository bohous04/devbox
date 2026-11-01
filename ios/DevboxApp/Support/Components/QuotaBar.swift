import SwiftUI

/// Port of the web `QuotaBar` (`components/QuotaBar.tsx`) — replaces `UsageRing` and the disk
/// `ProgressView` (Task 11 wires them into screens). `pct` is a fraction 0–1 (not a percentage as on the
/// web) — easier to compose with a `ProgressView`-like API and with the `tone(for:)` test (`0.9 → warn`).
/// `pct: nil` = not measured: a dash instead of a percentage and an empty bar (zero would falsely claim "nothing
/// used", the web likewise draws `—`).
struct QuotaBar: View {
    private let label: String
    private let pct: Double?
    private let caption: String?
    private let warnAt: Double

    /// `warnAt` is the fraction from which the bar turns amber — default 0.9 like the web `QuotaBar`
    /// (AI limits); disk (`StorageSummary`) passes `diskWarnPercent / 100`.
    init(label: String, pct: Double?, caption: String?, warnAt: Double = 0.9) {
        self.warnAt = warnAt
        self.label = label
        self.pct = pct
        self.caption = caption
    }

    /// `>= warnAt` is amber-500 (web `percent >= 90 ? bg-amber-500 : bg-primary`, disk
    /// `percent >= warning`), otherwise `nil` (the fill stays `primary`).
    static func tone(for pct: Double, warnAt: Double = 0.9) -> StatusTone? {
        pct >= warnAt ? .warn : nil
    }

    private var clamped: Double { min(1, max(0, pct ?? 0)) }

    private var fillColor: Color {
        if let pct, QuotaBar.tone(for: pct, warnAt: warnAt) == .warn { return Theme.C.warn }
        return Theme.C.primary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Text(pct == nil ? "—" : "\(Int((clamped * 100).rounded()))%")
                    .font(.system(size: 20, weight: .semibold))
                    .monospacedDigit()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.C.muted)
                    Capsule()
                        .fill(fillColor)
                        .frame(width: geo.size.width * clamped)
                }
            }
            .frame(height: 6)
            .padding(.vertical, 12)
            if let caption {
                Text(caption)
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
        .padding(Theme.S.cardPadding)
        .background(Theme.C.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous))
    }
}

#Preview("QuotaBar") {
    VStack(spacing: 12) {
        QuotaBar(label: "Weekly allowance", pct: 0.42, caption: "resets in 3 days")
        QuotaBar(label: "Weekly allowance", pct: 0.93, caption: "resets in 3 days")
        QuotaBar(label: "Weekly allowance", pct: 0, caption: "No weekly measurement available")
    }
    .padding()
    .background(Theme.C.background)
}
