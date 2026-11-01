import type { Database } from "bun:sqlite";
import {
  costByProject, listWorkIntervals, metricHourlyCells, type HourlyCell, metricByAttr, metricByRepo, metricDailyByAttr, metricDailySeries, metricHourly,
  metricSumBetween, metricValues, queryMetricSum, tokensByProject, totalCommitsToday, totalUnpushed,
  usageBySession,
} from "./db";

const DAY = 86_400_000;
function midnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function rolling30dStart(now: number): number { return now - 30 * DAY; }

export interface Totals { hoursToday: number; tokensToday: number; costToday: number; costMonth: number; commitsToday: number; unpushed: number }

export function buildTotals(db: Database, now: number): Totals {
  const mid = midnight(now);
  return {
    hoursToday: queryMetricSum(db, "claude_code.active_time.total", mid) / 3600,
    tokensToday: queryMetricSum(db, "claude_code.token.usage", mid),
    costToday: queryMetricSum(db, "claude_code.cost.usage", mid),
    costMonth: queryMetricSum(db, "claude_code.cost.usage", rolling30dStart(now)),
    commitsToday: totalCommitsToday(db),
    unpushed: totalUnpushed(db),
  };
}

export interface ProjectStat { project: string; costToday: number; tokensToday: number }

export function buildProjectLeaderboard(db: Database, now: number): ProjectStat[] {
  const mid = midnight(now);
  const cost = costByProject(db, mid);
  const tok = tokensByProject(db, mid);
  const projects = new Set([...Object.keys(cost), ...Object.keys(tok)]);
  return [...projects]
    .map((p) => ({ project: p, costToday: cost[p] ?? 0, tokensToday: tok[p] ?? 0 }))
    .sort((a, b) => b.costToday - a.costToday);
}

const COST = "claude_code.cost.usage";
const TOKENS = "claude_code.token.usage";
const ACTIVE = "claude_code.active_time.total";
// The devbox's own metrics — written by /api/agent-event from the user_prompt_submit hook.
// The prompt text is not stored ANYWHERE, only these two numbers.
export const PROMPT_CHARS = "devbox.prompt.chars";
export const PROMPT_WAIT = "devbox.prompt.wait_ms";

export interface Quantiles { count: number; avg: number; p50: number; p90: number }

/** Quantiles from values sorted in ASCENDING order (metricValues returns them that way).
 *  Median deliberately instead of mean — one terminal forgotten overnight would break the
 *  waiting mean into a nonsensical number. */
export function quantiles(sorted: number[]): Quantiles {
  const count = sorted.length;
  if (count === 0) return { count: 0, avg: 0, p50: 0, p90: 0 };
  const at = (q: number) => sorted[Math.min(count - 1, Math.max(0, Math.ceil(q * count) - 1))];
  return {
    count,
    avg: sorted.reduce((a, b) => a + b, 0) / count,
    p50: at(0.5),
    p90: at(0.9),
  };
}

const HOST_ATTR = '$."devbox.host"';
const ACCOUNT_ATTR = '$."user.account_uuid"';

export interface HostStat { key: string; cost: number; tokens: number; hours: number }

/** Merges cost+tokens+hours for one attribute into one series. Hours are converted
 *  from seconds, the same as in windowTotals. */
