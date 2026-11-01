import SwiftUI

/// Small reusable banner for the offline/error state — one shared component for
/// `SessionsScreen`/`OverviewScreen` instead of copies of the same layout. Styled after the web's
/// amber warning (`border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400`),
/// rounded, because it sits in the screen content (`ScreenScroll`) between cards.
///
/// The `message` default is a fixed offline text; callers that show a specific `errorText` message
/// (not a pure offline state, see `SessionsScreen.listContent`/`OverviewScreen.content`) pass
/// their own text via `OfflineBanner(message:)`.
struct OfflineBanner: View {
    var message = "Offline — retrying…"

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.exclamationmark")
            Text(message)
                .font(Theme.F.meta.weight(.medium))
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .foregroundStyle(Theme.C.warnText)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.C.warn.opacity(0.1), in: RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous)
                .strokeBorder(Theme.C.warn.opacity(0.3), lineWidth: 1)
        )
    }
}
