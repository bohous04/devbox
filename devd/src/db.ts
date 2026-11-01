import { migrateWeeklyUsage } from "./weeklyUsage";
import { Database } from "bun:sqlite";
import { migrateLiveActivities } from "./liveActivitiesDb";
// The agent a session launches — today a "profile", see agents.ts. The re-export (via
// import + export, not a bare `export ... from`) keeps today's import paths
// (`import { type AgentName } from "./db"`) valid and at the same time gives db.ts
// itself local names for use further down in the file.
import { AGENTS, isAgentName, type AgentName } from "./agents";
export { AGENTS, isAgentName, type AgentName };

export type SessionHost = "vps" | "instabox";

export function migrateDiskStats(db: Database): void {
  const cols = db.query("PRAGMA table_info(disk_stats)").all() as { name: string }[];
  if (cols.some((c) => c.name === "path")) db.run("DROP TABLE disk_stats");
}

// Schema version for migrations that CANNOT be detected from `PRAGMA table_info` — i.e. those
// that change DATA, not the shape of a table. Column migrations stay where they were (checking
// for a column's presence is idempotent on its own and needs no counter).
const SCHEMA_VERSION = 1;

/** One-off silencing of old scheduled runs.
 *
 *  `schedules.important` was created with DEFAULT 1 and the CRON UI NEVER had a toggle
 *  for it — so the value 1 on existing rows is not an operator choice, just the default
 *  of the time. Consequence: every nightly/morning run sent a Pushover EMERGENCY to the phone
 *  (priority 2 = repeats every minute for a whole hour until you acknowledge it), even for
 *  a mere "run started". Flipped to 0; whoever wants emergency can turn it back on in the UI. */
export function migrateScheduleImportance(db: Database): void {
  const { user_version: v } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v >= SCHEMA_VERSION) return;
  db.run(`UPDATE schedules SET important=0`);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export interface SessionRow {
  id: string; folder: string; project: string; repo: string; container: string;
  port_base: number; status: "running" | "stopped"; solo: 0 | 1;
  created_at: number; last_active_at: number; important: 0 | 1;
  // Optional nickname shown in the manager (otherwise project/repo). NULL = no name.
  // Optional in TS only so that SessionRow literals not yet created (insert) need not write `name`;
  // a row from the DB always carries `name` (string | null) thanks to the migration below.
  name?: string | null;
  // Critic enabled = the agent must not end a turn without review (criticGate). NULL/0 = off.
  // Optional for the same reason as `name`: insert literals need not specify it.
  critic?: 0 | 1;
  // Session agent (claude/codex). Optional only because of insert literals; DB has a NOT NULL default.
  agent?: AgentName;
  // The session's own working directory (git worktree over a bare clone of the repo).
  // NULL = repo in the OLD shape with a shared workspace; such repos are not migrated and behave
  // exactly as before. The shape is read from here, not from disk: a bare clone can appear next
  // to an old repo at any time and an old session would silently switch its working directory.
  worktree?: string | null;
  // Branch the session's worktree sits on. Determined ONCE at creation, and when repairing
  // a lost registration it is taken from here — re-derived, it would come out as the default
  // after its siblings disappear and the session would silently switch to `main`. NULL = row
  // from before the column existed (recordBranches fills it in) or shared workspace without a worktree.
  branch?: string | null;
  // 1 = once the agent finishes a turn, the session ends itself (scheduled run, see autoEnd.ts).
  // Optional for the same reason as `name`/`critic`: insert literals need not specify it.
  auto_end?: 0 | 1;
  // Where the session runs. Optional only because of insert literals; DB has a NOT NULL default 'vps'.
  host?: SessionHost;
  // InstaBox machine ID (m_…) when host='instabox', otherwise NULL. One session = one machine.
  instabox_machine_id?: string | null;
  // Tailnet IPv4 of the InstaBox machine (`tailscale ip -4` after `tailscale up`). Approval
  // gates (network.ts addInstaboxIp) never let a decision through from it (C1 final review).
  instabox_ts_ip?: string | null;
}

// Cleans a user-supplied session name: collapses whitespace (incl. \n/\t) to spaces, trims,
// clamps to 60 chars; empty/whitespace/undefined → null (= clear the nickname).
export function sanitizeSessionName(raw?: string | null): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return cleaned.length ? cleaned : null;
}

/** Attributes the Stats page breaks metrics down by, pulled out of the JSON into
 *  their own columns. The reason is purely performance: `json_extract` over the fat `attrs`
 *  cannot be covered by an index, so each of the ~18 breakdowns in `buildRange` had to read
 *  whole rows. With plain columns and a covering index SQLite reads only the index.
 *
 *  CAUTION: a VIRTUAL generated column CANNOT do this — SQLite will not use an index over it
 *  as covering and computes the value from attrs anyway (measured on the live DB: 0.117 s
 *  vs 0.026 s). Hence plain columns filled on INSERT and backfilled by a migration. */
const ATTR_COLUMNS = ["a_project", "a_model", "a_host", "a_account", "a_repo"] as const;

/** One wide covering index instead of five narrow ones: it covers every breakdown (with and
 *  without a project filter) and costs +91 MB instead of +159 MB. With more indexes over the same
 *  `(name, ts)` prefix the planner also kept picking the wrong one.
 *  `session_id` is here because of `usageBySession` (Sessions asks for it every 5 s),
 *  `value` at the end makes the index covering even for a plain SUM(value).
 *  The string must exactly match what SQLite stores in sqlite_master —
 *  the migration uses it to detect that the index has the old shape. */
const ROLLUP_INDEX_SQL =
  `CREATE INDEX metrics_rollup ON metrics (name, ts, ${ATTR_COLUMNS.join(", ")}, session_id, value)`;

/**
 * Expressions for ATTR_COLUMNS in the same order. `src` is an SQL expression with the attrs JSON
 * (`attrs` during backfill, `?5` in the INSERT).
 *
 * `a_repo` MUST NOT be looked up via a join on `sessions` — that table is deleted from when a
 * session ends (`deleteSession`), so the entire history of ended sessions would fall into a
 * single anonymous "—". Exactly that happened: one leaderboard row had 83 M tokens
 * and it was all ended sessions combined.
 *
 * More recently the metric carries the repo itself (`attrs.repo`, see OTEL_RESOURCE_ATTRIBUTES in
 * sessions.ts). Older rows do not have it; there it is derived from `devbox.session.id`
 * by cutting off the `dev-<project>-` prefix. `project` comes from the same attrs, so this is not
 * guessing — but it holds ONLY for historical rows whose id has the shape
 * `dev-<project>-<repo>`. A session with a sequence suffix would come out as repo
 * `web-2`; those, however, always carry `attrs.repo`, so they never get here.
 *
 * Note: `runOpts` NO LONGER does this reasoning — it gets the repo as a parameter from the columns,
 * because after introducing multiple sessions per repo it stopped being derivable from the id.
 */
function attrExprs(src: string): string[] {
  const project = `json_extract(${src}, '$.project')`;
  const sessionId = `json_extract(${src}, '$."devbox.session.id"')`;
  return [
    project,
    `json_extract(${src}, '$.model')`,
    `json_extract(${src}, '$."devbox.host"')`,
    `json_extract(${src}, '$."user.account_uuid"')`,
    `COALESCE(json_extract(${src}, '$.repo'), ` +
      `CASE WHEN ${sessionId} LIKE 'dev-' || ${project} || '-%' ` +
      `THEN substr(${sessionId}, length('dev-' || ${project} || '-') + 1) END)`,
  ];
}

