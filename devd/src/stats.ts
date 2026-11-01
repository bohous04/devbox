import { statfsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getSession, upsertGitStat, type SessionRow } from "./db";
import { sh } from "./git";
import { run as runProc, timeoutFor } from "./proc";

type R = { code: number; stdout: string; stderr: string };
export type Runner = (cwd: string, ...cmd: string[]) => R | Promise<R>;
const defaultRun: Runner = (cwd, ...cmd) => sh(cwd, ...cmd);

export interface GitStat { commits: number; added: number; removed: number; unpushed: number }

export async function collectGitStats(dir: string, run: Runner = defaultRun): Promise<GitStat> {
  const zero = { commits: 0, added: 0, removed: 0, unpushed: 0 };
  // devd runs as root, but workspaces are bind-mounted and owned by the container
  // user (uid 1000). Every git call must trust the dir explicitly, otherwise git
  // aborts with "detected dubious ownership" (exit 128) and we'd silently record
  // zeros — the real cause of "dashboard counts commits wrong".
  const git = (...args: string[]) => run(dir, "git", "-c", `safe.directory=${dir}`, ...args);
  try {
    const log = await git("log", "--since=midnight", "--oneline");
    if (log.code !== 0) return zero;
    const commits = log.stdout.split("\n").filter((l) => l.trim()).length;
    const numstat = await git("diff", "--numstat");
    let added = 0, removed = 0;
    for (const line of numstat.stdout.split("\n")) {
      const [a, r] = line.split("\t");
      if (a && r && a !== "-" && r !== "-") { added += parseInt(a, 10) || 0; removed += parseInt(r, 10) || 0; }
    }
    const rev = await git("rev-list", "--count", "@{u}..HEAD");
    const unpushed = rev.code === 0 ? parseInt(rev.stdout.trim(), 10) || 0 : 0;
    return { commits, added, removed, unpushed };
  } catch { return zero; }
}

/** One step of the stats tick for one session: collects git stats and writes them,
 *  BUT only if the session has not disappeared in the meantime. `collectGitStats` is three git subprocesses
 *  and the stats tick now yields the event loop between sessions (see index.ts) — so an
 *  `end()` can happen in between, which deletes the row in `git_stats` (`deleteGitStat`). Without this
 *  re-check the row would be written AGAIN after the deletion and would stay there forever: `git_stats`
 *  has no FK to `sessions` and nothing else deletes from it — an orphaned row would permanently
 *  inflate the dashboard totals (totalUnpushed, totalCommitsToday).
 *
 *  Returns whether it wrote (for tests) — the production caller does not need the return
 *  value. */
export async function collectSessionGitStat(
  db: Database, s: SessionRow, ws: string, collect: (dir: string) => Promise<GitStat> = collectGitStats,
): Promise<boolean> {
  const stat = await collect(ws);
  if (!getSession(db, s.id)) return false; // ended during await → the row would be orphaned
  upsertGitStat(db, s.id, stat);
  return true;
}

export type StatFs = (path: string) => { bsize: number; blocks: number; bfree: number };

// Used bytes of the filesystem holding `path`, via statfs — constant time. The former
// `du -sk /srv/dev` walked ~660 GB / millions of files every 2 min, took up to minutes
// and kept IO pressure ~20 % (2026-10-13). It also missed what actually fills the disk
// (docker/containerd data), which statfs counts.
export async function collectDiskUsage(path: string, stat: StatFs = statfsSync): Promise<number> {
  try {
    const s = stat(path);
    const used = (s.blocks - s.bfree) * s.bsize;
    return Number.isFinite(used) && used > 0 ? used : 0;
  } catch { return 0; }
}

export interface DockerStat { container: string; cpuPct: number; memBytes: number }

// Whole bytes — the iOS app decodes `memBytes` from /api/stats/live as Int, fractional bytes
// (e.g. 1683627180.032) would break decoding.
export function parseMem(s: string): number {
  const m = s.split("/")[0].trim().match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
    KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(n * (mult[unit] ?? 1));
}

// Shared between the collectors below so the `docker stats --format {{json .}}`
// line parsing (and its tolerance for bad/partial lines) lives in one place.
function parseDockerStatsOutput(stdout: string): DockerStat[] {
  const out: DockerStat[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      // For `docker stats` without arguments, `Container` is the full ID, not the name — sessions are
      // matched by name, so without `Name` every session had 0 % CPU and 0 B RAM.
      const j = JSON.parse(line) as { Name?: string; Container: string; CPUPerc: string; MemUsage: string };
      out.push({ container: j.Name || j.Container, cpuPct: parseFloat(j.CPUPerc) || 0, memBytes: parseMem(j.MemUsage) });
    } catch { /* skip bad line */ }
  }
  return out;
}

export async function collectDockerStats(run: Runner = defaultRun): Promise<DockerStat[]> {
  try {
    const r = await run(process.cwd(), "docker", "stats", "--no-stream", "--format", "{{json .}}");
    if (r.code !== 0) return [];
    return parseDockerStatsOutput(r.stdout);
  } catch { return []; }
}

// Name kept for index.ts; today just an alias — there is no own Bun.spawn here anymore.
export const collectDockerStatsAsync = (): Promise<DockerStat[]> =>
  collectDockerStats((cwd, ...cmd) => runProc(cmd, { cwd, timeoutMs: timeoutFor("DOCKER_QUERY") }));

export type ClaudeState = "working" | "waiting" | "idle";

export function classifyClaudeState(lastMetricTs: number | null, lastActiveTs: number, now: number): ClaudeState {
  if (lastMetricTs !== null && now - lastMetricTs < 30_000) return "working";
  // "idle" (grey "offline") only when BOTH activity axes have gone quiet: the last prompt and the last
  // metric. An autonomously working session (prompt long ago, but tokens flowing) thus, on a short
  // gap between exports (>30 s), drops to "waiting", not to "idle" — otherwise the dashboard and CLI
  // would show a working session as offline.
  const lastAny = Math.max(lastActiveTs, lastMetricTs ?? 0);
  if (now - lastAny > 10 * 60_000) return "idle";
  return "waiting";
}
