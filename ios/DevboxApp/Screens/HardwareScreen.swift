import Charts
import SwiftUI

/// Hardware screen — mirrors `dashboard/src/pages/Hardware.tsx` (see `HardwareStore` for the pure
/// helpers and fetch/actions). The layout is a native `List`/`Section` instead of web cards in a grid (same
/// choice as `OverviewScreen`/`SubscriptionsScreen`) — content, numbers and confirmation dialogs are 1:1.
///
/// Backup/Update/Reboot are mutations on a REAL machine (on the devbox a restart also takes down running
/// agents) — the app wires them with the same `ConfirmationDialog` texts as the web, it never triggers them
/// by itself.
struct HardwareScreen: View {
    @StateObject private var store: HardwareStore
    @EnvironmentObject private var liveStore: LiveStore
    @State private var selectedId: String?
    @State private var seriesRange: SeriesRange = .sixHours
    @State private var metric: HardwareStore.MetricKey = .cpu
    @State private var rebootedAt: Date?
    @State private var showRebootConfirm = false
    @State private var showUpdateConfirm = false
    // Split per action (review) — a shared `busy` used to light up the spinner/disabled on Backup,
    // Update and Reboot at once, even when the user clicked only one of them.
    @State private var backupBusy = false
    @State private var updateBusy = false
    @State private var rebootBusy = false
    @State private var actionError: String?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: HardwareStore(client: client))
    }

    var body: some View {
        Group {
            if let snapshot = store.snapshot {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    List {
                        machinesSection(snapshot, now: context.date)
                        if !snapshot.errors.isEmpty {
                            Section("Integrations reporting problems") {
                                ForEach(snapshot.errors, id: \.self) { e in
                                    Text(e).font(.system(.caption2, design: .monospaced))
                                }
                            }
                        }
                        if let actionError {
                            Section {
                                Text(actionError).font(.caption).foregroundStyle(Theme.C.dangerText)
                            }
                        }
                        if let current = currentMachine(snapshot) {
                            detail(for: current, now: context.date)
                        }
                        workspaceSection
                        servicesSection(snapshot.monitors)
                    }
                    .listStyle(.insetGrouped)
                }
            } else if let error = store.error {
                ContentUnavailableView(
                    "Monitoring is not available",
                    systemImage: "bolt.slash",
                    description: Text("\(error). Beszel, Uptime Kuma and the SSH key live on the server.")
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .themedListBackground()
        .navigationTitle("Hardware")
        .task { store.start() }
        .onDisappear { store.stop() }
        .refreshable { await store.load() }
        .onChange(of: selectedId) { rebootedAt = nil }
        .task(id: seriesTaskKey) { await loadSeriesIfNeeded() }
    }

    private var seriesTaskKey: String {
        "\(currentId(store.snapshot) ?? "")|\(seriesRange.rawValue)"
    }

    private func loadSeriesIfNeeded() async {
        guard let id = currentId(store.snapshot) else { return }
        await store.loadSeries(machineId: id, range: seriesRange)
    }

    private func currentId(_ snapshot: HardwareSnapshot?) -> String? {
        guard let snapshot else { return nil }
        if let selectedId, snapshot.machines.contains(where: { $0.id == selectedId }) { return selectedId }
        return snapshot.machines.first?.id
    }

    private func currentMachine(_ snapshot: HardwareSnapshot) -> Machine? {
        guard let id = currentId(snapshot) else { return nil }
        return snapshot.machines.first { $0.id == id }
    }

    // MARK: - Machines + Storage Box

    @ViewBuilder
    private func machinesSection(_ snapshot: HardwareSnapshot, now: Date) -> some View {
        Section {
            ForEach(snapshot.machines, id: \.id) { m in
                Button { selectedId = m.id } label: {
                    machineRow(m, selected: m.id == currentId(snapshot))
                }
                .buttonStyle(.plain)
            }
            if let box = snapshot.storageBox {
                HStack {
                    Image(systemName: "externaldrive").foregroundStyle(Theme.C.mutedForeground)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Storage Box").font(.subheadline.weight(.semibold))
                        Text("of \(Format.bytes(Double(box.totalBytes))) · \(HardwareStore.fillLabel(Double(box.usedBytes), Double(box.totalBytes))) · off-site borg repo")
                            .font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                    }
                    Spacer()
                    Text(Format.bytes(Double(box.usedBytes))).font(.subheadline.monospacedDigit())
                }
            }
        } header: {
            Text("Machines")
        } footer: {
            Text("updated \(Format.agoLabel(now.timeIntervalSince1970 * 1000 - Double(snapshot.updatedAt)))")
        }
    }

    private func machineRow(_ m: Machine, selected: Bool) -> some View {
        let attention = HardwareStore.attentionItems(m)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(dotColor(HardwareStore.machineDot(m))).frame(width: 8, height: 8)
                Text(m.label).font(.subheadline.weight(.semibold))
                if selected { Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(Theme.C.primary) }
                Spacer()
                if !attention.isEmpty {
                    Badge("\(attention.count) to check", variant: .secondary)
                }
            }
            HStack(spacing: 16) {
                statMini("CPU", pct(m.beszel?.cpu))
                statMini("RAM", pct(m.beszel?.memPct))
                statMini("Disk", pct(m.beszel?.diskPct))
            }
            if !attention.isEmpty {
                Text("⚠ \(attention.joined(separator: " · "))").font(.caption2).foregroundStyle(Theme.C.warnText)
            }
        }
        .padding(.vertical, 2)
        .foregroundStyle(.primary)
    }

    private func statMini(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased()).font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
            Text(value).font(.caption.monospacedDigit())
        }
    }

    private func dotColor(_ kind: HardwareStore.DotKind) -> Color {
        switch kind {
        case .ok: return Theme.C.ok
        case .danger: return Theme.C.danger
        case .off: return Theme.C.idle
        }
    }

    private func pct(_ v: Double?) -> String {
        guard let v else { return "—" }
        return "\(Int(v.rounded())) %"
    }

    private func tone(_ t: HardwareStore.Tone?) -> Color {
        switch t {
        case .ok: return Theme.C.okText
        case .warn: return Theme.C.warnText
        case .danger: return Theme.C.dangerText
        case nil: return Theme.C.mutedForeground
        }
    }

    // MARK: - Machine detail

    @ViewBuilder
    private func detail(for m: Machine, now: Date) -> some View {
        if let banner = HardwareStore.rebootBanner(rebootedAt: rebootedAt, uptimeSec: m.host?.uptimeSec, now: now) {
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(banner).font(.caption)
                }
            }
        }
        if !m.errors.isEmpty {
            Section {
                Text("Some data could not be refreshed").font(.subheadline.weight(.semibold))
                ForEach(m.errors, id: \.self) { e in
                    Text(e).font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.C.mutedForeground)
                }
            }
        }

        Section {
            HStack(spacing: 16) {
                statMini("CPU", pct(m.beszel?.cpu))
                statMini("Memory", pct(m.beszel?.memPct))
                statMini("Disk", pct(m.beszel?.diskPct))
                statMini("Uptime", m.host?.uptimeSec.map { Format.durationLabel(Double($0) * 1000) } ?? "—")
            }
            HStack {
                Text("OS").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Text(m.host?.os ?? "—").font(.caption.monospacedDigit())
            }
            if let disk = m.host?.disk {
                HStack {
                    Text("Disk used").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text("\(Format.bytes(Double(disk.usedBytes))) of \(Format.bytes(Double(disk.totalBytes)))").font(.caption.monospacedDigit())
                }
            }
            HStack {
                Text("Hostname").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                Spacer()
                Text(m.host?.hostname ?? "—").font(.system(.caption, design: .monospaced))
            }
        } header: {
            Text("Now")
        } footer: {
            Text("checked \(Format.agoLabel(now.timeIntervalSince1970 * 1000 - Double(m.checkedAt)))")
        }

        historySection(m)
        backupSection(m, now: now)
        updatesSection(m)
        activitySection(m, now: now)
    }

    // MARK: - History

    @ViewBuilder
    private func historySection(_ m: Machine) -> some View {
        Section {
            Picker("Range", selection: $seriesRange) {
                Text("1 h").tag(SeriesRange.oneHour)
                Text("6 h").tag(SeriesRange.sixHours)
                Text("24 h").tag(SeriesRange.twentyFourHours)
                Text("7 d").tag(SeriesRange.sevenDays)
            }
            .pickerStyle(.segmented)
            Picker("Metric", selection: $metric) {
                ForEach(HardwareStore.MetricKey.allCases, id: \.self) { k in Text(k.label).tag(k) }
            }
            .pickerStyle(.segmented)

            if let samples = store.series {
                let points = HardwareStore.toChart(samples, metric)
                if points.isEmpty {
                    Text(store.seriesError ?? "No data for this window — Beszel keeps a few hours of fine-grained history.")
                        .font(.caption).foregroundStyle(Theme.C.mutedForeground)
                } else {
                    historyChart(points)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            Text("History")
        }
    }

    @ViewBuilder
    private func historyChart(_ points: [HardwareStore.ChartPoint]) -> some View {
        let chart = Chart(points, id: \.at) { p in
            let date = Date(timeIntervalSince1970: Double(p.at) / 1000)
            LineMark(x: .value("Time", date), y: .value(metric.label, p.a))
                .foregroundStyle(Theme.C.primary)
            if let b = p.b {
                LineMark(x: .value("Time", date), y: .value("Upload", b))
                    .foregroundStyle(Theme.C.warnText)
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisValueLabel(format: seriesRange == .sevenDays ? .dateTime.day().hour() : .dateTime.hour().minute())
            }
        }
        .frame(height: 220)

        if let domain = HardwareStore.chartDomain(metric) {
            chart.chartYScale(domain: domain)
        } else {
            chart
        }
    }

    // MARK: - Backup

    /// Mirrors the "Duration" StatCard on the web — only from the last RUN (start→end), not cumulative.
    private func durationOfLastRun(_ b: MachineBackup) -> String {
        guard let started = b.startedAt, let finished = b.finishedAt, finished > started else { return "—" }
        return Format.durationLabel(Double(finished - started))
    }

    @ViewBuilder
    private func backupSection(_ m: Machine, now: Date) -> some View {
        Section {
            if let b = m.backup {
                let stale = HardwareStore.backupStale(m, now: now)
                let age = HardwareStore.backupAge(m, now: now)
                let lastRunTone = HardwareStore.lastRunTone(stale: stale, state: b.state)
                HStack {
                    Text("Last run").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text(age == nil ? "never" : Format.agoLabel(age!))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(lastRunTone == .warn ? Theme.C.warnText : lastRunTone == .ok ? Theme.C.okText : Theme.C.foreground)
                }
                HStack {
                    Text("Archives").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text(b.repo.map { "\($0.archives.count)" } ?? "—").font(.caption.monospacedDigit())
                }
                HStack {
                    Text("Repo size").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text(b.repo.map { Format.bytes(Double($0.storedBytes)) } ?? "—").font(.caption.monospacedDigit())
                }
                HStack {
                    Text("Duration").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text(durationOfLastRun(b)).font(.caption.monospacedDigit())
                }

                Button {
                    run($backupBusy) { try await store.runBackup(m.id) }
                } label: {
                    if backupBusy { ProgressView() } else { Text(b.state == "running" ? "Running…" : "Back up now") }
                }
                .disabled(backupBusy || b.state == "running")

                if !b.pull.isEmpty {
                    ForEach(b.pull, id: \.label) { p in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(p.label).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                            HStack {
                                Text(p.command).font(.system(.caption2, design: .monospaced)).lineLimit(1)
                                Spacer()
                                Button {
                                    UIPasteboard.general.string = p.command
                                } label: {
                                    Image(systemName: "doc.on.doc")
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                }

                if let repo = b.repo, !repo.archives.isEmpty {
                    ForEach(repo.archives.prefix(5), id: \.id) { a in
                        HStack {
                            Text(a.name).font(.system(.caption2, design: .monospaced)).lineLimit(1)
                            Spacer()
                            Text(Format.agoLabel(now.timeIntervalSince1970 * 1000 - Double(a.at))).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                        }
                    }
                }
            } else {
                Text("This machine has no backup configured").font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
            }
        } header: {
            Text("Backup")
        } footer: {
            if let nextAt = m.backup?.nextAt, Double(nextAt) > now.timeIntervalSince1970 * 1000 {
                Text("next in \(Format.durationLabel(Double(nextAt) - now.timeIntervalSince1970 * 1000))")
            }
        }
    }

    // MARK: - Updates

    @ViewBuilder
    private func updatesSection(_ m: Machine) -> some View {
        if let h = m.host {
            let running = m.id == "devbox" ? (liveStore.live?.sessions.filter { $0.status == .running }.count ?? 0) : 0
            let disruptive = HardwareStore.disruptiveUpdates(h.updates)
            let kernel = HardwareStore.kernelUpdates(h.updates)
            let none = !h.rebootRequired && h.updates.isEmpty
            let upgrading = HardwareStore.isUpgrading(m)
            let installDisabled = HardwareStore.updatesButtonDisabled(m, localBusy: updateBusy)

            Section {
                if none {
                    Text("Everything is up to date and no reboot is pending.").font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
                } else {
                    if h.rebootRequired {
                        Text("A reboot is pending\(h.rebootPkgs.isEmpty ? "" : " because of \(h.rebootPkgs.joined(separator: ", "))"). Nothing reboots on its own — do it when it suits you.")
                            .font(.caption)
                    }
                    if !h.updates.isEmpty {
                        Text("\(h.updates.count) package\(h.updates.count == 1 ? "" : "s") can be upgraded.").font(.caption.weight(.semibold))
                        ForEach(h.updates, id: \.pkg) { u in
                            HStack {
                                Text(u.pkg).font(.caption).lineLimit(1)
                                Spacer()
                                Text("\(u.from) → \(u.to)").font(.caption2.monospacedDigit()).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                            }
                        }
                    }
                }

                if !disruptive.isEmpty {
                    Text("This upgrade restarts the container runtime.").font(.caption.weight(.semibold))
                    Text("\(disruptive.joined(separator: ", ")) — installing \(disruptive.count == 1 ? "it" : "these") restarts Docker, which bounces every container on this machine\(running > 0 ? " and kills whatever the \(running) running session\(running == 1 ? "" : "s") \(running == 1 ? "is" : "are") doing" : ""). Containers with a restart policy come back; databases started by hand do not.")
                        .font(.caption2).foregroundStyle(Theme.C.warnText)
                }

                if disruptive.isEmpty {
                    Button {
                        run($updateBusy) { try await store.runUpdate(m.id) }
                    } label: {
                        Text(upgrading ? "Installing…" : h.updates.isEmpty ? "Nothing to install" : "Install \(h.updates.count) updates")
                    }
                    .disabled(installDisabled)
                } else {
                    // Extra guard compared to the web (review): the web leaves this disruptive branch clickable
                    // even during `upgrading`, the app locks it just like the plain one — a double tap could otherwise
                    // fire a second install on top of a running one.
                    Button(upgrading ? "Installing…" : "Install \(h.updates.count) updates") { showUpdateConfirm = true }
                        .disabled(installDisabled)
                        .confirmationDialog(
                            running > 0 ? "Restart containers — \(running) session\(running == 1 ? "" : "s") live?" : "Restart containers?",
                            isPresented: $showUpdateConfirm, titleVisibility: .visible
                        ) {
                            Button("Restart containers", role: .destructive) {
                                run($updateBusy) { try await store.runUpdate(m.id) }
                            }
                            Button("Cancel", role: .cancel) {}
                        }
                }

                Button("Reboot", role: .destructive) { showRebootConfirm = true }
                    .disabled(rebootBusy)
                    .confirmationDialog(
                        running > 0 ? "Reboot anyway — \(running) running" : "Reboot now?",
                        isPresented: $showRebootConfirm, titleVisibility: .visible
                    ) {
                        Button("Reboot", role: .destructive) {
                            run($rebootBusy) {
                                try await store.rebootHost(m.id)
                                rebootedAt = Date()
                            }
                        }
                        Button("Cancel", role: .cancel) {}
                    }

                // Mirrors the explanatory text under the buttons (Hardware.tsx `Updates`) — the priority order is
                // the same: install in progress > kernel-only info > how many sessions a reboot interrupts >
                // generic default.
                Text(
                    upgrading
                        ? "apt is running detached — it keeps going even if you close this."
                        : !kernel.isEmpty
                            ? "The new kernel only takes effect after a reboot — installing it changes nothing on its own."
                            : running > 0
                                ? "\(running) session\(running == 1 ? "" : "s") running on this machine; a reboot interrupts them."
                                : "Updates install in the background; a reboot needs the second click."
                )
                .font(.caption2).foregroundStyle(Theme.C.mutedForeground)

                if let upgrade = m.upgrade, upgrade.state == "failed" {
                    Text("The last upgrade failed\(upgrade.message.map { " (\($0))" } ?? ""). Check journalctl -u devd-apt-upgrade on the machine.")
                        .font(.caption2).foregroundStyle(Theme.C.dangerText)
                }
            } header: {
                Text("Updates")
            }
        }
    }

    // MARK: - Activity

    @ViewBuilder
    private func activitySection(_ m: Machine, now: Date) -> some View {
        if let h = m.host {
            Section {
                if h.logins.isEmpty {
                    Text("No logins in the last 14 days.").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                } else {
                    ForEach(Array(h.logins.prefix(8).enumerated()), id: \.offset) { _, l in
                        HStack {
                            Text(l.user).font(.caption.weight(.semibold))
                            Text("\(l.ip) · \(l.method)").font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                            Spacer()
                            Text(Format.agoLabel(now.timeIntervalSince1970 * 1000 - Double(l.at))).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                        }
                    }
                }
                Text("Commands run over SSH are not logged anywhere.").font(.caption2).foregroundStyle(Theme.C.mutedForeground)
            } header: {
                Text("SSH logins")
            }

            Section {
                if h.packages.isEmpty {
                    Text("Nothing installed or upgraded recently.").font(.caption).foregroundStyle(Theme.C.mutedForeground)
                } else {
                    ForEach(Array(h.packages.prefix(8).enumerated()), id: \.offset) { _, p in
                        HStack {
                            Text(p.action).font(.caption2).foregroundStyle(Theme.C.mutedForeground).frame(width: 50, alignment: .leading)
                            Text(p.pkg).font(.caption).lineLimit(1)
                            Spacer()
                            Text(Format.agoLabel(now.timeIntervalSince1970 * 1000 - Double(p.at))).font(.caption2).foregroundStyle(Theme.C.mutedForeground)
                        }
                    }
                }
            } header: {
                Text("Package changes")
            }
        }
    }

    // MARK: - Workspace disk (/srv/dev) — reuse OverviewStore's pure disk helpers, not a copy

    @ViewBuilder
    private var workspaceSection: some View {
        Section {
            if let disk = store.diskStats {
                let p = OverviewStore.pctOf(Double(disk.usedBytes), Double(disk.totalBytes))
                // `QuotaBar` instead of `ProgressView` (spec §6); the `diskWarnPercent` warning threshold
                // colors the bar amber like the web `StorageSummary`.
                QuotaBar(
                    label: "\(Format.bytes(Double(disk.usedBytes))) of \(Format.bytes(Double(disk.totalBytes)))",
                    pct: p / 100,
                    caption: OverviewStore.daysLeftLabel(disk.daysLeft),
                    warnAt: store.diskWarnPercent / 100
                )
            } else {
                ProgressView()
            }
        } header: {
            Text("Workspaces (/srv/dev)")
        } footer: {
            Text("warning at \(Int(store.diskWarnPercent)) %")
        }
    }

    // MARK: - Services

    @ViewBuilder
    private func servicesSection(_ monitors: [Monitor]) -> some View {
        let groups = HardwareStore.groupMonitors(monitors)
        let down = monitors.filter { !$0.up }.count
        Section {
            if monitors.isEmpty {
                Text("Uptime Kuma has nothing to report, or its API key is not set.").font(.caption).foregroundStyle(Theme.C.mutedForeground)
            } else {
                ForEach(groups, id: \.tag) { g in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(g.tag.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
                        ForEach(g.monitors, id: \.id) { m in monitorRow(m) }
                    }
                    .padding(.vertical, 2)
                }
            }
        } header: {
            Text("Services")
        } footer: {
            Text(down == 0 ? "all \(monitors.count) up" : "\(down) down")
        }
    }

    private func monitorRow(_ m: Monitor) -> some View {
        HStack(spacing: 8) {
            Circle().fill(m.up ? Theme.C.ok : Theme.C.danger).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(m.name).font(.caption).lineLimit(1)
                if let url = m.url { Text(url).font(.caption2).foregroundStyle(Theme.C.mutedForeground).lineLimit(1) }
            }
            Spacer()
            // The web hides this column under `sm:` (a narrow phone would squeeze it into illegibility) — instead of
            // hiding it the app puts it into its own column next to response time; it has the extra room.
            VStack(alignment: .trailing, spacing: 1) {
                Text(HardwareStore.uptimeLabel(m.uptime30d)).font(.caption2.monospacedDigit())
                Text("30 days").font(.system(size: 9)).foregroundStyle(Theme.C.mutedForeground)
            }
            VStack(alignment: .trailing, spacing: 1) {
                Text(m.responseMs.map { "\($0) ms" } ?? "—").font(.caption2.monospacedDigit())
                if let cert = m.certDaysLeft {
                    Text("cert \(cert) d").font(.caption2).foregroundStyle(tone(HardwareStore.certTone(cert)))
                }
            }
        }
    }

    // MARK: - Private

    private func run(_ busy: Binding<Bool>, _ operation: @escaping () async throws -> Void) {
        guard !busy.wrappedValue else { return }
        busy.wrappedValue = true
        actionError = nil
        Task {
            do { try await operation() } catch { actionError = errorText(error) }
            busy.wrappedValue = false
        }
    }

}
