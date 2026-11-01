import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteGitStat, deleteSession, failRunningCloneJobs, getSession, insertSession, insertMetrics,
  listSessions, logEvent, migrateDiskStats, migrateScheduleImportance, openDb, sanitizeSessionName, setSessionName,
  updateSession, upsertGitStat,
  deleteSchedule, getSchedule, insertSchedule, listSchedules, setScheduleLastRun, updateSchedule, type ScheduleRow,
  listEvents, pruneEvents, migrateMetricsIndex, migrateMetricsSessionIndex, migrateMetricsAttrColumns,
  insertCriticReview, latestCriticReview, listCriticReviews, pruneCriticReviews, setCritic, type CriticReviewRow,
  getRepoAgent, isAgentName, listRepoAgents, setRepoAgent, setSessionAgent,
  setAutoEnd,
  setSessionInstabox, getInstaboxBase, setInstaboxBase,
  deleteAgentLiveState, getAgentLiveState, upsertAgentLiveState,
} from "../src/db";

const row = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms",
  container: "dev-shop-cms", port_base: 40100, status: "running" as const,
  solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const,
};

test("session CRUD", () => {
  const db = openDb(":memory:");
  insertSession(db, row);
  expect(getSession(db, "dev-shop-cms")?.port_base).toBe(40100);
  updateSession(db, "dev-shop-cms", { status: "stopped", last_active_at: 9 });
  expect(getSession(db, "dev-shop-cms")).toMatchObject({ status: "stopped", last_active_at: 9 });
  expect(listSessions(db)).toHaveLength(1);
  logEvent(db, "dev-shop-cms", "stop");
  deleteSession(db, "dev-shop-cms");
  expect(getSession(db, "dev-shop-cms")).toBeNull();
});

test("setSessionName persists the display name and clears it with null", () => {
  const db = openDb(":memory:");
  insertSession(db, row);
  expect(getSession(db, "dev-shop-cms")?.name ?? null).toBeNull(); // default: no name
  setSessionName(db, "dev-shop-cms", "openclaw izolace");
  expect(getSession(db, "dev-shop-cms")?.name).toBe("openclaw izolace");
  setSessionName(db, "dev-shop-cms", null);
  expect(getSession(db, "dev-shop-cms")?.name ?? null).toBeNull();
});

test("sanitizeSessionName: trim, collapse whitespace, clamp 60, empty→null", () => {
  expect(sanitizeSessionName("  Hello  ")).toBe("Hello");
  expect(sanitizeSessionName("a\nb\tc")).toBe("a b c");
  expect(sanitizeSessionName("")).toBeNull();
  expect(sanitizeSessionName("   ")).toBeNull();
  expect(sanitizeSessionName(undefined)).toBeNull();
  expect(sanitizeSessionName("x".repeat(100))?.length).toBe(60);
});

test("port_base must be unique across sessions", () => {
  const db = openDb(":memory:");
  insertSession(db, row);
  const other = { ...row, id: "dev-shop-other", repo: "other", container: "dev-shop-other" };
  expect(() => insertSession(db, other)).toThrow();
});

test("metrics table insert and query", () => {
  const db = openDb(":memory:");
  insertMetrics(db, [{ ts: 1, session_id: "s", name: "n", value: 2, attrs: "{}" }]);
  expect((db.query("SELECT value FROM metrics WHERE name='n'").get() as { value: number }).value).toBe(2);
});

// A session's git_stats row must not linger after end() — otherwise
// totalCommitsToday/totalUnpushed keep summing rows for sessions that no longer exist.
test("deleteGitStat removes the row for an ended session", () => {
  const db = openDb(":memory:");
  upsertGitStat(db, "dev-shop-cms", { commits: 4, added: 10, removed: 2, unpushed: 3 });
  expect(db.query("SELECT * FROM git_stats WHERE session_id=?").get("dev-shop-cms")).not.toBeNull();
  deleteGitStat(db, "dev-shop-cms");
  expect(db.query("SELECT * FROM git_stats WHERE session_id=?").get("dev-shop-cms")).toBeNull();
});

