import SwiftUI

/// Shared states for `StatusDot`/`StatCard`/`Gauge` — mirrors `DOT`/`SEV_TEXT` from `primitives.tsx`
/// and `Gauge.tsx`. `idle` is the web `zinc-400` ("off"/"stopped"), not inactivity in the sense of an error.
enum StatusTone: Equatable {
    case ok
    case warn
    case danger
    case idle
}

extension StatusTone {
    var color: Color {
        switch self {
        case .ok: return Theme.C.ok
        case .warn: return Theme.C.warn
        case .danger: return Theme.C.danger
        case .idle: return Theme.C.idle
        }
    }
}

/// Status dot — port of the web `StatusDot` (`primitives.tsx`). `pulse` adds an `animate-ping`
/// ring around it (the web uses it for `working`/`running`).
struct StatusDot: View {
    private let tone: StatusTone
    private let pulse: Bool
    @State private var pulsing = false

    init(_ tone: StatusTone, pulse: Bool = false) {
        self.tone = tone
        self.pulse = pulse
    }

    private let diameter: CGFloat = 8

    var body: some View {
        ZStack {
            if pulse {
                Circle()
                    .fill(tone.color.opacity(0.6))
                    .frame(width: diameter, height: diameter)
                    .scaleEffect(pulsing ? 2.2 : 1)
                    .opacity(pulsing ? 0 : 0.6)
                    .animation(.easeOut(duration: 1.1).repeatForever(autoreverses: false), value: pulsing)
            }
            Circle()
                .fill(tone.color)
                .frame(width: diameter, height: diameter)
        }
        .frame(width: diameter, height: diameter)
        .onAppear { if pulse { pulsing = true } }
    }
}

#Preview("StatusDot") {
    VStack(alignment: .leading, spacing: 12) {
        HStack { StatusDot(.ok, pulse: true); Text("working") }
        HStack { StatusDot(.warn); Text("waiting") }
        HStack { StatusDot(.danger); Text("danger") }
        HStack { StatusDot(.idle); Text("idle") }
    }
    .padding()
    .background(Theme.C.background)
}
