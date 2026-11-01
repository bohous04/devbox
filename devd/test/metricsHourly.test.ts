import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { costByProject, insertMetrics, migrateMetricsHourly, openDb, queryMetricSum, resetStats, type MetricRow } from "../src/db";
import { buildRange, buildRangeRaw, PROMPT_CHARS, PROMPT_WAIT, type RangeStats } from "../src/aggregate";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NAMES = ["claude_code.cost.usage", "claude_code.token.usage", "claude_code.active_time.total", PROMPT_CHARS, PROMPT_WAIT];

/** Deterministic pseudo-random generator — the test must fail the same way every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function seed(db: Database, n = 3000): void {
  const r = rng(42);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const rows: MetricRow[] = [];
  for (let i = 0; i < n; i++) {
    const attrs: Record<string, string> = {};
    const project = pick(["alfa", "beta", "gama", null]);
    if (project) attrs.project = project;
    const repo = pick(["web", "api", null]);
    if (repo) attrs.repo = repo;
    const model = pick(["opus", "sonnet", null]);
    if (model) attrs.model = model;
    const host = pick(["devbox", "mac", null]);
    if (host) attrs["devbox.host"] = host;
    const account = pick(["acc-a", "acc-b", null]);
    if (account) attrs["user.account_uuid"] = account;
    rows.push({
      // negative ts too: SQLite divides towards zero, the rollup must compute the hour via floor
      ts: Math.floor((r() * 24 - 12) * DAY),
      session_id: pick(["s1", "s2", null]),
      name: pick(NAMES),
      value: Math.round(r() * 1000) / 10,
      attrs: JSON.stringify(attrs),
    });
  }
  insertMetrics(db, rows);
}

/** The rollup sums in a different order than SQL over raw rows — compared on
 *  rounded numbers, the structure (keys, day order) must match exactly. */
function norm(r: RangeStats): unknown {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)));
}
const sortKeys = (r: RangeStats) => {
  const by = <T,>(xs: T[], k: (x: T) => string) => [...xs].sort((a, b) => k(a).localeCompare(k(b)));
  return norm({
    ...r,
    projects: by(r.projects, (x) => x.project), models: by(r.models, (x) => x.model), repos: by(r.repos, (x) => x.repo),
    hosts: by(r.hosts, (x) => x.key), hostsPrevious: by(r.hostsPrevious, (x) => x.key), accounts: by(r.accounts, (x) => x.key),
    dailyByHost: by(r.dailyByHost, (x) => x.host),
  });
};

function expectSameAsRaw(db: Database) {
  for (const [from, to] of [[0, DAY], [-7 * DAY, 0], [-5 * DAY + 3 * HOUR, 6 * DAY + 3 * HOUR], [-12 * DAY, 12 * DAY]]) {
    for (const [project, repo] of [[null, null], ["alfa", null], [null, "web"], ["beta", "api"], ["missing", null]] as const) {
      expect(sortKeys(buildRange(db, from, to, project, repo))).toEqual(sortKeys(buildRangeRaw(db, from, to, project, repo)));
    }
  }
}

test("metrics_hourly: buildRange via the rollup gives the same as directly over metrics", () => {
  const db = openDb(":memory:");
  seed(db);
  expectSameAsRaw(db);
  db.close();
});

test("metrics_hourly: triggers keep the rollup in sync on UPDATE and DELETE of source rows", () => {
  const db = openDb(":memory:");
  seed(db);
  // codexStatsRepair rewrites a_model of existing rows — the rollup must not diverge
  db.run("UPDATE metrics SET a_model='gpt' WHERE id % 7 = 0");
  db.run("UPDATE metrics SET value = value * 2, ts = ts + 5 * 3600000 WHERE id % 11 = 0");
  db.run("DELETE FROM metrics WHERE id % 5 = 0");
  expectSameAsRaw(db);
  // a group without source rows disappears (otherwise the breakdown would show an empty key)
  const orphans = db.query(`SELECT COUNT(*) c FROM metrics_hourly h WHERE NOT EXISTS (
    SELECT 1 FROM metrics m WHERE m.name=h.name AND m.a_project IS h.a_project AND m.a_model IS h.a_model
      AND m.a_host IS h.a_host AND m.a_account IS h.a_account AND m.a_repo IS h.a_repo
      AND m.ts >= h.hour*3600000 AND m.ts < (h.hour+1)*3600000)`).get() as { c: number };
  expect(orphans.c).toBe(0);
  db.close();
});

test("migrateMetricsHourly: backfills the rollup for a DB that already has metrics, and is idempotent", () => {
  const db = openDb(":memory:");
  for (const t of ["metrics_hourly_ins", "metrics_hourly_del", "metrics_hourly_upd"]) db.run(`DROP TRIGGER ${t}`);
  db.run("DROP TABLE metrics_hourly");
  seed(db);                                     // without triggers — like an old DB
  expect(migrateMetricsHourly(db)).toBe(true);
  expect(migrateMetricsHourly(db)).toBe(false);
  expectSameAsRaw(db);
  // missing trigger = the whole rollup is rebuilt, not just the trigger
  db.run("DROP TRIGGER metrics_hourly_upd");
  expect(migrateMetricsHourly(db)).toBe(true);
  expectSameAsRaw(db);
  db.close();
});

test("resetStats: empties the rollup too and the triggers survive", () => {
  const db = openDb(":memory:");
  seed(db, 200);
  resetStats(db);
  expect((db.query("SELECT COUNT(*) c FROM metrics_hourly").get() as { c: number }).c).toBe(0);
  insertMetrics(db, [{ ts: 100, session_id: null, name: "claude_code.cost.usage", value: 4, attrs: "{}" }]);
  expect(buildRange(db, 0, DAY).totals.cost).toBe(4);
  db.close();
});

test("buildRange: a window not aligned to the hour takes the slow path and counts the edges exactly", () => {
  const db = openDb(":memory:");
  insertMetrics(db, [
    { ts: 10 * 60_000, session_id: null, name: "claude_code.cost.usage", value: 1, attrs: "{}" },
    { ts: 40 * 60_000, session_id: null, name: "claude_code.cost.usage", value: 2, attrs: "{}" },
  ]);
  // the rollup would count the whole hour 0; correct is only the row in minute 40
  expect(buildRange(db, 30 * 60_000, DAY + 30 * 60_000).totals.cost).toBe(2);
  db.close();
});

test("queryMetricSum / costByProject via the rollup match the raw sum even for a truncated first hour", () => {
  const db = openDb(":memory:");
  seed(db);
  const cost = "claude_code.cost.usage";
  for (const since of [-12 * DAY, -3 * DAY, -3 * DAY + 17 * 60_000 + 123, 0, 5 * HOUR + 1, 11 * DAY + 59 * 60_000]) {
    const raw = (db.query("SELECT COALESCE(SUM(value),0) v FROM metrics WHERE name=? AND ts>=?").get(cost, since) as { v: number }).v;
    expect(queryMetricSum(db, cost, since)).toBeCloseTo(raw, 6);
    const rawBy = db.query("SELECT COALESCE(a_project,'?') p, SUM(value) s FROM metrics WHERE name=? AND ts>=? GROUP BY p").all(cost, since) as { p: string; s: number }[];
    const got = costByProject(db, since);
    expect(Object.keys(got).sort()).toEqual(rawBy.map((r) => r.p).sort());
    for (const r of rawBy) expect(got[r.p]).toBeCloseTo(r.s, 6);
  }
  db.close();
});
