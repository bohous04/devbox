import Foundation

/// View-model for `HardwareScreen` — 1:1 basis from `dashboard/src/pages/Hardware.tsx` + its pure
/// helper `dashboard/src/hardwareView.ts`. The snapshot (`/api/hardware`) is polled every 20 s like on
/// the web (it is only a read from the server cache, see the web comment "no load on SSH"); the history
/// of one machine (`/api/hardware/:id/series`) is fetched separately, only for the selected machine and window.
///
/// Actions (backup/update/reboot) are mutations on a REAL machine — the app only WIRES them up (see
/// `HardwareScreen` `ConfirmationDialog`); it never runs them on its own.
@MainActor
final class HardwareStore: ObservableObject {
    @Published private(set) var snapshot: HardwareSnapshot?
    @Published private(set) var error: String?
    @Published private(set) var series: [MachineSample]?
    @Published private(set) var seriesError: String?
    @Published private(set) var diskStats: DiskStats?

    /// Warning threshold for the "Workspaces" gauge — the web reads it from `config.settings.diskWarnPercent`
    /// (default 80). `DevdConfig` in the app currently carries only `version` (the config editor is stage G,
    /// see the task brief "Models.swift only new types" — do not touch an existing type), so the app
    /// stays on the web's default value until the config editor is added.
    let diskWarnPercent: Double = 80

    private let client: DevdClient
    private let pollInterval: Duration
    private var pollTask: Task<Void, Never>?

    init(client: DevdClient, pollInterval: Duration = .seconds(20)) {
        self.client = client
        self.pollInterval = pollInterval
    }

