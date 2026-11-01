import type { Database } from "bun:sqlite";
import type { Catalog } from "./prodDb";

// Queue of requests for access to a database that is not yet in the catalog.
//
// Purpose: an agent that runs into an unknown database today gets a dry `unknown db`
// and has nothing more to do. Instead, a request is created, a popup appears on the mac and the catalog
// is extended only at the moment it is needed — it does not have to be thought up in advance.
export type DbRequestScope = "read" | "dml" | "migration";
export type DbRequestStatus = "pending" | "approved" | "rejected" | "failed";

export interface DbRequestRow {
  id: number; ts: number; session_id: string | null; project: string | null;
  wanted: string; why: string; status: DbRequestStatus;
  decided_at: number | null; note: string | null;
  requested_scope?: DbRequestScope;
}

export function createDbRequest(
  db: Database, p: { session: string | null; project: string | null; wanted: string; why: string; scope?: DbRequestScope },
): number {
  // An agent may easily run into the same database ten times a minute. An open request is therefore
  // recycled so that the approval queue does not fill with duplicates of the same thing.
  p = { ...p, wanted: p.wanted.trim(), why: p.why.trim() };
  const open = db.query(
    `SELECT r.id,r.status,r.requested_scope,o.operation_id,o.plan FROM db_requests r
     LEFT JOIN db_onboarding o ON o.request_id=r.id
     WHERE r.session_id IS ?1 AND r.wanted = ?2 ORDER BY r.id DESC LIMIT 1`,
  ).get(p.session, p.wanted) as { id: number; status: string; requested_scope: DbRequestScope; operation_id: number | null; plan: string | null } | null;
  const scope = p.scope ?? "read";
  const rank = { read: 0, dml: 1, migration: 2 };
  if (open) {
    // A denied request stays denied. Retry cannot reopen a human decision.
    if (open.status === "rejected") return open.id;
    let provided = open.requested_scope ?? "read";
    if (open.status === "approved" && open.plan) {
      try { const plan = JSON.parse(open.plan); provided = plan.migrations ? "migration" : plan.write ? "dml" : "read"; }
      catch { provided = "read"; }
    }
    if (rank[provided] >= rank[scope]) return open.id;
    if (open.status !== "approved") {
      // Once an Operations plan exists its scope and approval are immutable. The
      // blocked SQL keeps this request until verified completion, then gets a
      // separate access-extension request through normal polling.
      if (open.operation_id) return open.id;
      db.transaction(() => {
        db.query("UPDATE db_requests SET requested_scope=?,why=? WHERE id=?").run(scope, p.why, open.id);
        // Keep the old input for re-preparation, but invalidate its readiness. The
        // stored scope snapshot prevents async preflight from publishing it.
        db.query("UPDATE db_onboarding SET state='blocked',blocks=?,updated_at=? WHERE request_id=? AND operation_id IS NULL")
          .run(JSON.stringify([{ code: "scope_changed", category: "decision", message: "The requested access scope increased before approval.", action: "Prepare the updated plan; SQL still requires separate approval." }]), Date.now(), open.id);
      })();
      return open.id;
    }
  }

  return (db.query(
    "INSERT INTO db_requests (ts, session_id, project, wanted, why, requested_scope) VALUES (?,?,?,?,?,?) RETURNING id",
  ).get(Date.now(), p.session, p.project, p.wanted, p.why, p.scope ?? "read") as { id: number }).id;
}

export function listDbRequests(db: Database, o: { status?: DbRequestStatus; limit?: number } = {}): DbRequestRow[] {
  const where = o.status ? "WHERE status = ?" : "";
  const args = o.status ? [o.status] : [];
  return db.query(`SELECT * FROM db_requests ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(o.limit ?? 100, 500)) as DbRequestRow[];
}

export function getDbRequest(db: Database, id: number): DbRequestRow | undefined {
  return (db.query("SELECT * FROM db_requests WHERE id = ?").get(id) as DbRequestRow | null) ?? undefined;
}

export function setDbRequestStatus(
  db: Database, id: number, status: DbRequestStatus, extra: { note?: string } = {},
): void {
  db.query("UPDATE db_requests SET status=?, decided_at=?, note=? WHERE id=?")
    .run(status, Date.now(), extra.note ?? null, id);
}

/** Legacy catalog check. New onboarding uses the host preflight and a separately
 * approved Operations plan to provision missing dedicated tunnel credentials. */
export function serverReady(
  catalog: Catalog, server: string, opKeyTitles: string[],
): { ready: true } | { ready: false; missingKey?: string; unknownServer?: true } {
  const s = catalog.servers[server];
  if (!s) return { ready: false, unknownServer: true };
  if (!opKeyTitles.includes(s.key)) return { ready: false, missingKey: s.key };
  return { ready: true };
}
