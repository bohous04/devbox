#if DEBUG
import ActivityKit
import SwiftUI

/// Local simulator sample only (`--live-activity-preview`). No connection to devd,
/// credentials or push registration — the data are test data.
struct AgentActivityPreviewScreen: View {
    private typealias Attributes = DevboxAgentActivityAttributes

    @State private var activity: Activity<Attributes>?
    @State private var message = "Start a sample, then go to the Home Screen or lock the iPhone."

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Live Activity sample").font(.title2.bold())
                    Text("The real Dynamic Island and Lock Screen with test data.")
                    Text(message).foregroundStyle(.secondary)
                }
                Section("Agent status") {
                    Button("Mockup B2 (13 sessions)") { Task { await show(Attributes.previewB2) } }
                    Button("Nothing waiting (3 working)") { Task { await show(Attributes.previewWorking) } }
                    Button("Waiting for approval") { Task { await show(Self.waiting()) } }
                    Button("More agents (+4)") { Task { await show(Self.waiting(overflow: 4)) } }
                    Button("Agents working") { Task { await show(Self.only(.working)) } }
                    Button("Agent stalled") { Task { await show(Self.only(.stalled)) } }
                    Button("Stale connection") { Task { await show(Self.only(.working), stale: true) } }
                    Button("All done") { Task { await show(Self.only(.done)) } }
                    Button("End activity", role: .destructive) {
                        Task {
                            for item in Activity<Attributes>.activities {
                                await item.end(nil, dismissalPolicy: .immediate)
                            }
                            activity = nil
                            message = "Activity ended."
                        }
                    }
                }
            }
            .navigationTitle("Devbox · sample")
        }
    }

    private static func waiting(overflow: Int = 0) -> Attributes.ContentState {
        var state = Attributes.preview
        state.overflow = overflow
        state.counts.working += overflow
        return state
    }

    /// All sample sessions in one state (counts and dot match what the server would send).
    private static func only(_ status: Attributes.Status) -> Attributes.ContentState {
        var state = Attributes.preview
        for index in state.sessions.indices {
            state.sessions[index].status = status
            state.sessions[index].reason = nil
        }
        let n = state.sessions.count
        state.counts = .init(waiting: 0, working: status == .working ? n : 0, done: status == .done ? n : 0,
                             stalled: status == .stalled ? n : 0)
        state.dot = status == .working ? .working : status == .stalled ? .stalled : .idle
        return state
    }

    @MainActor
    private func show(_ state: Attributes.ContentState, stale: Bool = false) async {
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(stale ? -1 : 90))
        if let current = activity ?? Activity<Attributes>.activities.first {
            await current.update(content)
            activity = current
        } else {
            do {
                activity = try Activity.request(attributes: Attributes(serverID: "local-preview"),
                                                content: content, pushType: nil)
            } catch {
                message = error.localizedDescription
                return
            }
        }
        message = stale ? "The activity shows the last known state." : "Activity is running."
    }
}
#endif
