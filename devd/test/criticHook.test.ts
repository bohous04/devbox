import { expect, test } from "bun:test";

const HOOK = new URL("../../image/vendor/devd-hooks/devd-hook.sh", import.meta.url).pathname;

async function runHook(event: string, stdin: string, respond: (req: Request) => Response | Promise<Response>) {
  const srv = Bun.serve({ port: 0, fetch: respond });
  try {
    const p = Bun.spawn(["bash", HOOK, event], {
      env: { ...process.env, DEVD_SESSION_ID: "dev-shop-cms", DEVD_URL: `http://127.0.0.1:${srv.port}` },
      stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    return { out, code };
  } finally { srv.stop(true); }
}

test("stop: a blocking response is printed to stdout as JSON for Claude", async () => {
  const { out, code } = await runHook("stop", "{}", () =>
    Response.json({ decision: "block", reason: "missing await on line 3" }));
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe("block");
  expect(parsed.reason).toContain("missing await");
});

test("stop: a clean response prints nothing (the agent finishes normally)", async () => {
  const { out, code } = await runHook("stop", "{}", () => Response.json({ ok: true }));
  expect(code).toBe(0);
  expect(out.trim()).toBe("");
});

test("stop: unreachable devd prints nothing and does not crash", async () => {
  const p = Bun.spawn(["bash", HOOK, "stop"], {
    env: { ...process.env, DEVD_SESSION_ID: "dev-shop-cms", DEVD_URL: "http://127.0.0.1:1" },
    stdin: new TextEncoder().encode("{}"), stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out.trim()).toBe("");
});

test("user_prompt_submit sends the prompt text from the hook JSON", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("user_prompt_submit", JSON.stringify({ prompt: "add SSO" }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.event).toBe("user_prompt_submit");
  expect(seen.prompt).toBe("add SSO");
});

test("seed registers the Stop hook with a 300 s timeout", async () => {
  const seed = await Bun.file(new URL("../../image/seed-devd-hooks.sh", import.meta.url).pathname).text();
  expect(seed).toContain("timeout: 300");
});

test("every event sends session_id as agentSessionId", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("stop", JSON.stringify({ session_id: "main-1" }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.event).toBe("stop");
  expect(seen.agentSessionId).toBe("main-1");
});

test("subagent_start sends agent_type as agentType", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("subagent_start", JSON.stringify({ session_id: "main-1", agent_type: "Explore" }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.event).toBe("subagent_start");
  expect(seen.agentType).toBe("Explore");
});

test("task_created sends taskId, taskSubject, teammateName and teamName", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1", task_id: "t7", task_subject: "fix login",
    teammate_name: "bob", team_name: "alpha",
  });
  await runHook("task_created", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.taskId).toBe("t7");
  expect(seen.taskSubject).toBe("fix login");
  expect(seen.teammateName).toBe("bob");
  expect(seen.teamName).toBe("alpha");
});

test("missing optional fields do not get into the payload at all", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("teammate_idle", JSON.stringify({ session_id: "main-1" }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen).not.toHaveProperty("agentType");
  expect(seen).not.toHaveProperty("teammateName");
});

test("stop: a subagent in background_tasks counts", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [{ id: "a", type: "subagent", status: "running" }],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(1);
});

test("stop: a shell in background_tasks does NOT count (otherwise bun dev & would silence notifications forever)", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [{ id: "a", type: "shell", status: "running" }],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(0);
});

// Monitor was originally lumped in with `shell`, but that reasoning does not fit it. Measured live
// on 2026-08-18 on websites/claudeSolo-2 (notify_log):
//   22:12:16  stop        armed   backgroundTasks: 0   ← monitor was running
//   22:12:36  sweep_done  sent                         ← false "agent finished"
//   22:12:54  user_prompt_submit  <task-notification> "Monitor event: …"  ← agent continued
// The turn was not finished, just parked. Unlike `bun dev &`, a monitor is GUARANTEED
// to wake the agent and is bounded by a timeout (1500 s live), so the silencing is temporary.
test("stop: a monitor in background_tasks COUNTS — the turn is only parked, not done", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [{ id: "b", type: "monitor", status: "running" }],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(1);
});

// A finished monitor no longer parks the turn — the status must still decide.
test("stop: a finished monitor does not count", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [{ id: "b", type: "monitor", status: "completed" }],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(0);
});

