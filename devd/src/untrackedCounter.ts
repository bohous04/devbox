import { lstatSync } from "node:fs";
import { run as procRun, type RunOpts, type RunResult } from "./proc";

/**
 * Line counts of untracked files in an agent-controlled worktree.
 *
 * Not read by devd itself: devd runs as root, and the agent can swap any path component at any
 * time — O_NOFOLLOW only guards the last one, so root could be made to open a host file or a
 * device (`sub` → /dev: opening /dev/watchdog arms it). The counting therefore runs in a child
 * process under the worktree owner's uid/gid (setpriv, as in sshAgent.ts), which can open only
 * what the agent could open anyway. Inside, it keeps O_NOFOLLOW, the regular-file check and a
 * realpath check (stay inside the worktree — other sessions' trees belong to the same uid).
 */

/** Runs in the child (`bun -e`, so the source needs no file readable by the owner).
 *  stdin: {paths, maxBytes, budget}; stdout: {counts: (number|null)[], capped}. */
export const COUNTER_JS = `
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
const { paths, maxBytes, budget: total } = JSON.parse(await Bun.stdin.text());
const root = realpathSync(".");
let budget = total, capped = false;
const count = (p) => {
  let fd;
  // O_NONBLOCK: a FIFO would otherwise block the open forever.
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    if (st.size > budget) { capped = true; return null; }
    const real = realpathSync(p);
    if (real !== root && !real.startsWith(root + "/")) return null;
    const at = statSync(real);
    if (at.dev !== st.dev || at.ino !== st.ino) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    if (n !== st.size || buf.includes(0)) return null;
    budget -= n;
    let lines = 0;
    for (const b of buf) if (b === 10) lines++;
    if (n > 0 && buf[n - 1] !== 10) lines++;
    return lines;
  } catch { return null; } finally { closeSync(fd); }
};
const counts = paths.map(count);
process.stdout.write(JSON.stringify({ counts, capped }));
`;

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 1024 * 1024;

export interface CounterDeps {
  myUid: number;
  ownerOf: (ws: string) => { uid: number; gid: number };
  run: (cmd: string[], opts: RunOpts) => Promise<RunResult>;
}
const defaultDeps = (): CounterDeps => ({
  myUid: process.getuid?.() ?? -1,
  ownerOf: (ws) => { const st = lstatSync(ws); return { uid: st.uid, gid: st.gid }; },
  run: procRun,
});

export type CountResult = { counts: (number | null)[]; capped: boolean } | { unavailable: string };

/** `{unavailable}` is an explicit "not counted" (logged by the caller), never zeros. Throws
 *  `RootOwnedError` for a root-owned worktree: no uid to drop to. */
export class RootOwnedError extends Error {}

export async function countUntracked(
  ws: string, paths: string[], limits: { maxBytes: number; budget: number }, deps: CounterDeps = defaultDeps(),
): Promise<CountResult> {
  if (!paths.length) return { counts: [], capped: false };
  const counter = [process.execPath, "-e", COUNTER_JS];
  let cmd: string[];
  if (deps.myUid === 0) {
    let owner: { uid: number; gid: number };
    try { owner = deps.ownerOf(ws); } catch (e) { return { unavailable: `cannot read the worktree owner: ${(e as Error).message}` }; }
    if (owner.uid === 0) throw new RootOwnedError("session worktree is owned by root");
    cmd = ["setpriv", `--reuid=${owner.uid}`, `--regid=${owner.gid}`, "--clear-groups", ...counter];
  } else {
    // devd is not root (tests, dev machines): running as devd's own uid gains no privilege
    // over what devd already has, and a non-root process could not switch uid anyway.
    cmd = counter;
  }
  const r = await deps.run(cmd, { cwd: ws, stdin: JSON.stringify({ paths, ...limits }), timeoutMs: TIMEOUT_MS });
  if (r.timedOut) return { unavailable: "counter timed out" };
  if (r.code !== 0) return { unavailable: `counter exited ${r.code}: ${r.stderr.trim().slice(0, 500)}` };
  if (r.stdout.length > MAX_OUTPUT) return { unavailable: "counter output too large" };
  let out: { counts?: unknown; capped?: unknown };
  try { out = JSON.parse(r.stdout); } catch { return { unavailable: "counter output is not JSON" }; }
  const counts = out.counts;
  if (!Array.isArray(counts) || counts.length !== paths.length || !counts.every((c) => c === null || (Number.isInteger(c) && c >= 0))) {
    return { unavailable: "counter output is malformed" };
  }
  return { counts: counts as (number | null)[], capped: out.capped === true };
}
