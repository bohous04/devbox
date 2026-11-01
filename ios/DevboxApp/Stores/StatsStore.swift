import Foundation

/// View-model for `StatsScreen` — 1:1 basis from `dashboard/src/pages/Stats.tsx` + its pure
/// helpers (`dashboard/src/lib/range.ts`, `statsView.ts`, `statsHostView.ts`, `workHoursView.ts`).
///
/// Two independent requests as on the web (two separate `useEffect`s): `/api/stats/range` depends on
/// the range AND the project, `/api/stats/work` only on the range (the project filter is handled by `workForProject`
/// client-side, see the web comment — the endpoint would not use a second parameter). A failure of one must not
/// hide the data of the other, hence separate `error`/`workError`.
///
/// NOTE from memory (keep): the Projects leaderboard on the web stays UNFILTERED by the project filter
/// (it is also the toggle — tap = filter) — the app adopts this behaviour 1:1 (see `StatsScreen`).
@MainActor
final class StatsStore: ObservableObject {
    @Published private(set) var range: StatsRange
    @Published private(set) var project: String?
    @Published private(set) var data: RangeStats?
    @Published private(set) var error: String?
    @Published private(set) var options: [String] = []
    @Published private(set) var work: WorkHours?
    @Published private(set) var workError: String?

    private let client: DevdClient

    init(client: DevdClient, now: Date = Date()) {
        self.client = client
        range = Self.presetRange(.today, now: now)
    }

    /// Called by the range picker — changes BOTH datasets (range and work), same as the web (both `useEffect`s
    /// have `range.from`/`range.to` in their dependencies).
    func setRange(_ newRange: StatsRange) async {
        guard newRange != range else { return }
        range = newRange
        await reload()
    }

    /// Called by the project filter — changes ONLY `/api/stats/range` (work hours are filtered client-side).
    func setProject(_ newProject: String?) async {
        guard newProject != project else { return }
        project = newProject
        await reloadRange()
    }

    /// Initial load and the "Try again" button after an error.
    func reload() async {
        async let r: Void = reloadRange()
        async let w: Void = reloadWork()
        _ = await (r, w)
    }

    // MARK: - Pure: rozsah (1:1 `dashboard/src/lib/range.ts`)

    struct StatsRange: Equatable {
        let from: Int
        let to: Int
    }

    enum RangePresetId: String, CaseIterable, Equatable {
        case today, sevenDays = "7d", thirtyDays = "30d", ninetyDays = "90d", month, custom

        var label: String {
            switch self {
            case .today: return "Today"
            case .sevenDays: return "7 days"
            case .thirtyDays: return "30 days"
            case .ninetyDays: return "90 days"
            case .month: return "This month"
            case .custom: return "Custom"
            }
        }
    }

    /// Mirrors `presetRange`. `to` is an exclusive end (tomorrow's midnight), `from` the midnight of the start —
    /// in the device's LOCAL time, just as the web computes in the browser's local time (`Date.setHours`).
    /// The app never sends `.custom` here (see the `RangePresetId` picker below) — TS handles that at the
    /// type level (`Exclude<…, "custom">`), Swift has no such guarantee, hence a defensive fallback to
    /// "today" instead of a crash.
    nonisolated static func presetRange(_ id: RangePresetId, now: Date, calendar: Calendar = .current) -> StatsRange {
        let startOfToday = calendar.startOfDay(for: now)
        let toDate = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday
        let to = Int((toDate.timeIntervalSince1970 * 1000).rounded())
        let fromOfToday = Int((startOfToday.timeIntervalSince1970 * 1000).rounded())
        switch id {
        case .today:
            return StatsRange(from: fromOfToday, to: to)
        case .month:
            let comps = calendar.dateComponents([.year, .month], from: now)
            let startOfMonth = calendar.date(from: comps) ?? startOfToday
            return StatsRange(from: Int((startOfMonth.timeIntervalSince1970 * 1000).rounded()), to: to)
        case .sevenDays, .thirtyDays, .ninetyDays:
            let days = id == .sevenDays ? 7 : id == .thirtyDays ? 30 : 90
            return StatsRange(from: to - days * 86_400_000, to: to)
        case .custom:
            return StatsRange(from: fromOfToday, to: to)
        }
    }

