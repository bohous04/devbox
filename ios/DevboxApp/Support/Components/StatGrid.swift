import SwiftUI

/// Port of the web `StatGrid` (`primitives.tsx`) — a strip of metrics with a fixed cell height (58 px on
/// the web), a grid with border/dividers on a `muted/40` background. Instead of fixed `grid-cols-2/3/5`
/// per breakpoint the app uses `.adaptive`, because a phone has no web breakpoints.
struct StatGrid: View {
    private let items: [(label: String, value: String)]

    init(_ items: [(label: String, value: String)]) {
        self.items = items
    }

    private let columns = [GridItem(.adaptive(minimum: 68), spacing: 0)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(spacing: 2) {
                    Text(item.label)
                        .font(.system(size: 9.5, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(0.4)
                        .foregroundStyle(Theme.C.mutedForeground)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(item.value)
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .frame(height: 58)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
                .overlay(Rectangle().fill(Theme.C.border).frame(width: 1), alignment: .trailing)
                .overlay(Rectangle().fill(Theme.C.border).frame(height: 1), alignment: .bottom)
            }
        }
        .background(Theme.C.muted.opacity(0.4))
        .clipShape(RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous)
                .strokeBorder(Theme.C.border, lineWidth: 1)
        )
    }
}

#Preview("StatGrid") {
    StatGrid([
        (label: "Uptime", value: "3d 4h"),
        (label: "CPU", value: "12%"),
        (label: "RAM", value: "1.2G"),
        (label: "Tokens", value: "48k"),
        (label: "Cost", value: "$3.10"),
    ])
    .padding()
    .background(Theme.C.background)
}
