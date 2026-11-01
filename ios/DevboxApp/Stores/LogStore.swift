import Foundation

/// View-model for `LogScreen` — mirrors `dashboard/src/pages/Log.tsx` + the pure
/// `dashboard/src/logView.ts` (LOG_GROUPS/typesForGroups/toggle ported 1:1). Narrowed to what
/// the task specifies — filter by type group and session + "load more" (on mobile the app pages as an
/// infinite list, not the web's numbered `Pager`); the app also has no date range (the web defaults to
/// 30 days via `DateRangePicker`) — without `from`/`to` the app walks the whole history via
/// session/type filters, which is a simpler UI for a phone (deliberate narrowing, see the task report).
@MainActor
final class LogStore: ObservableObject {
    struct LogGroup: Equatable { let id: String; let label: String; let types: [String] }

    /// 1:1 `LOG_GROUPS` z `dashboard/src/logView.ts`.
    nonisolated static let groups: [LogGroup] = [
        LogGroup(id: "session", label: "Sessions", types: ["open", "open-solo", "recreate", "stop", "end", "restart-solo", "clone", "pull-conflict", "pull-error"]),
        LogGroup(id: "agent", label: "Agent", types: ["agent_done", "agent_blocked", "agent_stuck"]),
        LogGroup(id: "critic", label: "Critic", types: ["critic_pass", "critic_block", "critic_giveup", "critic_error", "critic_toggle"]),
        LogGroup(id: "cc", label: "cc upkeep", types: ["cc_upgraded", "cc_skipped", "cc_restart_failed", "cc_upgrade_failed"]),
        LogGroup(id: "schedule", label: "Scheduled runs", types: ["schedule_run", "schedule_skip", "schedule_error", "auto_end", "auto_end_kept", "auto_end_error"]),
        LogGroup(id: "prod", label: "Production DB", types: ["prod_db_access", "prod_write_proposed", "prod_write_executed", "prod_write_rejected"]),
        LogGroup(id: "host", label: "Host maintenance", types: ["host_update", "host_reboot"]),
        LogGroup(id: "access", label: "Access", types: ["terminal_open", "terminal_control", "ssh_key_access", "clipboard_access"]),
    ]

    private nonisolated static let groupedTypes: Set<String> = Set(groups.flatMap(\.types))

    /// Mirrors `ungroupedTypes` — types that fall into no group (so "Other" does not hide
    /// new types from devd until they are added here).
    nonisolated static func ungroupedTypes(_ allTypes: [String]) -> [String] {
        allTypes.filter { !groupedTypes.contains($0) }
    }

    /// Mirrors `typesForGroups`. Empty selection = no filter (empty array). A selected group with no
    /// match in the data is deliberately NOT DROPPED (`__none__` sentinel) — otherwise checking it would show
    /// everything instead of nothing.
    nonisolated static func typesForGroups(_ selected: [String], allTypes: [String]) -> [String] {
        guard !selected.isEmpty else { return [] }
        var out = Set<String>()
        for id in selected {
            if id == "other" {
                for t in ungroupedTypes(allTypes) { out.insert(t) }
                continue
            }
            if let group = groups.first(where: { $0.id == id }) {
                for t in group.types { out.insert(t) }
            }
        }
        let known = Set(allTypes)
        let hit = out.filter { known.contains($0) }
        return hit.isEmpty ? ["__none__"] : Array(hit)
    }

    /// Mirrors `toggle` — toggling an item in a multi-selection.
    nonisolated static func toggle(_ selected: [String], _ id: String) -> [String] {
        selected.contains(id) ? selected.filter { $0 != id } : selected + [id]
    }

    // MARK: - Fetch + load more

    private struct Query: Equatable { let session: String?; let types: [String] }

    private let client: DevdClient
    let perPage: Int
    private var lastQuery: Query?

    @Published private(set) var items: [ActivityEvent] = []
    @Published private(set) var total = 0
    @Published private(set) var allTypes: [String] = []
    @Published private(set) var error: String?
    @Published private(set) var loadingMore = false
    /// `true` after the first completed fetch (successful or not) — without it `items.isEmpty` alone
    /// cannot tell "never arrived yet" from "arrived, but the filter matches nothing", so the screen
    /// showed a spinner forever after a successful fetch with 0 rows instead of the empty state.
    @Published private(set) var loaded = false

    init(client: DevdClient, perPage: Int = 50) {
        self.client = client
        self.perPage = perPage
    }

    var hasMore: Bool { items.count < total }

    /// A new search from scratch — filter/session changed, the app drops the pages so far. `allTypes`
    /// (corresponding to the last successful fetch) decides which groups have any match in the data.
    ///
    /// The app clears `items`/`loaded` IMMEDIATELY (not after the response), but ONLY when the query has
    /// actually changed against `lastQuery` (review) — otherwise `LogScreen` would briefly show results of the
    /// PREVIOUS filter without a loading indicator until the response to the new query arrives. `.refreshable`
    /// however calls THIS same `reload` with the SAME query (pull-to-refresh) — there the app instead
    /// leaves the data in place until it finishes, standard iOS UX (a refresh request by itself does not clear
    /// what is visible).
    func reload(session: String?, selectedGroups: [String]) async {
        let types = Self.typesForGroups(selectedGroups, allTypes: allTypes)
        let query = Query(session: session, types: types)
        if query != lastQuery {
            items = []
            total = 0
            loaded = false
        }
        await fetchPage(offset: 0, session: session, types: types, replacing: true)
    }

    /// The app keeps the next page under the current filter via `lastQuery` (the last successful `reload`).
    func loadMore() async {
        guard !loadingMore, hasMore, let q = lastQuery else { return }
        await fetchPage(offset: items.count, session: q.session, types: q.types, replacing: false)
    }

    private func fetchPage(offset: Int, session: String?, types: [String], replacing: Bool) async {
        if replacing { error = nil } else { loadingMore = true }
        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(perPage)),
        ]
        if let session, !session.isEmpty { queryItems.append(URLQueryItem(name: "session", value: session)) }
        if !types.isEmpty { queryItems.append(URLQueryItem(name: "types", value: types.joined(separator: ","))) }
        var components = URLComponents()
        components.queryItems = queryItems
        let path = "/api/events?\(components.percentEncodedQuery ?? "")"
        do {
            let page: EventPage = try await client.get(path)
            lastQuery = Query(session: session, types: types)
            items = replacing ? page.items : items + page.items
            total = page.total
            allTypes = page.types
        } catch {
            self.error = errorText(error)
        }
        loaded = true
        loadingMore = false
    }

}
