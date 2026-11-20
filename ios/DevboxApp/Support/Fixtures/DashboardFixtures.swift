#if DEBUG
import Foundation

/// The dashboard pages of the `demo` set that the Mac screenshots show: the folder tree, the schedules, unpushed
/// commits, agent upkeep and operations. Every name here is invented.
enum DashboardFixtures {
    static let routes: [String: FixtureMode.Responder] = [
        "GET /api/tree": { _ in .json(tree) },
        "GET /api/schedules": { _ in .json(schedules(now: Date())) },
        "GET /api/unpushed": { _ in .json(unpushed(now: Date())) },
        "GET /api/agent-upkeep": { _ in .json(upkeep) },
        "GET /api/operations": { _ in .json(operations(now: Date())) },
        "GET /api/prod-db/writes": { _ in .json(prodWrites(now: Date())) },
    ]

    private static func repo(_ name: String, cloned: Bool = true, agent: String? = nil) -> [String: Any] {
        var r: [String: Any] = ["name": name, "cloneUrl": "https://git.example.com/\(name).git", "provider": "github", "cloned": cloned]
        if let agent { r["agent"] = agent }
        return r
    }

    static let tree: [[String: Any]] = [
        ["folder": "work", "project": "acme", "repos": [repo("web"), repo("billing", agent: "codex"), repo("mobile", cloned: false)]],
        ["folder": "work", "project": "orchard", "repos": [repo("sync"), repo("api")]],
        ["folder": "personal", "project": "lumen", "repos": [repo("docs"), repo("app")]],
    ]

    static func schedules(now: Date) -> [[String: Any]] {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        func s(_ id: String, _ name: String, _ cron: String, _ project: String, _ repo: String, enabled: Int, important: Int = 0,
               ranHoursAgo: Int?, runtime: String = "chat") -> [String: Any] {
            var row: [String: Any] = ["id": id, "name": name, "cron": cron, "folder": "work", "project": project, "repo": repo,
                                      "clone_url": "https://git.example.com/\(repo).git", "prompt": "Run the \(name.lowercased()) routine.",
                                      "important": important, "enabled": enabled, "runtime": runtime]
            if let ranHoursAgo { row["last_run_at"] = ms - ranHoursAgo * 3_600_000 }
            return row
        }
        return [
            s("s1", "Nightly dependency check", "0 3 * * *", "acme", "web", enabled: 1, important: 1, ranHoursAgo: 9),
            s("s2", "Weekly release notes", "0 9 * * 1", "lumen", "docs", enabled: 1, ranHoursAgo: 50),
            s("s3", "Flaky test triage", "30 7 * * 1-5", "orchard", "sync", enabled: 0, ranHoursAgo: nil, runtime: "tmux"),
        ]
    }

    static func unpushed(now: Date) -> [String: Any] {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        func commit(_ hash: String, _ subject: String, minutesAgo: Int) -> [String: Any] {
            ["hash": hash, "subject": subject, "at": ms - minutesAgo * 60_000, "author": "Sam Rivera"]
        }
        func repo(_ folder: String, _ project: String, _ name: String, branches: [[String: Any]], provider: String = "github",
                  error: String? = nil) -> [String: Any] {
            var r: [String: Any] = ["folder": folder, "project": project, "repo": name, "path": "/srv/dev/\(project)/\(name)",
                                    "bare": false, "noRemote": false, "branches": branches,
                                    "count": branches.reduce(0) { $0 + ($1["count"] as! Int) },
                                    "remote": ["provider": provider, "url": "https://git.example.com/\(project)/\(name).git",
                                               "host": "git.example.com", "owner": project, "name": name], "base": "main"]
            if let error { r["error"] = error }
            return r
        }
        let web = repo("work", "acme", "web", branches: [
            ["branch": "feat/checkout-totals", "upstream": "origin/feat/checkout-totals", "count": 3, "truncated": false, "commits": [
                commit("4f2a9c1e", "Round line totals before tax", minutesAgo: 12),
                commit("b81d7e03", "Show the discount row only when it applies", minutesAgo: 48),
                commit("0c9e55aa", "Add totals fixture for the checkout tests", minutesAgo: 95),
            ]],
            ["branch": "fix/login-redirect", "upstream": NSNull(), "count": 1, "truncated": false, "commits": [
                commit("9d3b2f70", "Keep the return path through the login redirect", minutesAgo: 230),
            ]],
        ])
        let sync = repo("work", "orchard", "sync", branches: [
            ["branch": "main", "upstream": "origin/main", "count": 2, "truncated": false, "commits": [
                commit("71c0de42", "Retry the batch upload on a 503", minutesAgo: 30),
                commit("e2a4f9b8", "Log the cursor when a page is skipped", minutesAgo: 75),
            ]],
        ], provider: "gitea")
        let docs = repo("personal", "lumen", "docs", branches: [
            ["branch": "draft/release-notes", "upstream": "origin/draft/release-notes", "count": 1, "truncated": false, "commits": [
                commit("3a7f1d06", "Draft the 2.4 release notes", minutesAgo: 1_440),
            ]],
        ])
        let folders: [[String: Any]] = [
            ["folder": "work", "count": 6, "repos": [web, sync]],
            ["folder": "personal", "count": 1, "repos": [docs]],
        ]
        return ["scanning": false, "error": NSNull(),
                "report": ["at": ms - 4 * 60_000, "total": 7, "scanned": 14, "folders": folders]]
    }

