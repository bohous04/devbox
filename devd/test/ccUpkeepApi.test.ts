import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { insertSession, openDb, type SessionRow } from "../src/db";
import type { CcStatus, UpkeepResult } from "../src/ccUpkeep";
import { memoAsync } from "../src/cache";

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

const STATUS: CcStatus = {
  latest: "2.1.220", image: "2.1.220",
  sessions: [{ id: ROW.id, project: "shop", repo: "cms", version: "2.1.207", panes: 1, stalePanes: 0, busyPct: 4 }],
};
const RESULT: UpkeepResult = { latest: "2.1.220", built: false, updated: [ROW.id], restarted: [], skipped: [] };

function app(run: (only?: string[]) => Promise<UpkeepResult | null>, status: () => Promise<CcStatus> = async () => STATUS, extra: Record<string, unknown> = {}) {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  const a = createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    ccUpkeep: { status, run }, ...extra,
  } as never);
  return a;
}

test("GET /api/cc-upkeep returns the status", async () => {
  const res = await app(async () => RESULT).request("/api/cc-upkeep");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(STATUS);
});

test("POST /api/cc-upkeep/run without a body runs the full sweep", async () => {
  const seen: (string[] | undefined)[] = [];
  const res = await app(async (only) => { seen.push(only); return RESULT; })
    .request("/api/cc-upkeep/run", { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(RESULT);
  expect(seen).toEqual([undefined]);
});

test("POST /api/cc-upkeep/run with a session passes it as a filter", async () => {
  const seen: (string[] | undefined)[] = [];
  const res = await app(async (only) => { seen.push(only); return RESULT; }).request("/api/cc-upkeep/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: ROW.id }),
  });
  expect(res.status).toBe(200);
  expect(seen).toEqual([[ROW.id]]);
});

test("POST /api/cc-upkeep/run with an unknown session → 404 and the job does not start", async () => {
  let ran = 0;
  const res = await app(async () => { ran++; return RESULT; }).request("/api/cc-upkeep/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: "dev-neexistuje" }),
  });
  expect(res.status).toBe(404);
  expect(ran).toBe(0);
});

test("POST /api/cc-upkeep/run when already running → 409", async () => {
  const res = await app(async () => null).request("/api/cc-upkeep/run", { method: "POST" });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("already running");
});

test("GET /api/cc-upkeep: the second call does not hit docker again", async () => {
  let calls = 0;
  const cached = memoAsync(async () => { calls++; return STATUS; }, 60_000);
  const a = app(async () => RESULT, () => cached.get());
  await a.request("/api/cc-upkeep");
  await a.request("/api/cc-upkeep");
  expect(calls).toBe(1);
});

test("after an upkeep run the status is fresh, not from cache", async () => {
  let calls = 0;
  const cached = memoAsync(async () => { calls++; return STATUS; }, 60_000);
  // The same invalidation ccUpkeepRun does in index.ts: after a cc upgrade the
  // remembered version is false and must be re-measured.
  const a = app(async () => { cached.invalidate(); return RESULT; }, () => cached.get());
  await a.request("/api/cc-upkeep");
  await a.request("/api/cc-upkeep/run", { method: "POST" });
  await a.request("/api/cc-upkeep");
  expect(calls).toBe(2);
});


test("agent upkeep validates provider/session and forwards the selected existing updater", async () => {
  const calls: unknown[] = [];
  const a = app(async()=>RESULT, undefined, {agentUpkeep:{
    status: async (provider:string) => ({provider,latest:"1.0.1",image:"1.0.0",mode:"on-launch",sessions:[]}),
    run: async (provider:string,only?:string[]) => {calls.push([provider,only]);return {provider,updated:[],restarted:[],deferred:[],failed:[],unchanged:[],built:false};},
  }});
  expect((await a.request("/api/agent-upkeep?provider=grok")).status).toBe(200);
  expect((await a.request("/api/agent-upkeep?provider=invalid")).status).toBe(400);
  const post=(body:unknown)=>a.request("/api/agent-upkeep/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  expect((await post({provider:"codex",session:ROW.id})).status).toBe(200);
  expect(calls).toEqual([["codex",[ROW.id]]]);
  expect((await post({provider:"grok",session:17})).status).toBe(400);
  expect((await post({provider:"grok",session:"missing"})).status).toBe(404);
  expect(calls).toHaveLength(1);
});
