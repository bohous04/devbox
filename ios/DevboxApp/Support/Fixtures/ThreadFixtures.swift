#if DEBUG
import Foundation

/// The chat thread of the `demo` set (`devbox://thread/dev-orchard-sync`): an earlier short turn, a bridge notice,
/// then one finished run with three commands (one failed) and a markdown answer with a list, a table and a link.
/// The thread stream is the shared `GET /api/stream` (open and silent), so the thread stays as loaded.
/// Every name here is invented.
enum ThreadFixtures {
    static let sessionId = "dev-orchard-sync"
    private static let base = "/api/sessions/\(sessionId)"

    static let routes: [String: FixtureMode.Responder] = [
        "GET \(base)/thread": { _ in raw(thread) },
        "GET \(base)/thread/target": { _ in
            .json(["agent": "claude", "harness": "claude", "account": NSNull(), "model": "claude-opus-5-5",
                   "awaitingTarget": false, "bridgeVersion": "1.7.0"])
        },
        "POST \(base)/thread/seen": { _ in .json([String: Any]()) },
        // Taken; the level would come back over the stream, which is silent here.
        "POST \(base)/thread/effort": { _ in FixtureResponse(status: 202, body: Data()) },
        // The chat header's place ("orchard / sync") comes from the live session list (with MirrorFixtures' sessions).
        "GET /api/stats/live": { _ in raw(live) },
        "GET /api/stats/sessions": { _ in .json([Any]()) },
        "GET \(base)/changes": { _ in raw(changes) },
        // The composer's `@`: the repo's paths containing the query.
        "GET \(base)/files": { request in
            let q = (URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value ?? "").lowercased()
            return .json(["files": repoFiles.filter { q.isEmpty || $0.lowercased().contains(q) }])
        },
        "GET \(base)/changes/diff": { request in
            let path = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
            guard let path, let diff = diffs[path] else { return FixtureResponse(status: 404, body: Data(#"{"error":"no such changed file"}"#.utf8)) }
            return .json(["path": path, "status": diff.status, "base": "origin/main", "binary": false, "truncated": false, "diff": diff.text])
        },
    ]

    private static let repoFiles = ["Dockerfile", "README.md", "package.json", "src/index.ts", "src/main.ts", "src/sync/manifest.ts",
                                    "src/sync/merge.ts", "test/manifest.test.ts", "docs/release notes.md"]

    /// The run's work on disk: two new files and a one-line export, uncommitted, against origin/main.
    private static let changes = #"""
    {"base":"origin/main","totals":{"files":3,"added":78,"removed":0},"files":[
     {"path":"src/sync/index.ts","status":"modified","added":1,"removed":0},
     {"path":"src/sync/queue.ts","status":"untracked","added":25,"removed":0},
     {"path":"src/sync/queue.test.ts","status":"untracked","added":52,"removed":0}]}
    """#

    private static let diffs: [String: (status: String, text: String)] = [
        "src/sync/index.ts": ("modified", """
        diff --git a/src/sync/index.ts b/src/sync/index.ts
        index 3f2a1c0..8b7e4d2 100644
        --- a/src/sync/index.ts
        +++ b/src/sync/index.ts
        @@ -1,3 +1,4 @@
         export { replay } from "./replay";
        +export { push, drain } from "./queue";
         
         export const SYNC_VERSION = 3;

        """),
        "src/sync/queue.ts": ("untracked", """
        diff --git a/src/sync/queue.ts b/src/sync/queue.ts
        new file mode 100644
        --- /dev/null
        +++ b/src/sync/queue.ts
        @@ -0,0 +1,25 @@
        +export type Job = { id: string; payload: unknown; attempts: number };
        +
        +const jobs: Job[] = [];
        +
        +/** Queues a job behind the ones already waiting. */
        +export function push(job: Job): void {
        +  jobs.push(job);
        +}
        +
        +/** Sends the oldest job first; stops at the first failure and keeps that job and the rest. */
        +export async function drain(send: (job: Job) => Promise<void>): Promise<number> {
        +  let sent = 0;
        +  while (jobs.length > 0) {
        +    const job = jobs[0];
        +    try {
        +      await send(job);
        +    } catch {
        +      job.attempts += 1;
        +      return sent;
        +    }
        +    jobs.shift();
        +    sent += 1;
        +  }
        +  return sent;
        +}

        """),
    ]

    private static func raw(_ json: String) -> FixtureResponse { FixtureResponse(body: Data(json.utf8)) }

    private static let live = #"""
    {"sessions":[{"id":"dev-orchard-sync","folder":"orchard","project":"orchard","repo":"sync","container":"dev-orchard-sync",
    "port_base":40100,"status":"running","solo":0,"created_at":1790000000000,"last_active_at":1790000600000,"important":0,
    "name":null,"critic":0,"agent":"claude","ports":[],"claudeState":"idle","cpuPct":0,"memBytes":0,
    "workspace":"/workspace","accountId":null},\#(MirrorFixtures.liveSessions)],"disk":{"usedBytes":1,"totalBytes":2}}
    """#

    private static let thread = #"""
    {"lastSeq":40,"seenSeq":40,"pending":[],"background":[],"native":null,
    "effort":{"model":"claude-opus-5-5","supported":["low","medium","high","xhigh","max"],"effective":"high","chosen":"high"},
    "commands":[{"name":"compact","description":"Clear the conversation history but keep a summary in context"},
     {"name":"review","description":"Review a pull request"},{"name":"init","description":"Initialize a new project instructions file"},
     {"name":"pr-comments","description":"Get comments from a GitHub pull request"},{"name":"security-review","description":"Review the pending changes for security issues"},
     {"name":"context","description":"Visualize current context usage as a colored grid","hint":"[detail]"}],
    "runs":[
     {"runId":"run-1","origin":"user","status":"completed","harness":"claude","nativeThreadId":"n-1","model":"claude-opus-5-5",
      "queuedAt":null,"startedAt":1790000000000,"endedAt":1790000012000,"endedSeq":8,"usage":null,"error":null},
     {"runId":"run-2","origin":"user","status":"completed","harness":"claude","nativeThreadId":"n-1","model":"claude-opus-5-5",
      "queuedAt":null,"startedAt":1790000100000,"endedAt":1790000234000,"endedSeq":40,"usage":null,"error":null}],
    "items":[
     {"seq":2,"runId":"run-1","itemId":"user:run-1","kind":"user","text":"Which Node version does the sync service pin?","ts":1790000000000,"status":"done"},
     {"seq":6,"runId":"run-1","itemId":"m-1","kind":"assistant","text":"It pins **Node 22** in `.nvmrc`; the Dockerfile uses the same image.","ts":1790000011000,"status":"done"},
     {"seq":9,"runId":null,"itemId":null,"kind":"notice","text":"Agent bridge restarted (v1.5.0)","ts":1790000050000,"status":"done"},
     {"seq":10,"runId":"run-2","itemId":"user:run-2","kind":"user","text":"Add a retry queue for the offline sync: create src/sync/queue.ts exporting push(job) and drain(send) (oldest first, stop at the first failure and keep the rest), plus queue.test.ts with six bun tests including an empty queue and a failing send. Run the tests and typecheck that file with bunx tsc --noEmit --strict src/sync/queue.ts. Then reply with one sentence of what you did, a short bullet list (bold lead words) of the behaviour, a markdown table Check | Result for tests and typecheck, and a link to https://example.com/docs/sync for reference. Do not commit.","ts":1790000100000,"status":"done"},
     {"seq":12,"runId":"run-2","itemId":"m-2","kind":"assistant","text":"I'll look at the sync module first.","ts":1790000104000,"status":"done"},
     {"seq":14,"runId":"run-2","itemId":"t-1","kind":"tool","text":"","tool":"Bash","input":{"command":"ls src/sync && cat src/sync/index.ts | head -40","description":"List the sync module"},"output":"index.ts\nreplay.ts\nexport { replay } from \"./replay\";","isError":false,"status":"done","ts":1790000106000},
     {"seq":20,"runId":"run-2","itemId":"t-2","kind":"tool","text":"","tool":"Bash","input":{"command":"bun test src/sync/queue.test.ts"},"output":"queue.test.ts:\n✓ push keeps order\n✓ drain sends oldest first\n✓ drain stops at the first failure\n✓ an empty queue drains to nothing\n✓ a failing send keeps the rest\n✓ push after drain appends\n\n 6 pass\n 0 fail","isError":false,"status":"done","ts":1790000180000},
     {"seq":26,"runId":"run-2","itemId":"t-3","kind":"tool","text":"","tool":"Bash","input":{"command":"bunx tsc --noEmit --strict src/sync/queue.ts"},"output":"error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.","isError":true,"status":"done","ts":1790000200000},
     {"seq":30,"runId":"run-2","itemId":"m-3","kind":"assistant","text":"The exact command refuses a single file inside a project that has a tsconfig.json.","ts":1790000205000,"status":"done"},
     {"seq":38,"runId":"run-2","itemId":"m-4","kind":"assistant","text":"I added `src/sync/queue.ts` and `queue.test.ts` with six bun tests; all pass. The requested typecheck command fails because the project has a tsconfig.json. Nothing is committed.\n\n- **Order:** `drain` sends the oldest job first.\n- **Failures:** it stops at the first failed send and keeps that job and the rest.\n- **Empty queue:** draining it sends nothing and resolves at once.\n\n| Check | Result |\n| --- | --- |\n| `bun test src/sync/queue.test.ts` | ✅ 6 pass, 0 fail |\n| `bunx tsc --noEmit --strict src/sync/queue.ts` | ❌ TS5112: a tsconfig.json is present, so tsc refuses a single file |\n\nReference: https://example.com/docs/sync/offline-queue/retry-and-backoff#drain-order","ts":1790000233000,"status":"done"}]}
    """#
}
#endif
