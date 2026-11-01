import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADAPTER = join(import.meta.dir, "..", "..", "image", "vendor", "devd-hooks", "agy-hook.sh");
const REAL_HOOK = join(import.meta.dir, "..", "..", "image", "vendor", "devd-hooks", "devd-hook.sh");

// Fake devd-hook: records which event it was called with, and for stop returns what it gets in env.
function fakeHook(dir: string, stopOut = ""): { path: string; log: string } {
  const log = join(dir, "calls.log");
  const path = join(dir, "devd-hook.sh");
  writeFileSync(path, `#!/usr/bin/env bash\ncat >/dev/null\necho "$1" >> ${log}\n[ "$1" = stop ] && printf '%s' '${stopOut}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return { path, log };
}
async function run(ev: string, stdin: string, env: Record<string, string>) {
  const p = Bun.spawn(["bash", ADAPTER, ev], { env: { ...process.env, ...env }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  return { out, code: await p.exited };
}
// Drop empty lines: `>>` creates the file before echo writes into it — an empty log
// would otherwise count as one call with event "" and waitForCalls would finish early.
const calls = (log: string) => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };

// Non-stop emits (Finding B) run in the background, detached from the adapter — so the log
// appears only AFTER run() returns its result. The tests therefore wait for the log (up to ~2 s)
// instead of weakening the assert to "it will show up eventually somehow".
async function waitForCalls(log: string, want: number, timeoutMs = 2000): Promise<string[]> {
  const start = Date.now();
  let c = calls(log);
  while (c.length < want && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    c = calls(log);
  }
  return c;
}

test("PreInvocation with invocationNum 0 = new prompt (user_prompt_submit) + session_start with the model", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d);
  const r = await run("PreInvocation", JSON.stringify({ conversationId: "c1", invocationNum: 0 }), { DEVD_HOOK: h.path });
  expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual({});
  // Both run in the background independently → the order is not fixed.
  expect((await waitForCalls(h.log, 2)).sort()).toEqual(["session_start", "user_prompt_submit"]);
});

test("PreInvocation with invocationNum > 0 = heartbeat (tool_complete)", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d);
  await run("PreInvocation", JSON.stringify({ conversationId: "c1", invocationNum: 3 }), { DEVD_HOOK: h.path });
  expect(await waitForCalls(h.log, 1)).toEqual(["tool_complete"]);
});

test("SessionStart = session_start", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d);
  const agyHome = join(d, "agy-home");
  const r = await run("SessionStart", JSON.stringify({ conversationId: "c1" }), { DEVD_HOOK: h.path, AGY_HOME: agyHome });
  expect(JSON.parse(r.out)).toEqual({}); expect(await waitForCalls(h.log, 1)).toEqual(["session_start"]);
});

// SessionStart comes only from a conversation, i.e. AFTER agy finishes onboarding (colors,
// data-collection consent, trust). The marker tells agent-launch that a typed-in first prompt
// will no longer hit these menus.
//
// hooks.json is on the shared antigravity-home volume — the LOGIN container runs over it too
// (devbox-agy-login), which never has any real conversation and does not get
// DEVD_SESSION_ID. Without the condition its agy would create the marker before the user ever
// saw onboarding, and the scheduled prompt would go through the menu ("data-collection consent"
// is checked by default there).
test("SessionStart with a session ID (real conversation) creates the onboarding-finished marker", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d);
  const agyHome = join(d, "agy-home");
  const r = await run("SessionStart", JSON.stringify({ conversationId: "c1" }), { DEVD_HOOK: h.path, AGY_HOME: agyHome, DEVD_SESSION_ID: "dev-x" });
  expect(JSON.parse(r.out)).toEqual({});
  expect(existsSync(join(agyHome, ".devbox-onboarded"))).toBe(true);
});

test("SessionStart without DEVD_SESSION_ID (login container, no conversation) does not create the marker", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d);
  const agyHome = join(d, "agy-home");
  const r = await run("SessionStart", JSON.stringify({ conversationId: "c1" }), { DEVD_HOOK: h.path, AGY_HOME: agyHome });
  expect(JSON.parse(r.out)).toEqual({});
  expect(existsSync(join(agyHome, ".devbox-onboarded"))).toBe(false);
});

// Finding B (phase 1a review): PreInvocation runs before EVERY model call. A slow/
// dropping devd (curl -m 2) would otherwise double the latency of every turn — so the heartbeat
// (tool_complete) and user_prompt_submit must be fire-and-forget.
test("PreInvocation does not wait for a slow devd-hook (the heartbeat must not block the model)", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-"));
  const log = join(d, "calls.log");
  const path = join(d, "devd-hook.sh");
  writeFileSync(path, `#!/usr/bin/env bash\ncat >/dev/null\nif [ "$1" != stop ]; then sleep 3; fi\necho "$1" >> ${log}\nexit 0\n`);
  chmodSync(path, 0o755);
  const start = Date.now();
  const r = await run("PreInvocation", JSON.stringify({ conversationId: "c1", invocationNum: 7 }), { DEVD_HOOK: path });
  const elapsedMs = Date.now() - start;
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({});
  expect(elapsedMs).toBeLessThan(1000);
  // Confirmation that the hook really ran — just later, in the background.
  expect(await waitForCalls(log, 1, 4000)).toEqual(["tool_complete"]);
});

