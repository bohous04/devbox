import { expect, test } from "bun:test";
import { openDb, insertMetrics, metricDailyByAttr } from "./db";
import { buildRange } from "./aggregate";

const DAY = 86_400_000;

function seed() {
  const db = openDb(":memory:");
  // day 0 (from), day 1, day 2 (to is exclusively day 3)
  insertMetrics(db, [
    { ts: 0 * DAY + 100, session_id: "s1", name: "claude_code.cost.usage",   value: 1, attrs: JSON.stringify({ project: "alfa", model: "opus" }) },
    { ts: 1 * DAY + 100, session_id: "s1", name: "claude_code.cost.usage",   value: 2, attrs: JSON.stringify({ project: "beta", model: "sonnet" }) },
    { ts: 1 * DAY + 200, session_id: "s1", name: "claude_code.token.usage",  value: 500, attrs: JSON.stringify({ project: "beta", model: "sonnet" }) },
    { ts: 2 * DAY + 100, session_id: "s1", name: "claude_code.active_time.total", value: 3600, attrs: JSON.stringify({ project: "alfa" }) },
    // previous window (day -1) for the delta:
    { ts: -1 * DAY + 100, session_id: "s1", name: "claude_code.cost.usage",  value: 10, attrs: JSON.stringify({ project: "alfa", model: "opus" }) },
  ]);
  return db;
}

test("buildRange: totals, previous, daily series, projects, models", () => {
  const db = seed();
  const from = 0, to = 3 * DAY; // 3-day window
  const r = buildRange(db, from, to);

  expect(r.totals.cost).toBe(3);          // 1 + 2
  expect(r.totals.tokens).toBe(500);
  expect(r.totals.hours).toBe(1);         // 3600 s / 3600

  expect(r.previous.cost).toBe(10);       // okno [-3*DAY, 0)

  expect(r.daily.length).toBe(3);         // 3 days, including empty ones
  expect(r.daily[0].cost).toBe(1);
  expect(r.daily[1].cost).toBe(2);
  expect(r.daily[2].cost).toBe(0);

  expect(r.projects.find((p) => p.project === "beta")?.cost).toBe(2);
  expect(r.models.find((m) => m.model === "opus")?.cost).toBe(1);
});

test("buildRange: empty range → zeros, not a crash", () => {
  const db = openDb(":memory:");
  const r = buildRange(db, 0, 3 * DAY);
  expect(r.totals.cost).toBe(0);
  expect(r.daily.every((d) => d.cost === 0)).toBe(true);
});

test("buildRange: daily buckets are relative to from (local midnight), not the UTC day", () => {
  const db = openDb(":memory:");
  const from = 2 * DAY + 8 * 3_600_000; // 08:00 UTC on day 2 — a non-UTC-midnight 'local midnight'
  const to = from + 3 * DAY;            // exactly 3 local days
  insertMetrics(db, [
    { ts: from + 30 * 60_000,       session_id: "s", name: "claude_code.cost.usage", value: 5, attrs: "{}" }, // bucket 0
    { ts: from + DAY + 10 * 60_000, session_id: "s", name: "claude_code.cost.usage", value: 7, attrs: "{}" }, // bucket 1
  ]);
  const r = buildRange(db, from, to);
  expect(r.daily.length).toBe(3);          // exactly 3, no spurious 4th bar
  expect(r.daily[0].cost).toBe(5);
  expect(r.daily[1].cost).toBe(7);
  expect(r.daily[2].cost).toBe(0);
  expect(r.daily[0].day).toBe(from);       // first bucket anchored at from
});

