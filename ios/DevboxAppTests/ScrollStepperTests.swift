import XCTest
@testable import DevboxApp

/// Converts finger movement into wheel steps for tmux: finger down = content down = older history ("up").
final class ScrollStepperTests: XCTestCase {
    func testThreeAndHalfLinesDownGiveThreeUpStepsAndKeepRemainder() {
        var s = ScrollStepper(lineHeight: 10)
        let r = s.feed(35)
        XCTAssertEqual(r?.direction, .up)
        XCTAssertEqual(r?.steps, 3)
        XCTAssertEqual(s.remainder, 5, accuracy: 0.0001)
        // the leftover half row + another half = one step
        XCTAssertEqual(s.feed(5)?.steps, 1)
        XCTAssertEqual(s.remainder, 0, accuracy: 0.0001)
    }

    func testFingerUpScrollsDown() {
        var s = ScrollStepper(lineHeight: 10)
        let r = s.feed(-21)
        XCTAssertEqual(r?.direction, .down)
        XCTAssertEqual(r?.steps, 2)
    }

    func testSmallMovesAccumulate() {
        var s = ScrollStepper(lineHeight: 10)
        XCTAssertNil(s.feed(4))
        XCTAssertNil(s.feed(4))
        XCTAssertEqual(s.feed(4)?.steps, 1)
    }

    func testReversingDirectionDropsRemainder() {
        var s = ScrollStepper(lineHeight: 10)
        _ = s.feed(9) // almost a row down
        XCTAssertNil(s.feed(-2), "reversing must not turn the leftover 9 into a step in the wrong direction")
        XCTAssertEqual(s.remainder, -2, accuracy: 0.0001)
        XCTAssertEqual(s.feed(-8)?.direction, .down)
    }

    func testStepsClampedToTwenty() {
        var s = ScrollStepper(lineHeight: 10)
        XCTAssertEqual(s.feed(1000)?.steps, 20)
    }

    func testInvalidLineHeightNeverSteps() {
        var s = ScrollStepper(lineHeight: 0)
        XCTAssertNil(s.feed(100))
    }
}

/// Momentum after lifting the finger: velocity decays exponentially, at most ~1 s.
final class ScrollInertiaTests: XCTestCase {
    func testDecaysAndStops() {
        var i = ScrollInertia(velocity: 2000)
        var total: Double = 0
        var frames = 0
        while let dy = i.step(dt: 1.0 / 60) { total += dy; frames += 1 }
        XCTAssertGreaterThan(total, 0)
        XCTAssertLessThanOrEqual(frames, 60, "at most ~1 s")
        XCTAssertNil(i.step(dt: 1.0 / 60), "nothing after it stops")
    }

    func testSlowReleaseHasNoInertia() {
        var i = ScrollInertia(velocity: 20)
        XCTAssertNil(i.step(dt: 1.0 / 60))
    }

    func testDirectionFollowsVelocity() {
        var i = ScrollInertia(velocity: -1500)
        XCTAssertLessThan(i.step(dt: 1.0 / 60) ?? 0, 0)
    }
}
