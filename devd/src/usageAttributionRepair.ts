// One-off repair of historical usage that ended up without a repo ("Unknown" in Stats).
// Codex subagents (thread_spawn) do not send hook events, so the harvester could not
// pair them with a session. Headless Grok the same. The evidence is supplied by the caller (tools/
// usage-attribution-repair.ts reads it from the volume): parents of Codex threads from session_meta
// and the devbox session of a Grok sid from git_root_dir in summary.json.
//
// Attribution is only TAKEN OVER from existing data: from a parent that already has rows with a repo,
// or from a session looked up via notify_log. Ambiguous sources are left alone.
// Metric values do not change. Every rewritten row has an entry in the ledger (undo).
import type { Database } from "bun:sqlite";

export const ATTRIBUTION_REPAIR = "usage-attribution-2026-10-14-v1";
const LEDGER = "usage_attribution_repairs";

export interface AttributionEvidence {
  /** Codex thread id → parent_thread_id (subagents only). */
  codexParents: Record<string, string>;
  /** Grok sid → id devbox session z git_root_dir. */
  grokSessions: Record<string, string>;
}
type Target = { session: string; project: string; repo: string };
export interface AttributionPlanEntry { agent: string; sourceId: string; rowIds: number[]; target: Target; via: string }
export interface AttributionPlan {
  entries: AttributionPlanEntry[];
  unresolved: { agent: string; sourceId: string; rows: number; reason: string }[];
}

const SOURCE = `json_extract(attrs, '$."devbox.usage.source_id"')`;
const AGENT = `json_extract(attrs, '$."devbox.agent"')`;

export function planUsageAttribution(db: Database, ev: AttributionEvidence): AttributionPlan {
  const bySource = new Map<string, Target[]>();
  for (const r of db.query(`SELECT ${SOURCE} src, session_id, a_project, a_repo FROM metrics
      WHERE a_repo IS NOT NULL AND session_id IS NOT NULL AND a_project IS NOT NULL AND ${SOURCE} IS NOT NULL
      GROUP BY 1, 2, 3, 4`).all() as { src: string; session_id: string; a_project: string; a_repo: string }[]) {
    const list = bySource.get(r.src) ?? [];
    list.push({ session: r.session_id, project: r.a_project, repo: r.a_repo });
    bySource.set(r.src, list);
  }
  const sessionCache = new Map<string, Target | null>();
  const sessionTarget = (session: string): Target | null => {
    if (sessionCache.has(session)) return sessionCache.get(session)!;
    const rows = db.query(`SELECT DISTINCT a_project p, a_repo r FROM metrics
      WHERE session_id = ? AND a_repo IS NOT NULL AND a_project IS NOT NULL`).all(session) as { p: string; r: string }[];
    let t: Target | null = rows.length === 1 ? { session, project: rows[0].p, repo: rows[0].r } : null;
    if (rows.length === 0) {
      const live = db.query(`SELECT project, repo FROM sessions WHERE id = ?`).get(session) as { project: string; repo: string } | null;
      if (live) t = { session, ...live };
    }
    sessionCache.set(session, t);
    return t;
  };
  const notified = (thread: string) => (db.query(`SELECT session_id FROM notify_log
    WHERE agent_session_id = ? ORDER BY id DESC LIMIT 1`).get(thread) as { session_id: string } | null)?.session_id ?? null;

  const resolveCodex = (thread: string): { target: Target | null; via: string } => {
    const seen = new Set<string>();
    let id: string | undefined = thread;
    for (let depth = 0; id && !seen.has(id) && depth < 16; depth++, id = ev.codexParents[id]) {
      seen.add(id);
      const known = bySource.get(id);
      if (known?.length === 1) return { target: known[0], via: depth ? `parent:${depth}` : "self" };
      if (known && known.length > 1) return { target: null, via: "ambiguous" };
      const session = notified(id);
      if (session) {
        const t = sessionTarget(session);
        return t ? { target: t, via: depth ? `parent:${depth}:notify` : "notify" } : { target: null, via: "session-without-repo" };
      }
    }
    return { target: null, via: ev.codexParents[thread] ? "parent-unattributed" : "no-parent" };
  };

  const rowsBySource = new Map<string, { agent: string; ids: number[] }>();
  for (const r of db.query(`SELECT id, ${AGENT} agent, ${SOURCE} src FROM metrics
      WHERE a_repo IS NULL AND session_id IS NULL AND ${AGENT} IN ('codex', 'grok') AND ${SOURCE} IS NOT NULL`)
    .all() as { id: number; agent: string; src: string }[]) {
    const key = `${r.agent}\u0000${r.src}`;
    const group = rowsBySource.get(key) ?? { agent: r.agent, ids: [] };
    group.ids.push(r.id);
    rowsBySource.set(key, group);
  }

  const plan: AttributionPlan = { entries: [], unresolved: [] };
  for (const [key, group] of rowsBySource) {
    const sourceId = key.split("\u0000")[1];
    let resolved: { target: Target | null; via: string };
    if (group.agent === "codex") resolved = resolveCodex(sourceId);
    else {
      const session = ev.grokSessions[sourceId];
      const t = session ? sessionTarget(session) : null;
      resolved = { target: t, via: session ? (t ? "git_root_dir" : "session-without-repo") : "no-git-root" };
    }
    if (resolved.target) plan.entries.push({ agent: group.agent, sourceId, rowIds: group.ids, target: resolved.target, via: resolved.via });
    else plan.unresolved.push({ agent: group.agent, sourceId, rows: group.ids.length, reason: resolved.via });
  }
  return plan;
}

