import SwiftUI

/// Port of the web `Card` (`ui/card.tsx`) + `CardContent` padding — on the web Card is a pure container
/// (`rounded-xl border bg-card shadow-sm`) and the padding is carried by `CardContent` (`p-4`); the app
/// has no separate header/footer variants, so both were merged into one component with
/// `Theme.S.cardPadding`.
struct Card<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(Theme.S.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.C.card, in: RoundedRectangle(cornerRadius: Theme.R.xl, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.R.xl, style: .continuous)
                    .strokeBorder(Theme.C.border, lineWidth: 1)
            )
            // shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05)
            .shadow(color: .black.opacity(0.05), radius: 1, x: 0, y: 1)
    }
}

#Preview("Card") {
    ScrollView {
        VStack(spacing: Theme.S.gridGap) {
            Card {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Session").font(.headline)
                    Text("project · claude · main").font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
                }
            }
        }
        .padding(Theme.S.screenPadding)
    }
    .background(Theme.C.background)
}
