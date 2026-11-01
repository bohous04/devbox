import SwiftUI

/// The app's overview screen — mirrors `dashboard/src/pages/Overview.tsx`, narrowed to the three sections
/// specified for this stage: today's numbers, disk and recent activity (see `OverviewStore`). The web also
/// shows "Live sessions"/"Projects"/"Infrastructure" — the app covers those elsewhere (Sessions tab) or
/// leaves them for a later stage (Hardware, Stats), see task report.
///
/// Fetch-on-appear + pull-to-refresh, no polling — `TimelineView` only ticks a local clock for the
/// "X ago" labels on events, it triggers no network by itself.
struct OverviewScreen: View {
    @StateObject private var store: OverviewStore
    @EnvironmentObject private var appModel: AppModel
    @EnvironmentObject private var liveStore: LiveStore

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: OverviewStore(client: client))
    }

    var body: some View {
        // `.task`/`.refreshable` sit on this always-rendered `Group`, NOT on `content` —
        // `content` renders only WHEN some data already exists, so on a cold start (nothing
        // has arrived yet) a `.task` on `content` would never run and the app would stay forever
        // on the `ProgressView` (Critical from the final review). Same pattern as `HardwareScreen`.
        Group {
            if store.totals != nil || store.disk != nil || !store.events.isEmpty {
                content
            } else if let lastError = store.lastError {
                ContentUnavailableView {
                    Label("Can't reach devd", systemImage: "wifi.slash")
                } description: {
                    Text(lastError)
                } actions: {
                    Button("Try again") { Task { await store.load() } }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.background)
        .navigationTitle("Overview")
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    /// Number of currently working sessions for the "Today" section meta (web `N× working right now`).
    /// From `LiveStore` (polled by the whole `SessionsContainer`), not from `OverviewStore` — no extra fetch.
    private var workingCount: Int {
        liveStore.live?.sessions.filter { $0.status == .running && $0.claudeState == .working }.count ?? 0
    }

    @ViewBuilder
    private var content: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            ScreenScroll {
                if let lastError = store.lastError {
                    if !appModel.isOnline || lastError == offlineErrorText {
                        OfflineBanner()
                    } else {
                        OfflineBanner(message: "Showing last known data (\(lastError))")
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Today", trailing: workingCount > 0 ? "\(workingCount)× working right now" : nil)
                    TotalsGrid(totals: store.totals)
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Workspace storage")
                    DiskRow(disk: store.disk)
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Recent activity")
                    if store.events.isEmpty {
                        if store.loaded {
                            EmptyState("Nothing yet.", systemImage: "list.bullet")
                        } else {
                            Card { ProgressView().frame(maxWidth: .infinity) }
                        }
                    } else {
                        Card {
                            VStack(spacing: 0) {
                                ForEach(Array(store.events.enumerated()), id: \.element.id) { index, event in
                                    if index > 0 { Divider().overlay(Theme.C.border) }
                                    EventRow(event: event, now: context.date)
                                        .padding(.vertical, 8)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Six numbers from `/api/stats/totals` — `hoursToday`/`tokensToday`/`costToday` are today's totals,
/// `costMonth` the last 30 days, `commitsToday`/`unpushed` git activity across sessions.
private struct TotalsGrid: View {
    let totals: Totals?

    private let columns = [GridItem(.flexible(), spacing: Theme.S.gridGap), GridItem(.flexible(), spacing: Theme.S.gridGap)]

    var body: some View {
        if let totals {
            LazyVGrid(columns: columns, spacing: Theme.S.gridGap) {
                // Labels 1:1 with the `Overview.tsx` `StatCard` texts ("Active time"/"Tokens"/"Cost", not
                // "Hours today"/"Tokens today"/"Cost today") — the section itself is called "Today", the web
                // deliberately does not repeat "today" in every tile; "Active time" also avoids a clash
                // with the web's "Work hours" (wall-clock) on the Stats screen.
                StatCard(label: "Active time", value: String(format: "%.1f h", totals.hoursToday))
                StatCard(label: "Tokens", value: Format.compactNumber(Double(totals.tokensToday)))
                StatCard(label: "Cost", value: Format.usd(totals.costToday))
                StatCard(label: "Cost 30 days", value: Format.usd(totals.costMonth))
                StatCard(
                    label: "Commits today",
                    value: Format.compactNumber(Double(totals.commitsToday)),
                    caption: totals.unpushed > 0 ? "\(totals.unpushed) unpushed" : nil,
                    tone: totals.unpushed > 0 ? .warn : nil
                )
            }
        } else {
            Card { ProgressView().frame(maxWidth: .infinity) }
        }
    }
}

/// Workspace disk as a `QuotaBar` (web `StorageSummary` — used / capacity / days outlook).
private struct DiskRow: View {
    let disk: DiskStats?

    var body: some View {
        if let disk {
            let pct = OverviewStore.pctOf(Double(disk.usedBytes), Double(disk.totalBytes))
            QuotaBar(
                label: "\(Format.bytes(Double(disk.usedBytes))) of \(Format.bytes(Double(disk.totalBytes)))",
                pct: pct / 100,
                caption: OverviewStore.daysLeftLabel(disk.daysLeft),
                // Web `StorageSummary`: amber from `config.settings.diskWarnPercent ?? 80`. The app
                // does not read the config threshold (see `OverviewStore.diskSeverity`), it keeps the default 80 %.
                warnAt: 0.8
            )
        } else {
            Card { ProgressView().frame(maxWidth: .infinity) }
        }
    }
}

/// One activity row — layout mirrors `pages/Log.tsx` (dot by `kind`, badge with label,
/// `sessionShort`, detail, `agoLabel` on the right).
private struct EventRow: View {
    let event: ActivityEvent
    let now: Date

    var body: some View {
        let info = OverviewStore.eventLabel(event.type)
        let detail = OverviewStore.eventDetail(event.data)
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(dotColor(for: info.kind))
                .frame(width: 8, height: 8)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(info.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color(for: info.kind))
                    Text(OverviewStore.sessionShort(event.session_id))
                        .font(.caption2)
                        .foregroundStyle(Theme.C.mutedForeground)
                }
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(Theme.C.mutedForeground)
                }
            }
            Spacer(minLength: 8)
            Text(Format.agoLabel(now.timeIntervalSince1970 * 1000 - Double(event.ts)))
                .font(.caption2)
                .foregroundStyle(Theme.C.mutedForeground)
        }
    }

    private func dotColor(for kind: OverviewStore.EventKind) -> Color {
        switch kind {
        case .ok: return Theme.C.ok
        case .warn: return Theme.C.warn
        case .danger: return Theme.C.danger
        case .info: return Theme.C.idle
        }
    }

    private func color(for kind: OverviewStore.EventKind) -> Color {
        switch kind {
        case .ok: return Theme.C.okText
        case .warn: return Theme.C.warnText
        case .danger: return Theme.C.dangerText
        case .info: return Theme.C.mutedForeground
        }
    }
}
