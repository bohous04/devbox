import SwiftUI

/// Design tokens following the web (`dashboard/src/index.css` zinc palette, `primitives.tsx`,
/// `ui/card.tsx`/`ui/button.tsx`/`ui/badge.tsx`). Hex values are in
/// the internal design notes appendix A — the colours themselves live
/// in the asset catalog (`Assets.xcassets/Theme/*.colorset`, light/dark), this enum is only
/// typed access to them + dimensions/typography that the web keeps in Tailwind classes.
enum Theme {
    /// Colours — each name corresponds 1:1 to a colorset in `Assets.xcassets/Theme/`.
    enum C {
        static let background = Color("background")
        static let foreground = Color("foreground")
        static let card = Color("card")
        static let primary = Color("primary")
        static let primaryForeground = Color("primaryForeground")
        static let muted = Color("muted")
        static let mutedForeground = Color("mutedForeground")
        static let border = Color("border")
        static let destructive = Color("destructive")

        // Status (dots/bars/gauge) — fixed shades, the same in light and dark (emerald-500 etc.).
        static let ok = Color("ok")
        static let warn = Color("warn")
        static let danger = Color("danger")
        static let idle = Color("idle")

        // Text variants of the same states (emerald-600/400, amber-600/400, red-600/400).
        static let okText = Color("okText")
        static let warnText = Color("warnText")
        static let dangerText = Color("dangerText")

        /// `--chart-1`…`--chart-5`, in the order from the web.
        static let chart: [Color] = (1...5).map { Color("chart\($0)") }
        /// Account palette (`accountsView`/Stats page) — fixed, independent of the colour scheme.
        static let accounts: [Color] = (1...5).map { Color("account\($0)") }
    }

    /// `--radius-sm/md/lg/xl` (the web's `rounded-*`).
    enum R {
        static let sm: CGFloat = 6
        static let md: CGFloat = 8
        static let lg: CGFloat = 10
        static let xl: CGFloat = 14
    }

    /// Typography — size/weight following the web; uppercase and tracking (sectionLabel/statLabel/badge)
    /// are set by the caller via `.textCase`/`.tracking`, Font itself cannot do tracking.
    enum F {
        static let pageTitle = Font.system(size: 24, weight: .semibold)
        static let sectionLabel = Font.system(size: 12, weight: .medium)
        static let statValue = Font.system(size: 24, weight: .semibold, design: .monospaced)
        static let statLabel = Font.system(size: 12, weight: .medium)
        static let body = Font.system(size: 14)
        static let meta = Font.system(size: 12)
        static let badge = Font.system(size: 12, weight: .medium)
    }

    /// Spacing — `p-4` (cards), `gap-3`ish grids, sections, screen margin.
    enum S {
        static let cardPadding: CGFloat = 16
        static let gridGap: CGFloat = 12
        static let sectionGap: CGFloat = 20
        static let screenPadding: CGFloat = 16
    }
}
