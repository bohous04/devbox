import SwiftUI

/// Port of the web button variants (`ui/button.tsx`). The web has a height of 36/32 px — the app
/// raises it to min. 44 pt (Apple HIG touch target), the visuals (colours, `rounded-md`) stay the same.
struct DevboxButtonStyle: ButtonStyle {
    enum Variant {
        case `default`
        case outline
        case secondary
        case ghost
        case destructive
    }

    var variant: Variant = .default

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.F.body.weight(.medium))
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .foregroundStyle(foreground)
            .background(background(pressed: configuration.isPressed), in: RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous))
            .overlay(
                variant == .outline
                    ? RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous).strokeBorder(Theme.C.border, lineWidth: 1)
                    : nil
            )
            .opacity(configuration.isPressed ? 0.85 : 1)
    }

    private var foreground: Color {
        switch variant {
        case .default: return Theme.C.primaryForeground
        case .destructive: return .white
        case .outline, .ghost, .secondary: return Theme.C.foreground
        }
    }

    private func background(pressed: Bool) -> Color {
        switch variant {
        case .default: return Theme.C.primary.opacity(pressed ? 0.9 : 1)
        case .destructive: return Theme.C.destructive.opacity(pressed ? 0.9 : 1)
        case .secondary: return Theme.C.muted.opacity(pressed ? 0.8 : 1)
        case .outline: return pressed ? Theme.C.muted.opacity(0.5) : .clear
        case .ghost: return pressed ? Theme.C.muted.opacity(0.5) : .clear
        }
    }
}

#Preview("DevboxButtonStyle") {
    VStack(spacing: 10) {
        Button("Default") {}.buttonStyle(DevboxButtonStyle())
        Button("Outline") {}.buttonStyle(DevboxButtonStyle(variant: .outline))
        Button("Secondary") {}.buttonStyle(DevboxButtonStyle(variant: .secondary))
        Button("Ghost") {}.buttonStyle(DevboxButtonStyle(variant: .ghost))
        Button("Destructive") {}.buttonStyle(DevboxButtonStyle(variant: .destructive))
    }
    .padding()
    .background(Theme.C.background)
}