// A devd restart drops in-memory CloneQueue state but leaves persisted "running"
// clone_jobs rows behind; without finalizing them, CLI/dashboard pollers (which loop
// while status==="running" with no timeout) would hang forever.
test("failRunningCloneJobs finalizes orphaned running jobs as error", () => {
  const db = openDb(":memory:");
  db.query(`INSERT INTO clone_jobs (id, ts, scope, status, total, done, results) VALUES (?,?,?,?,?,?,?)`)
    .run("job-1", Date.now(), JSON.stringify({ kind: "all" }), "running", 3, 1, JSON.stringify([{ repo: "cms", ok: true }]));
  db.query(`INSERT INTO clone_jobs (id, ts, scope, status, total, done, results) VALUES (?,?,?,?,?,?,?)`)
    .run("job-2", Date.now(), JSON.stringify({ kind: "all" }), "done", 1, 1, JSON.stringify([{ repo: "web", ok: true }]));
  failRunningCloneJobs(db);
  const j1 = db.query("SELECT * FROM clone_jobs WHERE id=?").get("job-1") as { status: string; results: string };
  expect(j1.status).toBe("error");
  const results = JSON.parse(j1.results) as { repo: string; ok: boolean }[];
  expect(results).toContainEqual({ repo: "cms", ok: true }); // prior progress preserved
  expect(results.some((r) => r.repo === "(interrupted)" && r.ok === false)).toBe(true);
  const j2 = db.query("SELECT * FROM clone_jobs WHERE id=?").get("job-2") as { status: string };
  expect(j2.status).toBe("done"); // untouched: wasn't running
});

test("migrateDiskStats drops old path-keyed schema", () => {
  const db = openDb(":memory:"); // fresh: new schema already
  // simulate the old schema on a second handle
  db.run("DROP TABLE disk_stats");
  db.run("CREATE TABLE disk_stats (path TEXT PRIMARY KEY, ts INTEGER, bytes INTEGER)");
  db.run("INSERT INTO disk_stats VALUES ('/x', 1, 10)");
  migrateDiskStats(db);
  db.run("CREATE TABLE IF NOT EXISTS disk_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, bytes INTEGER NOT NULL)");
  const cols = (db.query("PRAGMA table_info(disk_stats)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("id");
  expect(cols).not.toContain("path");
});

test("schedules CRUD", () => {
  const db = openDb(":memory:");
  const row: ScheduleRow = { id: "s1", name: "nightly bump", cron: "0 3 * * *", folder: "acme", project: "shop", repo: "cms", clone_url: "https://github.com/acme/cms.git", prompt: "bump deps", important: 1, enabled: 1, last_run_at: null };
  insertSchedule(db, row);
  expect(listSchedules(db)).toEqual([row]);
  expect(getSchedule(db, "s1")).toEqual(row);
  updateSchedule(db, "s1", { enabled: 0, prompt: "other" });
  expect(getSchedule(db, "s1")!.enabled).toBe(0);
  expect(getSchedule(db, "s1")!.prompt).toBe("other");
  setScheduleLastRun(db, "s1", 123456);
  expect(getSchedule(db, "s1")!.last_run_at).toBe(123456);
  deleteSchedule(db, "s1");
  expect(listSchedules(db)).toEqual([]);
});

test("listEvents: DESC order, limit, session/type filter", () => {
  const db = openDb(":memory:");
  logEvent(db, "dev-shop-cms", "open", { a: 1 });
  logEvent(db, "dev-shop-cms", "agent_done", { via: "hook" });
  logEvent(db, "dev-blog-web", "open");
  const all = listEvents(db);
  expect(all.map((e) => e.type)).toEqual(["open", "agent_done", "open"]); // id DESC
  expect(all[0].session_id).toBe("dev-blog-web");
  expect(listEvents(db, { session: "dev-shop-cms" }).map((e) => e.type)).toEqual(["agent_done", "open"]);
  expect(listEvents(db, { type: "open" }).length).toBe(2);
  expect(listEvents(db, { limit: 1 }).length).toBe(1);
});

test("pruneEvents deletes old ones, keeps new ones", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO events (ts, session_id, type, data) VALUES (?,?,?,?)").run(1000, null, "old", null);
  logEvent(db, null, "new");
  pruneEvents(db, 60_000);
  expect(listEvents(db).map((e) => e.type)).toEqual(["new"]);
});

test("critic: column defaults to 0, setCritic toggles it", () => {
  const db = openDb(":memory:");
  insertSession(db, {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40100, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });
  expect(getSession(db, "dev-shop-cms")!.critic).toBe(0);
  setCritic(db, "dev-shop-cms", 1);
  expect(getSession(db, "dev-shop-cms")!.critic).toBe(1);
  setCritic(db, "dev-shop-cms", 0);
  expect(getSession(db, "dev-shop-cms")!.critic).toBe(0);
});

test("critic: migration of an old DB without the critic column", () => {
  // An old DB is created on disk without the `critic` column; openDb must add it
  // without losing data (same contract as the important/name migration).
  const path = `/tmp/devd-critic-migrace-${Date.now()}.sqlite`;
  const old = new Database(path);
  old.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    container TEXT NOT NULL, port_base INTEGER NOT NULL UNIQUE, status TEXT NOT NULL,
    solo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    important INTEGER NOT NULL DEFAULT 0)`);
  old.run(`INSERT INTO sessions VALUES ('dev-a-b','f','a','b','dev-a-b',40100,'running',0,1,1,0)`);
  old.close();
  const migrated = openDb(path);
  expect(getSession(migrated, "dev-a-b")!.critic).toBe(0);
  migrated.close();
  rmSync(path, { force: true });
});

test("critic_reviews: write, list newest first, latest, prune", () => {
  const db = openDb(":memory:");
  const base: Omit<CriticReviewRow, "id"> = {
    session_id: "dev-shop-cms", turn_id: "t1", round: 1, verdict: "issues",
    findings: JSON.stringify([{ severity: "important", what: "missing migration" }]),
    evidence: "tsc: 1 error", ms: 4200, at: 1000,
  };
  insertCriticReview(db, base);
  insertCriticReview(db, { ...base, round: 2, verdict: "ok", findings: "[]", evidence: null, at: 2000 });
  const rows = listCriticReviews(db, "dev-shop-cms");
  expect(rows).toHaveLength(2);
  expect(rows[0].at).toBe(2000);              // newest first
  expect(rows[0].verdict).toBe("ok");
  expect(latestCriticReview(db, "dev-shop-cms")!.round).toBe(2);
  expect(latestCriticReview(db, "dev-jine-repo")).toBeNull();
  pruneCriticReviews(db, 0);                   // everything older than now
  expect(listCriticReviews(db, "dev-shop-cms")).toHaveLength(0);
});

test("migration: existing DB without the agent column → old rows read as claude", () => {
  const path = join(tmpdir(), `devd-agent-migrate-${process.pid}.sqlite`);
  rmSync(path, { force: true });
  // schema exactly as BEFORE this feature (no agent column)
  const old = new Database(path);
  old.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    container TEXT NOT NULL, port_base INTEGER NOT NULL UNIQUE, status TEXT NOT NULL,
    solo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    important INTEGER NOT NULL DEFAULT 0, critic INTEGER NOT NULL DEFAULT 0)`);
  old.run(`INSERT INTO sessions VALUES ('dev-a-b','f','a','b','dev-a-b',41000,'running',0,1,1,0,0)`);
  old.close();

  const db = openDb(path);   // the migration happens here
  const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("agent");
  expect(getSession(db, "dev-a-b")!.agent).toBe("claude");
  db.close();
  rmSync(path, { force: true });
});

