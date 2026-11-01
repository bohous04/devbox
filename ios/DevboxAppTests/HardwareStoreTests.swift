import XCTest
@testable import DevboxApp

/// Pure `HardwareStore` functions — inputs/outputs copied from `dashboard/src/hardwareView.test.ts`.
final class HardwareStoreTests: XCTestCase {
    private func machine(
        beszel: BeszelSystem? = nil, host: HostReport? = nil, backup: MachineBackup? = nil,
        upgrade: UnitRun? = nil, errors: [String] = []
    ) -> Machine {
        Machine(id: "devbox", label: "devbox", beszel: beszel, host: host, backup: backup, upgrade: upgrade, checkedAt: 0, errors: errors)
    }

    private func host(
        updates: [PendingUpdate] = [], rebootRequired: Bool = false, uptimeSec: Int? = 1,
        logins: [SshLogin] = [], packages: [PkgEvent] = []
    ) -> HostReport {
        HostReport(
            hostname: "box", os: nil, kernel: nil, uptimeSec: uptimeSec, bootedAt: nil, disk: nil,
            rebootRequired: rebootRequired, rebootPkgs: [], updates: updates, logins: logins, packages: packages
        )
    }

    private func beszel(status: String) -> BeszelSystem {
        BeszelSystem(id: "x", name: "n", status: status, agentVersion: nil, uptimeSec: nil, cpu: 0, memPct: 0, diskPct: 0)
    }

    private func monitor(id: String = "1", tag: String? = nil, up: Bool = true) -> Monitor {
        Monitor(id: id, name: "m", type: "http", url: nil, hostname: nil, tag: tag, up: up, uptime1d: nil, uptime30d: nil, uptime365d: nil, responseMs: nil, certDaysLeft: nil)
    }

    // MARK: - machineDot

    func testMachineDotBeszelTakesPrecedenceOverProbe() {
        XCTAssertEqual(HardwareStore.machineDot(machine(beszel: beszel(status: "up"))), .ok)
        XCTAssertEqual(HardwareStore.machineDot(machine(beszel: beszel(status: "down"), host: host())), .danger)
        XCTAssertEqual(HardwareStore.machineDot(machine(host: host())), .ok)
        XCTAssertEqual(HardwareStore.machineDot(machine()), .off)
    }

    // MARK: - backupTone

    func testRunningBackupIsNotAProblem() {
        XCTAssertEqual(HardwareStore.backupTone("running"), .ok)
        XCTAssertEqual(HardwareStore.backupTone("ok"), .ok)
        XCTAssertEqual(HardwareStore.backupTone("failed"), .danger)
        XCTAssertEqual(HardwareStore.backupTone("unknown"), .warn)
    }

    // MARK: - attentionItems

    func testAttentionItemsCleanMachineHasNoReasons() {
        XCTAssertEqual(HardwareStore.attentionItems(machine()), [])
        XCTAssertEqual(HardwareStore.attentionItems(machine(host: host())), [])
    }

    func testAttentionItemsNamesEachReasonInStableOrder() {
        XCTAssertEqual(
            HardwareStore.attentionItems(machine(host: host(rebootRequired: true))),
            ["reboot required"]
        )
        let m = machine(
            host: host(updates: [
                PendingUpdate(pkg: "a", from: "1", to: "2"),
                PendingUpdate(pkg: "b", from: "1", to: "2"),
            ], rebootRequired: true),
            backup: MachineBackup(state: "failed", startedAt: nil, finishedAt: nil, nextAt: nil, message: nil, repo: nil, pull: []),
            errors: ["probe: unavailable"]
        )
        XCTAssertEqual(HardwareStore.attentionItems(m), ["reboot required", "2 updates", "backup failed", "1 error"])
    }

    func testAttentionItemsSingularVsPlural() {
        XCTAssertEqual(HardwareStore.attentionItems(machine(host: host(updates: [PendingUpdate(pkg: "a", from: "1", to: "2")]))), ["1 update"])
        XCTAssertEqual(HardwareStore.attentionItems(machine(errors: ["x", "y"])), ["2 errors"])
    }

