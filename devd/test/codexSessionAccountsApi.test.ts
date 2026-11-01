import { expect, test } from "bun:test";
import { createApp, type ApiDeps } from "../src/api";
import { CodexSessionAccountError } from "../src/codexSessionAccounts";
import { DEFAULT_CONFIG } from "../src/config";
import { openDb } from "../src/db";

const state = { accounts: [], panes: [{ target: "main:0.0", accountId: "default" }], currentAccountId: "default" };
function fixture(service?: ApiDeps["codexSessionAccounts"], codexSwitchWaitMs?: number) {
  return createApp({
    mgr: {} as never, db: openDb(":memory:"), cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}), cloneQueue: {} as never,
    configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    codexSessionAccounts: service, codexSwitchWaitMs,
  });
}
const url = "/api/sessions/dev-games-pdm/codex-account";
const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Codex session GET is read-only and never cached", async () => {
  const calls: string[] = [];
  const app = fixture({
    view: async (id) => { calls.push(id); return state; },
    switch: async () => { throw new Error("must not switch on GET"); },
  });
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(state);
  expect(calls).toEqual(["dev-games-pdm"]);
});

test("Codex session POST forwards explicit selection and reports partial failure", async () => {
  const seen: unknown[] = [];
  const result = { ok: false, accountId: "default", label: "Main account", unchanged: false,
    panes: [{ target: "main:0.0", outcome: "did-not-return" }], error: "A panel could not switch." };
  const app = fixture({ view: async () => state, switch: async (id, accountId) => { seen.push(id, accountId); return result; } });
  const response = await app.request(url, post({ accountId: "default" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(seen).toEqual(["dev-games-pdm", "default"]);
});

test("long conversation handoffs disable the request idle timeout before switching", async () => {
  const timeouts: number[] = [];
  const app = fixture({ view: async () => state, switch: async () => {
    expect(timeouts).toEqual([0]);
    return { ok: true, accountId: "default", label: "Main", unchanged: true, panes: [] };
  } });
  const server = { timeout: (_request: Request, seconds: number) => { timeouts.push(seconds); } };
  expect((await app.request(url, post({ accountId: "default" }), server)).status).toBe(200);
  await app.request(url, undefined, server);
  expect(timeouts).toEqual([0]);
});

test("Codex account service maps validation, missing session, and concurrent switch errors", async () => {
  for (const status of [400, 404, 409, 502] as const) {
    const app = fixture({ view: async () => state, switch: async () => { throw new CodexSessionAccountError("Switch rejected", status); } });
    const response = await app.request(url, post({ accountId: "default" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Switch rejected" });
  }
});

test("malformed request reaches validation without choosing a fallback account", async () => {
  const seen: unknown[] = [];
  const app = fixture({ view: async () => state, switch: async (_id, accountId) => {
    seen.push(accountId);
    throw new CodexSessionAccountError("Select an account", 400);
  } });
  expect((await app.request(url, { method: "POST", body: "{" })).status).toBe(400);
  expect(seen).toEqual([undefined]);
});

test("unconfigured service and internal errors cannot expose runtime secrets", async () => {
  expect((await fixture().request(url)).status).toBe(503);
  const fail = async (): Promise<never> => { throw new Error("SECRET fake-auth-token"); };
  for (const init of [undefined, post({ accountId: "default" })]) {
    const response = await fixture({ view: fail, switch: fail }).request(url, init);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SECRET");
  }
});

test("a slow switch answers 202, keeps running, and reports its result once", async () => {
  let release!: () => void;
  let calls = 0;
  const result = { ok: true, accountId: "default", label: "Main", unchanged: false, panes: [] };
  const app = fixture({ view: async () => state, switch: async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return result;
  } }, 5);
  const first = await app.request(url, post({ accountId: "default" }));
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ running: true });
  expect((await app.request(url, post({ accountId: "default" }))).status).toBe(409);
  expect(calls).toBe(1);
  expect(await (await app.request(url)).json()).toEqual({ ...state, switching: true });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await (await app.request(url)).json()).toEqual({ ...state, lastSwitch: result });
  expect(await (await app.request(url)).json()).toEqual(state);
});

test("a background switch failure is reported without internal details", async () => {
  let reject!: (err: Error) => void;
  const app = fixture({ view: async () => state, switch: () => new Promise((_resolve, fail) => { reject = fail; }) }, 5);
  expect((await app.request(url, post({ accountId: "default" }))).status).toBe(202);
  reject(new Error("SECRET fake-auth-token"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const body = await (await app.request(url)).json() as { lastSwitch: { ok: boolean } };
  expect(body.lastSwitch.ok).toBe(false);
  expect(JSON.stringify(body)).not.toContain("SECRET");
});