test("metricDailyByAttr: daily series broken down by host", () => {
  const db = openDb(":memory:");
  insertMetrics(db, [
    { ts: 0 * DAY + 10, session_id: null, name: "claude_code.cost.usage", value: 1, attrs: JSON.stringify({ "devbox.host": "mac" }) },
    { ts: 0 * DAY + 20, session_id: "s1", name: "claude_code.cost.usage", value: 2, attrs: JSON.stringify({ "devbox.host": "devbox" }) },
    { ts: 1 * DAY + 10, session_id: null, name: "claude_code.cost.usage", value: 4, attrs: JSON.stringify({ "devbox.host": "mac" }) },
    // an old row without the attribute → must fall under '—', not disappear
    { ts: 1 * DAY + 20, session_id: "s1", name: "claude_code.cost.usage", value: 8, attrs: JSON.stringify({}) },
  ]);
  const rows = metricDailyByAttr(db, "claude_code.cost.usage", '$."devbox.host"', 0, 2 * DAY);
  const get = (key: string, bucket: number) => rows.find((r) => r.key === key && r.bucket === bucket)?.sum ?? 0;
  expect(get("mac", 0)).toBe(1);
  expect(get("devbox", 0)).toBe(2);
  expect(get("mac", 1)).toBe(4);
  expect(get("—", 1)).toBe(8);
});

test("buildRange: breakdown by host and account, including NULL session_id", () => {
  const db = openDb(":memory:");
  const A = JSON.stringify({ "devbox.host": "mac", "user.account_uuid": "acc-a", project: "alfa" });
  const B = JSON.stringify({ "devbox.host": "devbox", "user.account_uuid": "acc-b", project: "beta" });
  insertMetrics(db, [
    // mac rows have session_id NULL — regression: they must not drop out of the totals
    { ts: 0 * DAY + 10, session_id: null, name: "claude_code.cost.usage", value: 1, attrs: A },
    { ts: 0 * DAY + 20, session_id: null, name: "claude_code.token.usage", value: 100, attrs: A },
    { ts: 0 * DAY + 30, session_id: null, name: "claude_code.active_time.total", value: 1800, attrs: A },
    { ts: 1 * DAY + 10, session_id: "s1", name: "claude_code.cost.usage", value: 3, attrs: B },
    { ts: 1 * DAY + 20, session_id: "s1", name: "claude_code.active_time.total", value: 3600, attrs: B },
    // previous window, mac only
    { ts: -1 * DAY + 10, session_id: null, name: "claude_code.cost.usage", value: 5, attrs: A },
  ]);
  const r = buildRange(db, 0, 2 * DAY);

  // the totals must include NULL session_id too
  expect(r.totals.cost).toBe(4);
  expect(r.totals.tokens).toBe(100);
  expect(r.totals.hours).toBe(1.5);

  const mac = r.hosts.find((h) => h.key === "mac")!;
  expect(mac.cost).toBe(1);
  expect(mac.tokens).toBe(100);
  expect(mac.hours).toBe(0.5);
  expect(r.hosts.find((h) => h.key === "devbox")!.cost).toBe(3);

  expect(r.hostsPrevious.find((h) => h.key === "mac")!.cost).toBe(5);

  expect(r.accounts.find((a) => a.key === "acc-a")!.cost).toBe(1);
  expect(r.accounts.find((a) => a.key === "acc-b")!.cost).toBe(3);

  const macDays = r.dailyByHost.find((d) => d.host === "mac")!.days;
  expect(macDays.length).toBe(2);       // window length, including empty days
  expect(macDays[0].cost).toBe(1);
  expect(macDays[1].cost).toBe(0);

  // Verify the conversion of active_time (seconds) to hours (divided by 3600)
  const devboxDays = r.dailyByHost.find((d) => d.host === "devbox")!.days;
  expect(devboxDays[1].hours).toBe(1);  // day 1 has active_time.total 3600 s = 1 hour
});

/* ------------------------------ filtr projektu ------------------------------ */

const ALFA = JSON.stringify({ project: "alfa", repo: "web", model: "opus", "devbox.host": "devbox", "user.account_uuid": "acc-a" });
const BETA = JSON.stringify({ project: "beta", repo: "api", model: "sonnet", "devbox.host": "mac", "user.account_uuid": "acc-b" });