    /// Mirrors `matchPreset` — a foreign range (custom selection in the calendar) is labelled `.custom`.
    nonisolated static func matchPreset(_ r: StatsRange, now: Date, calendar: Calendar = .current) -> RangePresetId {
        for id: RangePresetId in [.today, .sevenDays, .thirtyDays, .ninetyDays, .month] {
            let c = presetRange(id, now: now, calendar: calendar)
            if c.from == r.from && c.to == r.to { return id }
        }
        return .custom
    }

    /// Mirrors `rangeFromDraft` — `nil` until the user has picked at least a start. The end is an exclusive
    /// tomorrow's midnight (the last selected day is fully inside); the tap order is normalized.
    nonisolated static func rangeFromDraft(from: Date?, to: Date?, calendar: Calendar = .current) -> StatsRange? {
        guard let from else { return nil }
        let a = calendar.startOfDay(for: from)
        let b = calendar.startOfDay(for: to ?? from)
        let (lo, hi) = a <= b ? (a, b) : (b, a)
        let hiNext = calendar.date(byAdding: .day, value: 1, to: hi) ?? hi
        return StatsRange(
            from: Int((lo.timeIntervalSince1970 * 1000).rounded()),
            to: Int((hiNext.timeIntervalSince1970 * 1000).rounded())
        )
    }

    /// Mirrors `rangeDays` — number of whole days, decides whether drawing a daily series makes sense.
    nonisolated static func rangeDays(_ r: StatsRange) -> Int {
        Int((Double(r.to - r.from) / 86_400_000).rounded())
    }

    // MARK: - Pure: leaderboards (1:1 `dashboard/src/statsView.ts`)

    struct Ranked: Equatable {
        let key: String
        let cost: Double
        let tokens: Int
    }

    nonisolated static func rankedProjects(_ rows: [RangeStats.ProjectEntry]) -> [Ranked] {
        rows.map { Ranked(key: $0.project, cost: $0.cost, tokens: $0.tokens) }
    }

    nonisolated static func rankedModels(_ rows: [RangeStats.ModelEntry]) -> [Ranked] {
        rows.map { Ranked(key: $0.model, cost: $0.cost, tokens: $0.tokens) }
    }

    nonisolated static func rankedRepos(_ rows: [RangeStats.RepoEntry]) -> [Ranked] {
        rows.map { Ranked(key: $0.repo, cost: $0.cost, tokens: $0.tokens) }
    }

    /// Mirrors `projectOptions` — alphabetical, the "—" bucket (no attribute) is left out of the options
    /// (it cannot be filtered on), the active project is always in the options (even with no data in the range).
    nonisolated static func projectOptions(_ projects: [String], active: String?) -> [String] {
        var keys = projects.filter { !$0.isEmpty && $0 != "—" }
        if let active { keys.append(active) }
        return Array(Set(keys)).sorted()
    }

    /// Mirrors `share` — an empty total returns 0, not NaN.
    nonisolated static func share(_ part: Double, _ total: Double) -> Double {
        guard total.isFinite, total > 0 else { return 0 }
        return max(0, (part / total) * 100)
    }

    nonisolated static func totalCost(_ rows: [Ranked]) -> Double {
        rows.reduce(0) { $0 + $1.cost }
    }

    /// Mirrors `page` — a page out of range is clamped to the last existing one.
    nonisolated static func page<T>(_ rows: [T], _ pageIndex: Int, perPage: Int = 25) -> (items: [T], page: Int, pages: Int) {
        let pages = max(1, Int(ceil(Double(rows.count) / Double(perPage))))
        let p = min(max(pageIndex, 0), pages - 1)
        let start = p * perPage
        let end = min(start + perPage, rows.count)
        return (start < end ? Array(rows[start..<end]) : [], p, pages)
    }