test("setSessionAgent overwrites the agent of an existing session", () => {
  const db = openDb(":memory:");
  insertSession(db, {
    id: "dev-a-d", folder: "f", project: "a", repo: "d", container: "dev-a-d", port_base: 41020,
    status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0, agent: "claude",
  });
  setSessionAgent(db, "dev-a-d", "codex");
  expect(getSession(db, "dev-a-d")!.agent).toBe("codex");
});

test("insertSession stores the chosen agent", () => {
  const db = openDb(":memory:");
  insertSession(db, {
    id: "dev-a-c", folder: "f", project: "a", repo: "c", container: "dev-a-c", port_base: 41010,
    status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0, agent: "codex",
  });
  expect(getSession(db, "dev-a-c")!.agent).toBe("codex");
});

test("repo_prefs: write, overwrite, read, list; unknown value → null", () => {
  const db = openDb(":memory:");
  expect(getRepoAgent(db, "acme", "shop", "app")).toBeNull();
  setRepoAgent(db, "acme", "shop", "app", "codex", 100);
  expect(getRepoAgent(db, "acme", "shop", "app")).toBe("codex");
  setRepoAgent(db, "acme", "shop", "app", "claude", 200);   // upsert, not a second row
  expect(getRepoAgent(db, "acme", "shop", "app")).toBe("claude");
  setRepoAgent(db, "acme", "shop", "claudeSolo", "codex", 300);
  expect(listRepoAgents(db).sort((a, b) => a.repo.localeCompare(b.repo))).toEqual([
    { folder: "acme", project: "shop", repo: "app", agent: "claude" },
    { folder: "acme", project: "shop", repo: "claudeSolo", agent: "codex" },
  ]);
  db.run(`UPDATE repo_prefs SET agent='gpt' WHERE repo='app'`);
  expect(getRepoAgent(db, "acme", "shop", "app")).toBeNull();  // a broken value is ignored
});

