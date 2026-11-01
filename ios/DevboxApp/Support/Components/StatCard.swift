import SwiftUI

/// Port of the web `StatCard` (`primitives.tsx`) — label uppercase muted, value mono 2xl semibold,
/// optionally toned (web `tone: "warn" | "ok"`, the app additionally `danger`/`idle` for parity with
/// `StatusTone`). Replaces `Support/StatTile.swift`. `caption` is the web `sub` (second line,
/// `text-xs text-muted-foreground`, e.g. "3 unpushed"); the app does not adopt `unit`/`delta` from the web —
/// the toned delta lives in `MetricCard` on Statistics, the only place where the web shows it.
struct StatCard: View {
    private let label: String
    private let value: String
    private let caption: String?
    private let tone: StatusTone?

    init(label: String, value: String, caption: String? = nil, tone: StatusTone? = nil) {
        self.label = label
        self.value = value
        self.caption = caption
        self.tone = tone
    }

    private var valueColor: Color {
        switch tone {
        case .ok: return Theme.C.okText
        case .warn: return Theme.C.warnText
        case .danger: return Theme.C.dangerText
        case .idle, .none: return Theme.C.foreground
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(Theme.F.statLabel)
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(Theme.C.mutedForeground)
                    .lineLimit(1)
                Text(value)
                    .font(Theme.F.statValue)
                    .foregroundStyle(valueColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let caption {
                    Text(caption)
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.mutedForeground)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            // web `min-h-[96px]` on the whole card = 64 pt of content + 2 × 16 pt `Card` padding. The height
            // belongs inside the card — a `frame` around `Card` would only add empty space below the border.
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
        }
    }
}

#Preview("StatCard") {
    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.S.gridGap) {
        StatCard(label: "Active time", value: "4.2 h")
        StatCard(label: "Cost", value: "$12.40", tone: .ok)
        StatCard(label: "Commits today", value: "3", caption: "2 unpushed", tone: .warn)
        StatCard(label: "Errors", value: "1", tone: .danger)
    }
    .padding()
    .background(Theme.C.background)
}
