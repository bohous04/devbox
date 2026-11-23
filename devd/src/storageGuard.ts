// The storage guard on the host (infra/storage-guard) wraps /usr/local/bin/docker: it lets `docker rm`
// of a session container through only once the session is verifiably backed up offsite (Borg). That
// backup takes minutes to tens of minutes, but the wrapper waits only 40 s and then refuses the rm — End
// thus always timed out in DOCKER_LIFECYCLE (60 s) and the session could not be ended on the first try.
// That is why the backup is started here, ahead of time and with its own long cap; the rm then goes through immediately.
import { existsSync } from "node:fs";
import { run, type RunOpts, type RunResult } from "./proc";

export const STORAGE_GUARD = "/usr/local/bin/devbox-storage";
const PREPARE_TIMEOUT_MS = 4 * 3_600_000; // same cap as the systemd unit the wrapper starts

type Exec = (cmd: string[], opts: RunOpts) => Promise<RunResult>;

// prepare-end runs as its own transient unit — the very name the docker wrapper (host-docker.py preserve()) uses —
// outside devd.service's cgroup: a devd restart (a deploy) used to kill backups mid-run with devd. devd only waits on
// it; after a restart the resumed End waits for the unit an earlier devd left running and then runs prepare-end once
// more, which returns at once when that run verified (prepared/<Id>.json) and makes a fresh archive when it did not.
// No --pipe: a pipe to devd would break when devd dies and take the backup down with it; the reason is read from the journal.
const RUNNING = new Set(["activating", "active", "deactivating", "reloading"]);
const POLL_MS = 5_000;

export async function preserveForEnd(container: string, exec: Exec = run, guardInstalled = () => existsSync(STORAGE_GUARD),
  sleep: (ms: number) => Promise<void> = Bun.sleep): Promise<void> {
  if (!guardInstalled()) return;
  // Without a container there is nothing to protect or delete — prepare-end would fail on the inspect.
  const inspect = await exec(["/usr/bin/docker", "inspect", "-f", "{{.Id}}", container], { timeoutMs: 15_000 });
  if (inspect.code !== 0 && /No such/i.test(inspect.stderr)) return;
  if (inspect.code !== 0) throw new Error(`backup before ending: cannot inspect ${container}: ${inspect.stderr.trim()}`);
  const unit = `devbox-storage-end-${inspect.stdout.trim().slice(0, 12)}`;
  const deadline = Date.now() + PREPARE_TIMEOUT_MS;
  for (let clash = 0; ; clash++) {
    while (await unitRunning(exec, unit)) {
      if (Date.now() > deadline) throw new Error(`backup before ending did not finish within ${PREPARE_TIMEOUT_MS / 3_600_000} h`);
      await sleep(POLL_MS);
    }
    const r = await exec(["systemd-run", "--quiet", "--wait", "--collect", "--unit", unit, "--property=Type=oneshot",
      "--property=Nice=15", "--property=TimeoutStartSec=4h", STORAGE_GUARD, "prepare-end", container],
    { timeoutMs: Math.max(deadline - Date.now(), 1) });
    if (r.timedOut) throw new Error(`backup before ending did not finish within ${PREPARE_TIMEOUT_MS / 3_600_000} h`);
    if (r.code === 0) return;
    // The docker wrapper started the same unit between our check and our start: wait for it, then run once more.
    // A name that stays taken while nothing runs is a leftover unit, not a race: say so instead of spinning.
    if (/already exists/i.test(r.stderr) && clash < 3) { await sleep(POLL_MS); continue; }
    const journal = await exec(["journalctl", `_SYSTEMD_UNIT=${unit}.service`, "-n", "20", "-o", "cat", "--no-pager"], { timeoutMs: 15_000 });
    const why = journal.stdout.trim().split("\n").pop() || r.stderr.trim().split("\n").pop() || `rc=${r.code}`;
    throw new Error(`backup before ending failed (journalctl -u ${unit}): ${why}`);
  }
}

async function unitRunning(exec: Exec, unit: string): Promise<boolean> {
  const r = await exec(["systemctl", "show", "--property=ActiveState", "--value", unit], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`backup before ending: cannot read the state of ${unit}: ${r.stderr.trim()}`);
  return RUNNING.has(r.stdout.trim());
}
