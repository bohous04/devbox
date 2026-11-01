import Foundation

/// View-model for `OverviewScreen` — 1:1 basis from `dashboard/src/pages/Overview.tsx`, narrowed to
/// the three sections specified for this stage: today's numbers (`/api/stats/totals`), disk (`/api/stats/disk`)
/// and recent activity (`/api/events`). Unlike `LiveStore`, no polling — only fetch-on-appear
/// + pull-to-refresh (brief: "no polling — like the web, Subscriptions load on entry").
///
/// The three requests run concurrently; a failure of one does not clear the data of the others (same policy as
/// `LiveStore.tick`) — the last known numbers stay under the offline banner, not a stuck
/// spinner or an empty screen.
@MainActor
final class OverviewStore: ObservableObject {
    @Published private(set) var totals: Totals?
    @Published private(set) var disk: DiskStats?
    @Published private(set) var events: [ActivityEvent] = []
    @Published private(set) var lastError: String?
    /// `true` after the first completed `load()` (successful or not) — same pattern as
    /// `LogStore.loaded`; without it "Recent activity" cannot tell "nothing has arrived yet" from
    /// "it arrived and it is empty", so "Nothing yet." would briefly flash even before the load finishes.
    @Published private(set) var loaded = false

    private let client: DevdClient
    /// How many recent events the app fetches — the card on mobile has limited space, unlike
    /// the Log on the web with pagination over the whole history.
    private let eventsLimit: Int

    init(client: DevdClient, eventsLimit: Int = 15) {
        self.client = client
        self.eventsLimit = eventsLimit
    }

    func load() async {
        async let totalsResult: Result<Totals, Error> = fetchResult("/api/stats/totals")
        async let diskResult: Result<DiskStats, Error> = fetchResult("/api/stats/disk")
        async let eventsResult: Result<[ActivityEvent], Error> = fetchResult("/api/events?limit=\(eventsLimit)")
        let (t, d, e) = await (totalsResult, diskResult, eventsResult)

        var errorMessage: String?
        switch t {
        case .success(let value): totals = value
        case .failure(let error): errorMessage = errorText(error)
        }
        switch d {
        case .success(let value): disk = value
        case .failure(let error): errorMessage = errorMessage ?? errorText(error)
        }
        switch e {
        case .success(let rows): events = rows
        case .failure(let error): errorMessage = errorMessage ?? errorText(error)
        }
        lastError = errorMessage
        loaded = true
    }

    // MARK: - Pure: disk (1:1 `dashboard/src/format.ts` pctOf/daysLeftLabel + `Gauge.tsx` diskSeverity)

    /// Mirrors `pctOf` — the app must not touch `Format.swift` (it belongs to another task), so the
    /// pure function lives here, where it is used.
    nonisolated static func pctOf(_ part: Double, _ total: Double) -> Double {
        guard total != 0 else { return 0 }
        return min(100, max(0, (part / total) * 100))
    }

    /// Mirrors `daysLeftLabel`.
    nonisolated static func daysLeftLabel(_ days: Double?) -> String {
        guard let days else { return "plenty of space" }
        return "~\(Int(days.rounded())) days"
    }

    enum Severity: Equatable { case ok, warn, danger }

    /// Mirrors `diskSeverity` from `dashboard/src/components/Gauge.tsx`. The web reads the threshold from
    /// `config.settings.diskWarnPercent` (default 80); the app keeps the default `80` hard-coded for the
    /// same reason as `HardwareStore.diskWarnPercent` — the config editor is a read-only, not yet
    /// available stage, so the app stays on the web's default value until it is added.
    nonisolated static func diskSeverity(_ pct: Double, warnPct: Double = 80) -> Severity {
        if pct >= 92 { return .danger }
        if pct >= warnPct { return .warn }
        return .ok
    }

    // MARK: - Pure: event log (1:1 `dashboard/src/eventLabels.ts`)

    enum EventKind: Equatable { case info, ok, warn, danger }
    struct EventLabel { let label: String; let kind: EventKind }

