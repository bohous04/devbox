import ActivityKit
import Foundation

struct AgentActivitySnapshot: Equatable {
    enum Lifecycle { case pending, active, stale, ended, dismissed }
    let id: String
    let serverID: String
    let lifecycle: Lifecycle
    let pushToken: Data?

    var isLive: Bool { lifecycle == .pending || lifecycle == .active || lifecycle == .stale }
}

/// ActivityKit boundary: the lifecycle can be exercised with a fake driver, without APNs
/// entitlement, a real device or creating activities in the developer's running app.
@MainActor
protocol AgentActivityDriver: AnyObject {
    var activities: [AgentActivitySnapshot] { get }
    var areActivitiesEnabled: Bool { get }
    var pushToStartToken: Data? { get }
    func startObserving(onChange: @escaping () -> Void,
                        onDismissed: @escaping (_ activityID: String, _ serverID: String) -> Void)
    func stopObserving()
    func request(serverID: String, state: DevboxAgentActivityAttributes.ContentState) throws -> AgentActivitySnapshot
    func update(id: String, state: DevboxAgentActivityAttributes.ContentState) async
    func end(id: String) async
}

@MainActor
final class ActivityKitAgentDriver: AgentActivityDriver {
    private typealias AgentActivity = Activity<DevboxAgentActivityAttributes>
    private var observed: [String: AgentActivity] = [:]
    private var activityTasks: [String: [Task<Void, Never>]] = [:]
    private var tasks: [Task<Void, Never>] = []
    private var onChange: (() -> Void)?
    private var onDismissed: ((String, String) -> Void)?
    // Ending an activity ourselves must never turn into a user-dismissal preference.
    private var ending = Set<String>()
    private var completed = Set<String>()

    var areActivitiesEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var pushToStartToken: Data? {
        if #available(iOS 17.2, *) { return AgentActivity.pushToStartToken }
        return nil
    }
    var activities: [AgentActivitySnapshot] {
        // Activity.activities is authoritative, including activities started while the app
        // was terminated. Keep terminal snapshots until the manager retires their token.
        var all = observed
        for activity in AgentActivity.activities { all[activity.id] = activity }
        return all.values.map(Self.snapshot).sorted { $0.id < $1.id }
    }

    func startObserving(onChange: @escaping () -> Void,
                        onDismissed: @escaping (String, String) -> Void) {
        guard tasks.isEmpty else { return }
        self.onChange = onChange
        self.onDismissed = onDismissed
        for activity in AgentActivity.activities { observe(activity) }
        tasks.append(Task { [weak self] in
            for await activity in AgentActivity.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observe(activity)
                self?.onChange?()
            }
        })
        tasks.append(Task { [weak self] in
            for await _ in ActivityAuthorizationInfo().activityEnablementUpdates {
                guard !Task.isCancelled else { return }
                self?.onChange?()
            }
        })
        if #available(iOS 17.2, *) {
            tasks.append(Task { [weak self] in
                for await _ in AgentActivity.pushToStartTokenUpdates {
                    guard !Task.isCancelled else { return }
                    self?.onChange?()
                }
            })
        }
    }

    func stopObserving() {
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        activityTasks.values.flatMap { $0 }.forEach { $0.cancel() }
        activityTasks.removeAll()
        onChange = nil
        onDismissed = nil
    }

    func request(serverID: String, state: DevboxAgentActivityAttributes.ContentState) throws -> AgentActivitySnapshot {
        let activity = try AgentActivity.request(
            attributes: DevboxAgentActivityAttributes(serverID: serverID),
            content: content(state), pushType: .token
        )
        observe(activity)
        return Self.snapshot(activity)
    }

    func update(id: String, state: DevboxAgentActivityAttributes.ContentState) async {
        guard let activity = lookup(id) else { return }
        await activity.update(content(state))
    }

    func end(id: String) async {
        guard let activity = lookup(id) else { return }
        ending.insert(id)
        await activity.end(nil, dismissalPolicy: .immediate)
        activityTasks.removeValue(forKey: id)?.forEach { $0.cancel() }
        observed.removeValue(forKey: id)
    }

    private func lookup(_ id: String) -> AgentActivity? {
        observed[id] ?? AgentActivity.activities.first { $0.id == id }
    }

    private func content(_ state: DevboxAgentActivityAttributes.ContentState) -> ActivityContent<DevboxAgentActivityAttributes.ContentState> {
        // The server supplies a heartbeat at most every 60 seconds. Missing updates must
        // visibly go stale instead of leaving an old "working" claim on the Lock Screen.
        ActivityContent(state: state, staleDate: Date().addingTimeInterval(90))
    }

    private func observe(_ activity: AgentActivity) {
        guard activityTasks[activity.id] == nil else { return }
        observed[activity.id] = activity
        if activity.activityState == .ended { completed.insert(activity.id) }
        let tokenTask = Task { [weak self] in
            for await _ in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                self?.onChange?()
            }
        }
        let stateTask = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled else { return }
                if state == .ended { self?.completed.insert(activity.id) }
                if state == .dismissed, self?.ending.contains(activity.id) == false,
                   self?.completed.contains(activity.id) == false {
                    self?.onDismissed?(activity.id, activity.attributes.serverID)
                }
                self?.onChange?()
            }
        }
        // A push from devd that arrives while the app is running also goes straight to the home screen widget.
        let contentTask = Task {
            for await content in activity.contentUpdates {
                guard !Task.isCancelled else { return }
                SharedActivityStore.write(content.state)
            }
        }
        activityTasks[activity.id] = [tokenTask, stateTask, contentTask]
    }

    private static func snapshot(_ activity: AgentActivity) -> AgentActivitySnapshot {
        // iOS 26 may reserve an activity before presenting it. Keep its identity so
        // reconciliation does not retire it or request a second activity meanwhile.
        if #available(iOS 26.0, *), activity.activityState == .pending {
            return .init(id: activity.id, serverID: activity.attributes.serverID,
                         lifecycle: .pending, pushToken: activity.pushToken)
        }
        let lifecycle: AgentActivitySnapshot.Lifecycle
        switch activity.activityState {
        case .active: lifecycle = .active
        case .stale: lifecycle = .stale
        case .ended: lifecycle = .ended
        case .dismissed: lifecycle = .dismissed
        // The newer .pending case is availability-guarded above for the iOS 17 target.
        default: lifecycle = .ended
        }
        return .init(id: activity.id, serverID: activity.attributes.serverID,
                     lifecycle: lifecycle, pushToken: activity.pushToken)
    }
}
