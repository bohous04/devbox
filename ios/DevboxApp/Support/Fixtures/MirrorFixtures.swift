#if DEBUG
import Foundation

/// Two tmux sessions of the `demo` set, shown through devd's mirror (`devbox://thread/<id>`): Claude Code in
/// `dev-orchard-api-3`, which takes messages (a send is refused: text already sits in the terminal's prompt), and
/// Codex in `dev-acme-cli`, which is read-only. Their streams are open and silent. Every name here is invented.
enum MirrorFixtures {
    static let claudeId = "dev-orchard-api-3"
    static let codexId = "dev-acme-cli"

    static let routes: [String: FixtureMode.Responder] = {
        var r: [String: FixtureMode.Responder] = [:]
        for (id, body) in [(claudeId, claude), (codexId, codex)] {
            let base = "/api/sessions/\(id)"
            r["GET \(base)/thread"] = { _ in FixtureResponse(status: 409, body: Data(#"{"error":"not-a-chat-session"}"#.utf8)) }
            r["GET \(base)/mirror"] = { _ in FixtureResponse(body: Data(body.utf8)) }
            r["GET \(base)/mirror/stream"] = { _ in .openStream }
            r["GET \(base)/changes"] = { _ in
                .json(["base": "origin/main", "totals": ["files": 0, "added": 0, "removed": 0], "files": [Any]()])
            }
        }
        r["POST /api/sessions/\(claudeId)/mirror/messages"] = { _ in
            FixtureResponse(status: 409, body: Data(#"""
                {"error":"terminal-has-draft","message":"Text is already typed into the terminal's prompt. Send or clear it in the terminal first."}
                """#.utf8))
        }
        r["POST /api/sessions/\(codexId)/mirror/messages"] = { _ in
            FixtureResponse(status: 409, body: Data(#"""
                {"error":"codex-send-unsupported","message":"Sending from chat isn't available for Codex yet; reply in the terminal."}
                """#.utf8))
        }
        return r
    }()

    /// The sessions' rows for the live list (ThreadFixtures serves it), so the header names them.
    static let liveSessions = #"""
    {"id":"dev-orchard-api-3","folder":"orchard","project":"orchard","repo":"api","container":"dev-orchard-api-3",
     "port_base":40200,"status":"running","solo":0,"created_at":1790000000000,"last_active_at":1790000600000,"important":0,
     "name":null,"critic":0,"agent":"claude","ports":[],"claudeState":"idle","cpuPct":0,"memBytes":0,
     "workspace":"/workspace","accountId":null},
    {"id":"dev-acme-cli","folder":"acme","project":"acme","repo":"cli","container":"dev-acme-cli",
     "port_base":40300,"status":"running","solo":0,"created_at":1790000000000,"last_active_at":1790000600000,"important":0,
     "name":null,"critic":0,"agent":"codex","ports":[],"claudeState":"idle","cpuPct":0,"memBytes":0,
     "workspace":"/workspace","accountId":null}
    """#

    private static let claude = #"""
    {"mirror":{"state":"live","agent":"Claude Code","conversationId":"c-1","activity":"idle","terminalPrompt":null,"sendBlock":null},
     "snapshot":{"lastSeq":12,"seenSeq":0,"pending":[],"background":[],"native":{"harness":"claude","nativeThreadId":"c-1","account":null,"model":null},
      "runs":[{"runId":"mirror:u1","origin":"user","status":"completed","harness":"claude","nativeThreadId":"c-1","model":null,
        "queuedAt":null,"startedAt":1790000000000,"endedAt":1790000040000,"endedSeq":12,"usage":null,"error":null}],
      "items":[
       {"seq":2,"runId":"mirror:u1","itemId":"user:u1","kind":"user","text":"Why does the health check time out on cold starts?","ts":1790000000000,"status":"done"},
       {"seq":4,"runId":"mirror:u1","itemId":"a1","kind":"assistant","text":"I'll check how the server starts.","ts":1790000004000,"status":"done"},
       {"seq":6,"runId":"mirror:u1","itemId":"t1","kind":"tool","text":"","tool":"Bash","input":{"command":"grep -n 'listen\\|migrate' src/server.ts"},"output":"12:  await migrate(db);\n18:  app.listen(port);","isError":false,"status":"done","ts":1790000010000},
       {"seq":10,"runId":"mirror:u1","itemId":"a2","kind":"assistant","text":"The server runs the database migrations **before** it listens, so the health check has nothing to talk to until they finish. On a cold start that takes about 20 s, longer than the check's 10 s timeout.\n\nListening first and answering `503` until the migrations are done would fix it.","ts":1790000039000,"status":"done"}]}}
    """#

    private static let codex = #"""
    {"mirror":{"state":"live","agent":"Codex","conversationId":"01aaaaaa-0000-7000-8000-000000000001","activity":"idle","terminalPrompt":null,
      "sendBlock":{"code":"codex-send-unsupported","message":"Sending from chat isn't available for Codex yet; reply in the terminal."}},
     "snapshot":{"lastSeq":9,"seenSeq":0,"pending":[],"background":[],
      "native":{"harness":"codex","nativeThreadId":"01aaaaaa-0000-7000-8000-000000000001","account":null,"model":null},
      "runs":[{"runId":"mirror:b1","origin":"user","status":"completed","harness":"codex","nativeThreadId":"01aaaaaa-0000-7000-8000-000000000001","model":null,
        "queuedAt":null,"startedAt":1790000000000,"endedAt":1790000030000,"endedSeq":9,"usage":null,"error":null}],
      "items":[
       {"seq":2,"runId":"mirror:b1","itemId":"user:u1","kind":"user","text":"Add a --json flag to the status command","ts":1790000000000,"status":"done"},
       {"seq":4,"runId":"mirror:b1","itemId":"call-1","kind":"tool","text":"","tool":"exec","input":{"cmd":"bun test test/status.test.ts"},"output":"4 pass\n0 fail","isError":false,"status":"done","ts":1790000020000},
       {"seq":7,"runId":"mirror:b1","itemId":"m1","kind":"assistant","text":"Added `--json` to `status`: it prints the same fields as one JSON object. The four status tests pass.","ts":1790000029000,"status":"done"}]}}
    """#
}
#endif
