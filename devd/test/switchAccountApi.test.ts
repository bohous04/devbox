import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import type { SwitchAccountResult } from "../src/accountSwitch";
import { DEFAULT_CONFIG } from "../src/config";
import { openDb } from "../src/db";

// Thin routing layer over accountSwitch.switchAccount (the business logic is
// tested in accountSwitch.test.ts with a fake exec/db) — here we only verify the
// status → HTTP code mapping and the JSON response shape, just as ccUpkeepApi.test.ts
// tests /api/cc-upkeep/run over a canned `run` function.
function app(switchAccount: (id: string, accountId?: string) => Promise<SwitchAccountResult>) {
  const db = openDb(":memory:");
  return createApp({
    mgr: {} as never, db, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    accounts: { profiles: {} as never, leaseMaxAgeMs: () => 4 * 3600_000, switchAccount },
  } as never);
}

test("without a configured pool → 503", async () => {
  const db = openDb(":memory:");
  const a = createApp({
    mgr: {} as never, db, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
  } as never);
  expect((await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" })).status).toBe(503);
});

test("unknown-session → 404", async () => {
  const a = app(async () => ({ status: "unknown-session" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(404);
});

test("not-running → 409", async () => {
  const a = app(async () => ({ status: "not-running" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(409);
});

test("unavailable target profile → 409 with an explanation that the current pane was preserved", async () => {
  const a = app(async () => ({ status: "profile-unavailable" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toContain("No Claude pane was stopped");
});

// Review round 2: concurrent call on the same session (the lock is in accountSwitch.ts).
test("in-progress (concurrent call on the same session) → 409", async () => {
  const a = app(async () => ({ status: "in-progress" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(409);
});

// C1: server-side safeguard in case an older build bypasses the CLI guard.
// Since Task 2 the message is generic (profile, not name) — the pool does not apply to any profile
// outside anthropicAccount, not just Codex, see accountSwitch.ts.
test("wrong-agent → 400", async () => {
  const a = app(async () => ({ status: "wrong-agent" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toContain("does not run on an Anthropic account");
});

test("no-account → 200, ok:false, accountId null", async () => {
  const a = app(async () => ({ status: "no-account" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: false, accountId: null, label: null, unchanged: false, exhausted: false, panes: [] });
});

test("unchanged → 200, ok:true, unchanged:true, no panes", async () => {
  const a = app(async () => ({ status: "unchanged", accountId: "backup", label: "backup@x.cz" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, accountId: "backup", label: "backup@x.cz", unchanged: true, exhausted: false, panes: [] });
});

test("failed → 200, ok:false, panes in the response", async () => {
  const panes = [{ target: "main:0.0", outcome: "did-not-exit" as const }];
  const a = app(async () => ({ status: "failed", accountId: "backup", label: "backup@x.cz", exhausted: false, panes }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: false, accountId: "backup", label: "backup@x.cz", unchanged: false, exhausted: false, panes });
});

test("switched → 200, ok:true, exhausted and panes are passed through", async () => {
  const panes = [{ target: "main:0.0", outcome: "restarted" as const }];
  const a = app(async () => ({ status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: true, panes }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, accountId: "backup", label: "backup@x.cz", unchanged: false, exhausted: true, panes });
});

test("sessionId from the URL parameter reaches switchAccount", async () => {
  const seen: string[] = [];
  const a = app(async (id) => { seen.push(id); return { status: "unknown-session" }; });
  await a.request("/api/sessions/dev-shop-cms/switch-account", { method: "POST" });
  expect(seen).toEqual(["dev-shop-cms"]);
});

test("body { accountId } is passed through as the manual target; no body = automatic (undefined)", async () => {
  const seen: (string | undefined)[] = [];
  const a = app(async (_id, accountId) => { seen.push(accountId); return { status: "unchanged", accountId: "x", label: "X" }; });
  await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST" });
  await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "backup" }) });
  expect(seen).toEqual([undefined, "backup"]);
});

test("invalid accountId in the body → 400 without calling switchAccount", async () => {
  let calls = 0;
  const a = app(async () => { calls++; return { status: "unknown-session" }; });
  for (const accountId of [42, ""]) {
    const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId }) });
    expect(r.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test("invalid-account (unknown/disabled target) → 400", async () => {
  const a = app(async () => ({ status: "invalid-account" }));
  const r = await a.request("/api/sessions/dev-x-y/switch-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "nope" }) });
  expect(r.status).toBe(400);
});
