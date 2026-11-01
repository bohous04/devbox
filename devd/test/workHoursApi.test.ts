import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { insertSession, insertWorkInterval, openDb, type SessionRow } from "../src/db";

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

function app() {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  const a = createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
  } as never);
  return { a, db };
}

test("GET /api/stats/work returns totals", async () => {
  const { a, db } = app();
  const t0 = 1_700_000_000_000;
  insertWorkInterval(db, { session_id: "dev-shop-cms", project: "shop", repo: "cms", started_at: t0, ended_at: t0 + 3_600_000, seconds: 3600, capped: 0 });
  insertWorkInterval(db, { session_id: "dev-shop-cms", project: "shop", repo: "cms", started_at: t0 + 1, ended_at: t0 + 1_800_000, seconds: 1800, capped: 1 });

  const r = await a.fetch(new Request(`http://x/api/stats/work?from=${t0 - 1}&to=${t0 + 86_400_000}`));
  expect(r.status).toBe(200);
  const w = await r.json() as { totalHours: number; byProject: { project: string; hours: number; cappedHours: number }[] };
  expect(w.totalHours).toBeCloseTo(1.5, 5);
  expect(w.byProject).toHaveLength(1);
  expect(w.byProject[0]).toEqual({ project: "shop", hours: 1.5, cappedHours: 0.5 });
});

test("GET /api/stats/work: missing or non-numeric from/to → 400", async () => {
  const { a } = app();
  expect((await a.fetch(new Request("http://x/api/stats/work?from=abc&to=100"))).status).toBe(400);
  expect((await a.fetch(new Request("http://x/api/stats/work"))).status).toBe(400);
  expect((await a.fetch(new Request("http://x/api/stats/work?from=100&to=100"))).status).toBe(400); // to must be > from
});
