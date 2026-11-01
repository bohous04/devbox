import Charts
import SwiftUI

/// Stats screen — mirrors `dashboard/src/pages/Stats.tsx` (see `StatsStore` for the pure helpers and
/// fetch). Layout follows the web: sections + cards (`ScreenScroll`), tinted `MetricCard`s at the top —
/// content and behavior (ranges, project filter, host switch, charts, leaderboards) are 1:1.
///
/// Simplification vs. the web (see task report): the daily chart for "All" hosts draws the TOTAL series
/// (`data.daily`), not a per-host breakdown into multicolored stacked areas — on a phone the
/// individual host curves could not be told apart anyway. The host switch above the cards/tables works
/// unchanged. The "Cost by model" pie chart is replaced by a sorted list with the same numbers
/// (percent + cost) — a donut on a small area adds nothing to the table below it.
struct StatsScreen: View {
    @StateObject private var store: StatsStore
    @State private var hostSelection = StatsStore.allHosts
    @State private var metric: StatsStore.Metric = .cost
    @State private var showCustomSheet = false
    @State private var customFrom = Date()
    @State private var customTo = Date()

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: StatsStore(client: client))
    }

    var body: some View {
        ScreenScroll {
            rangeSection
            if let error = store.error {
                EmptyStateRow(
                    title: "Failed to load stats", hint: error,
                    action: ("Try again", { Task { await store.reload() } })
                )
            } else if let data = store.data {
                content(data)
            } else {
                Card { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Statistics")
        .task { await store.reload() }
        .refreshable { await store.reload() }
        .sheet(isPresented: $showCustomSheet) { customRangeSheet }
    }

    // MARK: - Range + project picker

    @ViewBuilder
    private var rangeSection: some View {
        let activePreset = StatsStore.matchPreset(store.range, now: .now)
        VStack(spacing: 8) {
            Menu {
                ForEach(StatsStore.RangePresetId.allCases.filter { $0 != .custom }, id: \.self) { id in
                    Button(id.label) { Task { await store.setRange(StatsStore.presetRange(id, now: .now)) } }
                }
                Button("Custom…") {
                    customFrom = Date(timeIntervalSince1970: Double(store.range.from) / 1000)
                    customTo = Date(timeIntervalSince1970: Double(max(store.range.from, store.range.to - 86_400_000)) / 1000)
                    showCustomSheet = true
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                    Text(activePreset.label)
                    Spacer()
                    Text(rangeSpanLabel).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10))
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(DevboxButtonStyle(variant: .outline))

            Menu {
                Picker("Project", selection: Binding(
                    get: { store.project ?? "" },
                    set: { newValue in Task { await store.setProject(newValue.isEmpty ? nil : newValue) } }
                )) {
                    Text("All projects").tag("")
                    ForEach(store.options, id: \.self) { p in Text(p).tag(p) }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                    Text(store.project ?? "All projects").lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(DevboxButtonStyle(variant: .outline))
        }
    }

    private var rangeSpanLabel: String {
        let from = Date(timeIntervalSince1970: Double(store.range.from) / 1000)
        let to = Date(timeIntervalSince1970: Double(store.range.to - 86_400_000) / 1000)
        let fmt = DateFormatter()
        fmt.setLocalizedDateFormatFromTemplate("dM")
        return store.range.to - store.range.from <= 86_400_000 ? fmt.string(from: from) : "\(fmt.string(from: from)) – \(fmt.string(from: to))"
    }

    private var customRangeSheet: some View {
        NavigationStack {
            Form {
                DatePicker("From", selection: $customFrom, in: ...Date(), displayedComponents: .date)
                DatePicker("To", selection: $customTo, in: ...Date(), displayedComponents: .date)
            }
            .navigationTitle("Custom range")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showCustomSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        if let r = StatsStore.rangeFromDraft(from: customFrom, to: customTo) {
                            Task { await store.setRange(r) }
                        }
                        showCustomSheet = false
                    }
                }
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ data: RangeStats) -> some View {
        let hosts = StatsStore.hostOptions(data)
        let effHost = StatsStore.effectiveHost(hostSelection, options: hosts)
        let totals = StatsStore.totalsFor(data, effHost)
        let previous = StatsStore.previousFor(data, effHost)
        let hasData = data.totals.cost > 0 || data.totals.tokens > 0 || data.totals.hours > 0
        let days = StatsStore.rangeDays(store.range)

        if hosts.count > 1 {
            Picker("Host", selection: $hostSelection) {
                Text("All").tag(StatsStore.allHosts)
                ForEach(hosts, id: \.self) { h in Text(StatsStore.hostLabel(h)).tag(h) }
            }
            .pickerStyle(.segmented)
        }

        VStack(alignment: .leading, spacing: Theme.S.gridGap) {
            MetricCard(kind: .cost, value: Format.usd(totals.cost), change: StatsStore.delta(totals.cost, previous.cost))
            MetricCard(kind: .tokens, value: Format.compactNumber(Double(totals.tokens)), change: StatsStore.delta(Double(totals.tokens), Double(previous.tokens)))
            MetricCard(kind: .hours, value: String(format: "%.1f h", totals.hours), change: StatsStore.delta(totals.hours, previous.hours))
            Text("Active time is the agent's active telemetry time, not wall-clock — see Work hours below.")
                .font(Theme.F.meta)
                .foregroundStyle(Theme.C.mutedForeground)
        }

        if store.project != nil, !hasData {
            EmptyStateRow(
                title: "No data for \(store.project!) in this period",
                hint: "The project has no cost, tokens or agent activity in the selected range.",
                action: ("Show all projects", { Task { await store.setProject(nil) } })
            )
        }

        if days > 1 {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Daily trend")
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        Picker("Metric", selection: $metric) {
                            ForEach(StatsStore.Metric.allCases, id: \.self) { m in Text(m.label).tag(m) }
                        }
                        .pickerStyle(.segmented)
                        dailyChart(data, host: effHost)
                    }
                }
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                "Active time by hour of day",
                trailing: StatsStore.peakHour(data.hourly).map { "busiest around \(StatsStore.hourLabel($0))" }
            )
            Card { hourlyChart(data) }
        }

        workHoursSection

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Your prompts")
            LazyVGrid(columns: [GridItem(.flexible(), spacing: Theme.S.gridGap), GridItem(.flexible(), spacing: Theme.S.gridGap)], spacing: Theme.S.gridGap) {
                StatCard(
                    label: "Median prompt",
                    value: StatsStore.quantileLabel(data.prompts.chars, { Format.compactNumber($0) }),
                    caption: data.prompts.chars.count > 0 ? "\(data.prompts.chars.count) prompts" : "collected since launch"
                )
                StatCard(
                    label: "Median wait",
                    value: StatsStore.quantileLabel(data.prompts.waitMs, StatsStore.msLabel),
                    caption: data.prompts.waitMs.count > 0 ? "idle between turns" : "collected since launch"
                )
                StatCard(
                    label: "p90 wait",
                    value: data.prompts.waitMs.count > 0 ? StatsStore.msLabel(data.prompts.waitMs.p90) : "—",
                    caption: "slowest 10 %"
                )
            }
        }

        // The project leaderboard is deliberately NOT filtered by the server — it is both a switch (click =
        // filter) and context for how much of the total a project takes. Repos/Models are view-only.
        LeaderboardSection(
            title: "Projects", rows: StatsStore.rankedProjects(data.projects),
            onPick: { key in Task { await store.setProject(store.project == key ? nil : key) } },
            active: store.project
        )
        LeaderboardSection(title: "Repositories", rows: StatsStore.rankedRepos(data.repos), onPick: nil, active: nil)
        LeaderboardSection(title: "Models", rows: StatsStore.rankedModels(data.models), onPick: nil, active: nil)

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("By account")
            if data.accounts.isEmpty {
                EmptyState("No account data")
            } else {
                Card {
                    VStack(spacing: 10) {
                        ForEach(Array(data.accounts.enumerated()), id: \.element.key) { i, a in
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(Theme.C.accounts[i % Theme.C.accounts.count])
                                    .frame(width: 8, height: 8)
                                Text(a.key == "—" ? StatsStore.unknownLabel(a.key) : String(a.key.prefix(8)))
                                    .font(.system(size: 13, design: .monospaced))
                                Spacer()
                                Text(Format.usd(a.cost)).font(.system(size: 13, design: .monospaced))
                                Text(Format.compactNumber(Double(a.tokens)))
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(Theme.C.mutedForeground)
                                    .frame(width: 60, alignment: .trailing)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Charts

    @ViewBuilder
    private func dailyChart(_ data: RangeStats, host: String) -> some View {
        let points: [RangeStats.DailyPoint] = host == StatsStore.allHosts ? data.daily : (StatsStore.seriesFor(data, host).first ?? [])
        let hasData = points.contains { $0.cost > 0 || $0.tokens > 0 || $0.hours > 0 }
        if !hasData {
            EmptyStateRow(title: "No data for this period", hint: "Try a different date range.", action: nil)
        } else {
            // A time axis (Date), not string categories — `.automatic` then picks a few readable
            // days by itself; with categories Charts would truncate every label to the width of one day ("…").
            Chart(points, id: \.day) { p in
                let v = metricValue(metric, p)
                let day = Date(timeIntervalSince1970: Double(p.day) / 1000)
                AreaMark(x: .value("Day", day, unit: .day), y: .value(metric.label, v))
                    .foregroundStyle(Theme.C.chart[0].opacity(0.2))
                LineMark(x: .value("Day", day, unit: .day), y: .value(metric.label, v))
                    .foregroundStyle(Theme.C.chart[0])
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.defaultDigits))
                }
            }
            .frame(height: 220)
        }
    }

    private func metricValue(_ metric: StatsStore.Metric, _ p: RangeStats.DailyPoint) -> Double {
        switch metric {
        case .cost: return p.cost
        case .tokens: return Double(p.tokens)
        case .hours: return p.hours
        }
    }

    @ViewBuilder
    private func hourlyChart(_ data: RangeStats) -> some View {
        let hasData = data.totals.cost > 0 || data.totals.tokens > 0 || data.totals.hours > 0
        if !hasData {
            EmptyStateRow(title: "Nothing worked in this period", hint: nil, action: nil)
        } else {
            // A numeric hour axis (not string categories) — with categories Charts truncates every label
            // to the width of one column ("…", see screenshot Task 11), even when it shows fewer of them.
            Chart(data.hourly, id: \.hour) { h in
                BarMark(x: .value("Hour", h.hour), y: .value("Hours", h.hours), width: .fixed(8))
                    .foregroundStyle(Theme.C.chart[0])
            }
            .chartXScale(domain: -0.5...23.5)
            .chartXAxis {
                AxisMarks(values: [0, 4, 8, 12, 16, 20]) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let hour = value.as(Int.self) { Text(StatsStore.hourLabel(hour)) }
                    }
                }
            }
            .frame(height: 180)
        }
    }

    // MARK: - Work hours

    @ViewBuilder
    private var workHoursSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Work hours")
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    if let workError = store.workError {
                        EmptyStateRow(title: "Failed to load work hours", hint: workError, action: nil)
                    } else if let work = store.work {
                        let shown = StatsStore.workForProject(work, store.project)
                        if shown.byProject.isEmpty {
                            Text(store.project != nil ? "No tracked work for \(store.project!) in this period" : "No tracked work in this period")
                                .font(Theme.F.body)
                                .foregroundStyle(Theme.C.mutedForeground)
                        } else {
                            Text(StatsStore.formatHours(shown.totalHours))
                                .font(Theme.F.statValue)
                            ForEach(shown.byProject, id: \.project) { p in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack {
                                        Text(p.project).font(Theme.F.body)
                                        Spacer()
                                        Text(StatsStore.formatHours(p.hours)).font(.system(size: 13, design: .monospaced))
                                    }
                                    if let note = StatsStore.cappedNote(p) {
                                        Text(note).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                                    }
                                }
                            }
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    Text("wall-clock, prompt to end of turn — not the active time above")
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.mutedForeground)
                }
            }
        }
    }
}

