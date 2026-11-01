import XCTest
@testable import DevboxApp

/// Pure `StatsStore` functions — inputs/outputs copied from `dashboard/src/lib/range.test.ts`,
/// `statsView.test.ts`, `statsHostView.test.ts` and `workHoursView.test.ts`.
///
/// Dates are built in a FIXED calendar time zone (Europe/Prague), not `Calendar.current` — otherwise
/// the test would measure day/midnight by the CI machine's time zone and fail nondeterministically (exactly
/// the trap known from the dashboard tests with TZ logic).
final class StatsStoreTests: XCTestCase {
    private let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Prague")!
        return c
    }()

    private func date(_ y: Int, _ m: Int, _ d: Int, _ hh: Int = 15, _ mm: Int = 30) -> Date {
        var comps = DateComponents()
        comps.year = y; comps.month = m; comps.day = d; comps.hour = hh; comps.minute = mm
        return cal.date(from: comps)!
    }

    private func hour(of date: Date) -> Int { cal.component(.hour, from: date) }
    private func day(of date: Date) -> Int { cal.component(.day, from: date) }
    private func month(of date: Date) -> Int { cal.component(.month, from: date) }

    // MARK: - presetRange / matchPreset / rangeDays (range.test.ts)

    func testSevenDayPresetSpansMidnightToMidnight() {
        let now = date(2026, 7, 23)
        let r = StatsStore.presetRange(.sevenDays, now: now, calendar: cal)
        XCTAssertEqual(hour(of: Date(timeIntervalSince1970: Double(r.from) / 1000)), 0)
        XCTAssertEqual(hour(of: Date(timeIntervalSince1970: Double(r.to) / 1000)), 0)
        XCTAssertEqual(Int((Double(r.to - r.from) / 86_400_000).rounded()), 7)
    }

    func testMonthPresetStartsOnFirstOfMonth() {
        let now = date(2026, 7, 23)
        let r = StatsStore.presetRange(.month, now: now, calendar: cal)
        let from = Date(timeIntervalSince1970: Double(r.from) / 1000)
        XCTAssertEqual(day(of: from), 1)
        XCTAssertEqual(month(of: from), 7)
    }

    func testTodayPresetIsOneDayFromMidnight() {
        let now = date(2026, 7, 26)
        let r = StatsStore.presetRange(.today, now: now, calendar: cal)
        XCTAssertEqual(StatsStore.rangeDays(r), 1)
        XCTAssertEqual(r.to - r.from, 86_400_000)
    }

    func testMatchPresetRecognizesOwnPresetsAndCustom() {
        let now = date(2026, 7, 26)
        XCTAssertEqual(StatsStore.matchPreset(StatsStore.presetRange(.today, now: now, calendar: cal), now: now, calendar: cal), .today)
        XCTAssertEqual(StatsStore.matchPreset(StatsStore.presetRange(.sevenDays, now: now, calendar: cal), now: now, calendar: cal), .sevenDays)
        XCTAssertEqual(StatsStore.matchPreset(StatsStore.presetRange(.month, now: now, calendar: cal), now: now, calendar: cal), .month)
        XCTAssertEqual(StatsStore.matchPreset(.init(from: 1, to: 2), now: now, calendar: cal), .custom)
    }

    func testRangeDaysCountsWholeDays() {
        let now = date(2026, 7, 26)
        XCTAssertEqual(StatsStore.rangeDays(StatsStore.presetRange(.sevenDays, now: now, calendar: cal)), 7)
        XCTAssertEqual(StatsStore.rangeDays(StatsStore.presetRange(.thirtyDays, now: now, calendar: cal)), 30)
    }

    // MARK: - rangeFromDraft

    func testRangeFromDraftWithoutStartIsNil() {
        XCTAssertNil(StatsStore.rangeFromDraft(from: nil, to: nil, calendar: cal))
    }

    func testRangeFromDraftSingleDayIsOneDayRange() {
        let r = StatsStore.rangeFromDraft(from: date(2026, 8, 14, 9, 0), to: nil, calendar: cal)!
        let from = Date(timeIntervalSince1970: Double(r.from) / 1000)
        XCTAssertEqual(hour(of: from), 0)
        XCTAssertEqual(day(of: from), 14)
        XCTAssertEqual(Int((Double(r.to - r.from) / 86_400_000).rounded()), 1)
    }

    func testRangeFromDraftBothEndsGivesExclusiveEnd() {
        let r = StatsStore.rangeFromDraft(from: date(2026, 8, 14, 9, 0), to: date(2026, 8, 16, 22, 0), calendar: cal)!
        let from = Date(timeIntervalSince1970: Double(r.from) / 1000)
        let to = Date(timeIntervalSince1970: Double(r.to) / 1000)
        XCTAssertEqual(hour(of: from), 0)
        XCTAssertEqual(day(of: from), 14)
        XCTAssertEqual(day(of: to), 17) // exclusive midnight of tomorrow
        XCTAssertEqual(Int((Double(r.to - r.from) / 86_400_000).rounded()), 3)
    }

    func testRangeFromDraftSameDayTwiceIsOneDayRange() {
        let d = date(2026, 8, 14, 12, 0)
        let r = StatsStore.rangeFromDraft(from: d, to: d, calendar: cal)!
        XCTAssertEqual(Int((Double(r.to - r.from) / 86_400_000).rounded()), 1)
    }

    func testRangeFromDraftReversedOrderNormalizes() {
        let r = StatsStore.rangeFromDraft(from: date(2026, 8, 16), to: date(2026, 8, 14), calendar: cal)!
        let from = Date(timeIntervalSince1970: Double(r.from) / 1000)
        let to = Date(timeIntervalSince1970: Double(r.to) / 1000)
        XCTAssertEqual(day(of: from), 14)
        XCTAssertEqual(day(of: to), 17)
    }

    // MARK: - leaderboards (statsView.test.ts)

    func testRankedProjectsMirrorsToRanked() {
        let rows = [RangeStats.ProjectEntry(project: "shop", cost: 1, tokens: 10)]
        XCTAssertEqual(StatsStore.rankedProjects(rows), [StatsStore.Ranked(key: "shop", cost: 1, tokens: 10)])
    }

    func testShareNeverReturnsNaN() {
        XCTAssertEqual(StatsStore.share(1, 4), 25)
        XCTAssertEqual(StatsStore.share(1, 0), 0)
        XCTAssertEqual(StatsStore.share(0, 0), 0)
    }

    func testTotalCostSumsRows() {
        XCTAssertEqual(StatsStore.totalCost([.init(key: "a", cost: 1.5, tokens: 0), .init(key: "b", cost: 2.5, tokens: 0)]), 4)
        XCTAssertEqual(StatsStore.totalCost([]), 0)
    }

    func testPagePaginatesAndClampsOutOfRangeIndex() {
        let rows = Array(0..<60)
        XCTAssertEqual(StatsStore.page(rows, 0).items.count, 25)
        XCTAssertEqual(StatsStore.page(rows, 0).pages, 3)
        XCTAssertEqual(StatsStore.page(rows, 2).items, Array(50..<60))
        XCTAssertEqual(StatsStore.page(rows, 99).page, 2)
        let empty: [Int] = []
        let e = StatsStore.page(empty, 3)
        XCTAssertEqual(e.items, [])
        XCTAssertEqual(e.page, 0)
        XCTAssertEqual(e.pages, 1)
    }

    func testHourLabelPadsZero() {
        XCTAssertEqual(StatsStore.hourLabel(0), "00:00")
        XCTAssertEqual(StatsStore.hourLabel(9), "09:00")
        XCTAssertEqual(StatsStore.hourLabel(23), "23:00")
    }

    func testPeakHourFindsBusiestHourEmptyDayIsNil() {
        let h = { (hour: Int, hours: Double) in RangeStats.HourlyPoint(hour: hour, cost: 0, hours: hours) }
        XCTAssertEqual(StatsStore.peakHour([h(9, 1), h(14, 3), h(20, 2)]), 14)
        XCTAssertNil(StatsStore.peakHour([h(9, 0), h(14, 0)]))
        XCTAssertNil(StatsStore.peakHour([]))
    }

    func testMsLabelHumanizesAndZeroIsDash() {
        XCTAssertEqual(StatsStore.msLabel(0), "—")
        XCTAssertEqual(StatsStore.msLabel(-5), "—")
        XCTAssertEqual(StatsStore.msLabel(45_000), "45 s")
        XCTAssertEqual(StatsStore.msLabel(4 * 60_000), "4 min")
        XCTAssertEqual(StatsStore.msLabel(80 * 60_000), "1 h 20 min")
        XCTAssertEqual(StatsStore.msLabel(120 * 60_000), "2 h")
    }

    func testQuantileLabelWithoutDataIsDash() {
        XCTAssertEqual(StatsStore.quantileLabel(nil, { String($0) }), "—")
        XCTAssertEqual(StatsStore.quantileLabel(Quantiles(count: 0, avg: 0, p50: 0, p90: 0), { String($0) }), "—")
        XCTAssertEqual(StatsStore.quantileLabel(Quantiles(count: 3, avg: 5, p50: 4, p90: 9), { "\(Int($0)) zn." }), "4 zn.")
    }

    func testProjectOptionsIsAlphabeticalAndExcludesDash() {
        XCTAssertEqual(StatsStore.projectOptions(["vpsbetter", "alfa", "portal"], active: nil), ["alfa", "portal", "vpsbetter"])
        XCTAssertEqual(StatsStore.projectOptions(["—", "alfa"], active: nil), ["alfa"])
    }

    func testProjectOptionsKeepsActiveEvenWithoutDataInRange() {
        XCTAssertEqual(StatsStore.projectOptions(["beta"], active: "alfa"), ["alfa", "beta"])
        XCTAssertEqual(StatsStore.projectOptions(["alfa"], active: "alfa"), ["alfa"])
    }

    // MARK: - host switcher (statsHostView.test.ts)

    private func makeRangeStats(
        hosts: [HostStat] = [HostStat(key: "devbox", cost: 3, tokens: 0, hours: 1), HostStat(key: "mac", cost: 1, tokens: 100, hours: 0.5)],
        hostsPrevious: [HostStat] = [HostStat(key: "mac", cost: 5, tokens: 0, hours: 0)],
        dailyByHost: [RangeStats.HostDaily] = [
            .init(host: "devbox", days: [.init(day: 0, cost: 0, tokens: 0, hours: 0), .init(day: 1, cost: 3, tokens: 0, hours: 1)]),
            .init(host: "mac", days: [.init(day: 0, cost: 1, tokens: 100, hours: 0.5), .init(day: 1, cost: 0, tokens: 0, hours: 0)]),
        ]
    ) -> RangeStats {
        RangeStats(
            from: 0, to: 2, project: nil,
            totals: .init(cost: 4, tokens: 100, hours: 1.5),
            previous: .init(cost: 5, tokens: 0, hours: 0),
            daily: [], hourly: [],
            projects: [], models: [], repos: [],
            prompts: .init(chars: .init(count: 0, avg: 0, p50: 0, p90: 0), waitMs: .init(count: 0, avg: 0, p50: 0, p90: 0)),
            hosts: hosts, hostsPrevious: hostsPrevious, accounts: [],
            dailyByHost: dailyByHost
        )
    }

    func testHostOptionsIsAlphabetical() {
        XCTAssertEqual(StatsStore.hostOptions(makeRangeStats()), ["devbox", "mac"])
    }

    func testTotalsForAllVsSpecificHost() {
        let data = makeRangeStats()
        XCTAssertEqual(StatsStore.totalsFor(data, "all"), .init(cost: 4, tokens: 100, hours: 1.5))
        XCTAssertEqual(StatsStore.totalsFor(data, "mac"), .init(cost: 1, tokens: 100, hours: 0.5))
        XCTAssertEqual(StatsStore.totalsFor(data, "neexistuje"), .zero)
    }

    func testPreviousForMissingHostIsZero() {
        let data = makeRangeStats()
        XCTAssertEqual(StatsStore.previousFor(data, "mac").cost, 5)
        XCTAssertEqual(StatsStore.previousFor(data, "devbox"), .zero)
        XCTAssertEqual(StatsStore.previousFor(data, "all").cost, 5)
    }

    func testSeriesForAllVsSpecificHost() {
        let data = makeRangeStats()
        XCTAssertEqual(StatsStore.seriesFor(data, "all").count, 2)
        let one = StatsStore.seriesFor(data, "mac")
        XCTAssertEqual(one.count, 1)
        XCTAssertEqual(one[0][0].cost, 1)
    }

    func testSeriesForUnknownHostReturnsOneEmptyDataset() {
        let result = StatsStore.seriesFor(makeRangeStats(), "unknown")
        XCTAssertEqual(result.count, 1)
        XCTAssertTrue(result[0].isEmpty)
    }

    func testHostLabelAndUnknownLabel() {
        XCTAssertEqual(StatsStore.hostLabel("mac"), "Mac")
        XCTAssertEqual(StatsStore.hostLabel("devbox"), "Devbox")
        XCTAssertEqual(StatsStore.hostLabel("—"), "Unknown")
        XCTAssertEqual(StatsStore.hostLabel("nejaky-jiny-host"), "nejaky-jiny-host")
        XCTAssertEqual(StatsStore.unknownLabel("my-project"), "my-project")
    }

    func testEffectiveHostFallsBackToAllWhenLost() {
        XCTAssertEqual(StatsStore.effectiveHost("mac", options: ["devbox"]), "all")
        XCTAssertEqual(StatsStore.effectiveHost("mac", options: ["mac", "devbox"]), "mac")
        XCTAssertEqual(StatsStore.effectiveHost("all", options: []), "all")
    }

    // MARK: - delta (Stats.tsx)

    func testDeltaIsNilWhenPreviousIsZeroOrNegative() {
        XCTAssertNil(StatsStore.delta(10, 0))
        XCTAssertNil(StatsStore.delta(10, -1))
        XCTAssertEqual(StatsStore.delta(15, 10), 50)
    }

    // MARK: - Work hours (workHoursView.test.ts)

    func testFormatHoursShowsHoursAndMinutesNotDecimal() {
        XCTAssertEqual(StatsStore.formatHours(1.5), "1h 30m")
        XCTAssertEqual(StatsStore.formatHours(0.25), "15m")
        XCTAssertEqual(StatsStore.formatHours(0), "0m")
        XCTAssertEqual(StatsStore.formatHours(2), "2h")
    }

    func testFormatHoursRoundingCarriesIntoNextHour() {
        XCTAssertEqual(StatsStore.formatHours(0.999), "1h")
        XCTAssertEqual(StatsStore.formatHours(1.999), "2h")
    }

    func testCappedNoteOnlyWhenCapActuallyHit() {
        XCTAssertNil(StatsStore.cappedNote(.init(project: "p", hours: 2, cappedHours: 0)))
        XCTAssertNotNil(StatsStore.cappedNote(.init(project: "p", hours: 2, cappedHours: 0.5)))
    }

    private let work = WorkHours(
        totalHours: 3,
        byProject: [
            .init(project: "alfa", hours: 2, cappedHours: 0.5),
            .init(project: "beta", hours: 1, cappedHours: 0),
        ],
        daily: [.init(day: 0, hours: 3)]
    )

    func testWorkForProjectWithoutFilterReturnsUnchanged() {
        let v = StatsStore.workForProject(work, nil)
        XCTAssertEqual(v.totalHours, 3)
        XCTAssertEqual(v.byProject.count, 2)
    }

    func testWorkForProjectWithFilterKeepsOnlyThatProject() {
        let v = StatsStore.workForProject(work, "alfa")
        XCTAssertEqual(v.totalHours, 2)
        XCTAssertEqual(v.byProject.map(\.project), ["alfa"])
    }

    func testWorkForProjectWithoutHoursIsZeroNotTotal() {
        let v = StatsStore.workForProject(work, "gama")
        XCTAssertEqual(v.totalHours, 0)
        XCTAssertTrue(v.byProject.isEmpty)
    }
}
