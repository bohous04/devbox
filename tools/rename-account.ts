// Renames an account in the pool (the id is also the docker volume name and the profile path).
//
// Run ON THE VPS, where docker and the DB live:
//   bun tools/rename-account.ts <old-id> <new-id>            # dry-run (default)
//   bun tools/rename-account.ts <old-id> <new-id> --commit   # real run
//
// The mac is handled separately and is just `mv ~/.claude-pool/accounts/<old> <new>`:
// symlinks in the profile point into ~/.claude and none contains the id, and `.credentials.json`
// in the config dir is enough even without a Keychain entry (verified for real — `claude auth
// status` from a path whose hash is not in the Keychain reports loggedIn:true).
//
// Docker CANNOT rename a volume, so the content is copied into a new one and the old one is deleted
// only after verifying that the credentials in the new one are valid.

import { Database } from "bun:sqlite";
import { isValidAccountId, profileVolume } from "../devd/src/accountProfiles";
import { parseCredentials } from "../devd/src/accountTokens";

const DB_PATH = process.env.DEVD_DB ?? "/var/lib/devd/devd.sqlite";
const IMAGE = process.env.DEVD_IMAGE ?? "devbox:latest";

export type PlanAction = "rename" | "already-done" | "refuse";
/** `deleteOld: false` = the old volume is left on disk because running
 *  containers hold it. This is not a half-done migration: the DB and the new volume are done, only cleanup
 *  waits for a recreate. The caller MUST print this so it is not forgotten — a live
 *  refresh token sits there. */
export interface RenamePlan { action: PlanAction; reason: string; deleteOld: boolean }

/** Decides what to do — a PURE function over the detected state, so it can be tested without
 *  docker and the DB. `oldInDb`/`newInDb` are the existence of a row in `anthropic_accounts`,
 *  `busyContainers` is the number of RUNNING containers holding the old volume. */
export function renamePlan(o: {
  oldId: string; newId: string;
  oldInDb: boolean; newInDb: boolean;
  oldVolume: boolean; newVolume: boolean;
  /** RUNNING containers holding the old volume — they matter when deciding whether
   *  the migration interrupts anyone. */
  busyContainers: number;
  /** ALL containers referencing the volume, including stopped ones. `docker
   *  volume rm` is blocked even by a stopped container, so cleanup follows this number,
   *  not `busyContainers` (in a real run the migration first ended with "volume is in
   *  use" from a container that had been stopped a moment earlier). If missing, it is derived
   *  from `busyContainers` — older callers do not break. */
  refCount?: number;
  /** Keep the containers holding the old volume running (migration without downtime). */
  allowBusy?: boolean;
}): RenamePlan {
  const no = (reason: string): RenamePlan => ({ action: "refuse", reason, deleteOld: false });

  if (!isValidAccountId(o.oldId)) return no(`invalid old id: ${o.oldId}`);
  if (!isValidAccountId(o.newId)) return no(`invalid new id: ${o.newId}`);
  if (o.oldId === o.newId) return no("old and new id are the same");

  // Idempotence: a finished (or manually completed) move is recognized by the target
  // being in the DB and the source no longer. A repeated run must then do nothing and not crash —
  // the migration is routinely rerun after an interruption.
  if (!o.oldInDb && o.newInDb) return { action: "already-done", reason: "account is already renamed", deleteOld: false };

  if (!o.oldInDb) return no(`account ${o.oldId} is not in the DB`);
  if (o.newInDb) return no(`account ${o.newId} already exists in the DB — the id must not be overwritten`);
  if (!o.oldVolume) return no(`volume ${profileVolume(o.oldId)} does not exist`);

  // Half-done attempt: the target volume exists but the DB row does not. We will not delete someone else's volume
  // blindly — the content may be half-copied and we cannot tell the difference.
  if (o.newVolume) {
    return no(`volume ${profileVolume(o.newId)} already exists (left over from an interrupted migration?) — delete it manually and run again`);
  }

  // A running container holds the old volume, so `docker volume rm` will not free it.
  //
  // With `--allow-busy` the migration still completes and the old volume is just LEFT on disk:
  // nothing changes under the running agents (their CLAUDE_CONFIG_DIR still points to the
  // mounted old path), and every NEW Claude session in such a container
  // gets a lease on the new id, whose mount it lacks — `account-lease` stays silent in that case
  // and falls back to the shared claude-home. Fail-open, not a logged-out agent (verified
  // in image/account-lease.sh: `[ -d "$ROOT/$acct" ] || exit 0`). The cost is that those
  // sessions do not go through the pool until a recreate.
  if (o.busyContainers > 0 && !o.allowBusy) {
    return no(`${o.busyContainers} running containers hold ${profileVolume(o.oldId)} — stop the sessions, or add --allow-busy (the old volume then stays on disk)`);
  }

  // Cleanup follows ALL references, not just running ones: `docker volume rm` refuses
  // even because of a stopped container.
  const refs = o.refCount ?? o.busyContainers;
  return { action: "rename", reason: `${o.oldId} → ${o.newId}`, deleteOld: refs === 0 };
}