    private nonisolated static let labels: [String: EventLabel] = [
        "open": EventLabel(label: "Session opened", kind: .info),
        "open-solo": EventLabel(label: "claudeSolo opened", kind: .info),
        "recreate": EventLabel(label: "Container recreated", kind: .info),
        "agent-switch": EventLabel(label: "Agent switched (container recreated)", kind: .info),
        "agent-switch-live": EventLabel(label: "Agent switched (live)", kind: .info),
        "stop": EventLabel(label: "Session stopped", kind: .info),
        "end": EventLabel(label: "Session ended", kind: .info),
        "restart-solo": EventLabel(label: "claudeSolo restarted", kind: .info),
        "clone": EventLabel(label: "Repo cloned", kind: .info),
        "worktree": EventLabel(label: "Worktree created", kind: .info),
        "pull-conflict": EventLabel(label: "Pull conflict", kind: .warn),
        "pull-error": EventLabel(label: "Pull error", kind: .warn),
        "agent_done": EventLabel(label: "Claude finished the work", kind: .ok),
        "agent_blocked": EventLabel(label: "Claude is waiting for input", kind: .warn),
        "agent_stuck": EventLabel(label: "Claude may be stuck", kind: .danger),
        "schedule_run": EventLabel(label: "Scheduled run started", kind: .info),
        "schedule_skip": EventLabel(label: "Scheduled run skipped", kind: .info),
        "schedule_error": EventLabel(label: "Scheduled run failed", kind: .danger),
        "auto_end": EventLabel(label: "Scheduled run ended itself", kind: .info),
        "auto_end_kept": EventLabel(label: "Worktree kept — uncommitted work", kind: .warn),
        "auto_end_error": EventLabel(label: "Scheduled run failed to end", kind: .danger),
        "terminal_open": EventLabel(label: "Terminal opened", kind: .info),
        "terminal_control": EventLabel(label: "Terminal control taken", kind: .info),
        // 1:1 `dashboard/src/eventLabels.ts` (Task 8 fix): denied/bypass must stay `.danger`,
        // not `.info` — bypass is break-glass, otherwise the audit log would show disabling a protection as
        // a neutral row. "waiting"/"idle" from the web design do not belong in `EventKind` (only
        // info/ok/warn/danger) — requested is `.warn` like `prod_write_proposed`
        // (waiting for a human decision), grant_revoked `.info` like `auto_end`.
        "ssh_key_requested": EventLabel(label: "Agent requested an SSH key", kind: .warn),
        "ssh_key_approved": EventLabel(label: "SSH key approved", kind: .ok),
        "ssh_key_denied": EventLabel(label: "SSH key denied", kind: .danger),
        "ssh_key_access": EventLabel(label: "SSH key handed to ssh-agent", kind: .ok),
        "ssh_key_bypass": EventLabel(label: "SSH gate bypassed (break-glass)", kind: .danger),
        "ssh_grant_revoked": EventLabel(label: "SSH grant revoked", kind: .info),
        "clipboard_access": EventLabel(label: "Clipboard access", kind: .info),
        "critic_pass": EventLabel(label: "Critic approved the work", kind: .ok),
        "critic_block": EventLabel(label: "Critic sent the work back for fixes", kind: .warn),
        "critic_giveup": EventLabel(label: "Critic couldn't agree — released with reservations", kind: .warn),
        "critic_error": EventLabel(label: "Critic failed", kind: .danger),
        "critic_toggle": EventLabel(label: "Critic toggled", kind: .info),
        "prod_db_access": EventLabel(label: "Production DB read", kind: .info),
        "prod_write_proposed": EventLabel(label: "Production write proposed", kind: .warn),
        "prod_write_executed": EventLabel(label: "Production write executed", kind: .ok),
        "prod_write_rejected": EventLabel(label: "Production write rejected", kind: .info),
        "cc_upgraded": EventLabel(label: "Claude Code upgraded", kind: .ok),
        "cc_skipped": EventLabel(label: "cc upgrade skipped", kind: .info),
        "cc_restart_failed": EventLabel(label: "cc restart got stuck", kind: .warn),
        "cc_upgrade_failed": EventLabel(label: "cc upgrade failed", kind: .danger),
        "host_update": EventLabel(label: "System packages upgraded", kind: .info),
        "host_reboot": EventLabel(label: "Machine rebooted from the dashboard", kind: .warn),
    ]

    /// Mirrors `eventLabel` — an unknown type gets itself as the label (`.info`), same as the web.
    nonisolated static func eventLabel(_ type: String) -> EventLabel {
        labels[type] ?? EventLabel(label: type, kind: .info)
    }

    private nonisolated static let detailKeys = [
        "schedule", "branch", "kind", "files", "error", "container", "url", "message",
        "from", "to", "restarted", "stuck", "pane", "reason", "worktree",
    ]

    /// Mirrors `eventDetail` — pulls a few keys out of the messy JSON payload and joins them with a dot.
    nonisolated static func eventDetail(_ data: String?) -> String {
        guard let data, !data.isEmpty,
              let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any]
        else { return "" }
        var parts: [String] = []
        for key in detailKeys {
            guard let value = json[key], !(value is NSNull) else { continue }
            if let array = value as? [Any] {
                parts.append(array.map { "\($0)" }.joined(separator: ", "))
            } else {
                parts.append("\(value)")
            }
        }
        return parts.joined(separator: " · ")
    }

    /// Mirrors `sessionShort` — `dev-` prefix removed, ONLY THE FIRST hyphen to a slash (same
    /// semantics as JS `String.replace` without the global flag).
    nonisolated static func sessionShort(_ sessionId: String?) -> String {
        guard let sessionId, !sessionId.isEmpty else { return "system" }
        guard sessionId.hasPrefix("dev-") else { return sessionId }
        let rest = sessionId.dropFirst(4)
        guard let dashIndex = rest.firstIndex(of: "-") else { return String(rest) }
        return String(rest[rest.startIndex..<dashIndex]) + "/" + String(rest[rest.index(after: dashIndex)...])
    }

    // MARK: - Private

    private func fetchResult<T: Decodable>(_ path: String) async -> Result<T, Error> {
        do {
            return .success(try await client.get(path))
        } catch {
            return .failure(error)
        }
    }

}
