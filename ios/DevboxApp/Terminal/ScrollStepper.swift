import Foundation

/// Terminal history lives in tmux (SwiftTerm has an empty scrollback under tmux), so we convert a finger
/// drag into wheel steps (`TerminalProto.encodeScroll`). Pure logic without UIKit,
/// so it can be tested (`ScrollStepperTests`).
struct ScrollStepper {
    let lineHeight: Double
    /// Unfinished fraction of a row (sign = finger direction), carried over to the next movement.
    private(set) var remainder: Double = 0

    init(lineHeight: Double) {
        self.lineHeight = lineHeight
    }

    /// `dy` = finger movement increment in points (positive = down). Finger down = content down = older
    /// history → `.up`. Returns `nil` until a whole row has accumulated. Steps above 20 are dropped
    /// (the server will not take more in one message and we do not want to catch up after a hard flick).
    mutating func feed(_ dy: Double) -> (direction: TerminalProto.ScrollDirection, steps: Int)? {
        guard lineHeight > 0, dy.isFinite, dy != 0 else { return nil }
        // A direction reversal drops the remainder — otherwise an almost completed downward row would,
        // after a small upward movement, "fire" a step in the wrong direction.
        if remainder != 0, (dy > 0) != (remainder > 0) { remainder = 0 }
        remainder += dy
        let lines = Int(remainder / lineHeight) // trunc k nule
        guard lines != 0 else { return nil }
        remainder -= Double(lines) * lineHeight
        return (lines > 0 ? .up : .down, min(abs(lines), TerminalProto.maxScrollSteps))
    }

    mutating func reset() {
        remainder = 0
    }
}

/// Coast after the finger is released (like UIScrollView): velocity (points/s) decays exponentially, ending
/// below `minVelocity` or after `maxDuration`. `step` returns the offset per frame, `nil` = done.
struct ScrollInertia {
    private var velocity: Double
    private var elapsed: Double = 0
    private var done = false

    /// Velocity decay per second (0.02 → after 1 s 2 % remains); ≈ UIScrollView .normal.
    static let decayPerSecond = 0.02
    static let minVelocity = 60.0
    static let maxDuration = 1.0

    init(velocity: Double) {
        self.velocity = velocity
    }

    mutating func step(dt: Double) -> Double? {
        guard !done, dt > 0, abs(velocity) >= Self.minVelocity, elapsed < Self.maxDuration else {
            done = true
            return nil
        }
        let dy = velocity * dt
        elapsed += dt
        velocity *= pow(Self.decayPerSecond, dt)
        return dy
    }
}
