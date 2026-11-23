#if DEBUG
import Foundation

/// The inbox of the `demo` set: two sessions waiting on an answer, a failed run and a failed CI, three finished runs not
/// yet seen, one running, one waiting on CI and one queued, idle ones (two tmux) and the shelves (a settled failure
/// among them), as devd groups them. Times are relative to launch, so the labels read the same on every run.
/// Every name here is invented. The release notes session has no branch recorded (a row from an older devd).
/// Settle, unsettle and seen answer as devd does: settle asks first ({confirm: true}) for a row that waits or works, unsettle brings back
/// the row as listed, and seen takes tmux sessions only.
enum InboxFixtures {
    static let routes: [String: FixtureMode.Responder] = {
        var routes: [String: FixtureMode.Responder] = [
            "GET /api/inbox": { _ in .json(["items": items(now: Date())]) },
            "GET /api/stream": { _ in .openStream },
        ]
        for row in items(now: Date()) {
            let id = row["sessionId"] as! String
            let base = "POST /api/sessions/\(id)"
            routes["\(base)/settle"] = { request in settle(id, confirmed: FixtureMode.body(of: request).map { String(decoding: $0, as: UTF8.self).contains(#""confirm":true"#) } ?? false) }
            routes["\(base)/unsettle"] = { _ in .json(listed(id)) }
            routes["\(base)/seen"] = { _ in
                listed(id)["runtime"] as? String == "tmux" ? FixtureResponse(status: 204)
                    : FixtureResponse(status: 409, body: Data(#"{"error":"not-a-tmux-session"}"#.utf8))
            }
        }
        return routes
    }()

    private static func listed(_ id: String) -> [String: Any] { items(now: Date()).first { $0["sessionId"] as? String == id }! }

    /// devd's settle: it ends the session after its grace (endsAt), and asks first for one that waits or works.
    private static func settle(_ id: String, confirmed: Bool) -> FixtureResponse {
        var row = listed(id)
        var attention = row["attention"] as! [String: Any]
        if !confirmed, attention["reason"] as? String == "request" {
            return FixtureResponse(status: 409, body: Data(#"{"error":"request-open","message":"The agent is waiting for your answer. End it?"}"#.utf8))
        }
        if !confirmed, attention["section"] as? String == "working" {
            return FixtureResponse(status: 409, body: Data(#"{"error":"agent-working","message":"The agent is still working. End it?"}"#.utf8))
        }
        let now = Int(Date().timeIntervalSince1970 * 1000)
        attention["section"] = "settled"
        attention["since"] = now
        row["attention"] = attention
        row["endsAt"] = now + 8_000
        row["endsIn"] = 8_000
        return .json(row)
    }

    static func items(now: Date) -> [[String: Any]] {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        func ago(_ minutes: Int) -> Int { ms - minutes * 60_000 }
        func item(_ id: String, _ title: String, _ project: String, _ repo: String, agent: String = "claude",
                  runtime: String = "chat", branch: String? = nil, section: String, reason: String?, since: Int, until: Int? = nil,
                  last: String?) -> [String: Any] {
            var attention: [String: Any] = ["section": section, "since": since]
            if let reason { attention["reason"] = reason }
            if let until { attention["until"] = until }
            var out: [String: Any] = ["sessionId": id, "runtime": runtime, "title": title, "project": project, "repo": repo,
                                      "agent": agent, "attention": attention]
            if let last { out["lastText"] = last }
            if let branch { out["branch"] = branch }
            return out
        }
        return [
            item("dev-acme-billing", "Run the invoice table migration", "acme", "billing", branch: "invoice-migration", section: "needs_you", reason: "request",
                 since: ago(14), last: "The migration rewrites 41k rows. May I run it against the staging database?"),
            item("dev-acme-web", "Pick a date library for the calendar", "acme", "web", agent: "codex", branch: "calendar-dates", section: "needs_you",
                 reason: "request", since: ago(6), last: "date-fns or the Temporal polyfill? date-fns is smaller; Temporal is the future API."),
            item("dev-acme-uploads", "Fix the flaky upload test", "acme", "web", branch: "flaky-upload", section: "needs_you", reason: "failed",
                 since: ago(31), last: "2 of 148 tests failed: upload retries after a timeout."),
            item("dev-lumen-app", "Dark mode for the settings page", "lumen", "app", branch: "settings-dark-mode", section: "working", reason: "running",
                 since: ago(2), last: "Updating the colour tokens in theme.css and the two settings forms."),
            item("dev-orchard-lint", "Pin the test runner version", "orchard", "api", agent: "codex", branch: "pin-runner", section: "needs_you",
                 reason: "ci-failed", since: ago(22), last: "CI failed on lint: two unused imports."),
            item("dev-orchard-search", "Cache the search results", "orchard", "web", agent: "codex", branch: "search-cache", section: "working",
                 reason: "pr-checks", since: ago(9), last: "PR opened; waiting for the checks."),
            item("dev-acme-index", "Index the archive table", "acme", "billing", branch: "archive-index", section: "working",
                 reason: "queued", since: ago(12), last: "Queued behind the running turn."),
            item("dev-acme-rename", "Rename the billing module", "acme", "billing", agent: "codex", branch: "rename-billing", section: "needs_you",
                 reason: "completed", since: ago(95), last: "Done. Renamed 14 files and updated the imports; tests pass."),
            // The session ThreadFixtures has a thread for, so a screenshot can show a row selected with its thread open.
            item("dev-orchard-sync", "Add a retry queue to the offline sync", "orchard", "sync", branch: "sync-retry-queue", section: "needs_you",
                 reason: "completed", since: ago(3),
                 last: "I added src/sync/queue.ts and queue.test.ts with six bun tests; all pass. The typecheck command fails."),
            item("dev-lumen-docs", "Write the 2.4 release notes", "lumen", "docs", agent: "antigravity", section: "needs_you", reason: "completed",
                 since: ago(320), last: "Drafted the notes in CHANGELOG.md: 6 features, 11 fixes."),
            item("dev-lumen-onboarding", "Draft the onboarding emails", "lumen", "app", agent: "vibe", branch: "onboarding-emails", section: "idle", reason: nil,
                 since: ago(2 * 1440 + 60), last: "Three emails drafted in docs/onboarding.md."),
            // devd names an unnamed session after its path; the row then shows "api #3".
            item("dev-orchard-api-3", "orchard/api", "orchard", "api", runtime: "tmux", section: "idle", reason: nil, since: ago(1500), last: nil),
            // Grok in tmux: the mirror cannot read it (MirrorFixtures).
            item("dev-lumen-sketch", "lumen/sketch", "lumen", "sketch", agent: "grok", runtime: "tmux", section: "idle", reason: nil,
                 since: ago(1700), last: nil),
            item("dev-lumen-deps", "Bump the build dependencies", "lumen", "app", branch: "bump-build-deps", section: "snoozed", reason: "rate-limited",
                 since: ago(50), until: ms + 3 * 3_600_000, last: "Usage limit reached; resumes after the reset."),
            item("dev-acme-logo", "Swap the logo in the footer", "acme", "web", branch: "footer-logo", section: "settled", reason: "completed",
                 since: ago(2900), last: "Replaced the footer logo with the new SVG."),
            item("dev-orchard-v1", "Retire the v1 endpoints", "orchard", "api", branch: "retire-v1", section: "settled", reason: "failed",
                 since: ago(3100), last: "The v1 contract tests fail: two clients still call /v1/sync."),
        ]
    }
}
#endif
