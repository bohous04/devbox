import XCTest
import UIKit
@testable import DevboxApp

/// `Theme.C` is just typed access to the asset catalog (`Assets.xcassets/Theme/*.colorset`) —
/// the real risk is a typo in a colorset name or a missing dark variant, which only shows up
/// as a `nil`/transparent color at runtime. So the test checks the catalog, not `Color` itself.
final class ThemeTests: XCTestCase {
    private let colorNames = [
        "background", "foreground", "card", "primary", "primaryForeground",
        "muted", "mutedForeground", "border", "destructive",
        "ok", "warn", "danger", "idle", "okText", "warnText", "dangerText",
        "chart1", "chart2", "chart3", "chart4", "chart5",
        "account1", "account2", "account3", "account4", "account5",
    ]

    func testAllThemeColorsResolveInLightAndDark() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            for name in colorNames {
                guard let color = UIColor(named: name) else {
                    XCTFail("missing color asset \"\(name)\"")
                    continue
                }
                var alpha: CGFloat = 0
                color.resolvedColor(with: traits).getRed(nil, green: nil, blue: nil, alpha: &alpha)
                XCTAssertGreaterThan(alpha, 0, "\"\(name)\" is transparent (clear) in \(style)")
            }
        }
    }

    func testQuotaBarToneWarnThreshold() {
        XCTAssertEqual(QuotaBar.tone(for: 0.9), .warn)
        XCTAssertNil(QuotaBar.tone(for: 0.89))
    }

    /// Disk (Overview/Hardware) warns earlier — web `StorageSummary` turns amber from `diskWarnPercent` (80).
    func testQuotaBarToneHonorsCustomThreshold() {
        XCTAssertEqual(QuotaBar.tone(for: 0.8, warnAt: 0.8), .warn)
        XCTAssertNil(QuotaBar.tone(for: 0.79, warnAt: 0.8))
    }
}
