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

export async function preserveForEnd(container: string, exec: Exec = run, guardInstalled = () => existsSync(STORAGE_GUARD)): Promise<void> {
  if (!guardInstalled()) return;
  // Without a container there is nothing to protect or delete — prepare-end would fail on the inspect.
  const inspect = await exec(["/usr/bin/docker", "inspect", "-f", "{{.Id}}", container], { timeoutMs: 15_000 });
  if (inspect.code !== 0 && /No such/i.test(inspect.stderr)) return;
  const r = await exec([STORAGE_GUARD, "prepare-end", container], { timeoutMs: PREPARE_TIMEOUT_MS });
  if (r.timedOut) throw new Error(`backup before ending did not finish within ${PREPARE_TIMEOUT_MS / 3_600_000} h`);
  if (r.code !== 0) throw new Error(`backup before ending failed: ${r.stderr.trim().split("\n").pop() ?? `rc=${r.code}`}`);
}
