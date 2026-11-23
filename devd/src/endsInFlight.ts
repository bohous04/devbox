import type { Database } from "bun:sqlite";
import { getSession } from "./db";

// Ends that outlive devd. An end waits tens of minutes for the offsite backup (storageGuard.ts) and a deploy restarts
// devd: before this, any end not started by a settle was only in memory, so the restart left the session stopped but
// not ended, with nobody finishing it. mgr.end writes the row here when it starts and deletes it when it finishes or
// fails; startup resumes what is left. Settles have their own resume with its checks (sessionInbox.ts armEnds).

export type SoloAction = "keep" | "delete";
export interface EndInFlight { session_id: string; solo_action: SoloAction; keep_worktree: number; started_at: number }

export function endsInFlight(db: Database): EndInFlight[] {
  return db.query(`SELECT session_id, solo_action, keep_worktree, started_at FROM ends_in_flight ORDER BY started_at, session_id`).all() as EndInFlight[];
}
export function putEndInFlight(db: Database, id: string, soloAction: SoloAction, keepWorktree: boolean, now: number): void {
  db.query(`INSERT OR REPLACE INTO ends_in_flight (session_id, solo_action, keep_worktree, started_at) VALUES (?,?,?,?)`)
    .run(id, soloAction, keepWorktree ? 1 : 0, now);
}
export function deleteEndInFlight(db: Database, id: string): void {
  db.query(`DELETE FROM ends_in_flight WHERE session_id = ?`).run(id);
}

/** Restarts the ends an earlier devd left running, the way they were asked for. Returns the ids it resumed. */
export function resumeEnds(d: {
  db: Database;
  end: (id: string, soloAction: SoloAction, opts: { keepWorktree: boolean }) => Promise<void>;
  notify: (title: string, message: string) => void;
}): string[] {
  const resumed: string[] = [];
  for (const e of endsInFlight(d.db)) {
    if (!getSession(d.db, e.session_id)) { deleteEndInFlight(d.db, e.session_id); continue; }
    const settle = d.db.query(`SELECT 1 FROM session_attention WHERE session_id = ? AND end_started_at IS NOT NULL`).get(e.session_id);
    if (settle) continue;
    resumed.push(e.session_id);
    d.end(e.session_id, e.solo_action, { keepWorktree: e.keep_worktree === 1 }).then(
      () => d.notify("Session ended", `${e.session_id}: finished after a devd restart.`),
      (err: Error) => { console.error(`resumed end ${e.session_id} failed:`, err); d.notify("Ending session failed", `${e.session_id}: ${err.message}`); },
    );
  }
  return resumed;
}

/** Sessions with an end cut short by a restart: startup recovery must not start them again (host-docker.py drops the
 *  backup's proof on `docker start`), their end is being finished. */
export function endingIds(db: Database): Set<string> {
  const rows = db.query(`SELECT session_id FROM ends_in_flight UNION SELECT session_id FROM session_attention WHERE end_started_at IS NOT NULL`).all() as { session_id: string }[];
  return new Set(rows.map((r) => r.session_id));
}