    static let upkeep: [String: Any] = {
        func s(_ id: String, _ project: String, _ repo: String, _ version: String?, running: Int?, restart: Bool?) -> [String: Any] {
            ["id": id, "project": project, "repo": repo, "version": version.map { $0 as Any } ?? NSNull(),
             "running": running.map { $0 as Any } ?? NSNull(), "restartRequired": restart.map { $0 as Any } ?? NSNull()]
        }
        return ["provider": "claude", "latest": "2.4.1", "image": "2.4.0", "mode": "nightly", "sessions": [
            s("dev-acme-web", "acme", "web", "2.4.1", running: 1, restart: false),
            s("dev-acme-billing", "acme", "billing", "2.4.0", running: 0, restart: false),
            s("dev-orchard-sync", "orchard", "sync", "2.4.1", running: 2, restart: true),
            s("dev-orchard-api", "orchard", "api", "2.4.1", running: 0, restart: false),
            s("dev-lumen-docs", "lumen", "docs", nil, running: nil, restart: nil),
        ]]
    }()

    static func operations(now: Date) -> [[String: Any]] {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        func json(_ value: Any) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
        }
        func op(_ id: Int, _ status: String, minutesAgo: Int, params: [String: Any], result: String? = nil, error: String? = nil) -> [String: Any] {
            ["id": id, "ts": ms - minutesAgo * 60_000, "session_id": "dev-acme-web", "op": "deploy", "params": json(params),
             "status": status, "decided_at": NSNull(), "result": result.map { $0 as Any } ?? NSNull(), "error": error.map { $0 as Any } ?? NSNull()]
        }
        let changes = json(["Build the image from feat/checkout-totals", "Run the database migration 0042_totals", "Restart the web service"])
        return [
            op(14, "pending", minutesAgo: 6, params: ["app": "acme-web", "environment": "production", "branch": "feat/checkout-totals",
                                                     "changes": changes, "afterWrite": "9"]),
            op(13, "executed", minutesAgo: 180, params: ["app": "orchard-sync", "environment": "staging", "branch": "main"],
               result: "Deployed in 2 min 14 s"),
            op(12, "failed", minutesAgo: 1_500, params: ["app": "lumen-docs", "environment": "production", "branch": "main"],
               error: "Health check failed after 3 attempts"),
        ]
    }

    static func prodWrites(now: Date) -> [[String: Any]] {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        return [
            ["id": 9, "ts": ms - 8 * 60_000, "session_id": "dev-acme-web", "db": "acme-prod", "status": "pending",
             "sql": "ALTER TABLE orders ADD COLUMN total_rounded numeric(12,2);", "decided_at": NSNull(), "result": NSNull(), "error": NSNull()],
            ["id": 8, "ts": ms - 26 * 3_600_000, "session_id": "dev-orchard-sync", "db": "orchard-prod", "status": "executed",
             "sql": "UPDATE cursors SET page = 0 WHERE stale = true;", "decided_at": ms - 25 * 3_600_000, "result": "3 rows", "error": NSNull()],
        ]
    }
}
#endif
