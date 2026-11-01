import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AccountUsage } from "./accountUsage";
import type { CodexWindow } from "./codexUsage";
import type { UsageAccountHistory, UsagePoint, UsageProvider, UsageResponse } from "../../shared/usage";

const DAY = 86400_000;
const RETENTION = 90 * DAY;
type Observation = Pick<UsagePoint, "window" | "percentUsed" | "resetsAt">;
export const usageIdentityKey = (identity: string) => createHash("sha256").update(identity).digest("hex").slice(0, 24);
const validPercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
function observation(window: string, percent: unknown, resetsAt: unknown): Observation[] {
  return validPercent(percent) ? [{ window, percentUsed: percent, resetsAt: typeof resetsAt === "number" && Number.isSafeInteger(resetsAt) && resetsAt > 0 ? resetsAt : null }] : [];
}
export function claudeWeeklyUsage(usage: AccountUsage): Observation[] {
  const result = usage.limits.flatMap((w) => w && (w.kind === "weekly_all" || w.kind === "weekly_scoped")
    ? observation(w.kind === "weekly_scoped" ? `${w.kind}:${w.modelName ?? "unknown"}` : w.kind, w.percent, w.resetsAt) : []);
  if (!result.some((w) => w.window === "weekly_all")) result.push(...observation("weekly_all", usage.sevenDayPct, usage.sevenDayResetsAt));
  return [...new Map(result.map((p) => [p.window, p])).values()];
}
export function codexWeeklyUsage(windows: CodexWindow[]): Observation[] {
  return windows.flatMap((w) => w.windowMinutes === 10080 ? observation(w.kind, w.usedPct, w.resetsAt) : []);
}

