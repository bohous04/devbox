import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ChangedFile, ChangeStatus, SessionChanges } from "../../shared/changes";
import { sh } from "./git";

/** An explicit failure the route maps to its HTTP status — never an empty list in its place. */
export class ChangesError extends Error {
  constructor(readonly status: 409 | 500, message: string) { super(message); }
}

const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
// Upper bound on what all untracked files together may make devd read per request.
const UNTRACKED_BUDGET = 32 * 1024 * 1024;

type Git = (...args: string[]) => ReturnType<typeof sh>;

/**
 * The worktree's changes: committed-but-unpushed + staged + unstaged (one `git diff <merge-base>`
 * against the working tree covers all three) + untracked files, whose lines count as added.
 *
 * Every git here goes through proc.run → safeGit.ts: the worktree is agent-controlled, so its
 * config/attributes are untrusted. Untracked files are read by devd itself (root), so they are
 * opened with O_NOFOLLOW and must be regular files — a symlink to a host file is not followed.
 */
export async function collectChanges(ws: string, limits: { maxFiles?: number; maxUntrackedBytes?: number } = {}): Promise<SessionChanges> {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxUntracked = limits.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES;
  if (!isDir(ws)) throw new ChangesError(409, "session worktree is missing");
  // devd runs as root over a worktree owned by uid 1000 → safe.directory (same as collectGitStats).
  const git: Git = (...args) => sh(ws, "git", "-c", `safe.directory=${ws}`, ...args);
  const must = async (...args: string[]): Promise<string> => {
    const r = await git(...args);
    if (r.code !== 0) throw new ChangesError(500, `git ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };

  const top = await git("rev-parse", "--show-toplevel");
  if (top.code !== 0) throw new ChangesError(409, `session worktree is not readable: ${top.stderr.trim()}`);
  if ((await git("rev-parse", "--verify", "--quiet", "HEAD^{commit}")).code !== 0) throw new ChangesError(409, "repository has no commits yet");

  const base = await resolveBase(git, ws);
  const rev = base === "HEAD" ? "HEAD" : (await mergeBase(git, base));

  const statuses = parseNameStatus(await must("diff", "-M", "--name-status", "-z", rev));
  const counts = parseNumstat(await must("diff", "-M", "--numstat", "-z", rev));
  const files: ChangedFile[] = statuses.map((s) => {
    const n = counts.get(s.path);
    if (!n) throw new ChangesError(500, `git diff --numstat has no entry for ${s.path}`);
    return { path: s.path, status: s.status, added: n.added, removed: n.removed, ...(s.oldPath ? { oldPath: s.oldPath } : {}) };
  });

  let budget = UNTRACKED_BUDGET;
  for (const path of (await must("ls-files", "--others", "--exclude-standard", "-z")).split("\0")) {
    if (!path) continue;
    const lines = countLines(join(ws, path), Math.min(maxUntracked, budget));
    if (lines) budget -= lines.bytes;
    files.push({ path, status: "untracked", added: lines?.lines ?? null, removed: lines ? 0 : null });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = { files: files.length, added: 0, removed: 0 };
  for (const f of files) { totals.added += f.added ?? 0; totals.removed += f.removed ?? 0; }
  return { base, files: files.slice(0, maxFiles), totals, ...(files.length > maxFiles ? { truncated: true as const } : {}) };
}

/** The upstream if the branch has one, else origin's default branch, else "HEAD" (no merge-base). */
async function resolveBase(git: Git, ws: string): Promise<string> {
  const up = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  if (up.code === 0 && up.stdout.trim()) return up.stdout.trim();
  const sym = await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
  // Session worktrees sit on a bare clone (clone.ts/trackRemote), which has no origin/HEAD;
  // the bare clone's own HEAD names the default branch. Only for a linked worktree — in an
  // ordinary repo the common dir's HEAD is the current branch, not the default one.
  const dirs = await git("rev-parse", "--git-dir", "--git-common-dir");
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n").map((p) => (isAbsolute(p) ? p : resolve(ws, p)));
  if (dirs.code !== 0 || !gitDir || !commonDir || gitDir === commonDir) return "HEAD";
  const head = await sh(ws, "git", "-c", `safe.directory=${commonDir}`, "--git-dir", commonDir, "symbolic-ref", "--quiet", "--short", "HEAD");
  const name = head.stdout.trim();
  if (head.code !== 0 || !name) return "HEAD";
  const remote = `origin/${name}`;
  return (await git("rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`)).code === 0 ? remote : "HEAD";
}

async function mergeBase(git: Git, base: string): Promise<string> {
  const r = await git("merge-base", base, "HEAD");
  if (r.code !== 0 || !r.stdout.trim()) throw new ChangesError(500, `no merge-base between HEAD and ${base}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
  return r.stdout.trim();
}

const STATUS: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", U: "modified" };

/** `git diff --name-status -z`: `X\0path\0`, or `R<score>\0old\0new\0` for renames. */
export function parseNameStatus(out: string): { path: string; status: ChangeStatus; oldPath?: string }[] {
  const t = out.split("\0");
  const res: { path: string; status: ChangeStatus; oldPath?: string }[] = [];
  for (let i = 0; i < t.length && t[i]; ) {
    const code = t[i]!;
    const status = STATUS[code[0]!];
    if (!status) throw new ChangesError(500, `unexpected git diff status ${JSON.stringify(code)}`);
    if (code[0] === "R") { res.push({ path: t[i + 2]!, status, oldPath: t[i + 1]! }); i += 3; }
    else { res.push({ path: t[i + 1]!, status }); i += 2; }
  }
  return res;
}

/** `git diff --numstat -z`: `a\tr\tpath\0`, or `a\tr\t\0old\0new\0` for renames; `-` = binary. */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const t = out.split("\0");
  const res = new Map<string, { added: number | null; removed: number | null }>();
  for (let i = 0; i < t.length && t[i]; ) {
    const [a, r, ...rest] = t[i]!.split("\t");
    let path = rest.join("\t");
    if (path) i += 1;
    else { path = t[i + 2]!; i += 3; }
    res.set(path, { added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) });
  }
  return res;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Line count of an untracked file, like `git diff --numstat` would count it; null when it is
 *  not a regular file, larger than `max`, binary (NUL byte) or unreadable. */
function countLines(path: string, max: number): { lines: number; bytes: number } | null {
  let fd: number;
  // O_NONBLOCK: a FIFO would otherwise block the open forever.
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    if (n !== st.size || buf.includes(0)) return null;
    let lines = 0;
    for (const b of buf) if (b === 0x0a) lines++;
    if (n > 0 && buf[n - 1] !== 0x0a) lines++;
    return { lines, bytes: n };
  } catch { return null; } finally { closeSync(fd); }
}