async function sh(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

async function volumeExists(name: string): Promise<boolean> {
  return (await sh(["docker", "volume", "inspect", name])).code === 0;
}

/** `all: true` also counts stopped containers — `docker volume rm` is blocked by those too. */
async function containersUsing(volume: string, all = false): Promise<number> {
  const r = await sh(["docker", "ps", ...(all ? ["-a"] : []), "-q", "--filter", `volume=${volume}`]);
  return r.stdout.split("\n").filter((l) => l.trim() !== "").length;
}

async function main(): Promise<void> {
  const [oldId, newId, ...rest] = process.argv.slice(2);
  const commit = rest.includes("--commit");
  const allowBusy = rest.includes("--allow-busy");
  if (!oldId || !newId) {
    console.error("usage: bun tools/rename-account.ts <old-id> <new-id> [--commit] [--allow-busy]");
    process.exit(2);
  }

  const db = new Database(DB_PATH);
  // `!= null` on purpose (not `!== null`): bun:sqlite returns null for an empty result,
  // but undefined would pass here as "row exists" and the migration would overwrite someone else's id.
  const has = (id: string) =>
    (db.query("SELECT 1 FROM anthropic_accounts WHERE id=?").get(id) as unknown) != null;

  const plan = renamePlan({
    oldId, newId,
    oldInDb: has(oldId), newInDb: has(newId),
    oldVolume: await volumeExists(profileVolume(oldId)),
    newVolume: await volumeExists(profileVolume(newId)),
    busyContainers: await containersUsing(profileVolume(oldId)),
    refCount: await containersUsing(profileVolume(oldId), true),
    allowBusy,
  });

  console.log(`plan: ${plan.action} — ${plan.reason}`);
  if (plan.action === "already-done") return;
  if (plan.action === "refuse") process.exit(1);
  if (!commit) {
    console.log("(dry-run; add --commit for the real run)");
    return;
  }

  const from = profileVolume(oldId);
  const to = profileVolume(newId);

  // 1) copy the content. `cp -a` keeps symlinks and permissions; chown because a fresh
  //    volume has a root:root mountpoint, while the container runs as uid 1000.
  console.log(`copying ${from} → ${to}`);
  const cp = await sh([
    "docker", "run", "--rm", "-u", "0",
    "-v", `${from}:/from:ro`, "-v", `${to}:/to`,
    IMAGE, "sh", "-c", "cp -a /from/. /to/ && chown -R 1000:1000 /to && chmod 700 /to",
  ]);
  if (cp.code !== 0) {
    console.error(`copy failed: ${cp.stderr.trim().slice(0, 300)}`);
    process.exit(1);
  }

  // 2) verification BEFORE deleting anything. The blob is only parsed, never printed.
  const read = await sh(["docker", "run", "--rm", "-u", "0", "-v", `${to}:/p`, IMAGE, "cat", "/p/.credentials.json"]);
  if (read.code !== 0 || parseCredentials(read.stdout) === null) {
    console.error(`${to} has no usable credentials — the old volume STAYS, clean up ${to} and try again`);
    process.exit(1);
  }
  console.log(`verified: ${to} has valid credentials`);

  // 3) DB in a single transaction — leases and usage reference the id, not a foreign key.
  db.transaction(() => {
    db.query("UPDATE anthropic_accounts SET id=? WHERE id=?").run(newId, oldId);
    db.query("UPDATE account_usage SET account_id=? WHERE account_id=?").run(newId, oldId);
    db.query("UPDATE account_leases SET account_id=? WHERE account_id=?").run(newId, oldId);
  })();
  console.log("DB updated");

  // 4) only now the old volume — and only if nobody holds it
  if (plan.deleteOld) {
    const rm = await sh(["docker", "volume", "rm", "-f", from]);
    if (rm.code !== 0) console.error(`WARNING: could not delete ${from} (${rm.stderr.trim().slice(0, 200)}) — delete it manually, it holds a live refresh token`);
    else console.log(`${from} deleted`);
  } else {
    console.log(`CLEANUP LEFT: ${from} is held by running containers and stays on disk with a live`);
    console.log(`  refresh token. After recreating all sessions: docker volume rm ${from}`);
  }

  console.log(`done. Don't forget on the Mac: \`mv ~/.claude-pool/accounts/${oldId} ~/.claude-pool/accounts/${newId}\`.`);
}

if (import.meta.main) await main();
