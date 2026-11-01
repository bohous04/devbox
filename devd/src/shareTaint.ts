// "Tainted" session: a container that was shared at least once stays restricted
// (the same lockdown rules as an active share, dind sidecar stopped) until it is
// REBUILT — i.e. until the session gets a new container with a different docker id.
//
// Why not just for the duration of the share (final review C4): the guest had a shell in the container, so
// whatever they left running there (nohup loop, reverse shell, git hook, .bashrc) lives on even after
// the link is revoked/expires. If the lockdown ended with the link, those processes would get full
// access to the devd API. The taint is therefore bound to the CONTAINER's docker id (not to the session) and
// stored in the DB — a devd restart does not clear it, a container rebuild does (new id = clean state).
//
// The `session_taints` table is created in db.ts (openDb).
import type { Database } from "bun:sqlite";
import { dindName } from "./dind";
import { run, timeoutFor, type RunOpts, type RunResult } from "./proc";

type Exec = (cmd: string[], opts: RunOpts) => Promise<RunResult>;

/** Records a taint of container `containerId` of session `sessionId`. Idempotent. */
export function markTainted(db: Database, sessionId: string, containerId: string, now = Date.now()): void {
  db.query(`INSERT OR IGNORE INTO session_taints (container_id, session_id, created_at) VALUES (?,?,?)`)
    .run(containerId, sessionId, now);
}

/** Docker ids of the session's containers that were ever shared. */
export function taintedContainerIds(db: Database, sessionId: string): string[] {
  return (db.query(`SELECT container_id FROM session_taints WHERE session_id=?`).all(sessionId) as { container_id: string }[])
    .map((r) => r.container_id);
}

/** Sessions that have at least one taint row (regardless of whether the container is still alive). */
export function sessionsWithTaint(db: Database): Set<string> {
  return new Set((db.query(`SELECT DISTINCT session_id FROM session_taints`).all() as { session_id: string }[]).map((r) => r.session_id));
}

/** Is the session tainted? `currentContainerId`:
 *  - string = docker id of the container the session currently has → the taint applies only if it is
 *    one of the shared containers;
 *  - null = the container does not exist (removed, rebuild in progress) → nothing tainted is running;
 *  - undefined = we do not know (docker inspect has not run yet / failed) → fail-closed: applies
 *    if the session has any taint row. */
export function isTainted(db: Database, sessionId: string, currentContainerId: string | null | undefined): boolean {
  const ids = taintedContainerIds(db, sessionId);
  if (ids.length === 0) return false;
  if (currentContainerId === undefined) return true;
  if (currentContainerId === null) return false;
  return ids.includes(currentContainerId);
}

/** Cleanup: rows whose session no longer exists, or whose session provably has a different
 *  (new) container. `current` = session → docker id from a fresh inspect; a session that is
 *  missing from the map (the container does not exist right now, inspect did not return it) is NOT CLEANED. */
export function pruneTaints(db: Database, current: Map<string, string>): number {
  let removed = 0;
  const rows = db.query(`SELECT st.container_id AS container_id, st.session_id AS session_id, s.id AS live
    FROM session_taints st LEFT JOIN sessions s ON s.id = st.session_id`).all() as { container_id: string; session_id: string; live: string | null }[];
  for (const r of rows) {
    const now = current.get(r.session_id);
    if (r.live === null || (now !== undefined && now !== r.container_id)) {
      db.query(`DELETE FROM session_taints WHERE container_id=?`).run(r.container_id);
      removed++;
    }
  }
  return removed;
}

/** Docker id of container `name`, null = the container does not exist. Any other docker error → exception
 *  (the caller decides fail-closed). */
export async function dockerContainerId(name: string, exec: Exec = run): Promise<string | null> {
  const r = await exec(["docker", "inspect", "--type", "container", "-f", "{{.Id}}", name], { timeoutMs: timeoutFor("DOCKER_QUERY") });
  if (r.timedOut) throw new Error("docker inspect timed out");
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  if (/No such container|No such object/i.test(r.stderr)) return null;
  throw new Error(r.stderr.trim() || `docker inspect exited with code ${r.code}`);
}

/** Stops the session's dind sidecar and verifies that it really is not running (nonexistent sidecar = OK).
 *  The data (`dind-<id>-data`) stays. The sidecar has `--restart unless-stopped`, so once manually
 *  stopped it does not come back on its own even after a docker restart; only ensureDind starts it again, and that
 *  does not do so for a shared/tainted session. Failure → exception with the reason. */
export async function stopDindSidecar(session: string, exec: Exec = run): Promise<void> {
  const name = dindName(session);
  const stop = await exec(["docker", "stop", name], { timeoutMs: timeoutFor("DOCKER_LIFECYCLE") });
  if (stop.code !== 0 && !/No such container/i.test(stop.stderr)) {
    throw new Error(stop.timedOut ? "docker stop timed out" : stop.stderr.trim() || `docker stop exited with code ${stop.code}`);
  }
  const st = await exec(["docker", "inspect", "--type", "container", "-f", "{{.State.Running}}", name], { timeoutMs: timeoutFor("DOCKER_QUERY") });
  if (st.code !== 0 && /No such container|No such object/i.test(st.stderr)) return;
  if (st.code !== 0) throw new Error(st.stderr.trim() || `docker inspect exited with code ${st.code}`);
  if (st.stdout.trim() !== "false") throw new Error(`sidecar ${name} is still running after docker stop`);
}