test("isAgentName lets through only claude and codex", () => {
  expect(isAgentName("claude")).toBe(true);
  expect(isAgentName("codex")).toBe(true);
  expect(isAgentName("gpt")).toBe(false);
  expect(isAgentName(undefined)).toBe(false);
  expect(isAgentName(1)).toBe(false);
});

// The morning cron woke the phone with a Pushover emergency alert (priority 2 = repeats every
// minute for a whole hour). Cause: `schedules.important` had DEFAULT 1 and the CRON UI never
// had a toggle for it — so the 1 on existing rows was not the operator's
// choice. The migration is one-shot (marker in `PRAGMA user_version`) so a human
// can turn emergency back on and the next devd start does not take it away again.
test("migrateScheduleImportance: silences old schedules, but only once", () => {
  const db = openDb(":memory:");
  db.run("PRAGMA user_version = 0");
  db.run("UPDATE schedules SET important=1");   // state before the migration
  insertSchedule(db, {
    id: "s-old", name: "morning status", cron: "7 8 * * *", folder: "acme", project: "shop", repo: "cms",
    clone_url: "https://x/cms.git", prompt: "p", important: 1, enabled: 1, last_run_at: null,
  });

  migrateScheduleImportance(db);
  expect(getSchedule(db, "s-old")!.important).toBe(0);

  // the operator deliberately turned emergency back on — the next devd start must not overwrite it
  updateSchedule(db, "s-old", { important: 1 });
  migrateScheduleImportance(db);
  expect(getSchedule(db, "s-old")!.important).toBe(1);
});

test("openDb: a fresh DB creates schedules as quiet", () => {
  const db = openDb(":memory:");
  db.run(`INSERT INTO schedules (id,name,cron,folder,project,repo,clone_url,prompt) VALUES ('s','n','0 3 * * *','f','p','r','https://x','x')`);
  expect(getSchedule(db, "s")!.important).toBe(0);
});

// The metrics table on the live devbox has hundreds of thousands of rows and hundreds of MB (attrs is
// fat JSON). Without an index each of the ~20 queries in buildRange did a full scan and
// /api/stats/range took 5–8 s. The test guards the query PLAN, not just the index's existence.
test("openDb: metric sums go through the index, not a full scan", () => {
  const db = openDb(":memory:");
  const plan = db.query(
    "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(value),0) FROM metrics WHERE name=? AND ts>=? AND ts<?"
  ).all("claude_code.cost.usage", 0, 1) as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" ");
  expect(detail).toContain("metrics_name_ts");
  expect(detail).not.toContain("SCAN metrics");
});

test("migrateMetricsIndex: adds the index to an older DB too and does nothing the second time", () => {
  const db = openDb(":memory:");
  db.run("DROP INDEX metrics_name_ts");
  expect(migrateMetricsIndex(db)).toBe(true);   // created
  expect(migrateMetricsIndex(db)).toBe(false);  // already exists, no work
});

test("migrateMetricsSessionIndex: the session_id index is created and covers MAX(ts)", () => {
  const db = openDb(":memory:");
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='metrics'").all() as { name: string }[])
    .map((r) => r.name);
  expect(names).toContain("metrics_session_ts");

  // Without the index lastMetricTs did a full scan of the whole table — the plan must confirm it.
  const plan = (db.query("EXPLAIN QUERY PLAN SELECT MAX(ts) FROM metrics WHERE session_id=?").all("x") as { detail: string }[])
    .map((r) => r.detail).join(" ");
  expect(plan).toContain("COVERING INDEX metrics_session_ts");
});

test("migrateMetricsSessionIndex: adds the index to an older DB too and does nothing the second time", () => {
  const db = openDb(":memory:");
  db.run("DROP INDEX metrics_session_ts");
  expect(migrateMetricsSessionIndex(db)).toBe(true);   // created
  expect(migrateMetricsSessionIndex(db)).toBe(false);  // already exists, no work
});

