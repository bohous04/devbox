import type { Database } from "bun:sqlite";

// Lifecycle of an operation proposal. The shape is deliberately the same as prod_writes (same states,
// same decided_at/result/error columns) — when these get merged into one overview,
// there will be nothing to reconcile.
export type OpStatus = "pending" | "approved" | "running" | "executed" | "failed" | "rejected";

export interface OpRow {
  id: number; ts: number; session_id: string | null; op: string; params: string;
  status: OpStatus; decided_at: number | null; result: string | null; error: string | null;
  error_details?: string | null;
}

export function proposeOperation(
  db: Database, p: { session: string | null; op: string; params: Record<string, string> },
): number {
  const serialized = JSON.stringify(p.params);
  const old = db.query("SELECT id FROM operations WHERE session_id IS ? AND op=? AND params=? ORDER BY id DESC LIMIT 1")
    .get(p.session, p.op, serialized) as { id: number } | null;
  if (old) return old.id;
  return (db.query("INSERT INTO operations (ts, session_id, op, params) VALUES (?,?,?,?) RETURNING id")
    .get(Date.now(), p.session, p.op, serialized) as { id: number }).id;
}

export function listOperations(db: Database, opts: { status?: OpStatus; limit?: number } = {}): OpRow[] {
  const where = opts.status ? "WHERE status = ?" : "";
  const args = opts.status ? [opts.status] : [];
  return db.query(`SELECT * FROM operations ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(opts.limit ?? 100, 500)) as OpRow[];
}

export function getOperation(db: Database, id: number): OpRow | undefined {
  // bun:sqlite returns null for a missing row; we normalize to undefined so the declared
  // type matches reality and callers can make do with `if (!row)`.
  return (db.query("SELECT * FROM operations WHERE id = ?").get(id) as OpRow | null) ?? undefined;
}

export function setOperationStatus(
  db: Database, id: number, status: OpStatus, extra: { result?: string; error?: string; errorDetails?: unknown } = {},
): void {
  db.query("UPDATE operations SET status=?, decided_at=?, result=?, error=?,error_details=? WHERE id=?")
    .run(status, Date.now(), extra.result ?? null, extra.error ?? null, extra.errorDetails ? JSON.stringify(extra.errorDetails) : null, id);
}