function statsByAttr(db: Database, attrPath: string, from: number, to: number, project?: string | null, repo?: string | null): HostStat[] {
  const m = new Map<string, HostStat>();
  const at = (key: string) => {
    const e = m.get(key) ?? { key, cost: 0, tokens: 0, hours: 0 };
    m.set(key, e);
    return e;
  };
  for (const r of metricByAttr(db, COST, attrPath, from, to, project, repo)) at(r.key).cost = r.sum;
  for (const r of metricByAttr(db, TOKENS, attrPath, from, to, project, repo)) at(r.key).tokens = r.sum;
  for (const r of metricByAttr(db, ACTIVE, attrPath, from, to, project, repo)) at(r.key).hours = r.sum / 3600;
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

export interface RangeStats {
  from: number; to: number;
  /** Exact scope for measured values. Projects retain the complete selector
   * context; repoOptions retains the project's repositories for switching. */
  project: string | null;
  repo: string | null;
  /** Options retain other repositories when a repository is selected. */
  repoOptions: string[];
  totals: { cost: number; tokens: number; hours: number };
  previous: { cost: number; tokens: number; hours: number };
  daily: { day: number; cost: number; tokens: number; hours: number }[];
  hourly: { hour: number; cost: number; hours: number }[];
  projects: { project: string; cost: number; tokens: number }[];
  models: { model: string; cost: number; tokens: number }[];
  repos: { repo: string; cost: number; tokens: number }[];
  prompts: { chars: Quantiles; waitMs: Quantiles };
  hosts: HostStat[];
  hostsPrevious: HostStat[];
  accounts: HostStat[];
  dailyByHost: { host: string; days: { day: number; cost: number; tokens: number; hours: number }[] }[];
}

function windowTotals(db: Database, from: number, to: number, project?: string | null, repo?: string | null) {
  return {
    cost: metricSumBetween(db, COST, from, to, project, repo),
    tokens: metricSumBetween(db, TOKENS, from, to, project, repo),
    hours: metricSumBetween(db, ACTIVE, from, to, project, repo) / 3600,
  };
}

/** Project/repository scope applies to all measured dimensions. Selector
 * context is intentionally separate: projects is global, repoOptions is scoped
 * to the project but not the currently selected repository.
 *
 * The fast path goes through the hourly rollup (`metrics_hourly`, see db.ts): instead of ~40
 * index passes over the whole window it reads a few hundred to a thousand cells and computes
 * the rest in JS. It can only be used for a window aligned to whole hours and for a zone
 * with a whole-hour offset — otherwise an hour at the window edge, a daily bucket or a
 * local hour of the day would land wrong. The dashboard always sends local midnights, so
 * the slow path (`buildRangeRaw`) remains only for manual queries with an odd range. */
export function buildRange(db: Database, from: number, to: number, project?: string | null, repo?: string | null): RangeStats {
  return rollupUsable(from, to) ? buildRangeHourly(db, from, to, project, repo) : buildRangeRaw(db, from, to, project, repo);
}

const HOUR = 3_600_000;
function rollupUsable(from: number, to: number): boolean {
  const span = to - from;
  return from % HOUR === 0 && to % HOUR === 0
    && [from - span, from, to].every((t) => new Date(t).getTimezoneOffset() % 60 === 0);
}

type Cell = HourlyCell;
const sumOf = (cells: Cell[]) => cells.reduce((s, c) => s + c.sum, 0);
/** Sum per key sorted in descending order — the same shape as `metricByAttr`. */
function groupSum(cells: Cell[], key: (c: Cell) => string | null): { key: string; sum: number }[] {
  const m = new Map<string, number>();
  for (const c of cells) { const k = key(c) ?? "—"; m.set(k, (m.get(k) ?? 0) + c.sum); }
  return [...m.entries()].map(([k, sum]) => ({ key: k, sum })).sort((a, b) => b.sum - a.sum);
}

function buildRangeHourly(db: Database, from: number, to: number, project?: string | null, repo?: string | null): RangeStats {
  const span = to - from;
  const nDays = Math.round(span / DAY);
  // The project filter goes into SQL, the repo one only here: repoOptions needs the project's data
  // WITHOUT the repo filter (the options for the switcher), everything else with it.
  const all = metricHourlyCells(db, [COST, TOKENS, ACTIVE, PROMPT_CHARS, PROMPT_WAIT], from, to, project);
  const scoped = repo ? all.filter((c) => c.repo === repo) : all;
  const prevAll = metricHourlyCells(db, [COST, TOKENS, ACTIVE], from - span, from, project);
  const prev = repo ? prevAll.filter((c) => c.repo === repo) : prevAll;
  const of = (cells: Cell[], name: string) => cells.filter((c) => c.name === name);
  const cur = { cost: of(scoped, COST), tokens: of(scoped, TOKENS), active: of(scoped, ACTIVE) };
  const before = { cost: of(prev, COST), tokens: of(prev, TOKENS), active: of(prev, ACTIVE) };

  const totals = { cost: sumOf(cur.cost), tokens: sumOf(cur.tokens), hours: sumOf(cur.active) / 3600 };
  const previous = { cost: sumOf(before.cost), tokens: sumOf(before.tokens), hours: sumOf(before.active) / 3600 };

  const dayOf = (c: Cell) => Math.floor((c.hour * HOUR - from) / DAY);
  const byDay = (cells: Cell[]) => {
    const m = new Map<number, number>();
    for (const c of cells) m.set(dayOf(c), (m.get(dayOf(c)) ?? 0) + c.sum);
    return m;
  };
  const cD = byDay(cur.cost), tD = byDay(cur.tokens), aD = byDay(cur.active);
  const daily: RangeStats["daily"] = [];
  for (let i = 0; i < nDays; i++) {
    daily.push({ day: from + i * DAY, cost: cD.get(i) ?? 0, tokens: tD.get(i) ?? 0, hours: (aD.get(i) ?? 0) / 3600 });
  }

  const merge = (costRows: { key: string; sum: number }[], tokRows: { key: string; sum: number }[]) => {
    const m = new Map<string, { cost: number; tokens: number }>();
    for (const r of costRows) m.set(r.key, { cost: r.sum, tokens: 0 });
    for (const r of tokRows) { const e = m.get(r.key) ?? { cost: 0, tokens: 0 }; e.tokens = r.sum; m.set(r.key, e); }
    return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.cost - a.cost);
  };
  // The project ranking is deliberately unfiltered (see buildRangeRaw) — with a filter
  // one extra read is needed, without it what we already have is enough.
  const unscoped = project || repo ? metricHourlyCells(db, [COST, TOKENS], from, to) : all;
  const projRows = merge(groupSum(of(unscoped, COST), (c) => c.project), groupSum(of(unscoped, TOKENS), (c) => c.project));
  const modelRows = merge(groupSum(cur.cost, (c) => c.model), groupSum(cur.tokens, (c) => c.model));
  const repoOptions = [...new Set([
    ...all.map((c) => c.repo ?? "—"),
    ...listWorkIntervals(db, from, to, project).map((r) => r.repo),
  ])].filter((r) => r !== "—").sort();
  const repoRows = merge(groupSum(cur.cost, (c) => c.repo), groupSum(cur.tokens, (c) => c.repo));

  const localHour = (c: Cell) => c.localHour;
  const hCost = new Map<number, number>(), hActive = new Map<number, number>();
  for (const c of cur.cost) hCost.set(localHour(c), (hCost.get(localHour(c)) ?? 0) + c.sum);
  for (const c of cur.active) hActive.set(localHour(c), (hActive.get(localHour(c)) ?? 0) + c.sum);
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, cost: hCost.get(h) ?? 0, hours: (hActive.get(h) ?? 0) / 3600 }));

  const attrStats = (w: typeof cur, key: (c: Cell) => string | null): HostStat[] => {
    const m = new Map<string, HostStat>();
    const at = (k: string) => { const e = m.get(k) ?? { key: k, cost: 0, tokens: 0, hours: 0 }; m.set(k, e); return e; };
    for (const r of groupSum(w.cost, key)) at(r.key).cost = r.sum;
    for (const r of groupSum(w.tokens, key)) at(r.key).tokens = r.sum;
    for (const r of groupSum(w.active, key)) at(r.key).hours = r.sum / 3600;
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const hosts = attrStats(cur, (c) => c.host);
  const hostsPrevious = attrStats(before, (c) => c.host);
  const accounts = attrStats(cur, (c) => c.account);

  const perHost = (cells: Cell[]) => {
    const m = new Map<string, Map<number, number>>();
    for (const c of cells) {
      const k = c.host ?? "—";
      if (!m.has(k)) m.set(k, new Map());
      const d = m.get(k)!;
      d.set(dayOf(c), (d.get(dayOf(c)) ?? 0) + c.sum);
    }
    return m;
  };
  const cH = perHost(cur.cost), tH = perHost(cur.tokens), aH = perHost(cur.active);
  const dailyByHost = hosts.map((h) => ({
    host: h.key,
    days: Array.from({ length: nDays }, (_, i) => ({
      day: from + i * DAY,
      cost: cH.get(h.key)?.get(i) ?? 0,
      tokens: tH.get(h.key)?.get(i) ?? 0,
      hours: (aH.get(h.key)?.get(i) ?? 0) / 3600,
    })),
  }));

  return {
    from, to, project: project ?? null, repo: repo ?? null, repoOptions, totals, previous, daily, hourly,
    projects: projRows.map((r) => ({ project: r.key, cost: r.cost, tokens: r.tokens })),
    models: modelRows.map((r) => ({ model: r.key, cost: r.cost, tokens: r.tokens })),
    repos: repoRows.map((r) => ({ repo: r.key, cost: r.cost, tokens: r.tokens })),
    // Quantiles need individual values, not sums — they keep coming from the raw table
    // (prompt metrics are thousands of rows a month, not millions).
    prompts: {
      chars: quantiles(metricValues(db, PROMPT_CHARS, from, to, project, repo)),
      waitMs: quantiles(metricValues(db, PROMPT_WAIT, from, to, project, repo)),
    },
    hosts, hostsPrevious, accounts, dailyByHost,
  };
}

