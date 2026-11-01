import { expect, test } from "bun:test";
import { diskHistory, diskHistoryEnds, insertDiskTotal, insertMetrics, insertWorkInterval, openDb, upsertGitStat } from "../src/db";
import { buildProjectLeaderboard, buildTotals, buildWorkHours, predictDisk } from "../src/aggregate";

const DAY = 86_400_000;
function seed(now: number) {
  const db = openDb(":memory:");
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const mid = d.getTime(); // local midnight, matches aggregate.ts
  insertMetrics(db, [
    { ts: mid + 1000, session_id: "dev-shop-cms", name: "claude_code.token.usage", value: 1500, attrs: JSON.stringify({ project: "shop" }) },
    { ts: mid + 2000, session_id: "dev-shop-cms", name: "claude_code.cost.usage", value: 0.5, attrs: JSON.stringify({ project: "shop" }) },
    { ts: mid + 3000, session_id: "dev-blog-cms", name: "claude_code.cost.usage", value: 0.2, attrs: JSON.stringify({ project: "metro" }) },
    { ts: mid + 4000, session_id: "dev-shop-cms", name: "claude_code.active_time.total", value: 3600, attrs: "{}" },
  ]);
  upsertGitStat(db, "dev-shop-cms", { commits: 4, added: 10, removed: 2, unpushed: 3 });
  return { db, mid };
}

test("buildTotals aggregates since midnight", () => {
  const now = 1_800_000_000_000;
  const { db } = seed(now);
  const t = buildTotals(db, now);
  expect(t.tokensToday).toBe(1500);
  expect(t.costToday).toBeCloseTo(0.7);
  expect(t.hoursToday).toBeCloseTo(1);
  expect(t.commitsToday).toBe(4);
  expect(t.unpushed).toBe(3);
});

test("project leaderboard ranks by cost", () => {
  const now = 1_800_000_000_000;
  const { db } = seed(now);
  const board = buildProjectLeaderboard(db, now);
  expect(board[0].project).toBe("shop");
  expect(board[0].costToday).toBeCloseTo(0.5);
});

test("the leaderboard reads a_project via the covering index and keeps a row without a project under '?'", () => {
  const now = 1_800_000_000_000;
  const { db } = seed(now);
  insertMetrics(db, [{
    ts: now - 1000, session_id: null, name: "claude_code.cost.usage", value: 0.25,
    attrs: JSON.stringify({ "devbox.host": "mac" }),   // no project — typically a Mac session
  }]);
  const board = buildProjectLeaderboard(db, now);
  const nameless = board.find((r) => r.project === "?");
  expect(nameless?.costToday).toBeCloseTo(0.25);

  const plan = (db.query(
    "EXPLAIN QUERY PLAN SELECT COALESCE(a_project,'?') p, SUM(value) s FROM metrics WHERE name=? AND ts>=? GROUP BY p"
  ).all("claude_code.cost.usage", 0) as { detail: string }[]).map((r) => r.detail).join(" ");
  expect(plan).toContain("COVERING INDEX metrics_rollup");
});

test("predictDisk extrapolates days left", () => {
  const p = predictDisk([{ ts: 0, bytes: 100 }, { ts: 2 * DAY, bytes: 300 }], 1000);
  expect(p.growthPerDay).toBeCloseTo(100);
  expect(p.daysLeft).toBeCloseTo(7); // (1000-300)/100
  expect(predictDisk([{ ts: 0, bytes: 100 }], 1000).daysLeft).toBeNull(); // not enough data
});

// disk_stats is now an append-only TOTAL-usage snapshot table (append-only via
// insertDiskTotal), rather than one row per workspace overwritten in place — so
// diskHistory() is genuinely a temporal series and predictDisk gets real deltas.
test("disk_stats append-only series feeds predictDisk a real growth rate", () => {
  const db = openDb(":memory:");
  const now = 1_800_000_000_000;
  // insertDiskTotal always stamps Date.now(), so seed explicit historical rows directly
  // to control the timestamps (2 days apart) the way a real collector loop would over time.
  db.query("INSERT INTO disk_stats (ts,bytes) VALUES (?,?)").run(now - 2 * DAY, 100 * 1e9);
  db.query("INSERT INTO disk_stats (ts,bytes) VALUES (?,?)").run(now, 300 * 1e9);
  const rows = diskHistory(db);
  expect(rows).toHaveLength(2);
  const p = predictDisk(rows, 1000 * 1e9);
  expect(p.usedBytes).toBe(300 * 1e9);
  expect(p.growthPerDay).toBeCloseTo(100 * 1e9);
  expect(p.daysLeft).toBeCloseTo(7);

  insertDiskTotal(db, 310 * 1e9); // exercises the real insertion path too
  expect(diskHistory(db)).toHaveLength(3);
});