test("Stop: a critic block is translated to agy continue with the reason", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-"));
  const h = fakeHook(d, JSON.stringify({ decision: "block", reason: "missing test" }));
  const r = await run("Stop", JSON.stringify({ conversationId: "c1", terminationReason: "NO_TOOL_CALL" }), { DEVD_HOOK: h.path });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({ decision: "continue", reason: "missing test" });
});

test("Stop: a clean end returns {} (the agent finishes normally)", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d, "");
  const r = await run("Stop", "{}", { DEVD_HOOK: h.path });
  expect(JSON.parse(r.out)).toEqual({});
});

test("missing emitter, broken stdin and unknown event → {} and exit 0", async () => {
  for (const [ev, stdin] of [["Stop", "{"], ["PreInvocation", "nonsense"], ["Bogus", "{}"]] as const) {
    const r = await run(ev, stdin, { DEVD_HOOK: "/nonexistent/devd-hook.sh" });
    expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual({});
  }
});

test("end-to-end with the real devd-hook.sh: conversationId goes to devd as agentSessionId", async () => {
  let seen: Record<string, unknown> = {};
  const srv = Bun.serve({ port: 0, fetch: async (req) => { seen = await req.json() as Record<string, unknown>; return Response.json({ decision: "block", reason: "fix it" }); } });
  try {
    const r = await run("Stop", JSON.stringify({ conversationId: "conv-9", terminationReason: "NO_TOOL_CALL" }),
      { DEVD_HOOK: REAL_HOOK, DEVD_SESSION_ID: "dev-x", DEVD_URL: `http://127.0.0.1:${srv.port}` });
    expect(seen.event).toBe("stop");
    expect(seen.agentSessionId).toBe("conv-9");
    expect(JSON.parse(r.out)).toEqual({ decision: "continue", reason: "fix it" });
  } finally { srv.stop(true); }
});

// SessionStart also sends the model (agy gives it as modelName) — devd needs it for
// harvest usage attribution (api.ts, harvest_state "agy-sids"). emit_bg runs in the
// background, so the test waits for seen.event by polling.
test("SessionStart sends devd modelName as agentModel", async () => {
  let seen: Record<string, unknown> = {};
  const srv = Bun.serve({ port: 0, fetch: async (req) => { seen = await req.json() as Record<string, unknown>; return Response.json({ ok: true }); } });
  try {
    await run("SessionStart", JSON.stringify({ conversationId: "ab32-01", modelName: "gemini-3.8-flash-high" }),
      { DEVD_HOOK: REAL_HOOK, DEVD_SESSION_ID: "dev-x", DEVD_URL: `http://127.0.0.1:${srv.port}`, AGY_HOME: mkdtempSync(join(tmpdir(), "agyh-")) });
    for (let i = 0; i < 20 && !seen.event; i++) await Bun.sleep(100);   // emit runs in the background
    expect(seen.event).toBe("session_start");
    expect(seen.agentSessionId).toBe("ab32-01");
    expect(seen.agentModel).toBe("gemini-3.8-flash-high");
  } finally { srv.stop(true); }
});

// A new prompt (PreInvocation 0) announces the conversation again with the current model —
// the user switches it between prompts with `/model` (live: modelName in PreInvocation changes
// after switching). A heartbeat (invocationNum > 0) does not send session_start.
test("PreInvocation 0 also sends devd session_start with the current modelName; >0 does not", async () => {
  const seen: Record<string, unknown>[] = [];
  const srv = Bun.serve({ port: 0, fetch: async (req) => { seen.push(await req.json() as Record<string, unknown>); return Response.json({ ok: true }); } });
  try {
    const env = { DEVD_HOOK: REAL_HOOK, DEVD_SESSION_ID: "dev-x", DEVD_URL: `http://127.0.0.1:${srv.port}` };
    await run("PreInvocation", JSON.stringify({ conversationId: "ab32-01", invocationNum: 0, modelName: "claude-opus-5-5-high" }), env);
    for (let i = 0; i < 30 && seen.length < 2; i++) await Bun.sleep(100);
    const start = seen.find((e) => e.event === "session_start");
    expect(start?.agentSessionId).toBe("ab32-01");
    expect(start?.agentModel).toBe("claude-opus-5-5-high");
    expect(seen.some((e) => e.event === "user_prompt_submit")).toBe(true);

    seen.length = 0;
    await run("PreInvocation", JSON.stringify({ conversationId: "ab32-01", invocationNum: 3, modelName: "claude-opus-5-5-high" }), env);
    for (let i = 0; i < 20 && seen.length < 1; i++) await Bun.sleep(100);
    await Bun.sleep(300);
    expect(seen.map((e) => e.event)).toEqual(["tool_complete"]);
  } finally { srv.stop(true); }
});