    /// "09:00" for the hour-of-day axis.
    nonisolated static func hourLabel(_ h: Int) -> String {
        String(format: "%02d:00", h)
    }

    /// Busiest hour of the day — `nil` when no work was done.
    nonisolated static func peakHour(_ hourly: [RangeStats.HourlyPoint]) -> Int? {
        var best: (hour: Int, v: Double)?
        for h in hourly {
            let v = h.hours > 0 ? h.hours : 0
            if v > 0, best == nil || v > best!.v { best = (h.hour, v) }
        }
        return best?.hour
    }

    /// Duration in ms → short label for tiles; 0 or a negative value returns "—", not "0 s".
    nonisolated static func msLabel(_ ms: Double) -> String {
        guard ms.isFinite, ms > 0 else { return "—" }
        let s = Int((ms / 1000).rounded())
        if s < 60 { return "\(s) s" }
        let m = s / 60
        if m < 60 { return "\(m) min" }
        let h = m / 60
        let rem = m % 60
        return rem != 0 ? "\(h) h \(rem) min" : "\(h) h"
    }

    /// Label for a quantile without data returns "—" — prompt statistics start on the day of the deploy.
    nonisolated static func quantileLabel(_ q: Quantiles?, _ fmt: (Double) -> String) -> String {
        guard let q, q.count > 0 else { return "—" }
        return fmt(q.p50)
    }

    // MARK: - Pure: host switcher (1:1 `dashboard/src/statsHostView.ts`)

    struct HostTotals: Equatable {
        let cost: Double
        let tokens: Int
        let hours: Double
        static let zero = HostTotals(cost: 0, tokens: 0, hours: 0)
    }

    static let allHosts = "all"

    /// Mirrors `hostOptions` — alphabetical, so the switcher does not jump between loads.
    nonisolated static func hostOptions(_ data: RangeStats) -> [String] {
        data.hosts.map(\.key).sorted()
    }

    private nonisolated static func pick(_ rows: [HostStat], _ host: String) -> HostTotals {
        guard let r = rows.first(where: { $0.key == host }) else { return .zero }
        return HostTotals(cost: r.cost, tokens: r.tokens, hours: r.hours)
    }

    nonisolated static func totalsFor(_ data: RangeStats, _ host: String) -> HostTotals {
        host == allHosts
            ? HostTotals(cost: data.totals.cost, tokens: data.totals.tokens, hours: data.totals.hours)
            : pick(data.hosts, host)
    }

    nonisolated static func previousFor(_ data: RangeStats, _ host: String) -> HostTotals {
        host == allHosts
            ? HostTotals(cost: data.previous.cost, tokens: data.previous.tokens, hours: data.previous.hours)
            : pick(data.hostsPrevious, host)
    }

    /// Mirrors `seriesFor` — "all" returns a series per host, a specific host one; an unknown host
    /// returns `[[]]` (one empty dataset), not `[]`, so the chart is not left without a section at all.
    nonisolated static func seriesFor(_ data: RangeStats, _ host: String) -> [[RangeStats.DailyPoint]] {
        if host == allHosts { return data.dailyByHost.map(\.days) }
        guard let one = data.dailyByHost.first(where: { $0.host == host }) else { return [[]] }
        return [one.days]
    }

    /// The host actually used in the UI — falls back to "all" if the selected host does not exist in the data
    /// (current range) (the switcher can get "lost" by changing the range).
    nonisolated static func effectiveHost(_ host: String, options: [String]) -> String {
        host == allHosts || options.contains(host) ? host : allHosts
    }

    /// Mirrors `unknownLabel` — "—" (SQL fallback for a missing attribute) is labelled Unknown.
    nonisolated static func unknownLabel(_ key: String) -> String {
        key == "—" ? "Unknown" : key
    }

    /// Mirrors `hostLabel`.
    nonisolated static func hostLabel(_ host: String) -> String {
        if host == "mac" { return "Mac" }
        if host == "devbox" { return "Devbox" }
        return unknownLabel(host)
    }

