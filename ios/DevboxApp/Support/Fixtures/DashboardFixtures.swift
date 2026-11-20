#if DEBUG
import Foundation

/// The dashboard pages of the `demo` set that the Mac screenshots show: the folder tree and the schedules. Every
/// name here is invented.
enum DashboardFixtures {
    static let routes: [String: FixtureMode.Responder] = [
        "GET /api/tree": { _ in .json(tree) },
        "GET /api/schedules": { _ in .json(schedules(now: Date())) },
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
}
#endif