test("diskHistoryEnds: only the first and last sample, predictDisk gives the same result from them", () => {
  const db = openDb(":memory:");
  expect(diskHistoryEnds(db)).toEqual([]);
  db.query("INSERT INTO disk_stats (ts,bytes) VALUES (?,?)").run(5 * DAY, 500);
  expect(diskHistoryEnds(db)).toEqual([{ ts: 5 * DAY, bytes: 500 }]);
  // inserted out of order: ts decides, not id
  for (const [ts, bytes] of [[1 * DAY, 100], [9 * DAY, 900], [3 * DAY, 300]]) db.query("INSERT INTO disk_stats (ts,bytes) VALUES (?,?)").run(ts, bytes);
  expect(diskHistoryEnds(db)).toEqual([{ ts: 1 * DAY, bytes: 100 }, { ts: 9 * DAY, bytes: 900 }]);
  expect(predictDisk(diskHistoryEnds(db), 2000)).toEqual(predictDisk(diskHistory(db), 2000));
});

test("buildWorkHours: per-project totals including cappedHours", () => {
  const db = openDb(":memory:");
  const t0 = 1_700_000_000_000;
  insertWorkInterval(db, { session_id: "a", project: "shop", repo: "cms", started_at: t0, ended_at: t0 + 3_600_000, seconds: 3600, capped: 0 });
  insertWorkInterval(db, { session_id: "b", project: "shop", repo: "web", started_at: t0 + 1, ended_at: t0 + 1_800_000, seconds: 1800, capped: 1 });
  insertWorkInterval(db, { session_id: "c", project: "games", repo: "srv", started_at: t0 + 2, ended_at: t0 + 900_000, seconds: 900, capped: 0 });

  const w = buildWorkHours(db, t0 - 1, t0 + 86_400_000);
  expect(w.totalHours).toBeCloseTo(1.75, 5);
  const shop = w.byProject.find((p) => p.project === "shop")!;
  expect(shop.hours).toBeCloseTo(1.5, 5);
  expect(shop.cappedHours).toBeCloseTo(0.5, 5);
  expect(w.byProject[0].project).toBe("shop");   // descending by hours
});

test("buildWorkHours: the daily series has no gaps", () => {
  const db = openDb(":memory:");
  const t0 = 1_700_000_000_000;
  insertWorkInterval(db, { session_id: "a", project: "p", repo: "r", started_at: t0, ended_at: t0 + 3_600_000, seconds: 3600, capped: 0 });
  const w = buildWorkHours(db, t0, t0 + 3 * 86_400_000);
  expect(w.daily).toHaveLength(3);
  expect(w.daily[0].hours).toBeCloseTo(1, 5);
  expect(w.daily[1].hours).toBe(0);
  expect(w.daily[2].hours).toBe(0);
  expect(w.daily[0].day).toBe(t0);
  expect(w.daily[1].day).toBe(t0 + 86_400_000);
});

test("buildWorkHours: empty data gives zeros, not an empty array of days", () => {
  const db = openDb(":memory:");
  const w = buildWorkHours(db, 0, 2 * 86_400_000);
  expect(w.totalHours).toBe(0);
  expect(w.byProject).toEqual([]);
  expect(w.daily).toHaveLength(2);
});

// Window boundary: `started_at === to` is OUTSIDE (belongs to the next window), `started_at ===
// from` is INSIDE. listWorkIntervals already does that (started_at >= from AND < to) —
// this test makes sure buildWorkHours never shifts that boundary (e.g. by wrong
// rounding of the day).
test("buildWorkHours: an interval on the to boundary is EXCLUDED, on the from boundary INCLUDED", () => {
  const db = openDb(":memory:");
  const t0 = 1_700_000_000_000;
  const to = t0 + 86_400_000;
  insertWorkInterval(db, { session_id: "at-from", project: "p", repo: "r", started_at: t0, ended_at: t0 + 60_000, seconds: 60, capped: 0 });
  insertWorkInterval(db, { session_id: "at-to", project: "p", repo: "r", started_at: to, ended_at: to + 60_000, seconds: 60, capped: 0 });

  const w = buildWorkHours(db, t0, to);
  expect(w.totalHours).toBeCloseTo(60 / 3600, 5); // only "at-from", "at-to" is outside the window
  expect(w.byProject).toHaveLength(1);
  expect(w.byProject[0].hours).toBeCloseTo(60 / 3600, 5);
});