// Round 3: teammate was DELIBERATELY dropped from the allowlist. A live test showed that
// teammate entries in background_tasks never disappear (23 teammates after 4.5 h, one finished hours
// earlier, still "running") — with teammate in the allowlist a session that ever used one would
// never get the "finished" notification again. Teammates are tracked by the inflight counter (see
// agentEvents.ts, signal unification).
test("stop: a teammate in background_tasks does NOT count (entries never disappear, see spec)", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [{ id: "a", type: "teammate", status: "running" }],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(0);
});

test("stop: a mixed array counts subagent/cloud session/monitor — not teammate/shell/workflow", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [
      { id: "a", type: "subagent", status: "running" },
      { id: "b", type: "shell", status: "running" },
      { id: "c", type: "teammate", status: "pending" },
      { id: "d", type: "monitor", status: "running" },
      { id: "e", type: "cloud session", status: "running" },
      { id: "f", type: "workflow", status: "running" },
    ],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(3); // subagent + cloud session + monitor
});

test("stop: missing background_tasks omits the key from the payload entirely (older Claude Code)", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("stop", JSON.stringify({ session_id: "main-1" }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen).not.toHaveProperty("backgroundTasks");
});

test("stop: a relevant type with a finished status does not count", async () => {
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({
    session_id: "main-1",
    background_tasks: [{ id: "a", type: "subagent", status: "completed" }],
  });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(0);
});

test("stop: empty background_tasks sends 0 (different from a missing key)", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("stop", JSON.stringify({ session_id: "main-1", background_tasks: [] }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen.backgroundTasks).toBe(0);
});

test("stop: background_tasks == null omits the key from the payload (not 0 — we don't know, not nothing running)", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("stop", JSON.stringify({ session_id: "main-1", background_tasks: null }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen).not.toHaveProperty("backgroundTasks");
});

test("stop: background_tasks as a string omits the key from the payload", async () => {
  let seen: Record<string, unknown> = {};
  await runHook("stop", JSON.stringify({ session_id: "main-1", background_tasks: "nope" }), async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen).not.toHaveProperty("backgroundTasks");
});

test("stop: background_tasks as an EMPTY object (not an array) omits the key from the payload", async () => {
  // An empty object, not an object with id/type/status fields: on the latter `.background_tasks[]?`
  // iterates its STRING values (jq objects support .[]), select(.type==…) crashes on them
  // with an error → empty stdout → the bash fallback `bg="null"` gives the same result as the fix,
  // but for a different reason — the test would thus pass even against the old script version (verified,
  // see report). `{}` returns nothing on `.[]?`, `length` is 0 → the old version sends
  // `backgroundTasks: 0` (a real bug), only the type check in the fix tells them apart.
  let seen: Record<string, unknown> = {};
  const stdin = JSON.stringify({ session_id: "main-1", background_tasks: {} });
  await runHook("stop", stdin, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(seen).not.toHaveProperty("backgroundTasks");
});

test("stop: two concatenated JSON documents on stdin do not kill the POST (otherwise the critic's verdict would be lost too)", async () => {
  let seen: Record<string, unknown> = {};
  const doc1 = JSON.stringify({ session_id: "main-1", background_tasks: [{ id: "a", type: "subagent", status: "running" }] });
  const doc2 = JSON.stringify({ garbage: true });
  const { code } = await runHook("stop", doc1 + doc2, async (req) => {
    seen = await req.json() as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  expect(code).toBe(0);
  expect(seen.event).toBe("stop"); // the POST must happen, not silently fall through (an empty {} would not satisfy this)
  expect(seen.sessionId).toBe("dev-shop-cms");
  expect(seen.agentSessionId).toBe("main-1");
  expect(seen.backgroundTasks).toBe(1); // takes only the FIRST document
});

// The overall 290 s limit is here because of the critic (devd synchronously waits on Stop for the verdict),
// but ESTABLISHING the connection never takes longer than an instant: devd on the host either listens
// or not. When a firewall silently drops SYN (2026-09-05: a session on the dind-net-* network,
// ufw only allowed docker0), curl without a separate connect timeout waited the whole
// 290 s — and the agent looked busy for five more minutes after finishing its work. A connection
// to an overloaded devd (blocked event loop) does not trip this: the TCP handshake is completed by
// the kernel from the backlog even without the application.
test("stop: curl has a separate connect timeout so a dropped SYN does not hang for 290 s", async () => {
  const sh = await Bun.file(HOOK).text();
  const stopCurl = sh.split("\n").find((l) => l.includes("-m 290"));
  expect(stopCurl).toBeDefined();
  expect(stopCurl).toContain("--connect-timeout 3");
});
