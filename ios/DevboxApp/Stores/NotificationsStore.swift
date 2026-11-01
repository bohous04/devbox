import Foundation

/// View-model for `NotificationsScreen` — mirrors `dashboard/src/pages/Notifications.tsx` + the pure
/// `dashboard/src/notificationsView.ts` (`groupByTurn`/`promptExcerpt` ported 1:1). Fetch-on-
/// appear (the filter recomputes the query on the server, same as the web) + pull-to-refresh, no polling.
@MainActor
final class NotificationsStore: ObservableObject {
    enum Filter: String, CaseIterable { case all, sent, flagged }

    /// Mirrors `groupByTurn`'s `TurnGroup` — `header` divides the turn (the `user_prompt_submit` row),
    /// `nil` means the turn divider did not reach into the visible window (the page/filter cut it off).
    struct TurnGroup: Equatable {
        let key: String
        let header: NotifyLogRow?
        let rows: [NotifyLogRow]

        static func == (a: TurnGroup, b: TurnGroup) -> Bool {
            a.key == b.key && a.header?.id == b.header?.id && a.rows.map(\.id) == b.rows.map(\.id)
        }
    }

    /// Mirrors `groupByTurn` — the API returns rows descending (newest first) across ALL sessions,
    /// so the turn split also respects `session_id` (otherwise concurrent sessions would mix
    /// rows of other turns into one block). `bucketSession == nil` is the same sentinel as JS
    /// `null` — a real `session_id` is never nil, so a "not started yet" distinction is unnecessary.
    nonisolated static func groupByTurn(_ rows: [NotifyLogRow]) -> [TurnGroup] {
        var groups: [TurnGroup] = []
        var bucket: [NotifyLogRow] = []
        var bucketSession: String?
        func flushTail() {
            if let first = bucket.first {
                groups.append(TurnGroup(key: "tail-\(first.id)", header: nil, rows: bucket))
            }
            bucket = []
        }
        for r in rows {
            if let session = bucketSession, r.session_id != session { flushTail() }
            bucketSession = r.session_id
            if r.event == "user_prompt_submit" {
                groups.append(TurnGroup(key: "turn-\(r.id)", header: r, rows: bucket))
                bucket = []
                bucketSession = nil
            } else {
                bucket.append(r)
            }
        }
        flushTail()
        return groups
    }

    /// Mirrors `promptExcerpt`.
    nonisolated static func promptExcerpt(_ row: NotifyLogRow) -> String? {
        guard let detail = row.detail, !detail.isEmpty,
              let json = try? JSONSerialization.jsonObject(with: Data(detail.utf8)) as? [String: Any],
              let prompt = json["prompt"] as? String
        else { return nil }
        return prompt
    }

    /// 1:1 `EVENT_LABEL` z `dashboard/src/pages/Notifications.tsx`.
    private nonisolated static let eventLabels: [String: String] = [
        "stop": "Stop", "sweep_done": "Notification sent", "user_prompt_submit": "Prompt",
        "subagent_start": "Subagent started", "subagent_stop": "Subagent finished",
        "teammate_idle": "Teammate idle", "task_created": "Task created", "task_completed": "Task completed",
        "permission_request": "Permission request", "notification": "Notification",
    ]

    nonisolated static func eventLabel(_ event: String) -> String { eventLabels[event] ?? event }

    /// 1:1 `VERDICT_LABEL`.
    nonisolated static let verdictLabels: [NotifyVerdict: String] = [
        .falsePositive: "Fired but shouldn't have",
        .missing: "Should have fired",
        .ok: "Correct",
    ]

    // MARK: - Fetch + mutate

    private let client: DevdClient

    @Published private(set) var rows: [NotifyLogRow]?
    @Published private(set) var error: String?

    init(client: DevdClient) {
        self.client = client
    }

    /// "Only sent" filters on the SERVER (decision=sent), same as the web — sent/sweep_done is rare compared to
    /// the subagent_start/stop noise, a client-side filter over the last 300 rows could show
    /// nothing even though a sent one exists.
    func load(filter: Filter) async {
        var queryItems = [URLQueryItem(name: "limit", value: "300")]
        if filter == .flagged { queryItems.append(URLQueryItem(name: "verdict", value: "flagged")) }
        if filter == .sent { queryItems.append(URLQueryItem(name: "decision", value: "sent")) }
        var components = URLComponents()
        components.queryItems = queryItems
        do {
            rows = try await client.get("/api/notify-log?\(components.percentEncodedQuery ?? "")")
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    // `NotifyVerdict` is only `Decodable` (the app has so far only READ it) — so the body encodes `rawValue`,
    // same trick as `SessionActions.AgentBody` for `AgentName`.
    private struct VerdictBody: Encodable { let verdict: String?; let note: String? }

    /// `verdict: nil` clears the flag — the server treats a missing and an explicit `null` the same (`body?.verdict
    /// ?? null` in devd/src/api.ts), so the app does not have to handle the difference between an omitted key
    /// (Swift `encodeIfPresent` for Optional properties) and JS `JSON.stringify({verdict: null})`.
    func setVerdict(_ id: Int, verdict: NotifyVerdict?, note: String?) async throws {
        try await client.postVoid("/api/notify-log/\(id)/verdict", body: VerdictBody(verdict: verdict?.rawValue, note: note))
    }

}
