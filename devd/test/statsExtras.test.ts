import { expect, test } from "bun:test";
import {
  countEvents, distinctEventTypes, insertMetrics, insertSession, listEvents, logEvent,
  metricByRepo, metricHourly, metricValues, openDb, usageBySession, type SessionRow,
} from "../src/db";
import { PROMPT_CHARS, PROMPT_WAIT, buildRange, buildSessionUsage, quantiles } from "../src/aggregate";

const COST = "claude_code.cost.usage";
const TOKENS = "claude_code.token.usage";

let nextPort = 40100;
function session(id: string, project: string, repo: string): SessionRow {
  return {
    id, folder: "acme", project, repo, container: id, port_base: (nextPort += 10),
    status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  };
}
const metric = (name: string, value: number, ts: number, session_id: string | null = null, attrs = "{}") =>
  ({ ts, session_id, name, value, attrs });

/* ------------------------------- quantiles ------------------------------- */

test("quantiles: empty input does not return NaN", () => {
  expect(quantiles([])).toEqual({ count: 0, avg: 0, p50: 0, p90: 0 });
});

test("quantiles computes median and p90 from sorted values", () => {
  const q = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(q.count).toBe(10);
  expect(q.avg).toBeCloseTo(5.5);
  expect(q.p50).toBe(5);
  expect(q.p90).toBe(9);
});

test("quantiles: the median withstands an outlier that would break the average", () => {
  // exactly why the UI shows the median: one terminal forgotten overnight
  const vals = [1, 1, 2, 2, 3, 3, 4, 4, 5, 100_000].sort((a, b) => a - b);
  const q = quantiles(vals);
  expect(q.p50).toBeLessThan(5);
  expect(q.avg).toBeGreaterThan(9_000);
});

/* ------------------------------- aggregation ------------------------------- */

// CAUTION: SQLite does the bucketing via 'localtime', i.e. by the SYSTEM time zone —
// while `bun test` runs JS in UTC. A concrete hour number is therefore unusable in the test
// (CI in UTC gives a different one than a mac in CET). We test the shape of the result:
// two distinct blocks with correct sums, 12 h apart, and 24 buckets without gaps.
test("metricHourly buckets by hour and buildRange fills the missing ones with zeros", () => {
  const db = openDb(":memory:");
  const from = new Date(2026, 0, 1).getTime();
  const to = from + 86_400_000;
  const at = (hour: number) => from + hour * 3_600_000 + 1_800_000;   // hour + 30 min
  insertMetrics(db, [metric(COST, 1, at(9)), metric(COST, 2, at(9)), metric(COST, 5, at(21))]);

  const hourly = metricHourly(db, COST, from, to);
  expect(hourly).toHaveLength(2);
  expect(hourly.map((h) => h.sum).sort((a, b) => a - b)).toEqual([3, 5]);
  expect(Math.abs(hourly[1].hour - hourly[0].hour)).toBe(12);

  const r = buildRange(db, from, to);
  expect(r.hourly).toHaveLength(24);                       // 0–23 without gaps
  expect(r.hourly.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  expect(r.hourly.reduce((a, h) => a + h.cost, 0)).toBe(8); // nothing got lost on the way
  expect(r.hourly.filter((h) => h.cost > 0)).toHaveLength(2);
});

/** Resource attributes as Claude Code sends them from the container. */
const otel = (id: string, project: string, repo?: string) =>
  JSON.stringify({ "devbox.session.id": id, project, ...(repo ? { repo } : {}) });

test("metricByRepo takes the repo from the metric attrs", () => {
  const db = openDb(":memory:");
  const ts = Date.now();
  insertMetrics(db, [
    metric(COST, 1, ts, "dev-shop-cms", otel("dev-shop-cms", "shop", "cms")),
    metric(COST, 2, ts, "dev-shop-cms", otel("dev-shop-cms", "shop", "cms")),
    metric(COST, 4, ts, "dev-games-portal", otel("dev-games-portal", "games", "portal")),
  ]);
  const rows = metricByRepo(db, COST, ts - 1000, ts + 1000);
  expect(rows.find((r) => r.repo === "cms")?.sum).toBe(3);
  expect(rows.find((r) => r.repo === "portal")?.sum).toBe(4);
  expect(rows.find((r) => r.repo === "—")).toBeUndefined();
});

test("an ENDED session keeps its repo even when its row in sessions no longer exists", () => {
  // This was the bug: the repo was looked up via a join on `sessions`, but that row is
  // deleted when the session ends. All ended sessions therefore fell into ONE
  // anonymous "—" — on live data that was a row with 83 M tokens.
  const db = openDb(":memory:");
  const ts = Date.now();
  insertSession(db, session("dev-shop-cms", "shop", "cms"));       // this one is still alive
  insertMetrics(db, [
    metric(COST, 1, ts, "dev-shop-cms", otel("dev-shop-cms", "shop", "cms")),
    // older metrics (without attrs.repo) from sessions that have already ended
    metric(COST, 8, ts, "dev-shop-Ledger-App", otel("dev-shop-Ledger-App", "shop")),
    metric(COST, 3, ts, "dev-apps-vps-dev-infra", otel("dev-apps-vps-dev-infra", "apps")),
    metric(COST, 2, ts, "dev-shop-claudeSolo-3", otel("dev-shop-claudeSolo-3", "shop")),
  ]);
  const rows = metricByRepo(db, COST, ts - 1000, ts + 1000);
  expect(rows.find((r) => r.repo === "Ledger-App")?.sum).toBe(8);
  expect(rows.find((r) => r.repo === "vps-dev-infra")?.sum).toBe(3);   // dashes in the name survive
  expect(rows.find((r) => r.repo === "claudeSolo-3")?.sum).toBe(2);
  expect(rows.find((r) => r.repo === "cms")?.sum).toBe(1);
  expect(rows.find((r) => r.repo === "—")).toBeUndefined();
});

test("an underivable repo ends up under — and not as nonsense", () => {
  const db = openDb(":memory:");
  const ts = Date.now();
  insertMetrics(db, [
    metric(COST, 1, ts, "weird", JSON.stringify({ "devbox.session.id": "weird", project: "shop" })),
    metric(COST, 2, ts, "dev-x-y", JSON.stringify({ "devbox.session.id": "dev-x-y" })),  // no project
    metric(COST, 4, ts, null),                                                            // no attrs at all
  ]);
  const rows = metricByRepo(db, COST, ts - 1000, ts + 1000);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ repo: "—", sum: 7 });
});

