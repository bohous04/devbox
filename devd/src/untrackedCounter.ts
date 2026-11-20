import { lstatSync, realpathSync } from "node:fs";
import { run as procRun, type RunOpts, type RunResult } from "./proc";

/**
 * Line counts (COUNTER_JS) and content for the per-file diff (READER_JS) of untracked files in
 * an agent-controlled worktree.
 *
 * Not read by devd itself: devd runs as root, and the agent can swap any path component at any
 * time — O_NOFOLLOW only guards the last one, so root could be made to open a host file or a
 * device (`sub` → /dev: opening /dev/watchdog arms it). The counting therefore runs in a child
 * process under the worktree owner's uid/gid (setpriv, as in sshAgent.ts), which can open only
 * what the agent could open anyway. Inside, it keeps O_NOFOLLOW, the regular-file check and a
 * realpath check (stay inside the worktree — other sessions' trees belong to the same uid).
 *
 * Bun itself must not pick anything up from the agent: it loads `bunfig.toml` (preload = code)
 * and `.env` from its cwd and config from HOME. So: cwd "/", `--config=/dev/null`,
 * `--no-env-file`, `--no-install`, and an environment of only PATH and HOME=/nonexistent (devd's
 * own env carries secrets). The worktree's realpath goes in on stdin; the child joins paths.
 * Why bun and not coreutils (`wc -l` under setpriv): wc follows symlinks and has no
 * regular-file/NUL checks; rebuilding O_NOFOLLOW + fstat + inode check in shell is not simpler.
 */

/** Runs in the child (`bun -e`, so the source needs no file readable by the owner).
 *  stdin: {root, paths, maxBytes, budget}; stdout: {counts: (number|null)[], capped}. */
export const COUNTER_JS = `
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
const { root, paths: rel, maxBytes, budget: total } = JSON.parse(await Bun.stdin.text());
const paths = rel.map((p) => join(root, p));
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

/** Runs `js` (`bun -e`) under the worktree owner with `input` on stdin; see the header for the
 *  hardening. `{unavailable}` = the child could not run or failed. */
async function ownerChild(ws: string, js: string, input: Record<string, unknown>, deps: CounterDeps): Promise<{ stdout: string } | { unavailable: string }> {
  const child = [process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", "-e", js];
  let root: string;
  try { root = realpathSync(ws); } catch (e) { return { unavailable: `cannot resolve the worktree: ${(e as Error).message}` }; }
  let cmd: string[];
  if (deps.myUid === 0) {
    let owner: { uid: number; gid: number };
    try { owner = deps.ownerOf(ws); } catch (e) { return { unavailable: `cannot read the worktree owner: ${(e as Error).message}` }; }
    if (owner.uid === 0) throw new RootOwnedError("session worktree is owned by root");
    cmd = ["setpriv", `--reuid=${owner.uid}`, `--regid=${owner.gid}`, "--clear-groups", ...child];
  } else {
    // devd is not root (tests, dev machines): running as devd's own uid gains no privilege
    // over what devd already has, and a non-root process could not switch uid anyway.
    cmd = child;
  }
  const r = await deps.run(cmd, {
    cwd: "/", inheritEnv: false, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent" },
    stdin: JSON.stringify({ root, ...input }), timeoutMs: TIMEOUT_MS,
  });
  if (r.timedOut) return { unavailable: "child timed out" };
  if (r.code !== 0) return { unavailable: `child exited ${r.code}: ${r.stderr.trim().slice(0, 500)}` };
  if (r.stdout.length > MAX_OUTPUT) return { unavailable: "child output too large" };
  return { stdout: r.stdout };
}

export async function countUntracked(
  ws: string, paths: string[], limits: { maxBytes: number; budget: number }, deps: CounterDeps = defaultDeps(),
): Promise<CountResult> {
  if (!paths.length) return { counts: [], capped: false };
  const r = await ownerChild(ws, COUNTER_JS, { paths, ...limits }, deps);
  if ("unavailable" in r) return r;
  let out: { counts?: unknown; capped?: unknown };
  try { out = JSON.parse(r.stdout); } catch { return { unavailable: "counter output is not JSON" }; }
  const counts = out.counts;
  if (!Array.isArray(counts) || counts.length !== paths.length || !counts.every((c) => c === null || (Number.isInteger(c) && c >= 0))) {
    return { unavailable: "counter output is malformed" };
  }
  return { counts: counts as (number | null)[], capped: out.capped === true };
}

/** Sibling of COUNTER_JS for the per-file diff: the first `maxBytes` of one untracked file, with
 *  the same checks. stdin: {root, path, maxBytes}; stdout: {ok:false} or
 *  {ok:true, binary, truncated, exec, content(base64)}. */
export const READER_JS = `
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
const { root, path, maxBytes } = JSON.parse(await Bun.stdin.text());
const p = join(root, path);
const read = () => {
  let fd;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return { ok: false }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false };
    const real = realpathSync(p);
    if (real !== root && !real.startsWith(root + "/")) return { ok: false };
    const at = statSync(real);
    if (at.dev !== st.dev || at.ino !== st.ino) return { ok: false };
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const data = buf.subarray(0, readSync(fd, buf, 0, len, 0));
    const binary = data.includes(0);
    return { ok: true, binary, truncated: st.size > data.length, exec: (st.mode & 0o111) !== 0, content: binary ? "" : data.toString("base64") };
  } catch { return { ok: false }; } finally { closeSync(fd); }
};
process.stdout.write(JSON.stringify(read()));
`;

export type ReadResult =
  | { ok: false }
  | { ok: true; binary: boolean; truncated: boolean; exec: boolean; content: string }
  | { unavailable: string };

/** One untracked file's content (UTF-8, at most `maxBytes`), read by the owner child. */
export async function readUntracked(ws: string, path: string, maxBytes: number, deps: CounterDeps = defaultDeps()): Promise<ReadResult> {
  const r = await ownerChild(ws, READER_JS, { path, maxBytes }, deps);
  if ("unavailable" in r) return r;
  let out: { ok?: unknown; binary?: unknown; truncated?: unknown; exec?: unknown; content?: unknown };
  try { out = JSON.parse(r.stdout); } catch { return { unavailable: "reader output is not JSON" }; }
  if (out.ok === false) return { ok: false };
  if (out.ok !== true || typeof out.binary !== "boolean" || typeof out.truncated !== "boolean" || typeof out.exec !== "boolean" || typeof out.content !== "string") {
    return { unavailable: "reader output is malformed" };
  }
  return { ok: true, binary: out.binary, truncated: out.truncated, exec: out.exec, content: Buffer.from(out.content, "base64").toString("utf8") };
}