function seedTwoProjects() {
  const db = openDb(":memory:");
  insertMetrics(db, [
    { ts: 0 * DAY + 100, session_id: "s1", name: "claude_code.cost.usage", value: 1, attrs: ALFA },
    { ts: 0 * DAY + 200, session_id: "s1", name: "claude_code.token.usage", value: 100, attrs: ALFA },
    { ts: 0 * DAY + 300, session_id: "s1", name: "claude_code.active_time.total", value: 3600, attrs: ALFA },
    { ts: 1 * DAY + 100, session_id: "s2", name: "claude_code.cost.usage", value: 2, attrs: BETA },
    { ts: 1 * DAY + 200, session_id: "s2", name: "claude_code.token.usage", value: 500, attrs: BETA },
    { ts: 1 * DAY + 300, session_id: "s2", name: "claude_code.active_time.total", value: 7200, attrs: BETA },
    // previous window for the delta: in both projects, so it shows that filtering applies there too
    { ts: -1 * DAY + 100, session_id: "s1", name: "claude_code.cost.usage", value: 10, attrs: ALFA },
    { ts: -1 * DAY + 200, session_id: "s2", name: "claude_code.cost.usage", value: 20, attrs: BETA },
    // prompty
    { ts: 0 * DAY + 400, session_id: "s1", name: "devbox.prompt.chars", value: 10, attrs: ALFA },
    { ts: 1 * DAY + 400, session_id: "s2", name: "devbox.prompt.chars", value: 1000, attrs: BETA },
  ]);
  return db;
}

test("buildRange with project filter: totals, previous window and daily series only for that project", () => {
  const r = buildRange(seedTwoProjects(), 0, 2 * DAY, "alfa");

  expect(r.project).toBe("alfa");
  expect(r.totals.cost).toBe(1);          // beta's 2 do not count
  expect(r.totals.tokens).toBe(100);
  expect(r.totals.hours).toBe(1);
  expect(r.previous.cost).toBe(10);       // not 30 — the filter applies to the previous window too
  expect(r.daily[0].cost).toBe(1);
  expect(r.daily[1].cost).toBe(0);        // day 1 is entirely beta's
});

test("buildRange with project filter: models, repos, hours of day and host/account breakdown also respect the filter", () => {
  const r = buildRange(seedTwoProjects(), 0, 2 * DAY, "alfa");

  expect(r.models.map((m) => m.model)).toEqual(["opus"]);
  expect(r.repos.map((x) => x.repo)).toEqual(["web"]);
  expect(r.hourly.reduce((s, h) => s + h.cost, 0)).toBe(1);
  expect(r.hosts.map((h) => h.key)).toEqual(["devbox"]);
  expect(r.hostsPrevious.map((h) => h.key)).toEqual(["devbox"]);
  expect(r.accounts.map((a) => a.key)).toEqual(["acc-a"]);
  expect(r.dailyByHost.map((d) => d.host)).toEqual(["devbox"]);
  expect(r.dailyByHost[0].days[0].cost).toBe(1);
});

test("buildRange with project filter: prompt quantiles only for that project", () => {
  const r = buildRange(seedTwoProjects(), 0, 2 * DAY, "alfa");
  expect(r.prompts.chars.count).toBe(1);
  expect(r.prompts.chars.p50).toBe(10);   // beta's thousand-character prompt does not move the median
});

test("buildRange with filter: the project list stays complete (it feeds the switcher)", () => {
  const r = buildRange(seedTwoProjects(), 0, 2 * DAY, "alfa");
  expect(r.projects.map((p) => p.project).sort()).toEqual(["alfa", "beta"]);
  expect(r.projects.find((p) => p.project === "beta")?.cost).toBe(2);
});

test("buildRange with an unknown project → zeros, not a crash", () => {
  const r = buildRange(seedTwoProjects(), 0, 2 * DAY, "missing");
  expect(r.totals.cost).toBe(0);
  expect(r.previous.cost).toBe(0);
  expect(r.daily.every((d) => d.cost === 0 && d.tokens === 0 && d.hours === 0)).toBe(true);
  expect(r.models).toEqual([]);
  expect(r.hosts).toEqual([]);
});

test("buildRange without filter: project is null and totals cover all projects", () => {
  const r = buildRange(seedTwoProjects(), 0, 2 * DAY);
  expect(r.project).toBe(null);
  expect(r.totals.cost).toBe(3);
});
