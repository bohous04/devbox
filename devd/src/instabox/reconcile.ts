import type { Database } from "bun:sqlite";
import { getInstaboxBase, listSessions, setSessionInstaboxTsIp } from "../db";
import { forgetInstaboxIp } from "../network";
import type { InstaboxClient } from "./client";

export interface IbxStatus {
  enabled: true; ok: boolean; error?: string;
  machines: number; devboxMachines: number; maxMachines: number; storedBytes: number; maxStoredBytes: number;
  base: { snapshotId: string; builtAt: number; stale: boolean } | null;
  orphans: { id: string; name: string; state: string }[];
  /** Base build machines (`devbox=base-build`) when no build is running — a leftover after a devd
   *  crash or a failed cleanup. They are deleted the same way as orphaned machines (I5b). */
  buildLeftovers: { id: string; name: string; state: string }[];
  lost: string[];
}
export interface ReconcileOpts {
  /** Is BaseBuilder running right now? Then its machine is not a leftover. No function = nothing runs. */
  buildRunning?: () => boolean;
}

// Compares devbox=1 machines with sessions in the DB. Deletes nothing — orphaned machines and lost
// sessions are only reported; deletion is always a manual action from the dashboard (work could be lost).
// The lost/unreachable states are not written to the DB (spec, Clarifications); they are computed here.
export async function reconcile(db: Database, client: InstaboxClient, localImageDigest: () => Promise<string | null>, opts: ReconcileOpts = {}): Promise<IbxStatus> {
  const b = getInstaboxBase(db);
  const digest = await localImageDigest().catch(() => null);
  const base = b ? { snapshotId: b.snapshot_id, builtAt: b.built_at, stale: digest !== null && digest !== b.image_digest } : null;
  try {
    const buildRunning = opts.buildRunning?.() ?? false;
    const [machines, usage, builds] = await Promise.all([
      client.list({ devbox: "1" }), client.usage(),
      buildRunning ? Promise.resolve([]) : client.list({ devbox: "base-build" }),
    ]);
    const sessions = listSessions(db).filter((s) => s.host === "instabox");
    // Orphaned = no session has it in instabox_machine_id (I5a). Going by metadata.session
    // does not work: a session id is recycled after the session ends and the old machine would hide
    // behind the new session. The only exception is a session whose create has not yet written the
    // machine id (the window between client.create and setSessionInstabox) — its machine is recognized by metadata.
    const owned = new Set(sessions.flatMap((s) => (s.instabox_machine_id ? [s.instabox_machine_id] : [])));
    const creating = new Set(sessions.filter((s) => !s.instabox_machine_id).map((s) => s.id));
    const live = new Set(machines.map((m) => m.id));
    const lost = sessions.filter((s) => s.instabox_machine_id && !live.has(s.instabox_machine_id));
    // The lost session's machine no longer exists → its tailnet IP may be assigned to another device;
    // approval gates stop banning it (C1).
    for (const s of lost) {
      if (!s.instabox_ts_ip) continue;
      forgetInstaboxIp(s.instabox_ts_ip);
      setSessionInstaboxTsIp(db, s.id, null);
    }
    const view = (m: { id: string; name: string; state: string }) => ({ id: m.id, name: m.name, state: m.state });
    return {
      enabled: true, ok: true,
      machines: usage.machines, devboxMachines: machines.length, maxMachines: usage.maxMachines,
      storedBytes: usage.storedBytes, maxStoredBytes: usage.maxStoredBytes, base,
      orphans: machines.filter((m) => !owned.has(m.id) && !creating.has(m.metadata.session ?? "")).map(view),
      buildLeftovers: builds.map(view),
      lost: lost.map((s) => s.id),
    };
  } catch (e) {
    return { enabled: true, ok: false, error: (e as Error).message, machines: 0, devboxMachines: 0, maxMachines: 0, storedBytes: 0, maxStoredBytes: 0, base, orphans: [], buildLeftovers: [], lost: [] };
  }
}

/** Deletes a machine ONLY when reconcile reports it as orphaned (devbox=1 that no
 *  session owns) or as a base build leftover (devbox=base-build, no build running). A session's
 *  machine, a running base build or other machines of the account (vps02) cannot be deleted this way.
 *  An API outage throws: the route returns it as 502, not as "not orphaned". */
export async function killOrphan(db: Database, client: InstaboxClient, machineId: string, opts: ReconcileOpts = {}): Promise<boolean> {
  const st = await reconcile(db, client, async () => null, opts);
  if (!st.ok) throw new Error(st.error ?? "InstaBox API unavailable");
  if (![...st.orphans, ...st.buildLeftovers].some((o) => o.id === machineId)) return false;
  return client.kill(machineId);
}

/** Status for the dashboard: fresh (within `ttlMs`) from cache, otherwise recomputed. Concurrent calls
 *  share one running computation — the panel and the form ask at once and each query = 2 API calls. */
export function createStatusCache(compute: () => Promise<IbxStatus>, ttlMs: number, now: () => number = Date.now) {
  let cache: { at: number; value: IbxStatus } | null = null;
  let inflight: Promise<IbxStatus> | null = null;
  const refresh = (): Promise<IbxStatus> => inflight ??= compute()
    .then((value) => { cache = { at: now(), value }; return value; })
    .finally(() => { inflight = null; });
  return {
    get: (): Promise<IbxStatus> => (cache && now() - cache.at < ttlMs ? Promise.resolve(cache.value) : refresh()),
    refresh,
    current: (): IbxStatus | null => cache?.value ?? null,
  };
}
