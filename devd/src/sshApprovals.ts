import type { Database } from "bun:sqlite";
import type { SshAgents } from "./sshAgent";

/** 90 s: how long `srv` waits for a human decision before giving up. */
export const APPROVAL_TTL_MS = 90_000;

/** JavaScript Date limit; durations are never silently shortened. */
export const MAX_GRANT_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_GRANT_MINUTES = Math.floor((MAX_GRANT_TIMESTAMP - Date.now()) / 60_000);

export interface GrantDuration {
  grantMinutes: number;
  grantPermanent?: true;
  grantUntil?: number;
}

/** Shared validation for HTTP and Mac decisions. Missing minutes preserve old
 *  one-shot callers; only the literal boolean true can authorize permanence. */
export function parseGrantDuration(body: unknown, now = Date.now()): GrantDuration | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { grantMinutes = 0, grantPermanent } = body as Record<string, unknown>;
  if (grantPermanent !== undefined && typeof grantPermanent !== "boolean") return null;
  if (typeof grantMinutes !== "number" || !Number.isSafeInteger(grantMinutes) || grantMinutes < 0) return null;
  if (grantPermanent === true) {
    return grantMinutes === 0 ? { grantMinutes: 0, grantPermanent: true } : null;
  }
  if (grantMinutes === 0) return { grantMinutes: 0 };
  const grantUntil = now + grantMinutes * 60_000;
  if (!Number.isSafeInteger(grantUntil) || grantUntil <= now || grantUntil > MAX_GRANT_TIMESTAMP) return null;
  return { grantMinutes, grantUntil };
}

export type SshApprovalStatus = "pending" | "approved" | "denied" | "expired" | "activated" | "revoked";
export type DecidedBy = "mac" | "ios" | "dashboard";

export interface SshApprovalRow {
  id: string; session_id: string | null; title: string; why: string;
  target: string | null; server: string | null; cwd: string | null; project: string | null; repo: string | null;
  status: SshApprovalStatus; decided_by: DecidedBy | null;
  created_at: number; decided_at: number | null; expires_at: number; grant_until: number | null; grant_permanent: 0 | 1;
}

export interface NewApproval {
  session: string | null; title: string; why: string;
  target?: string | null; server?: string | null; cwd?: string | null; project?: string | null; repo?: string | null;
}

/** Expiry is NOT STORED — it is computed on read. Otherwise a request could be approved
 *  after the fact (cron finishes later than the human) and the key would be issued past the deadline. */
function view(row: SshApprovalRow | undefined, now: number): SshApprovalRow | undefined {
  if (!row) return undefined;
  if (row.status === "pending" && row.expires_at <= now) return { ...row, status: "expired" };
  return row;
}

