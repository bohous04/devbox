import SwiftUI

/// Port of the web `EmptyState` (`primitives.tsx`) — a box with a dashed border. The app
/// omits `hint`/`action` from the web (no caller needs either today; `EmptyStateRow` in
/// `StatsScreen.swift` stays separate, see the comment there).
struct EmptyState: View {
    private let text: String
    private let systemImage: String?

    init(_ text: String, systemImage: String? = nil) {
        self.text = text
        self.systemImage = systemImage
    }

    var body: some View {
        VStack(spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.C.mutedForeground)
            }
            Text(text)
                .font(Theme.F.body.weight(.medium))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.C.foreground)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous)
                .strokeBorder(Theme.C.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
    }
}

#Preview("EmptyState") {
    EmptyState("No sessions yet", systemImage: "tray")
        .padding()
        .background(Theme.C.background)
}