/** Writes a row the way an older devd version did — without the attribute columns. */
function insertMetricsRaw(db: Database, ts: number, sid: string, name: string, value: number, attrs: string) {
  db.query("INSERT INTO metrics (ts, session_id, name, value, attrs) VALUES (?,?,?,?,?)").run(ts, sid, name, value, attrs);
}

test("migrateMetricsAttrColumns: breakdowns go through the covering index, not through attrs", () => {
  const db = openDb(":memory:");
  const plan = (db.query(
    "EXPLAIN QUERY PLAN SELECT COALESCE(a_project,'—') k, SUM(value) s FROM metrics WHERE name=? AND ts>=? AND ts<? GROUP BY k"
  ).all("x", 0, 1) as { detail: string }[]).map((r) => r.detail).join(" ");
  expect(plan).toContain("COVERING INDEX metrics_rollup");
});

test("insertMetrics fills the attribute columns from attrs", () => {
  const db = openDb(":memory:");
  insertMetrics(db, [{
    ts: 1000, session_id: "dev-web-shop-1", name: "claude_code.cost.usage", value: 1,
    attrs: JSON.stringify({ project: "web", model: "opus", "devbox.host": "devbox", "user.account_uuid": "u1", repo: "shop" }),
  }]);
  const r = db.query("SELECT a_project, a_model, a_host, a_account, a_repo FROM metrics").get() as Record<string, string>;
  expect(r).toEqual({ a_project: "web", a_model: "opus", a_host: "devbox", a_account: "u1", a_repo: "shop" });
});

test("a_repo for older rows is derived from devbox.session.id when attrs.repo is missing", () => {
  const db = openDb(":memory:");
  insertMetrics(db, [{
    ts: 1000, session_id: "dev-web-shop-1", name: "claude_code.cost.usage", value: 1,
    attrs: JSON.stringify({ project: "web", "devbox.session.id": "dev-web-shop-1" }),
  }]);
  expect((db.query("SELECT a_repo FROM metrics").get() as { a_repo: string }).a_repo).toBe("shop-1");
});

test("migrateMetricsAttrColumns: an index with the old SHAPE is rebuilt, not judged only by name", () => {
  const db = openDb(":memory:");
  db.run("DROP INDEX metrics_rollup");
  // same name, but without session_id — exactly what an older version would leave behind
  db.run("CREATE INDEX metrics_rollup ON metrics (name, ts, a_project, value)");
  expect(migrateMetricsAttrColumns(db)).toBe(true);

  const sql = (db.query("SELECT sql FROM sqlite_master WHERE name='metrics_rollup'").get() as { sql: string }).sql;
  expect(sql).toContain("session_id");
  expect(migrateMetricsAttrColumns(db)).toBe(false);
});

test("usageBySession goes through the covering index (Sessions asks for it every 5 s)", () => {
  const db = openDb(":memory:");
  const plan = (db.query(
    "EXPLAIN QUERY PLAN SELECT session_id AS id, name, SUM(value) AS s FROM metrics " +
    "WHERE session_id IS NOT NULL AND name IN (?,?) AND ts>=? GROUP BY session_id, name"
  ).all("a", "b", 0) as { detail: string }[]).map((r) => r.detail).join(" ");
  expect(plan).toContain("COVERING INDEX metrics_rollup");
});

test("migrateMetricsAttrColumns: adds the columns to an older DB too, backfills them and does nothing the second time", () => {
  const db = openDb(":memory:");
  // simulate an old DB: columns and index gone, data stays
  db.run("DROP INDEX metrics_rollup");
  db.run("CREATE TABLE m2 AS SELECT id, ts, session_id, name, value, attrs FROM metrics");
  db.run("DROP TABLE metrics");
  db.run("ALTER TABLE m2 RENAME TO metrics");
  insertMetricsRaw(db, 1000, "dev-web-shop-1", "claude_code.cost.usage", 1, JSON.stringify({ project: "web", model: "opus" }));

  expect(migrateMetricsAttrColumns(db)).toBe(true);
  const r = db.query("SELECT a_project, a_model, a_repo FROM metrics").get() as Record<string, string | null>;
  expect(r.a_project).toBe("web");   // the backfill also computed the old row
  expect(r.a_model).toBe("opus");
  expect(r.a_repo).toBeNull();       // without attrs.repo and without devbox.session.id
  expect(migrateMetricsAttrColumns(db)).toBe(false);
});

