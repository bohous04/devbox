import type { Database } from "bun:sqlite";
import { run, type RunOpts as ProcRunOpts, type RunResult } from "./proc";

// Session container → where its docker daemon runs. VPS sessions go to the local socket,
// running InstaBox sessions via `docker -H ssh://ibx-<machine>` (the host block is held by
// instabox/ssh.ts). A module map instead of deps everywhere: docker for a session is called from ~10
// places (pty, tmux probe, critic, ccUpkeep, watchdog, accountSwitch…) and all of them know only the
// container name. A paused session has NO alias — SSH via the InstaBox gateway would wake the machine
// up, so a probe on a stopped session must end locally as "no container".
const remote = new Map<string, string>();
let authRefresher: ((container: string) => Promise<void>) | null = null;

// This is how the gateway rejects an expired/revoked certificate. Other errors are not retried.
const SSH_AUTH_FAILURE = /Permission denied \(publickey/;

export function ibxAlias(machineId: string): string { return `ibx-${machineId}`; }

export function setRemoteDocker(container: string, alias: string | null): void {
  if (alias) remote.set(container, alias); else remote.delete(container);
}

export function remoteDockerAlias(container: string): string | null { return remote.get(container) ?? null; }

export function dockerArgv(container?: string): string[] {
  const alias = container ? remote.get(container) : undefined;
  return alias ? ["docker", "-H", `ssh://${alias}`] : ["docker"];
}

export function loadRemoteDockers(db: Database): void {
  const rows = db.query(`SELECT container, instabox_machine_id FROM sessions WHERE host='instabox' AND status='running' AND instabox_machine_id IS NOT NULL`)
    .all() as { container: string; instabox_machine_id: string }[];
  for (const r of rows) setRemoteDocker(r.container, ibxAlias(r.instabox_machine_id));
}

/** Who can renew the machine's SSH certificate (index.ts → InstaboxSsh.ensure(force)). */
export function setRemoteAuthRefresher(fn: ((container: string) => Promise<void>) | null): void { authRefresher = fn; }

/** `docker <args>` against the daemon where the container runs. Spec, error states: "SSH certificate
 *  expired → renew it and retry the command once". `exec` is injected for tests. */
export async function runDocker(container: string | undefined, args: string[], opts: ProcRunOpts, exec: typeof run = run): Promise<RunResult> {
  const r = await exec([...dockerArgv(container), ...args], opts);
  if (!container || !remote.has(container) || r.code === 0 || !authRefresher || !SSH_AUTH_FAILURE.test(r.stderr)) return r;
  // Certificate renewal goes through the InstaBox API — if it fails, we return the original docker error.
  // Callers (execInContainer…) rely on runDocker not throwing.
  try { await authRefresher(container); } catch { return r; }
  return exec([...dockerArgv(container), ...args], opts);
}