export function migrateWeeklyUsage(db: Database): void {
  const existed = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='weekly_usage_accounts'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_usage_accounts (
    provider TEXT NOT NULL, account_id TEXT NOT NULL, identity_key TEXT NOT NULL,
    label TEXT NOT NULL, state TEXT NOT NULL, sampled_at INTEGER NOT NULL,
    PRIMARY KEY(provider,account_id,identity_key)
  ); CREATE TABLE IF NOT EXISTS weekly_usage_samples (
    provider TEXT NOT NULL, account_id TEXT NOT NULL, identity_key TEXT NOT NULL,
    window TEXT NOT NULL, percent_used REAL NOT NULL, resets_at INTEGER, sampled_at INTEGER NOT NULL,
    PRIMARY KEY(provider,account_id,identity_key,window,sampled_at)
  ); CREATE INDEX IF NOT EXISTS weekly_usage_time ON weekly_usage_samples(sampled_at);
  CREATE INDEX IF NOT EXISTS weekly_usage_reset ON weekly_usage_samples(provider,account_id,identity_key,resets_at);`);
  if (existed) return;
  // Only seed an existing sample whose observed account identity is trustworthy.
  // CO/GR old singleton snapshots lack observed identity/period metadata: no guess.
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='account_usage'").get()) {
    const rows = db.query(`SELECT a.id,a.label,a.org_id AS expected,u.* FROM anthropic_accounts a JOIN account_usage u ON a.id=u.account_id WHERE u.error IS NULL AND u.org_id IS NOT NULL`).all() as any[];
    for (const row of rows) {
      if (row.expected && row.expected !== row.org_id) continue;
      let limits = []; try { const value = JSON.parse(row.limits_json ?? "[]"); if (Array.isArray(value)) limits = value; } catch {}
      recordWeeklyUsage(db, "claude", row.id, row.label, row.org_id, row.fetched_at, claudeWeeklyUsage({ fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: row.seven_day_pct, sevenDayResetsAt: row.seven_day_resets_at, limits }));
    }
  }
}

/** Called only after successful existing collector reads. No network or auth I/O. */
export function recordWeeklyUsage(db: Database, provider: UsageProvider, accountId: string, label: string, identity: string | null, sampledAt: number, points: Observation[]): void {
  // History is secondary: a storage failure must not interrupt account selection
  // or turn a successful credential/usage refresh into a failed switching cycle.
  try { writeWeeklyUsage(db, provider, accountId, label, identity, sampledAt, points); }
  catch { console.error("weekly usage history write failed"); }
}
function writeWeeklyUsage(db: Database, provider: UsageProvider, accountId: string, label: string, identity: string | null, sampledAt: number, points: Observation[]): void {
  if (!identity) { weeklyUsageFailed(db, provider, accountId); return; }
  if (!Number.isSafeInteger(sampledAt) || sampledAt <= 0) return;
  const identityKey = usageIdentityKey(identity);
  const valid = points.filter((p) => validPercent(p.percentUsed) && p.window.length > 0 && p.window.length <= 200).map((p) => ({ ...p, resetsAt: p.resetsAt !== null && Number.isSafeInteger(p.resetsAt) && p.resetsAt > 0 ? p.resetsAt : null }));
  db.transaction(() => {
    db.query("UPDATE weekly_usage_accounts SET state='stale' WHERE provider=? AND account_id=? AND identity_key<>?").run(provider, accountId, identityKey);
    db.query(`INSERT INTO weekly_usage_accounts VALUES(?,?,?,?,?,?) ON CONFLICT(provider,account_id,identity_key) DO UPDATE SET label=excluded.label,state=excluded.state,sampled_at=excluded.sampled_at WHERE excluded.sampled_at>=weekly_usage_accounts.sampled_at`).run(provider, accountId, identityKey, label, valid.length ? "ok" : "unavailable", sampledAt);
    const insert = db.query("INSERT OR IGNORE INTO weekly_usage_samples VALUES(?,?,?,?,?,?,?)");
    for (const p of valid) insert.run(provider, accountId, identityKey, p.window, p.percentUsed, p.resetsAt, sampledAt);
    db.query("DELETE FROM weekly_usage_samples WHERE sampled_at<?").run(sampledAt - RETENTION);
  })();
}
export function weeklyUsageFailed(db: Database, provider: UsageProvider, accountId: string): void {
  try { db.query("UPDATE weekly_usage_accounts SET state='error' WHERE provider=? AND account_id=? AND state<>'stale'").run(provider, accountId); }
  catch { console.error("weekly usage history state write failed"); }
}

export function buildWeeklyUsage(db: Database, from: number, to: number, now = Date.now()): UsageResponse {
  const rows = db.query("SELECT * FROM weekly_usage_accounts ORDER BY provider,account_id,sampled_at DESC").all() as {provider: UsageProvider; account_id: string; identity_key: string; label: string; state: UsageAccountHistory["state"]; sampled_at: number}[];
  const claudeAccounts = db.query("SELECT id,label,org_id AS identity FROM anthropic_accounts").all() as {id:string;label:string;identity:string|null}[];
  const hasCodexRegistry = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name='codex_accounts'").get());
  const codexAccounts = hasCodexRegistry ? db.query("SELECT id,label,identity FROM codex_accounts").all() as {id:string;label:string;identity:string|null}[] : [];
  // The main CO volume is a real account slot even before/without registry rows.
  if (!codexAccounts.some((a) => a.id === "default")) codexAccounts.push({id:"default",label:"Main account",identity:null});
  // Singleton pollers do not refresh tokens — an expired login is therefore a common state
  // with a clear fix, not a generic collection error (Grok refreshes the token only in a running `gr`).
  const loginExpired = (provider: UsageProvider, accountId: string) => {
    const table = provider === "grok" ? "grok_usage" : provider === "codex" && accountId === "default" ? "codex_usage" : null;
    if (!table || !db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) return false;
    return (db.query(`SELECT state FROM ${table} LIMIT 1`).get() as {state:string}|null)?.state === "stale-login";
  };
  const errorDetail = (provider: UsageProvider, accountId: string) => !loginExpired(provider, accountId) ? "The account collector could not refresh usage"
    : provider === "grok" ? "Grok login expired; run gr in any session to refresh it" : "Codex login expired; sign in again in Settings";
  const accounts = rows.map((r): UsageAccountHistory => {
    const registered = (r.provider === "claude" ? claudeAccounts : r.provider === "codex" ? codexAccounts : []).find((a) => a.id === r.account_id);
    const deleted = (r.provider === "claude" || (r.provider === "codex" && hasCodexRegistry)) && !registered;
    const replaced = Boolean(registered?.identity && usageIdentityKey(registered.identity) !== r.identity_key)
      || rows.some((other) => other.provider === r.provider && other.account_id === r.account_id && other.identity_key !== r.identity_key && other.sampled_at > r.sampled_at);
    const archived = deleted || replaced;
    const key = [r.provider, r.account_id, r.identity_key];
    const select = "SELECT window,percent_used AS percentUsed,resets_at AS resetsAt,sampled_at AS sampledAt FROM weekly_usage_samples WHERE provider=? AND account_id=? AND identity_key=?";
    const history = db.query(`${select} AND sampled_at>=? AND sampled_at<? ORDER BY sampled_at`).all(...key, from, to) as UsagePoint[];
    // Missing windows in a newer successful observation must not look current.
    const latest = db.query(`${select} AND sampled_at=? ORDER BY window`).all(...key, r.sampled_at) as UsagePoint[];
    const resets = db.query("SELECT DISTINCT window,resets_at AS resetsAt FROM weekly_usage_samples WHERE provider=? AND account_id=? AND identity_key=? AND resets_at>=? AND resets_at<? ORDER BY resets_at").all(...key, from, to) as {window:string;resetsAt:number}[];
    canonicalResets(history, latest, resets);
    const expired = latest.some((p) => p.resetsAt !== null && p.resetsAt <= now);
    const state = archived || (r.state === "ok" && (now - r.sampled_at > 15 * 60_000 || expired)) ? "stale" : r.state;
    return { provider: r.provider, accountId: r.account_id, accountLabel: deleted ? `${r.label} (removed account)` : replaced ? `${r.label} (previous login)` : registered?.label ?? r.label, identityKey: r.identity_key, archived, state, detail: deleted ? "Historical readings for a removed account" : replaced ? "Historical readings for a previous login" : state === "ok" ? "Account weekly quota" : state === "stale" ? "Previous identity, reset due, or last reading is stale" : state === "error" ? errorDetail(r.provider, r.account_id) : "No measured weekly allowance", latest, history, resets };
  });
  // Accounts with no valid observation still appear, without a fabricated 0%.
  const missing = (provider: UsageProvider, accountId: string, accountLabel: string) => {
    if (!accounts.some((a) => a.provider === provider && a.accountId === accountId && !a.archived)) accounts.push({ provider, accountId, accountLabel, identityKey: "unmeasured", state: "unavailable", detail: "Waiting for an identified weekly quota observation", latest: [], history: [], resets: [] });
  };
  for (const a of claudeAccounts) missing("claude", a.id, a.label);
  for (const a of codexAccounts) missing("codex", a.id, a.label);
  missing("grok", "default", "Grok Build");
  return { from, to, accounts };
}
/** Claude reports the reset time as "now + remaining seconds", so the same reset arrives
 *  a few hundred ms differently each time (live: 2083 distinct values per week = 2 actual
 *  resets). The dashboard then drew over a thousand dashed reset lines and broke the chart
 *  with a gap between EVERY sample (usageChartPoints treats a change of resetsAt as a new
 *  period) — a 1.45 MB response and thousands of SVG elements on Overview. Values of the same window
 *  that lie within a minute of the first value of a cluster are aligned to that first one; actual
 *  resets are hours to days apart, so nothing gets merged. Mutates the array in place. */
const RESET_JITTER_MS = 60_000;
function canonicalResets(history: UsagePoint[], latest: UsagePoint[], resets: { window: string; resetsAt: number }[]): void {
  const values = new Map<string, number[]>();
  for (const p of [...history, ...latest, ...resets]) {
    if (p.resetsAt === null) continue;
    const list = values.get(p.window) ?? [];
    list.push(p.resetsAt);
    values.set(p.window, list);
  }
  const canon = new Map<string, Map<number, number>>();
  for (const [window, list] of values) {
    const m = new Map<number, number>();
    let start = -Infinity;
    for (const v of [...new Set(list)].sort((a, b) => a - b)) {
      if (v - start > RESET_JITTER_MS) start = v;
      m.set(v, start);
    }
    canon.set(window, m);
  }
  const fix = (p: { window: string; resetsAt: number | null }) => {
    if (p.resetsAt !== null) p.resetsAt = canon.get(p.window)?.get(p.resetsAt) ?? p.resetsAt;
  };
  history.forEach(fix); latest.forEach(fix); resets.forEach(fix);
  const seen = new Set<string>();
  for (let i = resets.length - 1; i >= 0; i--) {
    const k = `${resets[i].window}\u0000${resets[i].resetsAt}`;
    if (seen.has(k)) resets.splice(i, 1); else seen.add(k);
  }
}
export function weeklyUsageRange(query: {days?:string;from?:string;to?:string}, now = Date.now()): {from:number;to:number} | null {
  const days = query.days === undefined ? 7 : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) return null;
  const to = query.to === undefined ? now : Number(query.to);
  const from = query.from === undefined ? to - days * DAY : Number(query.from);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from < to && to <= now + 60_000 && to - from <= RETENTION ? {from,to} : null;
}
