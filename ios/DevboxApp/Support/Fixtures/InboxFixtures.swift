#if DEBUG
import Foundation

/// The inbox of the `demo` set: two sessions waiting on an answer, a failed run, two finished runs not yet seen,
/// one running, idle ones (one tmux) and the shelves, as devd groups them. Times are relative to launch, so the labels read the same on every run.
/// Every name here is invented.
enum InboxFixtures {
    static let routes: [String: FixtureMode.Responder] = [
        "GET /api/inbox": { _ in .json(["items": items(now: Date())]) },
        "GET /api/stream": { _ in .openStream },
    ]

    static func items(now: Date) -> [[String: Any]] {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        func ago(_ minutes: Int) -> Int { ms - minutes * 60_000 }
        func item(_ id: String, _ title: String, _ project: String, _ repo: String, agent: String = "claude",
                  runtime: String = "chat", section: String, reason: String?, since: Int, until: Int? = nil,
                  last: String?) -> [String: Any] {
            var attention: [String: Any] = ["section": section, "since": since]
            if let reason { attention["reason"] = reason }
            if let until { attention["until"] = until }
            var out: [String: Any] = ["sessionId": id, "runtime": runtime, "title": title, "project": project, "repo": repo,
                                      "agent": agent, "attention": attention]
            if let last { out["lastText"] = last }
            return out
        }
        return [
            item("dev-acme-billing", "Run the invoice table migration", "acme", "billing", section: "needs_you", reason: "request",
                 since: ago(14), last: "The migration rewrites 41k rows. May I run it against the staging database?"),
            item("dev-acme-web", "Pick a date library for the calendar", "acme", "web", agent: "codex", section: "needs_you",
                 reason: "request", since: ago(6), last: "date-fns or the Temporal polyfill? date-fns is smaller; Temporal is the future API."),
            item("dev-acme-uploads", "Fix the flaky upload test", "acme", "web", section: "needs_you", reason: "failed",
                 since: ago(31), last: "2 of 148 tests failed: upload retries after a timeout."),
            item("dev-lumen-app", "Dark mode for the settings page", "lumen", "app", section: "working", reason: "running",
                 since: ago(2), last: "Updating the colour tokens in theme.css and the two settings forms."),
            item("dev-acme-rename", "Rename the billing module", "acme", "billing", agent: "codex", section: "needs_you",
                 reason: "completed", since: ago(95), last: "Done. Renamed 14 files and updated the imports; tests pass."),
            item("dev-lumen-docs", "Write the 2.4 release notes", "lumen", "docs", section: "needs_you", reason: "completed",
                 since: ago(320), last: "Drafted the notes in CHANGELOG.md: 6 features, 11 fixes."),
            item("dev-lumen-onboarding", "Draft the onboarding emails", "lumen", "app", section: "idle", reason: nil,
                 since: ago(2 * 1440 + 60), last: "Three emails drafted in docs/onboarding.md."),
            // devd names an unnamed session after its path; the row then shows "api #3".
            item("dev-orchard-api-3", "orchard/api", "orchard", "api", runtime: "tmux", section: "idle", reason: nil, since: ago(1500), last: nil),
            item("dev-lumen-deps", "Bump the build dependencies", "lumen", "app", section: "snoozed", reason: "rate-limited",
                 since: ago(50), until: ms + 3 * 3_600_000, last: "Usage limit reached; resumes after the reset."),
            item("dev-acme-logo", "Swap the logo in the footer", "acme", "web", section: "settled", reason: "completed",
                 since: ago(2900), last: "Replaced the footer logo with the new SVG."),
        ]
    }
}
#endif