export function createApproval(db: Database, p: NewApproval, now = Date.now()): string {
  const id = crypto.randomUUID();
  db.query(`INSERT INTO ssh_approvals
    (id, session_id, title, why, target, server, cwd, project, repo, created_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.session, p.title, p.why, p.target ?? null, p.server ?? null, p.cwd ?? null,
         p.project ?? null, p.repo ?? null, now, now + APPROVAL_TTL_MS);
  return id;
}

export function getApproval(db: Database, id: string, now = Date.now()): SshApprovalRow | undefined {
  return view((db.query("SELECT * FROM ssh_approvals WHERE id = ?").get(id) as SshApprovalRow | null) ?? undefined, now);
}

export function listApprovals(
  db: Database, opts: { status?: SshApprovalStatus; limit?: number } = {}, now = Date.now(),
): SshApprovalRow[] {
  const rows = (db.query("SELECT * FROM ssh_approvals ORDER BY created_at DESC LIMIT ?")
    .all(Math.min(opts.limit ?? 100, 500)) as SshApprovalRow[])
    .map((r) => view(r, now)!);
  return opts.status ? rows.filter((r) => r.status === opts.status) : rows;
}

/** Label of the newest open (pending, not expired) request of the session for the Live Activity —
 *  "key · server|target" — or null when the session is not waiting for approval. */
export function pendingSshLabel(db: Database, session: string, now = Date.now()): string | null {
  const row = db.query(`SELECT title, server, target FROM ssh_approvals
    WHERE session_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
    .get(session, now) as Pick<SshApprovalRow, "title" | "server" | "target"> | null;
  if (!row) return null;
  const where = row.server ?? row.target;
  return where ? `${row.title} · ${where}` : row.title;
}

export interface Decision {
  status: "approved" | "denied";
  by: DecidedBy;
  grantUntil?: number;
  grantPermanent?: boolean;
}

/** Returns false when a decision is no longer possible (does not exist / not pending / expired). */
export function decideApproval(db: Database, id: string, d: Decision, now = Date.now()): boolean {
  if (d.grantPermanent !== undefined && typeof d.grantPermanent !== "boolean") return false;
  if (d.grantUntil !== undefined && (!Number.isSafeInteger(d.grantUntil) || d.grantUntil <= now || d.grantUntil > MAX_GRANT_TIMESTAMP)) return false;
  if (d.grantPermanent === true && d.grantUntil !== undefined) return false;
  const result = db.query(`UPDATE ssh_approvals
    SET status=?, decided_by=?, decided_at=?, grant_until=?, grant_permanent=?
    WHERE id=? AND status='pending' AND expires_at > ?`)
    .run(d.status, d.by, now, d.status === "approved" ? d.grantUntil ?? null : null,
      d.status === "approved" && d.grantPermanent === true ? 1 : 0, id, now);
  return result.changes > 0;
}

/** One-shot activation keeps its original deadline. Permanent grants bypass
 *  only the time limit, never session ownership or the terminal revoked state. */
export function activateApproval(db: Database, id: string, session: string | null, now = Date.now()): boolean {
  const result = db.query(`UPDATE ssh_approvals SET status='activated'
    WHERE id=? AND status='approved' AND session_id IS ?
      AND (grant_permanent = 1 OR COALESCE(grant_until, expires_at) > ?)`)
    .run(id, session, now);
  return result.changes > 0;
}

/** Grants are scoped to the requesting session, the selected key AND the target
 *  (normalized `user@host:port`, see resolveSshTarget). `target IS ?` makes a NULL
 *  target match only NULL: a grant without a target covers only target-less
 *  requests, and a grant for a target never covers a target-less request. Use this
 *  to decide whether a request may skip the human prompt. */
export function liveGrant(
  db: Database, session: string | null, title: string, target: string | null, now = Date.now(),
): SshApprovalRow | undefined {
  return (db.query(`SELECT * FROM ssh_approvals
    WHERE session_id IS ? AND title = ? AND target IS ? AND (grant_permanent = 1 OR grant_until > ?)
      AND status IN ('approved','activated')
    ORDER BY grant_permanent DESC, grant_until DESC LIMIT 1`)
    .get(session, title, target, now) as SshApprovalRow | null) ?? undefined;
}

/** Any live grant of the key for the session, regardless of target. Every path
 *  that KILLS the per-session ssh-agent must use this, not liveGrant: the agent
 *  holds the key, not a target, so killing it while another target's grant for the
 *  same key is still live would break that live grant. */
export function liveKeyGrant(db: Database, session: string | null, title: string, now = Date.now()): SshApprovalRow | undefined {
  return (db.query(`SELECT * FROM ssh_approvals
    WHERE session_id IS ? AND title = ? AND (grant_permanent = 1 OR grant_until > ?)
      AND status IN ('approved','activated')
    ORDER BY grant_permanent DESC, grant_until DESC LIMIT 1`)
    .get(session, title, now) as SshApprovalRow | null) ?? undefined;
}

export function listGrants(db: Database, now = Date.now()): SshApprovalRow[] {
  return db.query(`SELECT * FROM ssh_approvals
    WHERE (grant_permanent = 1 OR grant_until > ?) AND status IN ('approved','activated')
    ORDER BY grant_permanent DESC, grant_until DESC`).all(now) as SshApprovalRow[];
}

/** Permanent grants are only removed by explicit revocation. */
export function expiredGrants(db: Database, now = Date.now()): SshApprovalRow[] {
  return db.query(`SELECT * FROM ssh_approvals
    WHERE grant_permanent = 0 AND grant_until IS NOT NULL AND grant_until <= ?
      AND status IN ('approved','activated')`).all(now) as SshApprovalRow[];
}

/** Revocation is terminal and affects grants only, never pending approvals. */
export function revokeGrant(db: Database, id: string): boolean {
  const res = db.query(`UPDATE ssh_approvals
    SET grant_until = NULL, grant_permanent = 0, status = 'revoked'
    WHERE id = ? AND status IN ('approved','activated')
      AND (grant_permanent = 1 OR grant_until IS NOT NULL)`).run(id);
  return res.changes > 0;
}

/** One tick of the expired-grants reaper — extracted from `setInterval` in index.ts
 *  so it can be tested over a fake `sshAgents` (the real one spawns/kills processes) without
 *  a running devd. Previously no test existed, which is exactly why the
 *  wrong keying of agents by the bare session (see sshAgent.ts) survived a whole
 *  review round — nothing could catch it.
 *
 *  `sshAgents.kill` also receives the `title` of the expired grant, not just the session: a grant
 *  for key A can expire at a moment when the session has meanwhile activated
 *  key B via `srv` — `kill(session, title)` then (see sshAgent.ts) kills the agent ONLY
 *  if it still serves key A, otherwise it leaves the running agent B alone.
 *
 *  `rm` touches a foreign socket devd may not own (EPERM/EBUSY) — one
 *  failing row must not stop the cleanup of the rest nor bring down the whole devd (an uncaught
 *  throw in setInterval is an uncaught exception), hence a dedicated catch PER ROW,
 *  not just around the whole tick (`onError` also gets the row that failed — index.ts
 *  just logs it, the row stays in `ssh_approvals` and the next tick tries it again).
 *
 *  The `expiredGrants(db, now)` snapshot below takes the rows ONCE at the start, but the loop
 *  then yields between individual rows (`await sshAgents.kill`) — previously this
 *  interleaving could be ignored, because the whole tick ran synchronously between two turns
 *  of the event loop. Now, between the snapshot and the kill of a PARTICULAR row, there may be time for
 *  a whole `POST /api/ssh-approvals/:id/activate` for the SAME session+title (a new
 *  approval, a fresh `grant_until`) — `kill(session, title)` compares only the title
 *  (see sshAgent.ts), so without re-verification it would also kill the newly activated agent
 *  (review finding: 200 s via the socket, then SSH fails with "communication with
 *  agent failed", and nothing in the log pointing to the reaper). Hence, right before
 *  the kill, `liveKeyGrant` again — the same predicate as the other `kill` paths
 *  in api.ts — and the kill happens ONLY when NO grant is alive for that session+title,
 *  for any target (grants are bound to a target, but the agent holds the key: if the
 *  grant for target A expired and a grant for target B of the same key is alive, B needs the agent).
 *  The stale row `g` is ALWAYS revoked, whether kill was called or not: otherwise `expiredGrants` would keep picking it (endless tick) and
 *  `revokeGrant` targets only `g.id`, so it does not affect the new (live) row in any way. */
export async function reapExpiredGrants(
  db: Database,
  sshAgents: Pick<SshAgents, "kill">,
  now = Date.now(),
  onError: (id: string, e: unknown) => void = () => {},
): Promise<void> {
  for (const g of expiredGrants(db, now)) {
    try {
      if (g.session_id && !liveKeyGrant(db, g.session_id, g.title, now)) {
        await sshAgents.kill(g.session_id, g.title);
      }
      revokeGrant(db, g.id);
    } catch (e) { onError(g.id, e); }
  }
}