/** The original computation directly over `metrics`. Remains for windows not aligned to the hour
 *  and as the reference implementation the test compares the rollup against. */
export function buildRangeRaw(db: Database, from: number, to: number, project?: string | null, repo?: string | null): RangeStats {
  const span = to - from;
  const totals = windowTotals(db, from, to, project, repo);
  const previous = windowTotals(db, from - span, from, project, repo);

  // daily series without gaps: collect by day relative to from (local midnight), fill in zeros
  const nDays = Math.round((to - from) / DAY);
  const idx = (rows: { bucket: number; sum: number }[]) => new Map(rows.map((r) => [r.bucket, r.sum]));
  const cD = idx(metricDailySeries(db, COST, from, to, project, repo));
  const tD = idx(metricDailySeries(db, TOKENS, from, to, project, repo));
  const aD = idx(metricDailySeries(db, ACTIVE, from, to, project, repo));
  const daily: RangeStats["daily"] = [];
  for (let i = 0; i < nDays; i++) {
    daily.push({ day: from + i * DAY, cost: cD.get(i) ?? 0, tokens: tD.get(i) ?? 0, hours: (aD.get(i) ?? 0) / 3600 });
  }

  // projects: cost + tokens merged by key
  const merge = (costRows: { key: string; sum: number }[], tokRows: { key: string; sum: number }[]) => {
    const m = new Map<string, { cost: number; tokens: number }>();
    for (const r of costRows) m.set(r.key, { cost: r.sum, tokens: 0 });
    for (const r of tokRows) { const e = m.get(r.key) ?? { cost: 0, tokens: 0 }; e.tokens = r.sum; m.set(r.key, e); }
    return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.cost - a.cost);
  };
  // The project ranking is DELIBERATELY not filtered: it is the options for the switcher on Stats
  // and at the same time context (how much of the whole the project takes). Filtered, one
  // row at 100 % would remain and the filter could not be switched to another project.
  const projRows = merge(metricByAttr(db, COST, "$.project", from, to), metricByAttr(db, TOKENS, "$.project", from, to));
  const modelRows = merge(metricByAttr(db, COST, "$.model", from, to, project, repo), metricByAttr(db, TOKENS, "$.model", from, to, project, repo));
  const repoOptions = [...new Set([
    ...metricByRepo(db, COST, from, to, project),
    ...metricByRepo(db, TOKENS, from, to, project),
    ...metricByRepo(db, ACTIVE, from, to, project),
    ...metricByRepo(db, PROMPT_CHARS, from, to, project),
    ...metricByRepo(db, PROMPT_WAIT, from, to, project),
    ...listWorkIntervals(db, from, to, project),
  ].map(r => r.repo))].filter(r => r !== "—").sort();
  const repoRows = merge(
    metricByRepo(db, COST, from, to, project, repo).map((r) => ({ key: r.repo, sum: r.sum })),
    metricByRepo(db, TOKENS, from, to, project, repo).map((r) => ({ key: r.repo, sum: r.sum })),
  );

  // hours of the day 0–23 without gaps — an empty hour must be 0, not a missing column
  const hCost = new Map(metricHourly(db, COST, from, to, project, repo).map((r) => [r.hour, r.sum]));
  const hActive = new Map(metricHourly(db, ACTIVE, from, to, project, repo).map((r) => [r.hour, r.sum]));
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h, cost: hCost.get(h) ?? 0, hours: (hActive.get(h) ?? 0) / 3600,
  }));

  const hosts = statsByAttr(db, HOST_ATTR, from, to, project, repo);
  const hostsPrevious = statsByAttr(db, HOST_ATTR, from - span, from, project, repo);
  const accounts = statsByAttr(db, ACCOUNT_ATTR, from, to, project, repo);

  // daily series per host: the same zero-filling as for `daily`, just for each host separately
  const perHost = (name: string) => {
    const m = new Map<string, Map<number, number>>();
    for (const r of metricDailyByAttr(db, name, HOST_ATTR, from, to, project, repo)) {
      if (!m.has(r.key)) m.set(r.key, new Map());
      m.get(r.key)!.set(r.bucket, r.sum);
    }
    return m;
  };
  const cH = perHost(COST), tH = perHost(TOKENS), aH = perHost(ACTIVE);
  const dailyByHost = hosts.map((h) => ({
    host: h.key,
    days: Array.from({ length: nDays }, (_, i) => ({
      day: from + i * DAY,
      cost: cH.get(h.key)?.get(i) ?? 0,
      tokens: tH.get(h.key)?.get(i) ?? 0,
      hours: (aH.get(h.key)?.get(i) ?? 0) / 3600,
    })),
  }));

  return {
    from, to, project: project ?? null, repo: repo ?? null, repoOptions, totals, previous, daily, hourly,
    projects: projRows.map((r) => ({ project: r.key, cost: r.cost, tokens: r.tokens })),
    models: modelRows.map((r) => ({ model: r.key, cost: r.cost, tokens: r.tokens })),
    repos: repoRows.map((r) => ({ repo: r.key, cost: r.cost, tokens: r.tokens })),
    prompts: {
      chars: quantiles(metricValues(db, PROMPT_CHARS, from, to, project, repo)),
      waitMs: quantiles(metricValues(db, PROMPT_WAIT, from, to, project, repo)),
    },
    hosts, hostsPrevious, accounts, dailyByHost,
  };
}

