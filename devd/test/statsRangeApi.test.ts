import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { insertMetrics, openDb } from "../src/db";
import type { RangeStats } from "../src/aggregate";

const T0 = 1_700_000_000_000;

function app() {
  const db = openDb(":memory:");
  insertMetrics(db, [
    { ts: T0 + 100, session_id: "s1", name: "claude_code.cost.usage", value: 1, attrs: JSON.stringify({ project: "alfa" }) },
    { ts: T0 + 200, session_id: "s2", name: "claude_code.cost.usage", value: 2, attrs: JSON.stringify({ project: "beta" }) },
  ]);
  const a = createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
  } as never);
  return a;
}

const get = async (query: string) => {
  const r = await app().fetch(new Request(`http://x/api/stats/range?from=${T0}&to=${T0 + 86_400_000}${query}`));
  expect(r.status).toBe(200);
  return await r.json() as RangeStats;
};

test("GET /api/stats/range?project= narrows totals to the given project", async () => {
  const d = await get("&project=alfa");
  expect(d.project).toBe("alfa");
  expect(d.totals.cost).toBe(1);
  // the options for the switcher must stay complete
  expect(d.projects.map((p) => p.project).sort()).toEqual(["alfa", "beta"]);
});

test("GET /api/stats/range without project returns the whole devbox", async () => {
  const d = await get("");
  expect(d.project).toBe(null);
  expect(d.totals.cost).toBe(3);
});

test("GET /api/stats/range: an empty project is ignored (= no filter)", async () => {
  const d = await get("&project=");
  expect(d.project).toBe(null);
  expect(d.totals.cost).toBe(3);
});
