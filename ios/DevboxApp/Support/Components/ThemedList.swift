import SwiftUI

extension View {
    /// Background of screens that remain `List`/`Form` (long lists, theme-only screens) —
    /// hides the system grey grouped background and puts `Theme.C.background` in its place, like the web.
    func themedListBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(Theme.C.background)
    }
}

/// Skeleton of the main screens following the web (`AppPage` + `Section` + `Card`): a vertical scroll with
/// a `screenPadding` margin, sections `sectionGap` apart, `background` background.
struct ScreenScroll<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.S.sectionGap) {
                content
            }
            .padding(Theme.S.screenPadding)
        }
        .background(Theme.C.background)
    }
}
