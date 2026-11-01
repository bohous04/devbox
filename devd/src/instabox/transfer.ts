import { accountMountList } from "../accountProfiles";
import { codexAccountMountList } from "../codexAccountProfiles";
import { run } from "../proc";

export const SHARED_VOLUMES = ["claude-home", "codex-home", "grok-home"] as const;
export interface PoolAccountIds { claude: string[]; codex: string[] }

// Shell-quote helper — defined ONLY HERE (tasks 8 and 11 import it as `shq`).
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const COPY_TIMEOUT_MS = 15 * 60_000;
const FILE_TIMEOUT_MS = 60_000;

// Validation of id and volume names is DELIBERATELY not repeated: it comes from the mount lists that
// the session container also gets — what would not be mounted is not copied either.
export function poolVolumes(ids: PoolAccountIds): string[] {
  const volume = (m: string) => m.slice(0, m.indexOf(":"));
  return [...accountMountList(ids.claude).map(volume), ...codexAccountMountList(ids.codex).map(volume)];
}

export function volumesToCopy(ids: PoolAccountIds): string[] {
  return [...SHARED_VOLUMES, ...poolVolumes(ids)];
}

// What is NOT copied into the VM: conversation history, worktrees, logs, caches and SQLite state.
// The agent in the VM needs logins, settings, plugins and skills — not tens of GB of
// history (live: codex-home 34 GB, a pool codex account 36 GB, /data in the VM has 20 GB).
// Top-level entries as `./<name>`, SQLite files anywhere in the volume.
export const VOLUME_COPY_EXCLUDES = [
  "./sessions", "./archived_sessions", "./worktrees", "./projects", "./file-history",
  "./shell-snapshots", "./session-env", "./logs", "./log", "./.tmp", "./cache",
  "./devbox-sessions", "./generated_images", "./downloads", "./memtrace", "./backups",
  "./history.jsonl", "./hookprobe.jsonl",
  "*.sqlite", "*.sqlite-wal", "*.sqlite-shm",
] as const;

export function copyVolumeCmd(volume: string, image: string, remote: string[]): string {
  const src = ["docker", "run", "--rm", "-u", "0", "-v", `${volume}:/v:ro`, image].map(shq).join(" ");
  const dst = [...remote, "run", "--rm", "-i", "-u", "0", "-v", `${volume}:/v`, image].map(shq).join(" ");
  const excludes = VOLUME_COPY_EXCLUDES.map((e) => shq(`--exclude=${e}`)).join(" ");
  return `set -o pipefail; ${src} tar --numeric-owner ${excludes} -C /v -cf - . | ${dst} tar --numeric-owner -C /v -xf -`;
}

export function volumeReadArgv(prefix: string[], image: string, volume: string, file: string): string[] {
  return [...prefix, "run", "--rm", "-u", "0", "-v", `${volume}:/v`, image, "sh", "-c", `cat /v/${file} 2>/dev/null || exit 3`];
}

// tmp + rename: the agent in the second container must not read half-written JSON (spec §3).
export function volumeWriteArgv(prefix: string[], image: string, volume: string, file: string): string[] {
  const t = `/v/${file}.devd-tmp`;
  return [...prefix, "run", "--rm", "-i", "-u", "0", "-v", `${volume}:/v`, image, "sh", "-c",
    `umask 077; cat > ${t} && chown 1000:1000 ${t} && mv ${t} /v/${file}`];
}

const fail = (what: string, r: { timedOut: boolean; stderr: string }) =>
  new Error(`${what}: ${r.timedOut ? "timeout" : r.stderr.trim().slice(0, 300)}`);

export async function copyVolume(volume: string, image: string, remote: string[]): Promise<void> {
  const r = await run(["bash", "-c", copyVolumeCmd(volume, image, remote)], { timeoutMs: COPY_TIMEOUT_MS });
  if (r.timedOut || r.code !== 0) throw fail(`copying volume ${volume} failed`, r);
}

export async function readVolumeFile(prefix: string[], image: string, volume: string, file: string): Promise<string | null> {
  const r = await run(volumeReadArgv(prefix, image, volume, file), { timeoutMs: FILE_TIMEOUT_MS });
  if (!r.timedOut && r.code === 3) return null;
  if (r.timedOut || r.code !== 0) throw fail(`reading ${volume}/${file} failed`, r);
  return r.stdout;
}

export async function writeVolumeFile(prefix: string[], image: string, volume: string, file: string, content: string): Promise<void> {
  const r = await run(volumeWriteArgv(prefix, image, volume, file), { timeoutMs: FILE_TIMEOUT_MS, stdin: content });
  if (r.timedOut || r.code !== 0) throw fail(`writing ${volume}/${file} failed`, r);
}
