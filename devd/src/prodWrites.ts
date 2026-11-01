import { createConnection } from "mysql2/promise";
import type { Database } from "bun:sqlite";
import postgres from "postgres";
import { withTunnel } from "./prodTunnel";
import type { DbEntry, ServerRef } from "./prodDb";

export type WriteStatus = "blocked" | "pending" | "approved" | "executed" | "failed" | "rejected";
export type WriteScope = "dml" | "migration";
export interface WriteRow {
  id: number; ts: number; session_id: string | null; db: string; sql: string;
  status: WriteStatus; decided_at: number | null; result: string | null; error: string | null;
  scope: WriteScope; idempotency_key: string | null; exception: string | null;
}

export function createProposal(db: Database, p: { session: string | null; db: string; sql: string; scope?: WriteScope; idempotencyKey?: string; exception?: string }): number {
  const scope = p.scope ?? "dml";
  const old = p.idempotencyKey
    ? db.query("SELECT * FROM prod_writes WHERE session_id IS ? AND idempotency_key=?").get(p.session, p.idempotencyKey) as WriteRow | null
    : db.query("SELECT * FROM prod_writes WHERE session_id IS ? AND db=? AND sql=? AND scope=? ORDER BY id DESC LIMIT 1").get(p.session, p.db, p.sql, scope) as WriteRow | null;
  if (old) {
    if (old.db !== p.db || old.sql !== p.sql || old.scope !== scope) throw new Error("idempotency key already belongs to a different SQL proposal");
    return old.id;
  }
  return (db.query("INSERT INTO prod_writes (ts, session_id, db, sql, scope, idempotency_key, exception) VALUES (?,?,?,?,?,?,?) RETURNING id")
    .get(Date.now(), p.session, p.db, p.sql, scope, p.idempotencyKey ?? null, p.exception ?? null) as { id: number }).id;
}