export function openDb(path: string): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    container TEXT NOT NULL, port_base INTEGER NOT NULL UNIQUE, status TEXT NOT NULL,
    solo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    important INTEGER NOT NULL DEFAULT 0,
    critic INTEGER NOT NULL DEFAULT 0,
    agent TEXT NOT NULL DEFAULT 'claude',
    auto_end INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL DEFAULT 'vps', instabox_machine_id TEXT, instabox_ts_ip TEXT)`);
  // migration of older DBs (sessions without the important / name / critic / agent / worktree / auto_end column)
  const sessionCols = () => (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!sessionCols().includes("important")) {
    db.run(`ALTER TABLE sessions ADD COLUMN important INTEGER NOT NULL DEFAULT 0`);
  }
  if (!sessionCols().includes("name")) {
    db.run(`ALTER TABLE sessions ADD COLUMN name TEXT`); // NULL = no nickname
  }
  if (!sessionCols().includes("critic")) {
    db.run(`ALTER TABLE sessions ADD COLUMN critic INTEGER NOT NULL DEFAULT 0`); // 0 = critic off
  }
  if (!sessionCols().includes("agent")) {
    db.run(`ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'`);
  }
  if (!sessionCols().includes("worktree")) {
    db.run(`ALTER TABLE sessions ADD COLUMN worktree TEXT`); // NULL = old shape, shared workspace
  }
  if (!sessionCols().includes("auto_end")) {
    db.run(`ALTER TABLE sessions ADD COLUMN auto_end INTEGER NOT NULL DEFAULT 0`); // 0 = session survives the end of a turn
  }
  if (!sessionCols().includes("branch")) {
    db.run(`ALTER TABLE sessions ADD COLUMN branch TEXT`); // NULL = not recorded yet
  }
  if (!sessionCols().includes("host")) {
    db.run(`ALTER TABLE sessions ADD COLUMN host TEXT NOT NULL DEFAULT 'vps'`); // 'vps' | 'instabox'
  }
  if (!sessionCols().includes("instabox_machine_id")) {
    db.run(`ALTER TABLE sessions ADD COLUMN instabox_machine_id TEXT`); // m_… u host='instabox'
  }
  if (!sessionCols().includes("instabox_ts_ip")) {
    db.run(`ALTER TABLE sessions ADD COLUMN instabox_ts_ip TEXT`); // 100.x stroje u host='instabox'
  }
  // Current InstaBox base snapshot (single row). image_digest = `docker image inspect` of the
  // devbox image the snapshot was made from — the dashboard uses it to detect a stale base.
  db.run(`CREATE TABLE IF NOT EXISTS instabox_base (
    id INTEGER PRIMARY KEY CHECK(id=1), snapshot_id TEXT NOT NULL, image_digest TEXT NOT NULL, built_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    session_id TEXT, type TEXT NOT NULL, data TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT,
    name TEXT NOT NULL, value REAL NOT NULL, attrs TEXT NOT NULL,
    a_project TEXT, a_model TEXT, a_host TEXT, a_account TEXT, a_repo TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS git_stats (
    session_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, commits INTEGER NOT NULL,
    added INTEGER NOT NULL, removed INTEGER NOT NULL, unpushed INTEGER NOT NULL)`);
  migrateDiskStats(db);
  db.run(`CREATE TABLE IF NOT EXISTS disk_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, bytes INTEGER NOT NULL)`);
  // For diskHistoryEnds: first/last sample without scanning the whole table (tens of thousands of rows).
  db.run(`CREATE INDEX IF NOT EXISTS disk_stats_ts ON disk_stats (ts)`);
  db.run(`CREATE TABLE IF NOT EXISTS clone_jobs (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
    total INTEGER NOT NULL, done INTEGER NOT NULL, results TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL,
    folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    clone_url TEXT NOT NULL, prompt TEXT NOT NULL,
    important INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER)`);
  migrateScheduleImportance(db);
  // Dummy git tokens. In the database, not only in memory — a devd restart must not break git
  // in running sessions (the container has the dummy in a file and devd must be able to translate it).
  db.run(`CREATE TABLE IF NOT EXISTS git_placeholders (
    placeholder TEXT PRIMARY KEY, session_id TEXT NOT NULL, instance TEXT NOT NULL,
    created_at INTEGER NOT NULL)`);
  // Requests for access to a database that is not yet in the catalog (see dbRequests.ts).
  db.run(`CREATE TABLE IF NOT EXISTS db_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, project TEXT,
    wanted TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER, note TEXT)`);
  if (!(db.query("PRAGMA table_info(db_requests)").all() as { name: string }[]).some((c) => c.name === "requested_scope")) db.run("ALTER TABLE db_requests ADD COLUMN requested_scope TEXT NOT NULL DEFAULT 'read'");
  // Broker of named operations. Parameters are JSON, not a free-form command — what may get
  // here at all is decided by the catalog in operations.ts.
  db.run(`CREATE TABLE IF NOT EXISTS operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT,
    op TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER, result TEXT, error TEXT)`);
  if (!(db.query("PRAGMA table_info(operations)").all() as { name: string }[]).some((c) => c.name === "error_details")) db.run("ALTER TABLE operations ADD COLUMN error_details TEXT");
  db.run(`CREATE TABLE IF NOT EXISTS prod_writes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT,
    db TEXT NOT NULL, sql TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER, result TEXT, error TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS db_onboarding (
    request_id INTEGER PRIMARY KEY REFERENCES db_requests(id),
    state TEXT NOT NULL, plan TEXT, blocks TEXT NOT NULL DEFAULT '[]',
    operation_id INTEGER, step TEXT, updated_at INTEGER NOT NULL)`);
  for (const [column, type] of [["scope", "TEXT NOT NULL DEFAULT 'dml'"], ["idempotency_key", "TEXT"], ["exception", "TEXT"]]) {
    const columns = db.query("PRAGMA table_info(prod_writes)").all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.run(`ALTER TABLE prod_writes ADD COLUMN ${column} ${type}`);
  }
  // SSH grants persist for (session_id, title, target), until a deadline or explicit revocation.
  db.run(`CREATE TABLE IF NOT EXISTS ssh_approvals (
    id TEXT PRIMARY KEY, session_id TEXT, title TEXT NOT NULL, why TEXT NOT NULL,
    target TEXT, cwd TEXT, project TEXT, repo TEXT,
    status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL,
    grant_until INTEGER, grant_permanent INTEGER NOT NULL DEFAULT 0 CHECK (grant_permanent IN (0, 1)))`);
  if (!(db.query("PRAGMA table_info(ssh_approvals)").all() as { name: string }[]).some((c) => c.name === "grant_permanent")) {
    db.run("ALTER TABLE ssh_approvals ADD COLUMN grant_permanent INTEGER NOT NULL DEFAULT 0 CHECK (grant_permanent IN (0, 1))");
  }
  // Server alias from the config (sshServers) the request targets; NULL = target outside the config
  // or no target. The grant's scope is determined by `target`; `server` is just a label for humans.
  if (!(db.query("PRAGMA table_info(ssh_approvals)").all() as { name: string }[]).some((c) => c.name === "server")) {
    db.run("ALTER TABLE ssh_approvals ADD COLUMN server TEXT");
  }
  db.run(`CREATE TABLE IF NOT EXISTS critic_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    round INTEGER NOT NULL, verdict TEXT NOT NULL, findings TEXT NOT NULL,
    evidence TEXT, ms INTEGER NOT NULL, at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS repo_prefs (
    folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    agent TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (folder, project, repo))`);
  // Pool of Anthropic accounts. THESE TABLES CONTAIN NO TOKENS — those live exclusively
  // in the profiles (docker volume claude-acct-<id>), where Claude Code itself wrote them
  // and keeps them up to date.
  db.run(`CREATE TABLE IF NOT EXISTS anthropic_accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    quarantined_at INTEGER,
    added_at INTEGER NOT NULL)`);
  // migration of an older DB (the live account pool already had this table BEFORE the weight column) —
  // a purely additive ALTER, never re-create, otherwise a deploy would delete both accounts.
  if (!(db.query("PRAGMA table_info(anthropic_accounts)").all() as { name: string }[]).some((c) => c.name === "weight")) {
    db.run(`ALTER TABLE anthropic_accounts ADD COLUMN weight INTEGER`);   // NULL = weight unknown/unparseable
  }
  // Organization the account BELONGED to at registration (or when credentials were replaced).
  // Without it devd cannot tell that the profile has meanwhile logged in with another account — and
  // exactly that happened on 11 Aug 2026: profile `max5` (registered as team@example.com) logged in
  // as user@example.com and the pool ran for eight days on a SINGLE account, measured twice.
  if (!(db.query("PRAGMA table_info(anthropic_accounts)").all() as { name: string }[]).some((c) => c.name === "org_id")) {
    db.run(`ALTER TABLE anthropic_accounts ADD COLUMN org_id TEXT`);      // NULL = not determined yet
  }
  // limits_json is stored RAW so that new window types as they appear (today weekly_scoped for
  // the "Fable" model) do not require a schema migration.
  db.run(`CREATE TABLE IF NOT EXISTS account_usage (
    account_id TEXT PRIMARY KEY,
    five_hour_pct REAL, five_hour_resets_at INTEGER,
    seven_day_pct REAL, seven_day_resets_at INTEGER,
    limits_json TEXT,
    fetched_at INTEGER NOT NULL,
    error TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    org_id TEXT)`);
  // migration of an older DB: without the counter EVERY error (even a one-off 429 from the usage
  // endpoint) put measurement to sleep for the full backoff, because the poller could not tell a
  // first stumble from a permanently broken account. Additive ALTER, never re-create — otherwise a
  // deploy would discard the last measured numbers of both accounts.
  if (!(db.query("PRAGMA table_info(account_usage)").all() as { name: string }[]).some((c) => c.name === "error_count")) {
    db.run(`ALTER TABLE account_usage ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0`);
  }
  // Organization the API reported at the LAST successful measurement. Compared with `org_id` on
  // the account (registered identity) this reveals a switched profile; a match between two
  // accounts in turn reveals that the pool actually has only one.
  if (!(db.query("PRAGMA table_info(account_usage)").all() as { name: string }[]).some((c) => c.name === "org_id")) {
    db.run(`ALTER TABLE account_usage ADD COLUMN org_id TEXT`);
  }
  // One Codex login = one row. Constant primary key so that a second one cannot be
  // inserted into the table — the pool is for Anthropic accounts only, for now.
  db.run(`CREATE TABLE IF NOT EXISTS codex_usage (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL,
    plan_type TEXT,
    windows_json TEXT NOT NULL,
    credits_json TEXT,
    limit_reached TEXT,
    endpoint_idx INTEGER,
    fetched_at INTEGER NOT NULL,
    error TEXT)`);
  // One Grok login = one row, the same singleton pattern as codex_usage.
  // `used_pct` is nullable on purpose: SuperGrok does not expose a percentage and NULL means
  // "unknown", not zero (see grokUsageFetch.ts).
  db.run(`CREATE TABLE IF NOT EXISTS grok_usage (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL,
    tier TEXT,
    used_pct REAL,
    resets_at INTEGER,
    fetched_at INTEGER NOT NULL,
    error TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS account_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    client TEXT NOT NULL,
    session_id TEXT,
    label TEXT,
    created_at INTEGER NOT NULL,
    released_at INTEGER)`);
  // Notification debug log: a row for every hook event and for every decision, so that
  // one can trace back why "finished work" was or was not sent (and flag it).
  db.run(`CREATE TABLE IF NOT EXISTS notify_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
    event TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
    inflight INTEGER NOT NULL DEFAULT 0, teammates INTEGER NOT NULL DEFAULT 0,
    agent_session_id TEXT, detail TEXT,
    verdict TEXT, verdict_note TEXT, verdict_at INTEGER)`);
  db.run(`CREATE INDEX IF NOT EXISTS notify_log_session ON notify_log (session_id, id)`);
  // Worked hours. DELIBERATELY not trimmed (unlike notify_log): it is history
  // worth reading months back. Volume is on the order of single rows per turn.
  db.run(`CREATE TABLE IF NOT EXISTS work_intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
    seconds INTEGER NOT NULL, capped INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE INDEX IF NOT EXISTS work_intervals_project ON work_intervals (project, started_at)`);
  // Last KNOWN agent state (AgentEventHub.liveSnapshot) for Live Activity, so that after a
  // devd restart the dashboard/widget do not report "waiting for agent state" for a session that
  // finished its turn long ago. One row per session (overwritten), not history — see agentEvents.ts.
  db.run(`CREATE TABLE IF NOT EXISTS agent_live_state (
    session_id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL, reason TEXT,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status_since INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS harvest_state (
    source TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  migrateLiveActivities(db);
  db.run(`CREATE TABLE IF NOT EXISTS push_devices (
    token TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT,
    registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS push_alerts (
    alert_id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL,
    session_id TEXT, created_at INTEGER NOT NULL, last_sent_at INTEGER NOT NULL,
    acked_at INTEGER)`);
  // Sharing a session's terminal via a short-lived link (see shares.ts). `token_hash` is the
  // SHA-256 of the token — the raw token is NEVER stored in the DB, only its hash.
  db.run(`CREATE TABLE IF NOT EXISTS terminal_shares (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`);
  db.run(`CREATE INDEX IF NOT EXISTS terminal_shares_session ON terminal_shares (session_id)`);
  // Containers that were ever shared (shareTaint.ts): they stay restricted until the
  // session is rebuilt (new docker id). Key = the container's docker id, not the session.
  db.run(`CREATE TABLE IF NOT EXISTS session_taints (
    container_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS session_taints_session ON session_taints (session_id)`);
  migrateMetricsIndex(db);
  migrateMetricsSessionIndex(db);
  migrateMetricsAttrColumns(db);
  // Only after the attr columns: the rollup is filled from a_* and their backfill must finish first.
  migrateMetricsHourly(db);
  migrateWeeklyUsage(db);
  return db;
}

/** Index for queries over `metrics` — each of them filters `name=? AND ts BETWEEN`.
 *  Without it each of the ~20 queries in buildRange did a full scan over the whole table
 *  (375 k rows / 323 MB on the live devbox, because `attrs` is fat JSON) and
 *  /api/stats/range took 5–8 s. `value` is in the index on purpose: sums and daily
 *  series then read only the index and never touch the fat rows.
 *
 *  Returns true when the index was created now (older DB) — otherwise false. On 375 k rows
 *  it builds in a few seconds and happens at devd startup, not while a query runs. */
export function migrateMetricsIndex(db: Database): boolean {
  const has = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='metrics_name_ts'").get();
  if (has) return false;
  db.run(`CREATE INDEX metrics_name_ts ON metrics (name, ts, value)`);
  return true;
}

/** Index for `lastMetricTs` — `SELECT MAX(ts) FROM metrics WHERE session_id=?`.
 *  `metrics_name_ts` does not fit this shape (it leads with `name`), so the query did a full scan:
 *  on the live devbox 96 ms × number of sessions. And because `bun:sqlite` is synchronous
 *  and devd has a single JS thread, it blocked everything else too — /api/health could
 *  jump from 0.9 ms to 3.6 s with six concurrent /api/stats/live requests.
 *
 *  Returns true when the index was created now (older DB) — otherwise false. */
export function migrateMetricsSessionIndex(db: Database): boolean {
  const has = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='metrics_session_ts'").get();
  if (has) return false;
  db.run(`CREATE INDEX metrics_session_ts ON metrics (session_id, ts)`);
  return true;
}

/** Adds ATTR_COLUMNS and the covering index to a DB that does not have them yet, and backfills them
 *  for existing rows. On the live 376 k rows: ALTER instant, backfill 1.6 s,
 *  index 0.5 s, ANALYZE 0.15 s — one-off at devd startup, not while a query runs.
 *  The index adds ~91 MB to the DB file.
 *
 *  One wide index instead of five narrow ones is intentional: it covers every breakdown (with and
 *  without a project filter) and costs +91 MB instead of +159 MB. `value` at the end makes it covering
 *  even for a plain SUM(value).
 *
 *  Returns true when the migration ran now — otherwise false. */
export function migrateMetricsAttrColumns(db: Database): boolean {
  const cols = new Set((db.query("PRAGMA table_info(metrics)").all() as { name: string }[]).map((r) => r.name));
  const missing = ATTR_COLUMNS.filter((c) => !cols.has(c));
  // Compares the SHAPE of the index, not just its name: if the columns in ROLLUP_INDEX_SQL
  // ever changed, the name alone would leave the old index in place and the queries would silently
  // stop being covering.
  const existing = db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='metrics_rollup'")
    .get() as { sql: string } | null;
  const indexOk = existing?.sql === ROLLUP_INDEX_SQL;
  if (missing.length === 0 && indexOk) return false;

  for (const c of missing) db.run(`ALTER TABLE metrics ADD COLUMN ${c} TEXT`);
  if (missing.length > 0) {
    const exprs = attrExprs("attrs");
    db.run(`UPDATE metrics SET ${ATTR_COLUMNS.map((c, i) => `${c} = ${exprs[i]}`).join(", ")}`);
  }
  if (!indexOk) {
    if (existing) db.run("DROP INDEX metrics_rollup");
    db.run(ROLLUP_INDEX_SQL);
    db.run("ANALYZE");
  }
  return true;
}

/** Hourly rollup of `metrics` for /api/stats/range.
 *
 *  Why: buildRange runs ~40 queries and each one walks the covering index over the whole window.
 *  On the live DB (1.95 M rows, 1.36 M of them token.usage) that was 0.2 s for today,
 *  1 s for 7 days, 3.1 s for 30 days and 5.3 s for 90 days — and the whole time the single JS
 *  thread of devd was stalled, i.e. all other requests too. The breakdown keys, however, have low
 *  cardinality: the entire history fits into ~14 k rows (name × hour × a_*).
 *
 *  It is maintained by TRIGGERS, not code in insertMetrics: `metrics` is written from elsewhere too
 *  (codexStatsRepair rewrites a_model, tests touch it directly), and a rollup that silently
 *  diverges from its source would be worse than a slow query. `n` = number of source
 *  rows; a group with n=0 is deleted so that a breakdown does not show a key that no longer has data.
 *
 *  `hour` is an absolute hour (floor(ts/3600000)). The modulo is computed as
 *  ((ts % H) + H) % H because SQLite divides toward zero and negative ts (tests) would otherwise
 *  land one hour off. */
const HOUR_MS = 3_600_000;
const hourExpr = (ts: string) => `((${ts} - (((${ts} % ${HOUR_MS}) + ${HOUR_MS}) % ${HOUR_MS})) / ${HOUR_MS})`;
const HOURLY_KEY = ["a_project", "a_model", "a_host", "a_account", "a_repo"] as const;
const HOURLY_TRIGGERS = ["metrics_hourly_ins", "metrics_hourly_del", "metrics_hourly_upd"] as const;

function hourlyKeyWhere(row: "NEW" | "OLD"): string {
  return `name = ${row}.name AND hour = ${hourExpr(`${row}.ts`)} AND ` +
    HOURLY_KEY.map((c) => `${c} IS ${row}.${c}`).join(" AND ");
}
function hourlyAdd(): string {
  return `UPDATE metrics_hourly SET sum = sum + NEW.value, n = n + 1 WHERE ${hourlyKeyWhere("NEW")};
    INSERT INTO metrics_hourly (name, hour, ${HOURLY_KEY.join(", ")}, sum, n)
      SELECT NEW.name, ${hourExpr("NEW.ts")}, ${HOURLY_KEY.map((c) => `NEW.${c}`).join(", ")}, NEW.value, 1
      WHERE NOT EXISTS (SELECT 1 FROM metrics_hourly WHERE ${hourlyKeyWhere("NEW")});`;
}
function hourlySub(): string {
  return `UPDATE metrics_hourly SET sum = sum - OLD.value, n = n - 1 WHERE ${hourlyKeyWhere("OLD")};
    DELETE FROM metrics_hourly WHERE ${hourlyKeyWhere("OLD")} AND n <= 0;`;
}
function createHourlyTriggers(db: Database): void {
  db.run(`CREATE TRIGGER metrics_hourly_ins AFTER INSERT ON metrics BEGIN ${hourlyAdd()} END`);
  db.run(`CREATE TRIGGER metrics_hourly_del AFTER DELETE ON metrics BEGIN ${hourlySub()} END`);
  db.run(`CREATE TRIGGER metrics_hourly_upd AFTER UPDATE OF ts, name, value, ${HOURLY_KEY.join(", ")} ON metrics
    BEGIN ${hourlySub()} ${hourlyAdd()} END`);
}
function dropHourlyTriggers(db: Database): void {
  for (const t of HOURLY_TRIGGERS) db.run(`DROP TRIGGER IF EXISTS ${t}`);
}

/** Creates `metrics_hourly` + triggers and fills them from existing rows. On the live DB
 *  (1.95 M rows) measured at 3.1 s one-off at devd startup, result ~14 k rows
 *  and +2 MB. All in one transaction: either the rollup is complete including triggers, or absent entirely.
 *  Returns true when the migration ran now. */
export function migrateMetricsHourly(db: Database): boolean {
  const have = new Set((db.query(
    "SELECT name FROM sqlite_master WHERE (type='table' AND name='metrics_hourly') OR (type='trigger' AND name LIKE 'metrics_hourly_%')",
  ).all() as { name: string }[]).map((r) => r.name));
  if (have.has("metrics_hourly") && HOURLY_TRIGGERS.every((t) => have.has(t))) return false;
  db.transaction(() => {
    dropHourlyTriggers(db);
    db.run("DROP TABLE IF EXISTS metrics_hourly");
    db.run(`CREATE TABLE metrics_hourly (
      name TEXT NOT NULL, hour INTEGER NOT NULL,
      a_project TEXT, a_model TEXT, a_host TEXT, a_account TEXT, a_repo TEXT,
      sum REAL NOT NULL, n INTEGER NOT NULL)`);
    db.run(`INSERT INTO metrics_hourly (name, hour, ${HOURLY_KEY.join(", ")}, sum, n)
      SELECT name, ${hourExpr("ts")} AS h, ${HOURLY_KEY.join(", ")}, SUM(value), COUNT(*)
      FROM metrics GROUP BY name, h, ${HOURLY_KEY.join(", ")}`);
    // `sum` at the end makes the index covering for reading breakdowns.
    db.run(`CREATE INDEX metrics_hourly_key ON metrics_hourly (name, hour, ${HOURLY_KEY.join(", ")}, sum)`);
    createHourlyTriggers(db);
  })();
  return true;
}

export interface HourlyCell {
  name: string; hour: number;
  project: string | null; model: string | null; host: string | null; account: string | null; repo: string | null;
  /** Local hour of day (0–23) — computed by SQLite the same way as `metricHourly`,
   *  not by JS: `bun test` switches JS to UTC, but SQLite still reads the system zone. */
  localHour: number;
  sum: number;
}

/** Rollup cells for whole hours in [from, to). The caller MUST ensure that both from and to
 *  are aligned to the hour — otherwise the window edges would be counted in full. */
export function metricHourlyCells(db: Database, names: string[], from: number, to: number, project?: string | null): HourlyCell[] {
  const f = projectFilter(project, null);
  return db.query(
    "SELECT name, hour, a_project AS project, a_model AS model, a_host AS host, a_account AS account, a_repo AS repo, sum, " +
    `CAST(strftime('%H', hour * ${HOUR_MS / 1000}, 'unixepoch', 'localtime') AS INTEGER) AS localHour ` +
    `FROM metrics_hourly WHERE name IN (${names.map(() => "?").join(",")}) AND hour>=? AND hour<?` + f.sql,
  ).all(...names, Math.floor(from / HOUR_MS), Math.floor(to / HOUR_MS), ...f.args) as HourlyCell[];
}

export function insertSession(db: Database, r: SessionRow): void {
  db.query(`INSERT INTO sessions (id,folder,project,repo,container,port_base,status,solo,created_at,last_active_at,important,agent,worktree,branch,host,instabox_machine_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.folder, r.project, r.repo, r.container, r.port_base, r.status, r.solo, r.created_at, r.last_active_at, r.important, r.agent ?? "claude", r.worktree ?? null, r.branch ?? null, r.host ?? "vps", r.instabox_machine_id ?? null);
}

export function setSessionInstabox(db: Database, id: string, machineId: string | null): void {
  db.query(`UPDATE sessions SET instabox_machine_id=? WHERE id=?`).run(machineId, id);
}

export function setSessionInstaboxTsIp(db: Database, id: string, ip: string | null): void {
  db.query(`UPDATE sessions SET instabox_ts_ip=? WHERE id=?`).run(ip, id);
}

export interface InstaboxBase { snapshot_id: string; image_digest: string; built_at: number }
export function getInstaboxBase(db: Database): InstaboxBase | null {
  return (db.query(`SELECT snapshot_id, image_digest, built_at FROM instabox_base WHERE id=1`).get() as InstaboxBase | null) ?? null;
}
export function setInstaboxBase(db: Database, b: InstaboxBase): void {
  db.query(`INSERT INTO instabox_base (id,snapshot_id,image_digest,built_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id, image_digest=excluded.image_digest, built_at=excluded.built_at`)
    .run(b.snapshot_id, b.image_digest, b.built_at);
}

export function setSessionBranch(db: Database, id: string, branch: string): void {
  db.query(`UPDATE sessions SET branch=? WHERE id=?`).run(branch, id);
}

export function updateSession(db: Database, id: string, patch: Partial<Pick<SessionRow, "status" | "last_active_at">>): void {
  if (patch.status !== undefined) db.query(`UPDATE sessions SET status=? WHERE id=?`).run(patch.status, id);
  if (patch.last_active_at !== undefined) db.query(`UPDATE sessions SET last_active_at=? WHERE id=?`).run(patch.last_active_at, id);
}

export function setImportant(db: Database, id: string, important: 0 | 1): void {
  db.query(`UPDATE sessions SET important=? WHERE id=?`).run(important, id);
}

export function setCritic(db: Database, id: string, critic: 0 | 1): void {
  db.query(`UPDATE sessions SET critic=? WHERE id=?`).run(critic, id);
}

// "Once the agent finishes the turn, end the session." Set by the scheduler after creating
// a scheduled run (scheduler.ts), read by autoEnd.ts. On the session row, not in memory,
// so that a devd restart does not rob an in-progress run of its cleanup.
export function setAutoEnd(db: Database, id: string, autoEnd: 0 | 1): void {
  db.query(`UPDATE sessions SET auto_end=? WHERE id=?`).run(autoEnd, id);
}

export function setSessionAgent(db: Database, id: string, agent: AgentName): void {
  db.query(`UPDATE sessions SET agent=? WHERE id=?`).run(agent, id);
}

// Remembered agent choice for a repo (claudeSolo is remembered under the repo "claudeSolo",
// not under a specific claudeSolo-N). Upsert — one row per repo.
export function setRepoAgent(db: Database, folder: string, project: string, repo: string, agent: AgentName, now: number): void {
  db.query(`INSERT INTO repo_prefs (folder,project,repo,agent,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(folder,project,repo) DO UPDATE SET agent=excluded.agent, updated_at=excluded.updated_at`)
    .run(folder, project, repo, agent, now);
}

export function getRepoAgent(db: Database, folder: string, project: string, repo: string): AgentName | null {
  const row = db.query(`SELECT agent FROM repo_prefs WHERE folder=? AND project=? AND repo=?`)
    .get(folder, project, repo) as { agent: string } | null;
  return row && isAgentName(row.agent) ? row.agent : null;
}

export function listRepoAgents(db: Database): { folder: string; project: string; repo: string; agent: AgentName }[] {
  const rows = db.query(`SELECT folder,project,repo,agent FROM repo_prefs`).all() as
    { folder: string; project: string; repo: string; agent: string }[];
  return rows.filter((r) => isAgentName(r.agent)) as { folder: string; project: string; repo: string; agent: AgentName }[];
}

export interface CriticReviewRow {
  id: number; session_id: string; turn_id: string; round: number;
  verdict: "ok" | "issues" | "error"; findings: string; evidence: string | null;
  ms: number; at: number;
}

export function insertCriticReview(db: Database, r: Omit<CriticReviewRow, "id">): void {
  db.query(`INSERT INTO critic_reviews (session_id,turn_id,round,verdict,findings,evidence,ms,at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(r.session_id, r.turn_id, r.round, r.verdict, r.findings, r.evidence, r.ms, r.at);
}

export function listCriticReviews(db: Database, sessionId: string, limit = 20): CriticReviewRow[] {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return db.query(`SELECT * FROM critic_reviews WHERE session_id=? ORDER BY id DESC LIMIT ?`)
    .all(sessionId, n) as CriticReviewRow[];
}

export function latestCriticReview(db: Database, sessionId: string): CriticReviewRow | null {
  return (db.query(`SELECT * FROM critic_reviews WHERE session_id=? ORDER BY id DESC LIMIT 1`)
    .get(sessionId) as CriticReviewRow | null) ?? null;
}

// Grows with every turn — we trim it the same way as events (called by the stats loop in index.ts).
export function pruneCriticReviews(db: Database, keepMs = 90 * 86_400_000): void {
  db.query(`DELETE FROM critic_reviews WHERE at < ?`).run(Date.now() - keepMs);
}

export function setSessionName(db: Database, id: string, name: string | null): void {
  db.query(`UPDATE sessions SET name=? WHERE id=?`).run(name, id);
}

export function deleteSession(db: Database, id: string): void {
  db.query(`DELETE FROM sessions WHERE id=?`).run(id);
}

export function getSession(db: Database, id: string): SessionRow | null {
  return (db.query(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionRow | null) ?? null;
}

export function listSessions(db: Database): SessionRow[] {
  return db.query(`SELECT * FROM sessions ORDER BY created_at`).all() as SessionRow[];
}

export function logEvent(db: Database, sessionId: string | null, type: string, data?: unknown): void {
  db.query(`INSERT INTO events (ts, session_id, type, data) VALUES (?,?,?,?)`)
    .run(Date.now(), sessionId, type, data === undefined ? null : JSON.stringify(data));
}

export interface EventRow { id: number; ts: number; session_id: string | null; type: string; data: string | null }

export interface EventFilter {
  limit?: number; offset?: number; session?: string;
  /** One type, or several types at once (the dashboard log filters by groups). */
  type?: string; types?: string[];
  from?: number; to?: number;
}

// Conditions are assembled in one place so that listEvents and countEvents cannot
// diverge — otherwise pagination would count from a different set than the one displayed.
function eventWhere(opts: EventFilter): { sql: string; args: (string | number)[] } {
  const where: string[] = []; const args: (string | number)[] = [];
  if (opts.session) { where.push("session_id = ?"); args.push(opts.session); }
  const types = opts.types?.length ? opts.types : opts.type ? [opts.type] : [];
  if (types.length) { where.push(`type IN (${types.map(() => "?").join(",")})`); args.push(...types); }
  if (Number.isFinite(opts.from)) { where.push("ts >= ?"); args.push(opts.from as number); }
  if (Number.isFinite(opts.to)) { where.push("ts < ?"); args.push(opts.to as number); }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

export function listEvents(db: Database, opts: EventFilter = {}): EventRow[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const { sql, args } = eventWhere(opts);
  return db.query(`SELECT id, ts, session_id, type, data FROM events ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as EventRow[];
}

export function countEvents(db: Database, opts: EventFilter = {}): number {
  const { sql, args } = eventWhere(opts);
  return (db.query(`SELECT COUNT(*) AS n FROM events ${sql}`).get(...args) as { n: number }).n;
}

/** Event types that actually occur in the log — they populate the filter in the dashboard,
 *  so the user does not pick from a list of things that never appeared in their data. */
export function distinctEventTypes(db: Database): string[] {
  return (db.query(`SELECT DISTINCT type FROM events ORDER BY type`).all() as { type: string }[]).map((r) => r.type);
}

// events grows without bound (logEvent writes forever); now that the feed is displayed, we trim it
// the same way as disk_stats (called by the periodic stats loop in index.ts).
export function pruneEvents(db: Database, keepMs = 90 * 86_400_000): void {
  db.query(`DELETE FROM events WHERE ts < ?`).run(Date.now() - keepMs);
}

export interface WorkIntervalRow {
  id: number; session_id: string; project: string; repo: string;
  started_at: number; ended_at: number; seconds: number; capped: 0 | 1;
}
export type WorkIntervalInput = Omit<WorkIntervalRow, "id">;

export function insertWorkInterval(db: Database, r: WorkIntervalInput): void {
  db.query(`INSERT INTO work_intervals (session_id, project, repo, started_at, ended_at, seconds, capped)
    VALUES (?,?,?,?,?,?,?)`)
    .run(r.session_id, r.project, r.repo, r.started_at, r.ended_at, r.seconds, r.capped);
}

// Filters by the START of the interval — an interval belongs to the day the work started.
export function listWorkIntervals(db: Database, from: number, to: number, project?: string | null, repo?: string | null): WorkIntervalRow[] {
  const sql = (project ? " AND project=?" : "") + (repo ? " AND repo=?" : "");
  const args = [...(project ? [project] : []), ...(repo ? [repo] : [])];
  return db.query(`SELECT * FROM work_intervals WHERE started_at >= ? AND started_at < ?${sql} ORDER BY started_at`)
    .all(from, to, ...args) as WorkIntervalRow[];
}

export interface AgentLiveStateRow {
  session_id: string; status: string; body: string; reason: string | null;
  started_at: number; updated_at: number; status_since: number;
}

// A single UPSERT, no JOIN or full scan — the write must stay cheap even on the live DB
// (journal_mode=delete, heavy reads block writers). AgentEventHub calls it only
// on a state TRANSITION, not on every hook.
export function upsertAgentLiveState(db: Database, r: AgentLiveStateRow): void {
  db.query(`INSERT INTO agent_live_state (session_id,status,body,reason,started_at,updated_at,status_since)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET status=excluded.status, body=excluded.body, reason=excluded.reason,
      started_at=excluded.started_at, updated_at=excluded.updated_at, status_since=excluded.status_since`)
    .run(r.session_id, r.status, r.body, r.reason, r.started_at, r.updated_at, r.status_since);
}

export function getAgentLiveState(db: Database, sessionId: string): AgentLiveStateRow | null {
  return (db.query(`SELECT * FROM agent_live_state WHERE session_id=?`).get(sessionId) as AgentLiveStateRow | null) ?? null;
}

// Called by the hub when it stops tracking a session (forget/retainRunning) — otherwise the row would
// stay forever even after the session is deleted from `sessions`.
export function deleteAgentLiveState(db: Database, sessionId: string): void {
  db.query(`DELETE FROM agent_live_state WHERE session_id=?`).run(sessionId);
}

export type NotifyDecision = "armed" | "sent" | "deferred" | "suppressed" | "none";
export type NotifyVerdict = "false_positive" | "missing" | "ok";

export interface NotifyLogRow {
  id: number; ts: number; session_id: string; event: string;
  decision: NotifyDecision; reason: string | null;
  inflight: number; teammates: number;
  agent_session_id: string | null; detail: string | null;
  verdict: NotifyVerdict | null; verdict_note: string | null; verdict_at: number | null;
}
export type NotifyLogInput = Omit<NotifyLogRow, "id" | "verdict" | "verdict_note" | "verdict_at">;

export function insertNotifyLog(db: Database, r: NotifyLogInput): void {
  db.query(`INSERT INTO notify_log (ts, session_id, event, decision, reason, inflight, teammates, agent_session_id, detail)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(r.ts, r.session_id, r.event, r.decision, r.reason, r.inflight, r.teammates, r.agent_session_id, r.detail);
}

export function listNotifyLog(
  db: Database,
  opts: { session?: string; verdict?: NotifyVerdict | "flagged"; decision?: NotifyDecision; limit?: number } = {},
): NotifyLogRow[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const where: string[] = []; const args: (string | number)[] = [];
  if (opts.session) { where.push("session_id = ?"); args.push(opts.session); }
  if (opts.decision) { where.push("decision = ?"); args.push(opts.decision); }
  if (opts.verdict === "flagged") where.push("verdict IS NOT NULL");
  else if (opts.verdict) { where.push("verdict = ?"); args.push(opts.verdict); }
  const sql = `SELECT * FROM notify_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return db.query(sql).all(...args, limit) as NotifyLogRow[];
}

// Returns false for an unknown id so the API can respond 404 instead of a silent OK.
export function setNotifyVerdict(
  db: Database, id: number, verdict: NotifyVerdict | null, note: string | null, now = Date.now(),
): boolean {
  const exists = db.query(`SELECT id FROM notify_log WHERE id=?`).get(id);
  if (!exists) return false;
  db.query(`UPDATE notify_log SET verdict=?, verdict_note=?, verdict_at=? WHERE id=?`)
    .run(verdict, verdict === null ? null : note, verdict === null ? null : now, id);
  return true;
}

// Grows with every turn — we trim it the same way as events (called by the stats loop in index.ts).
export function pruneNotifyLog(db: Database, keepMs = 14 * 86_400_000): void {
  db.query(`DELETE FROM notify_log WHERE ts < ?`).run(Date.now() - keepMs);
}

export interface MetricRow { ts: number; session_id: string | null; name: string; value: number; attrs: string }

export function insertMetrics(db: Database, rows: MetricRow[]): void {
  // The attribute columns are computed by SQLite from the same expressions the migration uses —
  // so the logic does not fork into JS and start diverging from the old rows.
  const stmt = db.query(
    `INSERT INTO metrics (ts, session_id, name, value, attrs, ${ATTR_COLUMNS.join(", ")}) ` +
    `VALUES (?1,?2,?3,?4,?5, ${attrExprs("?5").join(", ")})`
  );
  const tx = db.transaction((rs: MetricRow[]) => { for (const r of rs) stmt.run(r.ts, r.session_id, r.name, r.value, r.attrs); });
  tx(rows);
}

/** State of the usage harvesters (offset in the grok log, codex rollout cumulatives, sid map).
 *  One generic table, JSON per source — three custom tables would be YAGNI. */
export function getHarvestState<T>(db: Database, source: string): T | null {
  const r = db.query(`SELECT state FROM harvest_state WHERE source = ?`).get(source) as { state: string } | null;
  if (!r) return null;
  try { return JSON.parse(r.state) as T; } catch { return null; }
}
export function setHarvestState(db: Database, source: string, state: unknown): void {
  db.query(`INSERT INTO harvest_state (source, state, updated_at) VALUES (?,?,?)
    ON CONFLICT(source) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(source, JSON.stringify(state), Date.now());
}

export function upsertGitStat(db: Database, sessionId: string, s: { commits: number; added: number; removed: number; unpushed: number }): void {
  db.query(`INSERT INTO git_stats (session_id, ts, commits, added, removed, unpushed) VALUES (?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET ts=excluded.ts, commits=excluded.commits, added=excluded.added, removed=excluded.removed, unpushed=excluded.unpushed`)
    .run(sessionId, Date.now(), s.commits, s.added, s.removed, s.unpushed);
}
export function insertDiskTotal(db: Database, bytes: number): void {
  db.query(`INSERT INTO disk_stats (ts, bytes) VALUES (?,?)`).run(Date.now(), bytes);
}
export function pruneDiskStats(db: Database, keepMs = 90 * 86_400_000): void {
  db.query(`DELETE FROM disk_stats WHERE ts < ?`).run(Date.now() - keepMs);
}
/** Sum from `sinceTs` onward: whole hours from the rollup, only the truncated first hour from
 *  raw rows (e.g. the rolling 30 days in buildTotals). /api/stats/totals asks
 *  every 5 s and over the raw table that was 4 index passes (~20 ms). */
export function queryMetricSum(db: Database, name: string, sinceTs: number): number {
  const h = Math.ceil(sinceTs / HOUR_MS);
  const rolled = (db.query(`SELECT COALESCE(SUM(sum),0) v FROM metrics_hourly WHERE name=? AND hour>=?`).get(name, h) as { v: number }).v;
  if (h * HOUR_MS === sinceTs) return rolled;
  return rolled + (db.query(`SELECT COALESCE(SUM(value),0) v FROM metrics WHERE name=? AND ts>=? AND ts<?`)
    .get(name, sinceTs, h * HOUR_MS) as { v: number }).v;
}
/** Optional exact project/repository filters. Values always remain bound SQL
 * parameters; absent dimensions never join live sessions or guess ownership. */
function projectFilter(project?: string | null, repo?: string | null): { sql: string; args: string[] } {
  return { sql: (project ? " AND a_project=?" : "") + (repo ? " AND a_repo=?" : ""),
    args: [...(project ? [project] : []), ...(repo ? [repo] : [])] };
}

/** Paths that have their own column (see ATTR_COLUMNS). An unknown path falls back to
 *  json_extract — slow but correct; a silently wrong result would be worse. */
const ATTR_PATH_COLUMN: Record<string, string> = {
  "$.project": "a_project",
  "$.model": "a_model",
  '$."devbox.host"': "a_host",
  '$."user.account_uuid"': "a_account",
};

export function metricSumBetween(db: Database, name: string, from: number, to: number, project?: string | null, repo?: string | null): number {
  const f = projectFilter(project, repo);
  const row = db.query("SELECT COALESCE(SUM(value),0) AS s FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql)
    .get(name, from, to, ...f.args) as { s: number };
  return row.s;
}

export function metricDailySeries(db: Database, name: string, from: number, to: number, project?: string | null, repo?: string | null): { bucket: number; sum: number }[] {
  const f = projectFilter(project, repo);
  const rows = db.query(
    "SELECT ((ts - ?)/86400000) AS bucket, COALESCE(SUM(value),0) AS sum FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql +
    " GROUP BY bucket ORDER BY bucket"
  ).all(from, name, from, to, ...f.args) as { bucket: number; sum: number }[];
  return rows;
}

export function metricByAttr(db: Database, name: string, attrPath: string, from: number, to: number, project?: string | null, repo?: string | null): { key: string; sum: number }[] {
  const f = projectFilter(project, repo);
  const col = ATTR_PATH_COLUMN[attrPath];
  if (!col) {
    return db.query(
      "SELECT COALESCE(json_extract(attrs, ?), '—') AS key, COALESCE(SUM(value),0) AS sum FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql +
      " GROUP BY key ORDER BY sum DESC"
    ).all(attrPath, name, from, to, ...f.args) as { key: string; sum: number }[];
  }
  return db.query(
    `SELECT COALESCE(${col}, '—') AS key, COALESCE(SUM(value),0) AS sum FROM metrics WHERE name=? AND ts>=? AND ts<?` + f.sql +
    " GROUP BY key ORDER BY sum DESC"
  ).all(name, from, to, ...f.args) as { key: string; sum: number }[];
}

/** Daily series broken down by attribute — `metricDailySeries` × `metricByAttr` in one
 *  query. `bucket` is the day index from `from`, same as in metricDailySeries.
 *  CAUTION with parameter order: attrPath and from are in the SELECT, i.e. before name. */
export function metricDailyByAttr(
  db: Database, name: string, attrPath: string, from: number, to: number, project?: string | null, repo?: string | null,
): { key: string; bucket: number; sum: number }[] {
  const f = projectFilter(project, repo);
  const col = ATTR_PATH_COLUMN[attrPath];
  if (!col) {
    return db.query(
      "SELECT COALESCE(json_extract(attrs, ?), '—') AS key, ((ts - ?)/86400000) AS bucket, " +
      "COALESCE(SUM(value),0) AS sum FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql + " " +
      "GROUP BY key, bucket ORDER BY bucket"
    ).all(attrPath, from, name, from, to, ...f.args) as { key: string; bucket: number; sum: number }[];
  }
  return db.query(
    `SELECT COALESCE(${col}, '—') AS key, ((ts - ?)/86400000) AS bucket, ` +
    "COALESCE(SUM(value),0) AS sum FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql + " " +
    "GROUP BY key, bucket ORDER BY bucket"
  ).all(from, name, from, to, ...f.args) as { key: string; bucket: number; sum: number }[];
}

/** Histogram by hour of day (0–23) in LOCAL time — "when do I actually work".
 *  UTC would shift the peak by an hour or two for us and the chart would lie. */
export function metricHourly(db: Database, name: string, from: number, to: number, project?: string | null, repo?: string | null): { hour: number; sum: number }[] {
  const f = projectFilter(project, repo);
  const rows = db.query(
    "SELECT CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour, COALESCE(SUM(value),0) AS sum " +
    "FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql + " GROUP BY hour ORDER BY hour"
  ).all(name, from, to, ...f.args) as { hour: number; sum: number }[];
  return rows;
}

/** Raw metric values — quantiles are computed in JS (see aggregate.quantiles),
 *  so they can be tested without a DB. Volume is on the order of thousands of rows per month, not millions. */
export function metricValues(db: Database, name: string, from: number, to: number, project?: string | null, repo?: string | null): number[] {
  const f = projectFilter(project, repo);
  const rows = db.query("SELECT value FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql + " ORDER BY value")
    .all(name, from, to, ...f.args) as { value: number }[];
  return rows.map((r) => r.value);
}

/** Metric sum per repository. The expression the repo is built from, including the reasoning
 *  why it MUST NOT be joined on `sessions`, is at `attrExprs` — here we only read the
 *  ready-made `a_repo` column. Rows without a repo fall under '—'. */
export function metricByRepo(db: Database, name: string, from: number, to: number, project?: string | null, repo?: string | null): { repo: string; sum: number }[] {
  const f = projectFilter(project, repo);
  const rows = db.query(
    "SELECT COALESCE(a_repo, '—') AS repo, COALESCE(SUM(value),0) AS sum " +
    "FROM metrics WHERE name=? AND ts>=? AND ts<?" + f.sql + " GROUP BY repo ORDER BY sum DESC"
  ).all(name, from, to, ...f.args) as { repo: string; sum: number }[];
  return rows;
}

/** Cost and tokens per session since `sinceTs` — for the session card in the dashboard. */
export function usageBySession(db: Database, costName: string, tokenName: string, sinceTs: number): Record<string, { cost: number; tokens: number }> {
  const rows = db.query(
    "SELECT session_id AS id, name, COALESCE(SUM(value),0) AS sum FROM metrics " +
    "WHERE session_id IS NOT NULL AND name IN (?,?) AND ts>=? GROUP BY session_id, name"
  ).all(costName, tokenName, sinceTs) as { id: string; name: string; sum: number }[];
  const out: Record<string, { cost: number; tokens: number }> = {};
  for (const r of rows) {
    const e = out[r.id] ?? { cost: 0, tokens: 0 };
    if (r.name === costName) e.cost = r.sum; else e.tokens = r.sum;
    out[r.id] = e;
  }
  return out;
}

export function lastMetricTs(db: Database, sessionId: string): number | null {
  const r = db.query(`SELECT MAX(ts) t FROM metrics WHERE session_id=?`).get(sessionId) as { t: number | null };
  return r.t ?? null;
}
export function deleteGitStat(db: Database, sessionId: string): void {
  db.query(`DELETE FROM git_stats WHERE session_id=?`).run(sessionId);
}
export function totalUnpushed(db: Database): number {
  return (db.query(`SELECT COALESCE(SUM(unpushed),0) v FROM git_stats`).get() as { v: number }).v;
}
export function totalCommitsToday(db: Database): number {
  return (db.query(`SELECT COALESCE(SUM(commits),0) v FROM git_stats`).get() as { v: number }).v;
}
/** Metric sum per project since `sinceTs`. It used to fetch `attrs` and parse the
 *  JSON in JS, i.e. read the fat rows — and the dashboard asks for `/api/stats/projects`
 *  every 5 s. Via `a_project` it reads only the covering index.
 *  The "?" bucket (row without a project, typically a Mac session) must stay "?", not "—":
 *  the leaderboard displays it that way and the Stats breakdowns use a different character. */
function sumByProject(db: Database, name: string, sinceTs: number): Record<string, number> {
  // Same split as queryMetricSum: whole hours from the rollup, truncated start from raw rows.
  const h = Math.ceil(sinceTs / HOUR_MS);
  const rows = db.query(
    "SELECT COALESCE(a_project, '?') AS p, COALESCE(SUM(sum),0) AS s FROM metrics_hourly WHERE name=? AND hour>=? GROUP BY p"
  ).all(name, h) as { p: string; s: number }[];
  if (h * HOUR_MS > sinceTs) {
    rows.push(...db.query(
      "SELECT COALESCE(a_project, '?') AS p, COALESCE(SUM(value),0) AS s FROM metrics WHERE name=? AND ts>=? AND ts<? GROUP BY p"
    ).all(name, sinceTs, h * HOUR_MS) as { p: string; s: number }[]);
  }
  const out: Record<string, number> = {};
  for (const r of rows) out[r.p] = (out[r.p] ?? 0) + r.s;
  return out;
}
export function costByProject(db: Database, sinceTs: number): Record<string, number> {
  return sumByProject(db, "claude_code.cost.usage", sinceTs);
}
export function tokensByProject(db: Database, sinceTs: number): Record<string, number> {
  return sumByProject(db, "claude_code.token.usage", sinceTs);
}
export function diskHistory(db: Database): { ts: number; bytes: number }[] {
  return db.query(`SELECT ts, bytes FROM disk_stats ORDER BY ts`).all() as { ts: number; bytes: number }[];
}
/** Only the first and last sample of the disk history — `predictDisk` and "used"
 *  in liveStats read nothing more from it. The whole `diskHistory` (64 k rows live) used to be
 *  fetched on every /api/stats/live and /api/stats/disk, i.e. 2× per 5 s for every open
 *  dashboard tab, and cost ~15 ms of blocked thread each time. */
export function diskHistoryEnds(db: Database): { ts: number; bytes: number }[] {
  const first = db.query(`SELECT id, ts, bytes FROM disk_stats ORDER BY ts, id LIMIT 1`).get() as { id: number; ts: number; bytes: number } | null;
  if (!first) return [];
  const last = db.query(`SELECT id, ts, bytes FROM disk_stats ORDER BY ts DESC, id DESC LIMIT 1`).get() as { id: number; ts: number; bytes: number };
  return (first.id === last.id ? [first] : [first, last]).map(({ ts, bytes }) => ({ ts, bytes }));
}

// Wipes the work statistics shown on the dashboard — cost/token/impression metrics
// and per-session git counters. Leaves sessions, disk history and clone jobs intact.
export function resetStats(db: Database): void {
  // Without triggers: a DELETE of the whole table would otherwise update the rollup for each of
  // the millions of rows. The rollup is emptied directly and the triggers return in the same transaction.
  db.transaction(() => {
    dropHourlyTriggers(db);
    db.run("DELETE FROM metrics");
    db.run("DELETE FROM metrics_hourly");
    createHourlyTriggers(db);
  })();
  db.run("DELETE FROM git_stats");
}

// Recovers clone_jobs orphaned by a devd restart: in-memory CloneQueue state (and thus
// the running loop) is lost on restart, but a persisted "running" row would otherwise
// poll forever (CLI/dashboard both loop `while status==="running"` with no timeout).
export function failRunningCloneJobs(db: Database): void {
  const rows = db.query(`SELECT id, results FROM clone_jobs WHERE status='running'`).all() as { id: string; results: string }[];
  if (rows.length === 0) return;
  const interrupted = { repo: "(interrupted)", ok: false, error: "interrupted by a devd restart" };
  const stmt = db.query(`UPDATE clone_jobs SET status='error', results=? WHERE id=?`);
  for (const r of rows) {
    let results: unknown[];
    try { results = JSON.parse(r.results); } catch { results = []; }
    if (!Array.isArray(results)) results = [];
    results.push(interrupted);
    stmt.run(JSON.stringify(results), r.id);
  }
}

export interface ScheduleRow {
  id: string; name: string; cron: string; folder: string; project: string; repo: string;
  clone_url: string; prompt: string; important: 0 | 1; enabled: 0 | 1; last_run_at: number | null;
}

export function insertSchedule(db: Database, r: ScheduleRow): void {
  db.query(`INSERT INTO schedules (id,name,cron,folder,project,repo,clone_url,prompt,important,enabled,last_run_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.name, r.cron, r.folder, r.project, r.repo, r.clone_url, r.prompt, r.important, r.enabled, r.last_run_at);
}
export function listSchedules(db: Database): ScheduleRow[] {
  return db.query(`SELECT * FROM schedules ORDER BY name`).all() as ScheduleRow[];
}
export function getSchedule(db: Database, id: string): ScheduleRow | null {
  return (db.query(`SELECT * FROM schedules WHERE id=?`).get(id) as ScheduleRow | null) ?? null;
}
export function updateSchedule(db: Database, id: string, patch: Partial<Omit<ScheduleRow, "id">>): void {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const set = cols.map((c) => `${c}=?`).join(", ");
  const args: (string | number | null)[] = [...cols.map((c) => (patch as Record<string, string | number | null>)[c]), id];
  db.query(`UPDATE schedules SET ${set} WHERE id=?`).run(...args);
}
export function setScheduleLastRun(db: Database, id: string, ts: number): void {
  db.query(`UPDATE schedules SET last_run_at=? WHERE id=?`).run(ts, id);
}
export function deleteSchedule(db: Database, id: string): void {
  db.query(`DELETE FROM schedules WHERE id=?`).run(id);
}

export interface AnthropicAccountRow {
  id: string; label: string; disabled: 0 | 1; quarantined_at: number | null; added_at: number;
  // Plan multiplier derived from `rateLimitTier` (accountTokens.parseTierWeight), e.g. 5
  // or 20. NULL = unknown/unparseable — in that case accountPolicy falls back
  // to the unweighted policy (see accountPolicy.ts). Optional only because of insert literals
  // (same pattern as SessionRow.name/critic/agent above) — the DB column is always
  // defined (a number or NULL), never undefined.
  weight?: number | null;
  // Organization the account belonged to when it was added (or when its credentials were
  // last replaced) — read from `claude auth status` in the profile. The poller
  // compares it with what the API reports on measurement; a difference means the profile has
  // meanwhile logged in somewhere else. NULL = not determined yet (old row), see `setAccountOrgId`.
  org_id?: string | null;
}

export interface AccountUsageRow {
  account_id: string;
  five_hour_pct: number | null; five_hour_resets_at: number | null;
  seven_day_pct: number | null; seven_day_resets_at: number | null;
  limits_json: string | null;
  fetched_at: number;
  error: string | null;
  // Organization from the last SUCCESSFUL response (header `anthropic-organization-id`).
  // An error does not overwrite it — like the percentages, the last known value is kept.
  org_id?: string | null;
  // Which consecutive error this is (0 = the last measurement succeeded). Drives the backoff length
  // in accountPoller.pollDue — the first failure is retried in a few tens of seconds, only
  // repeated ones are throttled to today's 20 minutes. Optional only because of literals that
  // create the row (same reason as `SessionRow.critic`/`agent` above); a row
  // read from the DB always carries it, the column is NOT NULL DEFAULT 0.
  error_count?: number;
}

export function insertAccount(db: Database, r: AnthropicAccountRow): void {
  db.query(`INSERT INTO anthropic_accounts (id,label,disabled,quarantined_at,added_at,weight,org_id) VALUES (?,?,?,?,?,?,?)`)
    .run(r.id, r.label, r.disabled, r.quarantined_at, r.added_at, r.weight ?? null, r.org_id ?? null);
}

export function listAccounts(db: Database): AnthropicAccountRow[] {
  return db.query(`SELECT * FROM anthropic_accounts ORDER BY added_at, id`).all() as AnthropicAccountRow[];
}

export function getAccount(db: Database, id: string): AnthropicAccountRow | null {
  return (db.query(`SELECT * FROM anthropic_accounts WHERE id=?`).get(id) as AnthropicAccountRow | null) ?? null;
}

export function setAccountDisabled(db: Database, id: string, disabled: 0 | 1): void {
  db.query(`UPDATE anthropic_accounts SET disabled=? WHERE id=?`).run(disabled, id);
}

// `at = null` = release from quarantine (after a new login into the profile).
export function setAccountQuarantined(db: Database, id: string, at: number | null): void {
  db.query(`UPDATE anthropic_accounts SET quarantined_at=? WHERE id=?`).run(at, id);
}

// Called by the poller after EVERY successful read of the profile (accountPoller.ts) — a plan
// upgrade/downgrade thus takes effect without manually re-adding the account.
export function setAccountWeight(db: Database, id: string, weight: number | null): void {
  db.query(`UPDATE anthropic_accounts SET weight=? WHERE id=?`).run(weight, id);
}

/** Writes the account's REGISTERED organization — the one against which a switched
 *  profile is later detected. Called when the account is added and when credentials are replaced, i.e.
 *  whenever someone CONSCIOUSLY determined the identity. The poller may only fill it in when missing
 *  (old row), never overwrite it: self-overwriting would turn "the profile is elsewhere" into "it was always so". */
export function setAccountOrgId(db: Database, id: string, orgId: string | null): void {
  db.query(`UPDATE anthropic_accounts SET org_id=? WHERE id=?`).run(orgId, id);
}

export function setAccountLabel(db: Database, id: string, label: string): void {
  db.query(`UPDATE anthropic_accounts SET label=? WHERE id=?`).run(label, id);
}

// Also deletes the measured data and lease history — otherwise deleting an account would leave orphans
// that buildAccountViews would never pair with any account.
export function deleteAccount(db: Database, id: string): void {
  db.query(`DELETE FROM account_usage WHERE account_id=?`).run(id);
  db.query(`DELETE FROM account_leases WHERE account_id=?`).run(id);
  db.query(`DELETE FROM anthropic_accounts WHERE id=?`).run(id);
}

export function upsertAccountUsage(db: Database, r: AccountUsageRow): void {
  db.query(`INSERT INTO account_usage
      (account_id,five_hour_pct,five_hour_resets_at,seven_day_pct,seven_day_resets_at,limits_json,fetched_at,error,error_count,org_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET
      five_hour_pct=excluded.five_hour_pct, five_hour_resets_at=excluded.five_hour_resets_at,
      seven_day_pct=excluded.seven_day_pct, seven_day_resets_at=excluded.seven_day_resets_at,
      limits_json=excluded.limits_json, fetched_at=excluded.fetched_at, error=excluded.error,
      error_count=excluded.error_count, org_id=excluded.org_id`)
    .run(r.account_id, r.five_hour_pct, r.five_hour_resets_at, r.seven_day_pct, r.seven_day_resets_at,
         r.limits_json, r.fetched_at, r.error, r.error_count ?? 0, r.org_id ?? null);
}

export function getAccountUsage(db: Database, id: string): AccountUsageRow | null {
  return (db.query(`SELECT * FROM account_usage WHERE account_id=?`).get(id) as AccountUsageRow | null) ?? null;
}

export function listAccountUsage(db: Database): AccountUsageRow[] {
  return db.query(`SELECT * FROM account_usage`).all() as AccountUsageRow[];
}

export interface CodexUsageRow {
  singleton: 1;
  state: "ok" | "signed-out" | "stale-login" | "error";
  plan_type: string | null;
  windows_json: string;
  credits_json: string | null;
  limit_reached: string | null;
  endpoint_idx: number | null;
  fetched_at: number;
  error: string | null;
}

export function upsertCodexUsage(db: Database, r: CodexUsageRow): void {
  db.query(`INSERT INTO codex_usage
      (singleton,state,plan_type,windows_json,credits_json,limit_reached,endpoint_idx,fetched_at,error)
      VALUES (1,?,?,?,?,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET
      state=excluded.state, plan_type=excluded.plan_type, windows_json=excluded.windows_json,
      credits_json=excluded.credits_json, limit_reached=excluded.limit_reached,
      endpoint_idx=excluded.endpoint_idx, fetched_at=excluded.fetched_at, error=excluded.error`)
    .run(r.state, r.plan_type, r.windows_json, r.credits_json, r.limit_reached,
         r.endpoint_idx, r.fetched_at, r.error);
}

export function getCodexUsage(db: Database): CodexUsageRow | null {
  return (db.query(`SELECT * FROM codex_usage WHERE singleton=1`).get() as CodexUsageRow | null) ?? null;
}

export interface GrokUsageRow {
  singleton: 1;
  state: "ok" | "signed-out" | "stale-login" | "error";
  tier: string | null;
  used_pct: number | null;
  resets_at: number | null;
  fetched_at: number;
  error: string | null;
}

export function upsertGrokUsage(db: Database, r: GrokUsageRow): void {
  db.query(`INSERT INTO grok_usage (singleton,state,tier,used_pct,resets_at,fetched_at,error)
      VALUES (1,?,?,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET
      state=excluded.state, tier=excluded.tier, used_pct=excluded.used_pct,
      resets_at=excluded.resets_at, fetched_at=excluded.fetched_at, error=excluded.error`)
    .run(r.state, r.tier, r.used_pct, r.resets_at, r.fetched_at, r.error);
}

export function getGrokUsage(db: Database): GrokUsageRow | null {
  return (db.query(`SELECT * FROM grok_usage WHERE singleton=1`).get() as GrokUsageRow | null) ?? null;
}

// Lease client: 'devbox' = session in a container (has a session_id), 'mac' = shim on the mac
// (session_id NULL — mac sessions have no devd session row).
export type LeaseClient = "mac" | "devbox";
export function isLeaseClient(v: unknown): v is LeaseClient {
  return v === "mac" || v === "devbox";
}

export interface AccountLeaseRow {
  id: number; account_id: string; client: LeaseClient;
  session_id: string | null; label: string | null;
  created_at: number; released_at: number | null;
}

export function insertLease(db: Database, r: Omit<AccountLeaseRow, "id">): number {
  const res = db.query(`INSERT INTO account_leases (account_id,client,session_id,label,created_at,released_at)
    VALUES (?,?,?,?,?,?) RETURNING id`)
    .get(r.account_id, r.client, r.session_id, r.label, r.created_at, r.released_at) as { id: number };
  return res.id;
}

export function releaseLease(db: Database, id: number, at: number): void {
  db.query(`UPDATE account_leases SET released_at=? WHERE id=? AND released_at IS NULL`).run(at, id);
}

export function releaseLeasesForSession(db: Database, sessionId: string, at: number): void {
  db.query(`UPDATE account_leases SET released_at=? WHERE session_id=? AND released_at IS NULL`).run(at, sessionId);
}

// An unreleased lease older than maxAgeMs counts as ABANDONED: the mac shim does not report
// process exit, so without this deadline the account would look occupied forever and the poller would
// poll it at the fast cadence forever.
// Which leases count as "someone is running on this account right now". Decided in TWO
// different ways depending on the client, because we know something different about each:
//
//   devbox — the lease carries `session_id` and devd KNOWS the state of that session, so it asks
//     it directly (`status = 'running'`). Lease age is worthless here: a session running
//     continuously for longer than `maxAgeMs` (= `autoStopHours`, i.e. 4 h — exactly the
//     population the pool exists for, because quota runs out only after hours of
//     operation) would drop out of the time window, the account would look idle and the
//     poller would fall into the quiet cadence for it. Measured in production 2026-07-31:
//     four sessions ran 22–26 h on max20 and the dashboard reported `lease=0` for both
//     accounts. A missing row in `sessions` (deleted session) = inactive.
//
//   mac — `session_id` is NULL and the shim reports no state, so the time window
//     remains the only available signal. There it is a legitimate estimate, not a substitute
//     for records.
//
// `maxAgeMs` is therefore NOT a dead parameter, it just now applies exclusively to mac leases.
export function activeLeases(db: Database, now: number, maxAgeMs: number): AccountLeaseRow[] {
  return db.query(`
    SELECT l.* FROM account_leases l
    LEFT JOIN sessions s ON s.id = l.session_id
    WHERE l.released_at IS NULL
      AND (CASE WHEN l.session_id IS NULL
                THEN l.created_at >= ?
                ELSE s.status = 'running' END)
    ORDER BY l.id`)
    .all(now - maxAgeMs) as AccountLeaseRow[];
}

// History for the policy (hysteresis and cooldown need to know what the client runs on
// and since when). `session_id IS NULL` must be tested separately in SQL — `= NULL` never matches.
export function leaseHistory(db: Database, client: LeaseClient, sessionId: string | null, limit = 20): AccountLeaseRow[] {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const sql = sessionId === null
    ? `SELECT * FROM account_leases WHERE client=? AND session_id IS NULL ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM account_leases WHERE client=? AND session_id=? ORDER BY id DESC LIMIT ?`;
  const args: (string | number)[] = sessionId === null ? [client, n] : [client, sessionId, n];
  return db.query(sql).all(...args) as AccountLeaseRow[];
}

// account_leases grows by a few rows at every session start and is never
// cleaned up (same problem as events/critic_reviews/disk_stats — called by the same
// periodic stats loop in index.ts). DIFFERENCE from those: an unreleased lease
// (`released_at IS NULL`) MUST NOT be deleted regardless of the age of `created_at` — it is
// still active (activeLeases) and deleting it would rob leaseHistory/lastSwitchAt
// of the record of which account the session is really on. Pruning therefore goes
// by `released_at` (when it was CLOSED), not by `created_at` (when it was CREATED), and
// only rows that are closed at all.
export function pruneAccountLeases(db: Database, keepMs = 90 * 86_400_000): void {
  db.query(`DELETE FROM account_leases WHERE released_at IS NOT NULL AND released_at < ?`).run(Date.now() - keepMs);
}

export interface PushDeviceRow {
  token: string; platform: string; name: string | null;
  registered_at: number; last_seen_at: number;
}

export function upsertPushDevice(db: Database, r: { token: string; platform: string; name?: string | null }): void {
  const now = Date.now();
  db.query(`INSERT INTO push_devices (token, platform, name, registered_at, last_seen_at) VALUES (?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET platform=excluded.platform, name=excluded.name, last_seen_at=excluded.last_seen_at`)
    .run(r.token, r.platform, r.name ?? null, now, now);
}

export function listPushDevices(db: Database): PushDeviceRow[] {
  return db.query(`SELECT * FROM push_devices`).all() as PushDeviceRow[];
}

export function deletePushDevice(db: Database, token: string): void {
  db.query(`DELETE FROM push_devices WHERE token=?`).run(token);
}

export interface PushAlertRow {
  alert_id: string; title: string; message: string;
  session_id: string | null; created_at: number; last_sent_at: number;
  acked_at: number | null;
}

export function insertPushAlert(db: Database, r: { alert_id: string; title: string; message: string; session_id: string | null }): void {
  const now = Date.now();
  db.query(`INSERT INTO push_alerts (alert_id, title, message, session_id, created_at, last_sent_at, acked_at) VALUES (?,?,?,?,?,?,?)`)
    .run(r.alert_id, r.title, r.message, r.session_id, now, now, null);
}

export function getPushAlert(db: Database, alertId: string): PushAlertRow | null {
  return (db.query(`SELECT * FROM push_alerts WHERE alert_id=?`).get(alertId) as PushAlertRow | null) ?? null;
}

export function ackPushAlert(db: Database, alertId: string, ts: number): boolean {
  const existing = getPushAlert(db, alertId);
  if (!existing || existing.acked_at !== null) return false;
  db.query(`UPDATE push_alerts SET acked_at=? WHERE alert_id=?`).run(ts, alertId);
  return true;
}

export function listOpenPushAlerts(db: Database, now: number): PushAlertRow[] {
  // Neacked AND created_at > now - 600_000 (10 min okno)
  return db.query(`SELECT * FROM push_alerts WHERE acked_at IS NULL AND created_at > ?`)
    .all(now - 600_000) as PushAlertRow[];
}

export function touchPushAlert(db: Database, alertId: string, ts: number): void {
  db.query(`UPDATE push_alerts SET last_sent_at=? WHERE alert_id=?`).run(ts, alertId);
}

// There are few alerts (only emergency notifications, not every push) — we trim anyway,
// same convention as notify_log/events (called by the stats loop in index.ts). A shorter
// window than for those (7 days): 10 min after creation an alert is dead regardless of ack
// (listOpenPushAlerts stops sending it), a longer history has no diagnostic
// value here.
export function prunePushAlerts(db: Database, keepMs = 7 * 86_400_000): void {
  db.query(`DELETE FROM push_alerts WHERE created_at < ?`).run(Date.now() - keepMs);
}
