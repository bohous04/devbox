import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getSession } from "./db";

// The `terminal_shares` table is created in db.ts (openDb) — only queries over it here,
// same pattern as sshApprovals.ts over `ssh_approvals`.

export interface ShareRow {
  id: string;
  session_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/** Validity presets offered in the UI (minutes) and a hard cap that applies outside them too. */
export const SHARE_PRESETS = [30, 60, 240, 480, 1440] as const;
export const SHARE_MAX_MINUTES = 1440;

/** The raw token is never stored in the DB — only its SHA-256 hex. Stealing the DB (or
 *  just its backed-up file) thus cannot be used directly to open someone else's
 *  terminal; the token itself lives only in the URL given to whoever created the share. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A small in-process event: whoever needs to close open guest WS connections when a
 *  share is revoked (share listener, Task 4/5) subscribes here via `onShareRevoked`.
 *  Expiry by timer is their concern — here we emit only on EXPLICIT revocation
 *  (revokeShare / revokeSessionShares). Returns an unsubscribe function. */
type RevokedListener = (ids: string[]) => void;
const revokedListeners = new Set<RevokedListener>();

export function onShareRevoked(cb: RevokedListener): () => void {
  revokedListeners.add(cb);
  return () => revokedListeners.delete(cb);
}

/** `revokeShare`/`revokeSessionShares` are also called IN THE MIDDLE of `SessionManager.end()`/
 *  `recreate()` — a crashed listener would bring down the whole session revoke/rebuild there
 *  (see review fix round 1). Each listener gets its own try/catch, so one
 *  failing listener neither stifles delivery to the others nor escapes up into the session teardown. */
function emitShareRevoked(ids: string[]): void {
  if (ids.length === 0) return;
  for (const cb of revokedListeners) {
    try { cb(ids); } catch (e) { console.error("onShareRevoked listener failed:", e); }
  }
}

/** Creates a new share. Validation of `minutes` (1…SHARE_MAX_MINUTES), existence and
 *  state of the session (running, not InstaBox) is done by the caller (the route in api.ts) — this
 *  function only writes the row and returns the raw token, which is NEVER stored or returned
 *  anywhere else (neither to the agent nor into the log — see logEvent in api.ts). */
export function createShare(db: Database, sessionId: string, minutes: number, now = Date.now()): { id: string; token: string; expiresAt: number } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString("base64url"); // 32 B → 43 base64url characters, no padding
  const id = crypto.randomUUID();
  const expiresAt = now + minutes * 60_000;
  db.query(`INSERT INTO terminal_shares (id, session_id, token_hash, created_at, expires_at, revoked_at)
    VALUES (?,?,?,?,?,NULL)`).run(id, sessionId, hashToken(token), now, expiresAt);
  return { id, token, expiresAt };
}

/** A valid share for the token: not revoked, not expired, the session is running and is NOT InstaBox.
 *  If any of the conditions fails → null, without distinguishing the reason (the share listener has
 *  nobody to explain why to, it just closes the connection). */
export function resolveShare(db: Database, token: string, now = Date.now()): ShareRow | null {
  const row = (db.query(`SELECT id, session_id, created_at, expires_at, revoked_at FROM terminal_shares WHERE token_hash=?`)
    .get(hashToken(token)) as ShareRow | null) ?? null;
  if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
  const session = getSession(db, row.session_id);
  if (!session || session.status !== "running" || session.host === "instabox") return null;
  return row;
}

/** Revokes one share (DELETE /api/shares/:id). Idempotent: for an already revoked
 *  or unknown id it returns null and nothing is emitted. Returns the `session_id` of the revoked
 *  share (not just a boolean), so the caller (the route) can log it PER SESSION,
 *  not as an anonymous row — review fix round 1. */
export function revokeShare(db: Database, id: string, now = Date.now()): string | null {
  const row = (db.query(`UPDATE terminal_shares SET revoked_at=? WHERE id=? AND revoked_at IS NULL RETURNING session_id`)
    .get(now, id) as { session_id: string } | null) ?? null;
  if (row) emitShareRevoked([id]);
  return row ? row.session_id : null;
}

/** Revokes all not-yet-revoked shares of a session — end/delete, container recreate.
 *  DELIBERATELY regardless of expires_at: expired but not yet revoked rows are also
 *  cleaned up here, so the table does not grow needlessly. One UPDATE…RETURNING (not SELECT + UPDATE):
 *  the same query yields both the rows and the ids it revoked. Returns the revoked ids and immediately emits
 *  `onShareRevoked`, so the listener (share listener) closes their connections. */
export function revokeSessionShares(db: Database, sessionId: string, now = Date.now()): string[] {
  const rows = db.query(`UPDATE terminal_shares SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL RETURNING id`)
    .all(now, sessionId) as { id: string }[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  emitShareRevoked(ids);
  return ids;
}

/** Listing for the dashboard (GET /api/shares): only live shares (not revoked, not expired),
 *  with the session name for display — NEVER with the token (it is never returned anywhere). */
export function listActiveShares(db: Database, now = Date.now()): (ShareRow & { name: string | null })[] {
  return db.query(`
    SELECT ts.id AS id, ts.session_id AS session_id, ts.created_at AS created_at,
           ts.expires_at AS expires_at, ts.revoked_at AS revoked_at, s.name AS name
    FROM terminal_shares ts LEFT JOIN sessions s ON s.id = ts.session_id
    WHERE ts.revoked_at IS NULL AND ts.expires_at > ?
    ORDER BY ts.created_at DESC`).all(now) as (ShareRow & { name: string | null })[];
}

/** Does the session have an active (not revoked, not expired) share right now? For the badge in the UI. */
export function isShared(db: Database, sessionId: string, now = Date.now()): boolean {
  return db.query(`SELECT 1 FROM terminal_shares WHERE session_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1`)
    .get(sessionId, now) !== null;
}
