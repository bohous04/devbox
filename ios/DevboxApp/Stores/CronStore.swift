import Foundation

/// View-model for `CronScreen` — mirrors `dashboard/src/pages/Schedule.tsx`, NARROWED to a read-only
/// view of the cron/prompt fields + simple actions (enable/disable, important/normal, run now,
/// delete). Creating and editing a schedule (cron expression + prompt + folder/project/repo pickers) stays
/// on the web — such a form is not a mobile priority (deliberate narrowing, see the task report). Fetch-on-
/// appear + pull-to-refresh, no polling (the web also only does `useEffect(load, [])`). After every mutation
/// the app re-fetches the whole list — same policy as the web (`await load()` after every action).
@MainActor
final class CronStore: ObservableObject {
    @Published private(set) var schedules: [Schedule]?
    @Published private(set) var error: String?

    private let client: DevdClient

    init(client: DevdClient) {
        self.client = client
    }

    func load() async {
        do {
            schedules = try await client.get("/api/schedules")
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    // `updateSchedule` in `dashboard/src/api.ts` sends only the CHANGED field (`Partial<Pick<...>>`) —
    // so the app has two separate bodies, not one with everything, so that cron/prompt/name do not get
    // overwritten unintentionally on the way.
    private struct EnabledPatch: Encodable { let enabled: Int }
    private struct ImportantPatch: Encodable { let important: Int }

    func setEnabled(_ s: Schedule) async throws {
        let _: Schedule = try await client.put("/api/schedules/\(s.id)", body: EnabledPatch(enabled: s.enabled == 1 ? 0 : 1))
        await load()
    }

    /// "Important" = emergency push (repeats until acknowledged) for that session's notifications —
    /// mirrors `toggleImportant` on the web.
    func setImportant(_ s: Schedule) async throws {
        let _: Schedule = try await client.put("/api/schedules/\(s.id)", body: ImportantPatch(important: s.important == 1 ? 0 : 1))
        await load()
    }

    func run(_ s: Schedule) async throws {
        try await client.postVoid("/api/schedules/\(s.id)/run", body: nil)
    }

    func delete(_ s: Schedule) async throws {
        try await client.deleteVoid("/api/schedules/\(s.id)")
        await load()
    }

}