// Warp tab state + checkpoint for devbox-recovery goes through warp-hook.sh --tty. The fake
// Warp hook records the agent, arguments and stdin (warp-title.py reads `session_id`, agy
// sends `conversationId`). The call runs in the background like emit_bg → we wait for the log.
function fakeWarp(dir: string, body?: string): { path: string; log: string } {
  const log = join(dir, "warp.log");
  const path = join(dir, "warp-hook.sh");
  writeFileSync(path, body ?? `#!/usr/bin/env bash\necho "$DEVD_WARP_AGENT $1 $2 $(cat)" >> ${log}\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

test("the adapter also calls the Warp hook with DEVD_WARP_AGENT=agy and session_id from conversationId", async () => {
  for (const [ev, stdin, want] of [
    ["SessionStart", { conversationId: "c1" }, "session_start"],
    ["PreInvocation", { conversationId: "c1", invocationNum: 0 }, "prompt_submit"],
    ["PreInvocation", { conversationId: "c1", invocationNum: 4 }, "tool_complete"],
    ["Stop", { conversationId: "c1", terminationReason: "NO_TOOL_CALL" }, "stop"],
  ] as const) {
    const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d); const w = fakeWarp(d);
    // AGY_HOME goes to a temp dir — otherwise SessionStart in this loop would create
    // the onboarding marker in the real $HOME of the machine running the test.
    const r = await run(ev, JSON.stringify(stdin), { DEVD_HOOK: h.path, WARP_HOOK: w.path, AGY_HOME: join(d, "agy-home") });
    expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual({});
    const [line] = await waitForCalls(w.log, 1);
    const prefix = `agy --tty ${want} `;
    expect(line.startsWith(prefix)).toBe(true);
    const payload = JSON.parse(line.slice(prefix.length));
    expect(payload.session_id).toBe("c1");
    expect(payload.conversationId).toBe("c1");
  }
});

test("a Warp hook that hangs, crashes or prints does not change the adapter's output or verdict", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-"));
  const h = fakeHook(d, JSON.stringify({ decision: "block", reason: "x" }));
  const w = fakeWarp(d, "#!/usr/bin/env bash\ncat >/dev/null\necho NOISE\necho NOISE >&2\nsleep 3\nexit 7\n");
  for (const [ev, stdin, want] of [
    ["Stop", "{}", { decision: "continue", reason: "x" }],
    ["PreInvocation", JSON.stringify({ conversationId: "c1", invocationNum: 2 }), {}],
    ["SessionStart", JSON.stringify({ conversationId: "c1" }), {}],
  ] as const) {
    const start = Date.now();
    // Same reason as above: SessionStart in this loop must not touch the real $HOME.
    const r = await run(ev, stdin, { DEVD_HOOK: h.path, WARP_HOOK: w.path, AGY_HOME: join(d, "agy-home") });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.out)).toEqual(want);
  }
});

test("a missing Warp hook does not break the adapter", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-")); const h = fakeHook(d);
  const r = await run("PreInvocation", JSON.stringify({ conversationId: "c1", invocationNum: 0 }), { DEVD_HOOK: h.path, WARP_HOOK: "/nonexistent/warp-hook.sh" });
  expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual({});
  expect((await waitForCalls(h.log, 2)).sort()).toEqual(["session_start", "user_prompt_submit"]);
});

// Stop blocked by the critic: agy gets `continue` and keeps working, but the next PreInvocation
// has invocationNum > 0 (reset only by a new prompt) → tool_complete, which warp-title.py
// drops after `stop`. A Warp `stop` would thus leave both the tab and checkpoint (active=false) "done".
test("a blocked Stop does not send Warp stop; a clean Stop does", async () => {
  const d = mkdtempSync(join(tmpdir(), "agyh-"));
  const h = fakeHook(d, JSON.stringify({ decision: "block", reason: "finish it" })); const w = fakeWarp(d);
  const r = await run("Stop", JSON.stringify({ conversationId: "c1" }), { DEVD_HOOK: h.path, WARP_HOOK: w.path });
  expect(JSON.parse(r.out)).toEqual({ decision: "continue", reason: "finish it" });
  await new Promise((res) => setTimeout(res, 1000));
  expect(calls(w.log)).toEqual([]);

  const d2 = mkdtempSync(join(tmpdir(), "agyh-")); const h2 = fakeHook(d2, ""); const w2 = fakeWarp(d2);
  const r2 = await run("Stop", JSON.stringify({ conversationId: "c1" }), { DEVD_HOOK: h2.path, WARP_HOOK: w2.path });
  expect(JSON.parse(r2.out)).toEqual({});
  const [line] = await waitForCalls(w2.log, 1);
  expect(line.startsWith("agy --tty stop ")).toBe(true);
});