    /// Idempotent — a second call without `stop()` in between does not double the polling.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.load()
                if Task.isCancelled { return }
                try? await Task.sleep(for: self.pollInterval)
            }
        }
        Task { [weak self] in await self?.loadWorkspaceDisk() }
    }

    /// Idempotent — calling it without running polling is a no-op.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    deinit {
        pollTask?.cancel()
    }

    func load() async {
        do {
            snapshot = try await client.get("/api/hardware")
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    func loadSeries(machineId: String, range: SeriesRange) async {
        series = nil
        seriesError = nil
        do {
            series = try await client.get("/api/hardware/\(machineId)/series?range=\(range.rawValue)")
        } catch {
            series = []
            seriesError = errorText(error)
        }
    }

    /// Action — POST and immediately refresh the snapshot (the result should appear in the UI right away,
    /// not after the next poll, same as the web `onRan`/`onAction`).
    func runBackup(_ id: String) async throws {
        try await client.postVoid("/api/hardware/\(id)/backup/run", body: nil)
        await load()
    }

    func runUpdate(_ id: String) async throws {
        try await client.postVoid("/api/hardware/\(id)/update", body: nil)
        await load()
    }

    /// Reboot does NOT call `load()` after the request finishes — the machine (and for the devbox, devd with
    /// it) is in the middle of restarting, a refresh would fail anyway. The reboot banner is held by
    /// `HardwareScreen` itself (`rebootBanner`); the snapshot fills in on the next regular poll.
    func rebootHost(_ id: String) async throws {
        try await client.postVoid("/api/hardware/\(id)/reboot", body: nil)
    }

    private func loadWorkspaceDisk() async {
        diskStats = try? await client.get("/api/stats/disk")
    }

    // MARK: - Pure: stav stroje (1:1 `dashboard/src/hardwareView.ts`)

    enum DotKind: Equatable { case ok, danger, off }

    /// Mirrors `machineDot` — Beszel status takes precedence, otherwise it is judged by the probe.
    nonisolated static func machineDot(_ m: Machine) -> DotKind {
        if let beszel = m.beszel { return beszel.status == "up" ? .ok : .danger }
        if m.host != nil { return .ok }
        return .off
    }

    enum Tone: Equatable { case ok, warn, danger }

    /// Mirrors `backupTone` — `running` is green, it is in progress, not a problem.
    nonisolated static func backupTone(_ state: String?) -> Tone? {
        guard let state else { return nil }
        if state == "ok" || state == "running" { return .ok }
        if state == "failed" { return .danger }
        if state == "unknown" { return .warn }
        return nil
    }

    /// Mirrors `attentionItems` — an empty array means "you don't need to look".
    nonisolated static func attentionItems(_ m: Machine) -> [String] {
        var items: [String] = []
        let updates = m.host?.updates.count ?? 0
        if m.host?.rebootRequired == true { items.append("reboot required") }
        if updates > 0 { items.append("\(updates) update\(updates == 1 ? "" : "s")") }
        if let backup = m.backup, backup.state == "failed" { items.append("backup failed") }
        if !m.errors.isEmpty { items.append("\(m.errors.count) error\(m.errors.count == 1 ? "" : "s")") }
        return items
    }

    /// Mirrors `backupAge` — age of the last backup in ms; `nil` when one has never completed.
    nonisolated static func backupAge(_ m: Machine, now: Date) -> Double? {
        guard let at = m.backup?.finishedAt ?? m.backup?.repo?.lastArchiveAt else { return nil }
        return max(0, now.timeIntervalSince1970 * 1000 - Double(at))
    }

    /// Mirrors the colour of the "Last run" StatCard on the web:
    /// `tone={stale || backupTone(b.state) === "danger" ? "warn" : backupTone(b.state) === "ok" ? "ok" : undefined}`.
    /// An old backup is a warning even when the last RUN finished fine (stale takes precedence).
    nonisolated static func lastRunTone(stale: Bool, state: String?) -> Tone? {
        if stale || backupTone(state) == .danger { return .warn }
        if backupTone(state) == .ok { return .ok }
        return nil
    }

    /// Mirrors `backupStale` — older than 26 h (daily timer + margin for drift) is suspicious;
    /// "never completed" is worse than "I know it didn't", hence `true` as well.
    nonisolated static func backupStale(_ m: Machine, now: Date) -> Bool {
        guard m.backup != nil else { return false }
        guard let age = backupAge(m, now: now) else { return true }
        return age > 26 * 3600_000
    }

    private nonisolated static let runtimePrefixes = ["docker", "containerd", "runc", "podman"]
    private nonisolated static let kernelPrefixes = ["linux-image", "linux-headers"]

    /// Mirrors `disruptiveUpdates` — packages whose upgrade RESTARTS RUNNING CONTAINERS
    /// (learned the hard way: docker-ce & co. restart docker and take down the session containers).
    nonisolated static func disruptiveUpdates(_ updates: [PendingUpdate]) -> [String] {
        updates.filter { u in runtimePrefixes.contains { u.pkg.hasPrefix($0) } }.map(\.pkg)
    }

    /// Mirrors `kernelUpdates` — a new kernel has no effect by itself, it only wants a restart.
    nonisolated static func kernelUpdates(_ updates: [PendingUpdate]) -> [String] {
        updates.filter { u in kernelPrefixes.contains { u.pkg.hasPrefix($0) } }.map(\.pkg)
    }

    /// Mirrors `upgrading` from `Updates` (Hardware.tsx): `m.upgrade?.state === "running"`. Server state,
    /// not a local "I just tapped" — SERVER state wins, because apt runs detached on the host and
    /// stays `"running"` even after the app is closed or the screen restarted, where a local `busy`
    /// would long since have dropped back to `false`.
    nonisolated static func isUpgrading(_ m: Machine) -> Bool {
        m.upgrade?.state == "running"
    }

    /// Mirrors `disabled={upgrading || h.updates.length === 0}` — the app additionally applies the guard to BOTH
    /// button variants (disruptive `ConfirmButton` and plain `ActionButton`), while the web has it only
    /// on the latter; unified on purpose (review) so a second install cannot be fired while the first
    /// is still running on the server. `localBusy` is only a supplement for IMMEDIATE feedback between the tap
    /// and the first poll — on its own it never unlocks a button the server reports as `"running"`.
    nonisolated static func updatesButtonDisabled(_ m: Machine, localBusy: Bool) -> Bool {
        guard let h = m.host else { return true }
        return localBusy || isUpgrading(m) || h.updates.isEmpty
    }

    // MARK: - Pure: grafy historie

    enum MetricKey: String, CaseIterable {
        case cpu, mem, disk, net

        var label: String {
            switch self {
            case .cpu: return "CPU"
            case .mem: return "Memory"
            case .disk: return "Disk"
            case .net: return "Network"
            }
        }

        var unit: String {
            self == .net ? "kB/s" : "%"
        }
    }

    struct ChartPoint: Equatable {
        let at: Int
        let a: Double
        let b: Double?
    }

    /// Mirrors `toChart` — network has two curves (up/down), the rest one.
    nonisolated static func toChart(_ samples: [MachineSample], _ metric: MetricKey) -> [ChartPoint] {
        samples.map { s in
            switch metric {
            case .cpu: return ChartPoint(at: s.at, a: s.cpu, b: nil)
            case .mem: return ChartPoint(at: s.at, a: s.memPct, b: nil)
            case .disk: return ChartPoint(at: s.at, a: s.diskPct, b: nil)
            case .net: return ChartPoint(at: s.at, a: s.netDownKbs, b: s.netUpKbs)
            }
        }
    }

    /// Y axis — percentages have a fixed domain 0–100 (otherwise recharts/Charts stretches a flat curve
    /// over the full height), network scales from the data.
    nonisolated static func chartDomain(_ metric: MetricKey) -> ClosedRange<Double>? {
        metric == .net ? nil : 0...100
    }

    /// Mirrors `timeLabel` — short windows want hours+minutes, weekly ones the day too. Device local
    /// time, just as the web reads `Date` methods in the browser's local time.
    ///
    /// Stays defined and tested for parity with the web (same approach as `StatsStore.page`,
    /// see the comment on `LeaderboardSection` in StatsScreen.swift), but the app does not call it in its chart:
    /// the web uses it to build the label for EVERY point on the recharts X axis by hand, whereas native Swift Charts
    /// (`historyChart` in HardwareScreen.swift) places and formats the ticks itself via
    /// `AxisValueLabel(format: .dateTime...)` — a custom string would have to bypass the automatic
    /// axis spacing and would duplicate what the framework handles better on its own.
    nonisolated static func timeLabel(_ at: Int, _ range: SeriesRange, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(at) / 1000)
        let comps = calendar.dateComponents([.day, .hour, .minute], from: date)
        let hh = String(format: "%02d", comps.hour ?? 0)
        let mm = String(format: "%02d", comps.minute ?? 0)
        if range == .sevenDays { return "\(comps.day ?? 0). \(hh):00" }
        return "\(hh):\(mm)"
    }

    /// Mirrors `uptimeLabel` — two decimal places, otherwise everything looks like "100 %".
    nonisolated static func uptimeLabel(_ v: Double?) -> String {
        guard let v else { return "—" }
        return String(format: "%.2f %%", v * 100)
    }

    /// Mirrors `groupMonitors` — a group with an outage goes to the top, otherwise alphabetical.
    nonisolated static func groupMonitors(_ monitors: [Monitor]) -> [(tag: String, monitors: [Monitor])] {
        var by: [String: [Monitor]] = [:]
        var order: [String] = []
        for m in monitors {
            let key = m.tag ?? "other"
            if by[key] == nil { order.append(key) }
            by[key, default: []].append(m)
        }
        return order.map { (tag: $0, monitors: by[$0]!) }
            .sorted { a, b in
                let aAllUp = a.monitors.allSatisfy { $0.up } ? 1 : 0
                let bAllUp = b.monitors.allSatisfy { $0.up } ? 1 : 0
                if aAllUp != bAllUp { return aAllUp < bAllUp }
                return a.tag < b.tag
            }
    }

    /// Mirrors `fillLabel` — usage below 1 % is not shown as "0 %" (the Storage Box is 0.19 %
    /// full and rounding would look like a broken value).
    nonisolated static func fillLabel(_ part: Double, _ total: Double) -> String {
        guard total > 0 else { return "—" }
        let pct = (part / total) * 100
        if pct > 0 && pct < 1 { return "< 1 %" }
        return "\(Int(pct.rounded())) %"
    }

    /// Mirrors `certTone` — under 14 days a warning, at/below 0 an error.
    nonisolated static func certTone(_ days: Int?) -> Tone? {
        guard let days else { return nil }
        if days <= 0 { return .danger }
        return days <= 14 ? .warn : nil
    }

    /// Cap after which the banner fades even without proof that the machine is back.
    nonisolated static let rebootBannerMaxMs: Double = 10 * 60_000

    /// Mirrors `rebootBanner` — text after tapping Reboot, `nil` = don't show. It disappears on its own
    /// once the probe brings an uptime SHORTER than the time since the tap; an unknown uptime (the machine is
    /// currently offline) keeps the banner; after `rebootBannerMaxMs` it fades even without proof of return.
    nonisolated static func rebootBanner(rebootedAt: Date?, uptimeSec: Int?, now: Date) -> String? {
        guard let rebootedAt else { return nil }
        let elapsed = now.timeIntervalSince(rebootedAt) * 1000
        if elapsed > rebootBannerMaxMs { return nil }
        if let uptimeSec, Double(uptimeSec) * 1000 < elapsed { return nil }
        let minutes = max(1, Int((elapsed / 60_000).rounded()))
        return "Rebooting — initiated \(minutes) min ago. The machine goes down and comes back on its own; this page may briefly fail to refresh in the meantime."
    }

}
