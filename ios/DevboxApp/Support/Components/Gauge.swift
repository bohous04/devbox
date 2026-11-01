import SwiftUI

/// Port of the web `Gauge` (`components/Gauge.tsx`) — a 270° arc with rounded ends, track in a
/// 15 % tone, 5 ticks in the `border` colour. The name shadows SwiftUI `Gauge` within the DevboxApp module
/// (the app does not use it anywhere else — verified by `grep`, see task-10-report.md).
///
/// The geometry is a 1:1 port of the web `polar()`/`arcPath()` math (`Gauge.tsx:15-24`) — SwiftUI
/// `Path.addArc`/`Circle().trim()` have a confusing direction convention, computing the points directly guarantees
/// the arc looks the same as on the web.
/// Geometry separated from `Gauge<Label>` — generic types cannot have static stored properties
/// (`sweep`/`start` could not otherwise be declared directly in `Gauge`).
private enum GaugeGeometry {
    static let sweep: Double = 270
    static let start: Double = -135

    /// Matches the web `polar(cx, cy, r, deg)`: 0° is at the top, the angle grows clockwise
    /// (same convention as SVG, both have the Y axis pointing down).
    static func point(center: CGPoint, radius: CGFloat, degrees: Double) -> CGPoint {
        let a = (degrees - 90) * Double.pi / 180
        return CGPoint(x: center.x + radius * CGFloat(cos(a)), y: center.y + radius * CGFloat(sin(a)))
    }

    static func arcPath(center: CGPoint, radius: CGFloat, from: Double, to: Double) -> Path {
        var path = Path()
        let segments = 72
        let step = (to - from) / Double(segments)
        for i in 0...segments {
            let deg = from + step * Double(i)
            let p = point(center: center, radius: radius, degrees: deg)
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        return path
    }
}

struct Gauge<Label: View>: View {
    private let pct: Double
    private let tone: StatusTone
    private let label: Label

    init(pct: Double, tone: StatusTone, @ViewBuilder label: () -> Label) {
        self.pct = pct
        self.tone = tone
        self.label = label()
    }

    private var frac: Double { min(1, max(0, pct)) }

    var body: some View {
        Color.clear
            .aspectRatio(200.0 / 168.0, contentMode: .fit)
            .overlay(
                GeometryReader { geo in
                    let side = min(geo.size.width, geo.size.height)
                    let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
                    let radius = side * 0.39 // r=78 out of viewBox width 200
                    let lineWidth = side * 0.055 // stroke 11/200

                    ZStack {
                        GaugeGeometry.arcPath(center: center, radius: radius, from: GaugeGeometry.start, to: GaugeGeometry.start + GaugeGeometry.sweep)
                            .stroke(tone.color.opacity(0.15), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                        if frac > 0 {
                            GaugeGeometry.arcPath(center: center, radius: radius, from: GaugeGeometry.start, to: GaugeGeometry.start + GaugeGeometry.sweep * frac)
                                .stroke(tone.color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                        }
                        ForEach(0..<5) { i in
                            tick(center: center, radius: radius, side: side, t: Double(i) / 4)
                        }
                        label
                            .frame(width: geo.size.width * 0.74)
                            .position(x: geo.size.width / 2, y: geo.size.height * 0.47)
                    }
                }
            )
    }

    @ViewBuilder
    private func tick(center: CGPoint, radius: CGFloat, side: CGFloat, t: Double) -> some View {
        let deg = GaugeGeometry.start + GaugeGeometry.sweep * t
        let outer = GaugeGeometry.point(center: center, radius: radius - side * 0.065, degrees: deg)
        let inner = GaugeGeometry.point(center: center, radius: radius - side * 0.09, degrees: deg)
        Path { path in
            path.move(to: outer)
            path.addLine(to: inner)
        }
        .stroke(Theme.C.border, lineWidth: 1.5)
    }
}

#Preview("Gauge") {
    HStack(spacing: 20) {
        Gauge(pct: 0.42, tone: .ok) {
            VStack(spacing: 2) {
                Text("42%").font(.title3.weight(.semibold).monospacedDigit())
                Text("disk").font(.caption).foregroundStyle(Theme.C.mutedForeground)
            }
        }
        Gauge(pct: 0.93, tone: .warn) {
            VStack(spacing: 2) {
                Text("93%").font(.title3.weight(.semibold).monospacedDigit())
                Text("quota").font(.caption).foregroundStyle(Theme.C.mutedForeground)
            }
        }
    }
    .padding()
    .background(Theme.C.background)
}