export interface SessionUsage { id: string; cost: number; tokens: number }

/** Cost and tokens per session for today — for the session card in the dashboard. */
export function buildSessionUsage(db: Database, now: number): SessionUsage[] {
  const byId = usageBySession(db, COST, TOKENS, midnight(now));
  return Object.entries(byId)
    .map(([id, v]) => ({ id, cost: v.cost, tokens: v.tokens }))
    .sort((a, b) => b.cost - a.cost);
}

export interface WorkHours {
  totalHours: number;
  byProject: { project: string; hours: number; cappedHours: number }[];
  daily: { day: number; hours: number }[];
}

// Worked hours from `work_intervals`. CAUTION: this is a different quantity than `hours`
// in buildRange — those come from the claude_code.active_time.total metric (agent activity),
// this is wall-clock from the prompt to the end of the turn. See spec, section "What is already in the repo".
export function buildWorkHours(db: Database, from: number, to: number, project?: string | null, repo?: string | null): WorkHours {
  const rows = listWorkIntervals(db, from, to, project, repo);
  const byProject = new Map<string, { hours: number; cappedHours: number }>();
  const nDays = Math.max(1, Math.round((to - from) / DAY));
  const dayHours = new Array<number>(nDays).fill(0);

  for (const r of rows) {
    const h = r.seconds / 3600;
    const e = byProject.get(r.project) ?? { hours: 0, cappedHours: 0 };
    e.hours += h;
    if (r.capped === 1) e.cappedHours += h;
    byProject.set(r.project, e);
    const i = Math.min(nDays - 1, Math.max(0, Math.floor((r.started_at - from) / DAY)));
    dayHours[i] += h;
  }

  return {
    totalHours: rows.reduce((s, r) => s + r.seconds, 0) / 3600,
    byProject: [...byProject.entries()]
      .map(([project, v]) => ({ project, ...v }))
      .sort((a, b) => b.hours - a.hours),
    daily: dayHours.map((hours, i) => ({ day: from + i * DAY, hours })),
  };
}

export interface DiskPrediction { usedBytes: number; totalBytes: number; growthPerDay: number; daysLeft: number | null }

export function predictDisk(rows: { ts: number; bytes: number }[], totalBytes: number): DiskPrediction {
  const usedBytes = rows.at(-1)?.bytes ?? 0;
  if (rows.length < 2) return { usedBytes, totalBytes, growthPerDay: 0, daysLeft: null };
  const first = rows[0], last = rows.at(-1)!;
  const days = (last.ts - first.ts) / DAY;
  const growthPerDay = days > 0 ? (last.bytes - first.bytes) / days : 0;
  const daysLeft = growthPerDay > 0 ? (totalBytes - usedBytes) / growthPerDay : null;
  return { usedBytes, totalBytes, growthPerDay, daysLeft };
}