test("auto_end: column defaults to 0, setAutoEnd toggles it", () => {
  const db = openDb(":memory:");
  insertSession(db, row);
  expect(getSession(db, "dev-shop-cms")!.auto_end).toBe(0);
  setAutoEnd(db, "dev-shop-cms", 1);
  expect(getSession(db, "dev-shop-cms")!.auto_end).toBe(1);
  setAutoEnd(db, "dev-shop-cms", 0);
  expect(getSession(db, "dev-shop-cms")!.auto_end).toBe(0);
});

test("auto_end: migration of an old DB without the auto_end column", () => {
  // Same contract as important/name/critic: the old DB on disk lacks the column,
  // openDb must add it and leave the data alone. Without the migration devd would crash
  // on the first SELECT from sessions after deploy.
  const path = join(tmpdir(), `devd-autoend-migrace-${Date.now()}.sqlite`);
  const old = new Database(path);
  old.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    container TEXT NOT NULL, port_base INTEGER NOT NULL UNIQUE, status TEXT NOT NULL,
    solo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    important INTEGER NOT NULL DEFAULT 0)`);
  old.run(`INSERT INTO sessions VALUES ('dev-a-b','f','a','b','dev-a-b',40100,'running',0,1,1,0)`);
  old.close();
  const migrated = openDb(path);
  expect(getSession(migrated, "dev-a-b")!.auto_end).toBe(0);
  migrated.close();
  rmSync(path, { force: true });
});

const IBX_ROW = { folder: "f", project: "p", repo: "r", status: "running" as const, solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const };

test("sessions.host defaults to vps and instabox can be written", () => {
  const db = openDb(":memory:");
  insertSession(db, { ...IBX_ROW, id: "dev-p-r", container: "dev-p-r", port_base: 40100 });
  expect(getSession(db, "dev-p-r")!.host).toBe("vps");
  expect(getSession(db, "dev-p-r")!.instabox_machine_id).toBeNull();
  insertSession(db, { ...IBX_ROW, id: "dev-p-r-2", container: "dev-p-r-2", port_base: 40110, host: "instabox" });
  setSessionInstabox(db, "dev-p-r-2", "m_1");
  const s = getSession(db, "dev-p-r-2")!;
  expect(s.host).toBe("instabox");
  expect(s.instabox_machine_id).toBe("m_1");
  expect(s.worktree).toBeNull();
});

test("instabox_base: single row, overwrite", () => {
  const db = openDb(":memory:");
  expect(getInstaboxBase(db)).toBeNull();
  setInstaboxBase(db, { snapshot_id: "sn_a", image_digest: "sha256:a", built_at: 1 });
  setInstaboxBase(db, { snapshot_id: "sn_b", image_digest: "sha256:b", built_at: 2 });
  expect(getInstaboxBase(db)).toEqual({ snapshot_id: "sn_b", image_digest: "sha256:b", built_at: 2 });
});

test("migration of an old DB adds host and instabox_machine_id", () => {
  const path = join(tmpdir(), `devd-mig-ibx-${process.pid}-${Date.now()}.sqlite`);
  const old = new Database(path);
  old.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL, container TEXT NOT NULL, port_base INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, solo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL)`);
  old.run(`INSERT INTO sessions VALUES ('dev-a-b','f','a','b','dev-a-b',40100,'running',0,1,1)`);
  old.close();
  const db = openDb(path);
  expect(getSession(db, "dev-a-b")!.host).toBe("vps");
  expect(getSession(db, "dev-a-b")!.instabox_machine_id).toBeNull();
});

test("agent_live_state: upsert overwrites the row of one session_id, delete removes it", () => {
  const db = openDb(":memory:");
  expect(getAgentLiveState(db, "dev-shop-cms")).toBeNull();
  upsertAgentLiveState(db, {
    session_id: "dev-shop-cms", status: "working", body: "Agent is working", reason: null,
    started_at: 1, updated_at: 1, status_since: 1,
  });
  upsertAgentLiveState(db, {
    session_id: "dev-shop-cms", status: "waiting", body: "Waiting for permission", reason: "Allow: Bash",
    started_at: 1, updated_at: 2, status_since: 2,
  });
  expect(getAgentLiveState(db, "dev-shop-cms")).toEqual({
    session_id: "dev-shop-cms", status: "waiting", body: "Waiting for permission", reason: "Allow: Bash",
    started_at: 1, updated_at: 2, status_since: 2,
  });
  deleteAgentLiveState(db, "dev-shop-cms");
  expect(getAgentLiveState(db, "dev-shop-cms")).toBeNull();
});
