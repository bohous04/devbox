import Foundation
import WidgetKit

/// Last agent state for the home screen widget. Only the app writes it (polling `/api/live-activities/state`
/// in the foreground, Live Activity content change); the extension has no network or Cloudflare credentials and reads
/// only this from the App Group `group.com.example.devbox`.
enum SharedActivityStore {
    typealias State = DevboxAgentActivityAttributes.ContentState

    static let appGroup = "group.com.example.devbox"
    static let widgetKind = "DevboxStatusWidget"
    /// Build 20: diagnostic widget with the production row (live time) — reads the same data.
    static let diagWidgetKind = "DevboxDiagElapsed"
    /// The widget shows older data as "Out of date" (and after the same interval asks for new data itself).
    static let staleAfter: TimeInterval = 15 * 60
    /// How often at most `savedAt` is refreshed for unchanged content.
    static let savedAtRefresh: TimeInterval = 60

    private static let key = "widget.agentState"

    /// `nil` only when the App Group is missing (target without the entitlement) — then nothing is saved.
    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    private struct Snapshot: Codable {
        var state: State
        var savedAt: Date
    }

    /// With no content change (difference only in `updatedAt`) nothing is written and the widget is not redrawn;
    /// `savedAt` is still refreshed at most once per `savedAtRefresh`, so the widget does not show
    /// "Out of date" for data the app keeps confirming. Returns whether it wrote.
    @discardableResult
    static func write(_ state: State, at: Date = .now, defaults: UserDefaults? = SharedActivityStore.defaults,
                      reload: () -> Void = SharedActivityStore.reloadWidgets) -> Bool {
        guard let defaults else { return false }
        if let stored = read(defaults: defaults), sameContent(stored.state, state),
           at.timeIntervalSince(stored.savedAt) < savedAtRefresh, at >= stored.savedAt {
            return false
        }
        guard let data = try? JSONEncoder().encode(Snapshot(state: state, savedAt: at)) else { return false }
        defaults.set(data, forKey: key)
        reload()
        return true
    }

    /// Deletes the stored state (server change) — the widget then shows "Open Devbox", not someone else's sessions.
    static func clear(defaults: UserDefaults? = SharedActivityStore.defaults,
                      reload: () -> Void = SharedActivityStore.reloadWidgets) {
        guard let defaults else { return }
        defaults.removeObject(forKey: key)
        reload()
    }

    /// Redraws both the status widget and the diagnostic widget.
    static func reloadWidgets() {
        for kind in [widgetKind, diagWidgetKind] {
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
    }

    /// Timeline entry times for the widget: now and, if the data are not stale yet, also the moment
    /// they become stale — so "Out of date" appears exactly 15 min after saving.
    static func timelineDates(now: Date, savedAt: Date?) -> [Date] {
        guard let savedAt else { return [now] }
        let staleAt = savedAt.addingTimeInterval(staleAfter + 1)
        return staleAt > now ? [now, staleAt] : [now]
    }

    private static func sameContent(_ a: State, _ b: State) -> Bool {
        var b = b
        b.updatedAt = a.updatedAt
        return a == b
    }

    static func read(defaults: UserDefaults? = SharedActivityStore.defaults) -> (state: State, savedAt: Date)? {
        guard let data = defaults?.data(forKey: key),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return nil }
        return (snapshot.state, snapshot.savedAt)
    }

    static func isStale(savedAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(savedAt) > staleAfter
    }
}