    // MARK: - backupAge / backupStale

    func testBackupAgeFromFinishedOrLastArchive() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let repo = BorgRepo(archives: [], lastArchiveAt: Int(now.timeIntervalSince1970 * 1000) - 5_000, originalBytes: 0, storedBytes: 0)
        let withFinished = machine(backup: MachineBackup(state: "ok", startedAt: nil, finishedAt: Int(now.timeIntervalSince1970 * 1000) - 1_000, nextAt: nil, message: nil, repo: repo, pull: []))
        XCTAssertEqual(HardwareStore.backupAge(withFinished, now: now), 1_000)
        let withoutFinished = machine(backup: MachineBackup(state: "ok", startedAt: nil, finishedAt: nil, nextAt: nil, message: nil, repo: repo, pull: []))
        XCTAssertEqual(HardwareStore.backupAge(withoutFinished, now: now), 5_000)
        XCTAssertNil(HardwareStore.backupAge(machine(), now: now))
    }

    func testBackupOlderThan26HoursIsStale() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        func mk(_ finishedAt: Int?) -> Machine {
            machine(backup: MachineBackup(state: "ok", startedAt: nil, finishedAt: finishedAt, nextAt: nil, message: nil, repo: nil, pull: []))
        }
        let nowMs = Int(now.timeIntervalSince1970 * 1000)
        XCTAssertFalse(HardwareStore.backupStale(mk(nowMs - 3600_000), now: now))
        XCTAssertTrue(HardwareStore.backupStale(mk(nowMs - 27 * 3600_000), now: now))
        XCTAssertTrue(HardwareStore.backupStale(mk(nil), now: now))
        XCTAssertFalse(HardwareStore.backupStale(machine(), now: now)) // a machine without a backup is not reported
    }

    // MARK: - lastRunTone

    func testLastRunToneStaleOrDangerIsWarnOkStateIsOkOtherwiseNil() {
        XCTAssertEqual(HardwareStore.lastRunTone(stale: false, state: "ok"), .ok)
        XCTAssertEqual(HardwareStore.lastRunTone(stale: true, state: "ok"), .warn) // stale takes precedence
        XCTAssertEqual(HardwareStore.lastRunTone(stale: false, state: "failed"), .warn)
        XCTAssertEqual(HardwareStore.lastRunTone(stale: false, state: "running"), .ok)
        XCTAssertNil(HardwareStore.lastRunTone(stale: false, state: nil))
        XCTAssertNil(HardwareStore.lastRunTone(stale: false, state: "unknown"))
    }

    // MARK: - toChart

    private let samples = [
        MachineSample(
            at: 1000, cpu: 12, memPct: 40, memUsedGb: 4, memTotalGb: 10, swapPct: 0,
            diskPct: 3.5, diskUsedGb: 68, diskTotalGb: 2000, diskReadMbs: 0.1, diskWriteMbs: 0.4,
            netUpKbs: 94.9, netDownKbs: 18.9, load1: 3, load5: 3.5, load15: 4
        ),
    ]

    func testToChartExtractsOneMetricNetHasTwoCurves() {
        XCTAssertEqual(HardwareStore.toChart(samples, .cpu), [.init(at: 1000, a: 12, b: nil)])
        XCTAssertEqual(HardwareStore.toChart(samples, .mem), [.init(at: 1000, a: 40, b: nil)])
        XCTAssertEqual(HardwareStore.toChart(samples, .disk), [.init(at: 1000, a: 3.5, b: nil)])
        XCTAssertEqual(HardwareStore.toChart(samples, .net), [.init(at: 1000, a: 18.9, b: 94.9)])
    }

    func testToChartEmptySeriesDoesNotCrash() {
        XCTAssertEqual(HardwareStore.toChart([], .cpu), [])
    }

    // MARK: - timeLabel

    func testTimeLabelShortWindowVsSevenDays() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Prague")!
        var comps = DateComponents()
        comps.year = 2026; comps.month = 7; comps.day = 27; comps.hour = 9; comps.minute = 5
        let at = Int((cal.date(from: comps)!.timeIntervalSince1970 * 1000).rounded())
        XCTAssertEqual(HardwareStore.timeLabel(at, .sixHours, calendar: cal), "09:05")
        XCTAssertEqual(HardwareStore.timeLabel(at, .sevenDays, calendar: cal), "27. 09:00")
    }

    // MARK: - uptimeLabel

    func testUptimeLabelTwoDecimalPlaces() {
        XCTAssertEqual(HardwareStore.uptimeLabel(0.9996455660310484), "99.96 %")
        XCTAssertEqual(HardwareStore.uptimeLabel(1), "100.00 %")
        XCTAssertEqual(HardwareStore.uptimeLabel(nil), "—")
    }

    // MARK: - groupMonitors

    func testMonitorsGroupByTagDownGroupFirst() {
        let groups = HardwareStore.groupMonitors([
            monitor(id: "1", tag: "INFRA", up: true),
            monitor(id: "2", tag: "Acme", up: true),
            monitor(id: "3", tag: "Acme", up: false),
            monitor(id: "4", tag: nil),
        ])
        XCTAssertEqual(groups.map(\.tag), ["Acme", "INFRA", "other"])
        XCTAssertEqual(groups[0].monitors.count, 2)
    }

    // MARK: - chartDomain

    func testChartDomainFixedForPercentagesAutoForNetwork() {
        XCTAssertEqual(HardwareStore.chartDomain(.cpu), 0...100)
        XCTAssertEqual(HardwareStore.chartDomain(.mem), 0...100)
        XCTAssertEqual(HardwareStore.chartDomain(.disk), 0...100)
        XCTAssertNil(HardwareStore.chartDomain(.net))
    }

    // MARK: - fillLabel

    func testFillLabelBelowOnePercentIsNotRoundedToZero() {
        XCTAssertEqual(HardwareStore.fillLabel(2_083_817_190, pow(1024, 4)), "< 1 %")
        XCTAssertEqual(HardwareStore.fillLabel(0, pow(1024, 4)), "0 %")
        XCTAssertEqual(HardwareStore.fillLabel(500, 1000), "50 %")
        XCTAssertEqual(HardwareStore.fillLabel(5, 0), "—")
    }

    // MARK: - disruptiveUpdates / kernelUpdates

    func testDockerUpgradeIsRecognizedAsDisruptive() {
        let updates = [
            PendingUpdate(pkg: "cloudflared", from: "1", to: "2"),
            PendingUpdate(pkg: "docker-ce", from: "1", to: "2"),
            PendingUpdate(pkg: "docker-ce-cli", from: "1", to: "2"),
            PendingUpdate(pkg: "containerd.io", from: "1", to: "2"),
            PendingUpdate(pkg: "docker-compose-plugin", from: "1", to: "2"),
            PendingUpdate(pkg: "python3.13", from: "1", to: "2"),
        ]
        XCTAssertEqual(HardwareStore.disruptiveUpdates(updates), ["docker-ce", "docker-ce-cli", "containerd.io", "docker-compose-plugin"])
    }

    func testHarmlessPackagesAreNotDisruptive() {
        let harmless = [PendingUpdate(pkg: "tailscale", from: "1", to: "2"), PendingUpdate(pkg: "libpython3.13-stdlib", from: "1", to: "2")]
        XCTAssertEqual(HardwareStore.disruptiveUpdates(harmless), [])
        XCTAssertEqual(HardwareStore.disruptiveUpdates([]), [])
        // "docker" must match only at the start of the name, not anywhere.
        XCTAssertEqual(HardwareStore.disruptiveUpdates([PendingUpdate(pkg: "libdocker-helper", from: "1", to: "2")]), [])
    }

    func testKernelUpdatesAreRecognizedSeparately() {
        let updates = [PendingUpdate(pkg: "linux-image-amd64", from: "1", to: "2"), PendingUpdate(pkg: "docker-ce", from: "1", to: "2")]
        XCTAssertEqual(HardwareStore.kernelUpdates(updates), ["linux-image-amd64"])
        XCTAssertEqual(HardwareStore.disruptiveUpdates(updates), ["docker-ce"])
    }

    // MARK: - isUpgrading / updatesButtonDisabled

    func testIsUpgradingReflectsServerUpgradeState() {
        XCTAssertTrue(HardwareStore.isUpgrading(machine(upgrade: UnitRun(state: "running", startedAt: nil, finishedAt: nil, nextAt: nil, message: nil))))
        XCTAssertFalse(HardwareStore.isUpgrading(machine(upgrade: UnitRun(state: "failed", startedAt: nil, finishedAt: nil, nextAt: nil, message: nil))))
        XCTAssertFalse(HardwareStore.isUpgrading(machine()))
    }

    func testUpdatesButtonDisabledNoUpdatesOrUpgradingOrLocalBusy() {
        let withUpdates = machine(host: host(updates: [PendingUpdate(pkg: "a", from: "1", to: "2")]))
        // There is something to install, nothing is running, the app is not awaiting a reply — the button is enabled.
        XCTAssertFalse(HardwareStore.updatesButtonDisabled(withUpdates, localBusy: false))
        // The local "I just tapped" locks right away, even before the first poll arrives.
        XCTAssertTrue(HardwareStore.updatesButtonDisabled(withUpdates, localBusy: true))
        // The server reports apt running — the SERVER state wins even without a local busy.
        let upgrading = machine(
            host: host(updates: [PendingUpdate(pkg: "a", from: "1", to: "2")]),
            upgrade: UnitRun(state: "running", startedAt: nil, finishedAt: nil, nextAt: nil, message: nil)
        )
        XCTAssertTrue(HardwareStore.updatesButtonDisabled(upgrading, localBusy: false))
        // Nothing to install → locked even without busy/upgrade.
        XCTAssertTrue(HardwareStore.updatesButtonDisabled(machine(host: host()), localBusy: false))
        // Without a host report the app knows nothing about updates — the safe default is locked.
        XCTAssertTrue(HardwareStore.updatesButtonDisabled(machine(), localBusy: false))
    }

    // MARK: - certTone

    func testCertExpiryWithin14DaysWarnsAfterExpiryIsError() {
        XCTAssertNil(HardwareStore.certTone(84))
        XCTAssertEqual(HardwareStore.certTone(10), .warn)
        XCTAssertEqual(HardwareStore.certTone(0), .danger)
        XCTAssertNil(HardwareStore.certTone(nil))
    }

    // MARK: - rebootBanner

    func testRebootBannerShowsUntilMachineReturnsOrTenMinutesPass() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertNil(HardwareStore.rebootBanner(rebootedAt: nil, uptimeSec: 12345, now: t0))
        // right after the tap: the banner shows even though uptime is still old (probe from before the reboot)
        XCTAssertTrue(HardwareStore.rebootBanner(rebootedAt: t0, uptimeSec: 99_999, now: t0.addingTimeInterval(30))!.contains("Rebooting"))
        // the machine is back: uptime (2 min) is shorter than the time since the tap (5 min)
        XCTAssertNil(HardwareStore.rebootBanner(rebootedAt: t0, uptimeSec: 120, now: t0.addingTimeInterval(5 * 60)))
        // uptime unknown (the machine is offline right now) → the banner stays
        XCTAssertTrue(HardwareStore.rebootBanner(rebootedAt: t0, uptimeSec: nil, now: t0.addingTimeInterval(5 * 60))!.contains("Rebooting"))
        // after 10 minutes it expires even without proof the machine is back
        XCTAssertNil(HardwareStore.rebootBanner(rebootedAt: t0, uptimeSec: nil, now: t0.addingTimeInterval(11 * 60)))
    }
}
