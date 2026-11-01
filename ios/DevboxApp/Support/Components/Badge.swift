import SwiftUI

/// Variants of the web `Badge` (`ui/badge.tsx`); the app omits `link`/`ghost` — the app never links
/// from a badge, it only displays state.
enum BadgeVariant {
    case `default`
    case secondary
    case destructive
    case outline
}

/// Pill popisek — `rounded-full px-2 py-0.5 text-xs font-medium`.
struct Badge: View {
    private let text: String
    private let variant: BadgeVariant

    init(_ text: String, variant: BadgeVariant = .default) {
        self.text = text
        self.variant = variant
    }

    private var background: Color {
        switch variant {
        case .default: return Theme.C.primary
        case .secondary: return Theme.C.muted
        case .destructive: return Theme.C.destructive
        case .outline: return .clear
        }
    }

    private var foreground: Color {
        switch variant {
        case .default: return Theme.C.primaryForeground
        case .secondary: return Theme.C.foreground
        case .destructive: return .white
        case .outline: return Theme.C.foreground
        }
    }

    var body: some View {
        Text(text)
            .font(Theme.F.badge)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
            .overlay(
                variant == .outline ? Capsule().strokeBorder(Theme.C.border, lineWidth: 1) : nil
            )
    }
}

#Preview("Badge") {
    HStack(spacing: 8) {
        Badge("default")
        Badge("secondary", variant: .secondary)
        Badge("destructive", variant: .destructive)
        Badge("outline", variant: .outline)
    }
    .padding()
    .background(Theme.C.background)
}