export function listProposals(db: Database, opts: { status?: WriteStatus; limit?: number } = {}): WriteRow[] {
  const where = opts.status ? "WHERE status = ?" : "";
  const args = opts.status ? [opts.status] : [];
  return db.query(`SELECT * FROM prod_writes ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(opts.limit ?? 100, 500)) as WriteRow[];
}

export function getProposal(db: Database, id: number): WriteRow | undefined {
  return db.query("SELECT * FROM prod_writes WHERE id = ?").get(id) as WriteRow | undefined;
}

export function setStatus(db: Database, id: number, status: WriteStatus, extra: { result?: string; error?: string } = {}): void {
  db.query("UPDATE prod_writes SET status=?, decided_at=?, result=?, error=? WHERE id=?")
    .run(status, Date.now(), extra.result ?? null, extra.error ?? null, id);
}

/** Retain bounded diagnostic rows in the already authorized proposal result.
 * Driver field metadata distinguishes SELECT rows from command acknowledgements.
 * Truncated output is explicitly unsuitable as complete schema evidence. */
export function summarizeMariaDbResult(result: unknown, fields?: unknown): { rows: number; note: string } {
  const singleRowset = Array.isArray(fields) && fields.length > 0 && fields.every(
    (field) => field && typeof field === "object" && !Array.isArray(field) && typeof field.name === "string",
  );
  const statements = singleRowset ? [result] : Array.isArray(result) ? result : [result];
  let rows = 0, usedBytes = 0, truncated = false;
  const sets: { statement: number; returnedRows: number; rows: unknown[]; truncated: boolean }[] = [];
  for (const [index, statement] of statements.entries()) {
    if (!Array.isArray(statement)) {
      const affected = Number((statement as { affectedRows?: unknown } | null)?.affectedRows);
      if (Number.isSafeInteger(affected) && affected >= 0) rows += affected;
      continue;
    }
    if (sets.length >= 8) { truncated = true; continue; }
    const output = { statement: index + 1, returnedRows: statement.length, rows: [] as unknown[], truncated: false };
    for (const row of statement) {
      if (output.rows.length >= 100) { output.truncated = true; break; }
      try {
        const encoded = JSON.stringify(row, (_, value) => typeof value === "bigint" ? value.toString() : value);
        if (encoded === undefined || usedBytes + Buffer.byteLength(encoded) > 48 * 1024) { output.truncated = true; break; }
        usedBytes += Buffer.byteLength(encoded);
        output.rows.push(JSON.parse(encoded));
      } catch { output.truncated = true; break; }
    }
    truncated ||= output.truncated;
    sets.push(output);
  }
  const note = `${rows} affected rows; MariaDB statements completed`;
  return { rows, note: sets.length || truncated ? `${note}\nResult sets: ${JSON.stringify({ truncated, sets })}` : note };
}

/** Execute separately approved SQL using the selected DML or migration role.
 * The HTTP preview is static: a rollback cannot undo every PostgreSQL side effect.
 * The optional rollback mode here is retained for isolated transport tests only. */
export async function executeWrite(
  entry: DbEntry, server: ServerRef, keyPath: string, rwPw: string, sql: string, opts: { preview?: boolean; scope?: WriteScope; ensureTunnel?: () => Promise<void> } = {},
): Promise<{ rows: number; note: string }> {
  if (!["postgres", "mariadb"].includes(entry.engine)) throw new Error(`write engine ${entry.engine} is not supported yet`);
  const user = opts.scope === "migration" ? entry.migrationUser : entry.rwUser;
  if (!user) throw new Error(opts.scope === "migration" ? "migration_credentials_missing" : "write_credentials_missing");
  const execute = async () => {
    if (entry.engine === "mariadb") {
      // MariaDB DDL implicitly commits; never run a preview and claim rollback.
      if (opts.preview) throw Error("mariadb_preview_is_static_only");
      let c: Awaited<ReturnType<typeof createConnection>> | undefined;
      try {
        c = await createConnection({ host: "127.0.0.1", port: entry.hostPort, database: entry.db, user, password: rwPw, multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, connectTimeout: 10000 });
        await c.beginTransaction();
        const [result, fields] = await c.query(sql);
        await c.commit();
        return summarizeMariaDbResult(result, fields);
      } catch (e) {
        try { await c?.rollback(); } catch {}
        const code = (e as { sqlState?: string }).sqlState;
        throw Error(`database_write_failed: SQLSTATE ${/^[A-Z0-9]{5}$/.test(code ?? "") ? code : "unknown"}; some statements may have committed; inspect before retrying`);
      } finally { await c?.end(); }
    }
    const c = postgres({ host: "127.0.0.1", port: entry.hostPort, database: entry.db, username: user, password: rwPw, ssl: false, max: 1, prepare: false });
    const rollback = Symbol("rollback");
    try {
      let rows = 0;
      try {
        await c.begin(async (tx) => {
          const r = await tx.unsafe(sql);
          rows = r.count ?? 0;
          if (opts.preview) throw rollback;
        });
      } catch (e) {
        if (e !== rollback) {
          if ((e as { code?: string }).code === "42501") throw new Error(opts.scope === "migration" ? "ddl_permission_denied: the approved migration role lacks ownership/DDL privileges" : "write_permission_denied: this role permits DML only; request a scoped migration");
          // PostgreSQL errors can contain SQL values and authentication details.
          throw new Error(`database_write_failed: SQLSTATE ${/^[A-Z0-9]{5}$/.test((e as { code?: string }).code ?? "") ? (e as { code: string }).code : "unknown"}`);
        }
      }
      return { rows, note: opts.preview ? `preview: ${rows} rows` : `${rows} rows written` };
    } finally { await c.end(); }
  };
  if (opts.ensureTunnel) { await opts.ensureTunnel(); return execute(); }
  return withTunnel(server, keyPath, entry.hostPort, execute);
}