    // MARK: - Pure: metrika grafu (Stats.tsx `METRICS`) a delta karet

    enum Metric: String, CaseIterable {
        case cost, tokens, hours
        var label: String {
            switch self {
            case .cost: return "Cost"
            case .tokens: return "Tokens"
            case .hours: return "Active time"
            }
        }
    }

    nonisolated static func format(_ metric: Metric, _ value: Double) -> String {
        switch metric {
        case .cost: return Format.usd(value)
        case .tokens: return Format.compactNumber(value)
        case .hours: return String(format: "%.1f h", value)
        }
    }

    nonisolated static func value(of metric: Metric, in totals: HostTotals) -> Double {
        switch metric {
        case .cost: return totals.cost
        case .tokens: return Double(totals.tokens)
        case .hours: return totals.hours
        }
    }

    /// Mirrors `delta` in `Stats.tsx` — percentage change against the previous period; `nil` when
    /// the previous period has nothing to compare against (prev <= 0), not a division by zero.
    nonisolated static func delta(_ cur: Double, _ prev: Double) -> Double? {
        prev <= 0 ? nil : ((cur - prev) / prev) * 100
    }

    /// "7/26" (M/D) for the X axis label of the daily chart — mirrors
    /// `toLocaleDateString("en-US", { day: "numeric", month: "numeric" })`.
    nonisolated static func dayLabel(_ ms: Int, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let comps = calendar.dateComponents([.month, .day], from: date)
        return "\(comps.month ?? 0)/\(comps.day ?? 0)"
    }

    // MARK: - Pure: Work hours (1:1 `dashboard/src/workHoursView.ts`)

    /// Mirrors `formatHours` — "1h 30m", not "1.5"; zero is "0m", not "0h" (not to be confused with a rounding
    /// error). Rounding is done on TOTAL minutes, not separately on h/m — otherwise
    /// the hour boundary would give "…h 60m" instead of a carry.
    nonisolated static func formatHours(_ h: Double) -> String {
        let totalMinutes = Int((h * 60).rounded())
        let hh = totalMinutes / 60
        let mm = totalMinutes % 60
        if hh == 0 { return "\(mm)m" }
        if mm == 0 { return "\(hh)h" }
        return "\(hh)h \(mm)m"
    }

    struct WorkView: Equatable {
        let totalHours: Double
        let byProject: [WorkHours.ByProject]
    }

    /// Mirrors `workForProject` — filtered client-side (`byProject` already has the per-project breakdown).
    nonisolated static func workForProject(_ w: WorkHours, _ project: String?) -> WorkView {
        guard let project else { return WorkView(totalHours: w.totalHours, byProject: w.byProject) }
        let filtered = w.byProject.filter { $0.project == project }
        return WorkView(totalHours: filtered.reduce(0) { $0 + $1.hours }, byProject: filtered)
    }

    /// Mirrors `cappedNote` — only where the 30 min/turn cap actually cut off some interval.
    nonisolated static func cappedNote(_ p: WorkHours.ByProject) -> String? {
        guard p.cappedHours > 0 else { return nil }
        return "\(formatHours(p.cappedHours)) capped by the 30-min-per-turn limit — actual work took longer"
    }

    // MARK: - Private

    private func reloadRange() async {
        data = nil
        error = nil
        do {
            var path = "/api/stats/range?from=\(range.from)&to=\(range.to)"
            if let project, let encoded = project.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                path += "&project=\(encoded)"
            }
            let d: RangeStats = try await client.get(path)
            data = d
            options = Self.projectOptions(d.projects.map(\.project), active: project)
        } catch {
            self.error = errorText(error)
        }
    }

    private func reloadWork() async {
        work = nil
        workError = nil
        do {
            work = try await client.get("/api/stats/work?from=\(range.from)&to=\(range.to)")
        } catch {
            workError = errorText(error)
        }
    }

}