// MARK: - Leaderboard (dashboard/src/pages/Stats.tsx `Leaderboard`)

private struct LeaderboardSection: View {
    let title: String
    let rows: [StatsStore.Ranked]
    let onPick: ((String) -> Void)?
    let active: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionHeader(title)
                if rows.count > 5 {
                    // The web paginates by 25 (see `StatsStore.page`, a port of the web `page()` — it stays
                    // defined and tested for parity, but the app does not call it here): the screen's `LazyVStack`
                    // draws rows lazily, so "Show all" can render the whole
                    // leaderboard at once without its own pagination — nobody clicks through hundreds of rows on a phone.
                    Button(expanded ? "Show top 5" : "Show all \(rows.count)") { expanded.toggle() }
                        .font(Theme.F.meta.weight(.medium))
                        .foregroundStyle(Theme.C.foreground)
                }
            }
            if rows.isEmpty {
                EmptyState("No activity in this period")
            } else {
                let total = StatsStore.totalCost(rows)
                let shown = expanded ? rows : Array(rows.prefix(5))
                Card {
                    VStack(spacing: 10) {
                        ForEach(Array(shown.enumerated()), id: \.element.key) { i, r in
                            row(r, index: i, total: total)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ r: StatsStore.Ranked, index: Int, total: Double) -> some View {
        // We do not give the "—" row (a bucket without the attribute) a drill-down — it cannot be filtered on.
        let pickable = onPick != nil && r.key != "—"
        let share = StatsStore.share(r.cost, total)
        let content = HStack(spacing: 10) {
            Text(String(format: "%02d", index + 1))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.C.mutedForeground)
            VStack(alignment: .leading, spacing: 4) {
                Text(StatsStore.unknownLabel(r.key)).font(Theme.F.body.weight(.medium)).lineLimit(1)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.C.muted)
                        Capsule()
                            .fill(Theme.C.accounts[index % Theme.C.accounts.count])
                            .frame(width: geo.size.width * CGFloat(share / 100))
                    }
                }
                .frame(height: 6)
            }
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.usd(r.cost)).font(.system(size: 13, design: .monospaced))
                Text("\(Format.compactNumber(Double(r.tokens))) tok · \(Int(share.rounded()))%")
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
        if pickable {
            Button { onPick!(r.key) } label: {
                content
                    .padding(.vertical, 4)
                    .padding(.horizontal, 6)
                    .background(
                        active == r.key ? Theme.C.muted : .clear,
                        in: RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            content.padding(.vertical, 4).padding(.horizontal, 6)
        }
    }
}

