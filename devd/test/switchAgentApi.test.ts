import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import type { SwitchAgentResult } from "../src/agentSwitch";
import { DEFAULT_CONFIG } from "../src/config";
import { openDb } from "../src/db";

// Thin routing layer over agentSwitch.switchAgent (the business logic is tested
// in agentSwitch.test.ts with a fake exec/db) — here only input validation and the
// status → HTTP code mapping, just like switchAccountApi.test.ts.
function app(switchAgent: (id: string, agent: string) => Promise<SwitchAgentResult>) {
  const db = openDb(":memory:");
  return createApp({
    mgr: {} as never, db, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    switchAgent,
  } as never);
}

const post = (a: ReturnType<typeof app>, body?: unknown) =>
  a.request("/api/sessions/dev-x-y/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("invalid / missing agent → 400, switchAgent is not called", async () => {
  let calls = 0;
  const a = app(async () => { calls++; return { status: "unchanged" }; });
  expect((await post(a, { agent: "gpt-neco" })).status).toBe(400);
  expect((await post(a, {})).status).toBe(400);
  expect((await post(a)).status).toBe(400);
  expect(calls).toBe(0);
});

test("unknown-session → 404, not-running/in-progress → 409", async () => {
  expect((await post(app(async () => ({ status: "unknown-session" })), { agent: "claude" })).status).toBe(404);
  expect((await post(app(async () => ({ status: "not-running" })), { agent: "claude" })).status).toBe(409);
  expect((await post(app(async () => ({ status: "in-progress" })), { agent: "claude" })).status).toBe(409);
});

// `status` goes over the wire — the CLI and dashboard build sentences from it; `ok` is just a shortcut.
test("unchanged/no-agent → 200 with status and empty panes", async () => {
  const r = await post(app(async () => ({ status: "unchanged" })), { agent: "claude" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, status: "unchanged", panes: [] });
  const n = await post(app(async () => ({ status: "no-agent" })), { agent: "claude" });
  expect(await n.json()).toEqual({ ok: false, status: "no-agent", panes: [] });
});

test("switched/failed → 200 with panes", async () => {
  const panes = [{ target: "main:0.0", outcome: "restarted" as const }];
  const ok = await post(app(async () => ({ status: "switched", panes })), { agent: "codex" });
  expect(await ok.json()).toEqual({ ok: true, status: "switched", panes });
  const bad = await post(app(async () => ({ status: "failed", panes: [] })), { agent: "codex" });
  expect(await bad.json()).toEqual({ ok: false, status: "failed", panes: [] });
});

// The dep being optional is a test-fixture convention (partial ApiDeps) — when it is not
// wired up the route must answer clearly, not crash on undefined.
test("without switchAgent wired up → 503", async () => {
  const db = openDb(":memory:");
  const a = createApp({
    mgr: {} as never, db, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
  } as never);
  expect((await post(a as ReturnType<typeof app>, { agent: "claude" })).status).toBe(503);
});

test("id from the URL and a valid agent reach switchAgent", async () => {
  const seen: [string, string][] = [];
  const a = app(async (id, agent) => { seen.push([id, agent]); return { status: "unchanged" }; });
  await a.request("/api/sessions/dev-shop-cms/agent", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "claude-openrouter" }),
  });
  expect(seen).toEqual([["dev-shop-cms", "claude-openrouter"]]);
});
