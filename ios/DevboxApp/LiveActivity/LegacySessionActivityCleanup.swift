import ActivityKit
import Foundation

// WHY THIS TYPE EXISTS: build 12 started per-session Live Activities of type
// `DevboxSessionActivityAttributes`. Build 13 removed that type entirely — and an app that does not
// know the type has no way to enumerate or end `Activity<…>.activities`, so after the
// upgrade old cards hung on the Lock Screen for hours. ActivityKit matches activities by
// type name and the (Codable) shape of the attributes, so it is here AGAIN, exactly in its old form
// (see git c87d36a^:ios/Shared/DevboxSessionActivityAttributes.swift) — only for cleanup.
// No widget/ActivityConfiguration exists for it and nothing new is started with it.
//
// DELETE (the type, `LegacySessionActivityCleanup` and the calls in DevboxAppApp/AppModel) once all
// phones have gone through build ≥ 14 — after that no such activity can exist.
struct DevboxSessionActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let status: String
        let detail: String
        let updatedAt: Date
    }

    let sessionId: String
    let title: String
    let project: String
}

/// Test seam — the real implementation touches ActivityKit, the test only counts calls.
protocol LegacyActivityEnding: AnyObject {
    /// Fire-and-forget: ends all old per-session activities with immediate dismissal.
    func endAllImmediately()
}

final class ActivityKitLegacySessionEnder: LegacyActivityEnding {
    func endAllImmediately() {
        let activities = Activity<DevboxSessionActivityAttributes>.activities
        guard !activities.isEmpty else { return }
        Task {
            for activity in activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
}

/// When cleanup runs: on every app launch and on every return to the foreground. It is cheap
/// (empty list = nothing) and also covers an app that just sits in the background after the upgrade.
@MainActor
final class LegacySessionActivityCleanup {
    let ender: LegacyActivityEnding

    init(ender: LegacyActivityEnding = ActivityKitLegacySessionEnder()) {
        self.ender = ender
    }

    func appLaunched() {
        ender.endAllImmediately()
    }

    func sceneBecame(active: Bool) {
        guard active else { return }
        ender.endAllImmediately()
    }
}