/** Rewrites rows in small transactions (the DB is in rollback-journal mode and devd
 *  writes into it continuously). A row that changed in the meantime is skipped. */
export function applyUsageAttribution(db: Database, plan: AttributionPlan, batchSize = 2000): { updated: number; skipped: number } {
  db.run(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
    metric_id INTEGER PRIMARY KEY, original_attrs TEXT NOT NULL, original_session_id TEXT,
    repair TEXT NOT NULL, repaired_at INTEGER NOT NULL)`);
  const pending = plan.entries.flatMap((e) => e.rowIds.map((id) => ({ id, t: e.target })));
  const ledger = db.query(`INSERT INTO ${LEDGER} SELECT id, attrs, session_id, ?, ? FROM metrics
    WHERE id = ? AND a_repo IS NULL AND session_id IS NULL`);
  const update = db.query(`UPDATE metrics SET
      attrs = json_set(attrs, '$."devbox.session.id"', ?1, '$.project', ?2, '$.repo', ?3, '$."devbox.usage.attribution_repair"', ?4),
      session_id = ?1, a_project = ?2, a_repo = ?3
    WHERE id = ?5 AND a_repo IS NULL AND session_id IS NULL`);
  let updated = 0, skipped = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    db.transaction(() => {
      const now = Date.now();
      for (const { id, t } of batch) {
        if (ledger.run(ATTRIBUTION_REPAIR, now, id).changes === 0) { skipped++; continue; }
        update.run(t.session, t.project, t.repo, ATTRIBUTION_REPAIR, id);
        updated++;
      }
    }).immediate();
  }
  return { updated, skipped };
}

/** Restores rows to their state before the repair according to the ledger. */
export function undoUsageAttribution(db: Database): number {
  const exists = db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${LEDGER}'`).get();
  if (!exists) return 0;
  return db.transaction(() => {
    // .changes would also count metrics_hourly rows modified by triggers.
    const n = (db.query(`SELECT COUNT(*) n FROM ${LEDGER} WHERE repair = ?`).get(ATTRIBUTION_REPAIR) as { n: number }).n;
    db.run(`UPDATE metrics SET attrs = l.original_attrs, session_id = l.original_session_id,
      a_project = json_extract(l.original_attrs, '$.project'), a_repo = NULL
      FROM ${LEDGER} l WHERE metrics.id = l.metric_id AND l.repair = ?`, [ATTRIBUTION_REPAIR]);
    db.run(`DELETE FROM ${LEDGER} WHERE repair = ?`, [ATTRIBUTION_REPAIR]);
    return n;
  }).immediate();
}