// MARK: - Shared small views

/// Port of the web `MetricCard` (`Stats.tsx`) — a tinted card (cost emerald, tokens blue, active
/// time violet: border 20 %, background 5 %, icon 10 %) with the change vs. the previous period as
/// a pill. Standalone, not as `StatCard`: the web also has it as a separate component just for
/// Stats, and the tones are not status tones (`StatusTone`) but metric colors.
private struct MetricCard: View {
    enum Kind { case cost, tokens, hours }

    let kind: Kind
    let value: String
    let change: Double?

    private var label: String {
        switch kind {
        case .cost: return "Cost"
        case .tokens: return "Tokens"
        case .hours: return "Active time"
        }
    }

    private var icon: String {
        switch kind {
        case .cost: return "dollarsign"
        case .tokens: return "sparkles"
        case .hours: return "clock"
        }
    }

    /// Tone base (emerald-500 / blue-500 / violet-500) — border, background and icon backing.
    private var base: Color {
        switch kind {
        case .cost: return Theme.C.ok
        case .tokens: return Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255)
        case .hours: return Color(red: 0x8B / 255, green: 0x5C / 255, blue: 0xF6 / 255)
        }
    }

    /// Tone text — web `text-*-700 dark:text-*-400`.
    private var ink: Color {
        switch kind {
        case .cost: return Color(light: 0x047857, dark: 0x34D399)
        case .tokens: return Color(light: 0x1D4ED8, dark: 0x60A5FA)
        case .hours: return Color(light: 0x6D28D9, dark: 0xA78BFA)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(label)
                    .font(Theme.F.body.weight(.medium))
                    .foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(ink)
                    .frame(width: 36, height: 36)
                    .background(base.opacity(0.1), in: RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous))
            }
            HStack(alignment: .firstTextBaseline) {
                Text(value)
                    .font(.system(size: 30, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer()
                if let change {
                    HStack(spacing: 2) {
                        Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.system(size: 10, weight: .semibold))
                        Text("\(Int(abs(change).rounded()))%")
                            .font(Theme.F.badge)
                            .monospacedDigit()
                    }
                    .foregroundStyle(ink)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(base.opacity(0.1), in: Capsule())
                    .accessibilityLabel("\(Int(abs(change).rounded())) percent \(change >= 0 ? "increase" : "decrease") versus previous period")
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(base.opacity(0.05), in: RoundedRectangle(cornerRadius: Theme.R.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.xl, style: .continuous)
                .strokeBorder(base.opacity(0.2), lineWidth: 1)
        )
    }
}

private extension Color {
    /// Dynamic light/dark color from hex — only for the `MetricCard` tones, which are not in the theme
    /// palette (asset catalog) because nothing else uses them.
    init(light: UInt32, dark: UInt32) {
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        }
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }
}

private struct EmptyStateRow: View {
    let title: String
    var hint: String?
    var action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(Theme.F.body.weight(.medium))
                .multilineTextAlignment(.center)
            if let hint {
                Text(hint)
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
                    .multilineTextAlignment(.center)
            }
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(DevboxButtonStyle(variant: .outline))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .padding(.horizontal, 12)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous)
                .strokeBorder(Theme.C.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
    }
}