test("usageBySession / buildSessionUsage: cost and tokens per session, sorted by cost", () => {
  const db = openDb(":memory:");
  const ts = Date.now();
  insertMetrics(db, [
    metric(COST, 1, ts, "dev-a"), metric(TOKENS, 100, ts, "dev-a"),
    metric(COST, 9, ts, "dev-b"), metric(TOKENS, 20, ts, "dev-b"),
    metric(COST, 5, ts, null),                    // ignored without a session
  ]);
  const raw = usageBySession(db, COST, TOKENS, 0);
  expect(raw["dev-a"]).toEqual({ cost: 1, tokens: 100 });
  expect(raw["dev-b"]).toEqual({ cost: 9, tokens: 20 });
  expect(Object.keys(raw)).toHaveLength(2);

  const list = buildSessionUsage(db, ts);
  expect(list[0].id).toBe("dev-b");              // most expensive first
});

test("buildRange returns prompt quantiles", () => {
  const db = openDb(":memory:");
  const from = Date.now() - 86_400_000;
  const to = Date.now() + 1000;
  const ts = Date.now();
  insertMetrics(db, [
    metric(PROMPT_CHARS, 10, ts), metric(PROMPT_CHARS, 20, ts), metric(PROMPT_CHARS, 30, ts),
    metric(PROMPT_WAIT, 1000, ts), metric(PROMPT_WAIT, 5000, ts),
  ]);
  const r = buildRange(db, from, to);
  expect(r.prompts.chars.count).toBe(3);
  expect(r.prompts.chars.p50).toBe(20);
  expect(r.prompts.waitMs.count).toBe(2);
});

test("metricValues returns values sorted ascending (quantiles assumes it)", () => {
  const db = openDb(":memory:");
  const ts = Date.now();
  insertMetrics(db, [metric(PROMPT_CHARS, 30, ts), metric(PROMPT_CHARS, 10, ts), metric(PROMPT_CHARS, 20, ts)]);
  expect(metricValues(db, PROMPT_CHARS, 0, ts + 1)).toEqual([10, 20, 30]);
});

/* --------------------------- filters and paging --------------------------- */

test("listEvents: offset pages and countEvents counts from the same set", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 12; i++) logEvent(db, i % 2 === 0 ? "dev-a" : "dev-b", i % 3 === 0 ? "agent_done" : "agent_blocked");

  expect(countEvents(db, {})).toBe(12);
  const page1 = listEvents(db, { limit: 5, offset: 0 });
  const page2 = listEvents(db, { limit: 5, offset: 5 });
  expect(page1).toHaveLength(5);
  expect(page2).toHaveLength(5);
  expect(page1.map((e) => e.id)).not.toEqual(page2.map((e) => e.id));

  // the filter must apply to both the list and the count, otherwise paging would show empty pages
  const f = { session: "dev-a" };
  expect(countEvents(db, f)).toBe(listEvents(db, { ...f, limit: 500 }).length);
});

test("listEvents: filter on several types at once and a time window", () => {
  const db = openDb(":memory:");
  logEvent(db, "dev-a", "agent_done");
  logEvent(db, "dev-a", "cc_upgraded");
  logEvent(db, "dev-a", "prod_write_proposed");

  expect(listEvents(db, { types: ["agent_done", "cc_upgraded"] })).toHaveLength(2);
  expect(countEvents(db, { types: ["agent_done", "cc_upgraded"] })).toBe(2);

  // a window in the future must return nothing
  expect(listEvents(db, { from: Date.now() + 60_000 })).toHaveLength(0);
});

test("distinctEventTypes returns only types that are actually in the data", () => {
  const db = openDb(":memory:");
  logEvent(db, null, "agent_done");
  logEvent(db, null, "agent_done");
  logEvent(db, null, "cc_skipped");
  expect(distinctEventTypes(db)).toEqual(["agent_done", "cc_skipped"]);
});
