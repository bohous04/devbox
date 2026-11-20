import { constants, realpathSync, statSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ChangedFile, ChangeStatus, SessionChanges } from "../../shared/changes";
import { sh } from "./git";

/** An explicit failure the route maps to its HTTP status — never an empty list in its place.
 *  The message goes to the client, so it carries no host paths or git stderr (those are logged). */
export class ChangesError extends Error {
  constructor(readonly status: 409 | 500, message: string) { super(message); }
}

const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
// Upper bound on what all untracked files together may make devd read per request.
const UNTRACKED_BUDGET = 32 * 1024 * 1024;

type Git = (...args: string[]) => ReturnType<typeof sh>;

/**
 * The worktree's changes against the merge-base with origin's default branch: committed (pushed
 * or not) + staged + unstaged (one `git diff <merge-base>` against the working tree covers all) +
 * untracked files, whose lines count as added.
 *
 * The worktree is agent-controlled, hence:
 *  - every git goes through proc.run → safeGit.ts (untrusted config/attributes);
 *  - its `.git` file is agent-writable, so the repo git resolves must be `expectedCommonDir` (the
 *    bare clone devd created, or `<ws>/.git` for a plain clone) — otherwise another repo on the
 *    host (another session, the config repo) would be listed;
 *  - untracked files are read by devd (root) itself: see untrackedLines.
 */
export async function collectChanges(
  ws: string, expectedCommonDir: string,
  limits: { maxFiles?: number; maxUntrackedBytes?: number; untrackedBudget?: number } = {},
): Promise<SessionChanges> {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxUntracked = limits.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES;
  let budget = limits.untrackedBudget ?? UNTRACKED_BUDGET;
  if (!isDir(ws)) throw new ChangesError(409, "session worktree is missing");
  // devd runs as root over a worktree owned by uid 1000 → safe.directory (same as collectGitStats).
  const git: Git = (...args) => sh(ws, "git", "-c", `safe.directory=${ws}`, ...args);
  const must = async (what: string, ...args: string[]): Promise<string> => {
    const r = await git(...args);
    if (r.code !== 0) {
      console.error(`changes ${ws}: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
      throw new ChangesError(500, `${what} failed`);
    }
    return r.stdout;
  };

  const dirs = await git("rev-parse", "--git-dir", "--git-common-dir");
  if (dirs.code !== 0) {
    console.error(`changes ${ws}: git rev-parse failed: ${dirs.stderr.trim()}`);
    throw new ChangesError(409, "session worktree is not a readable git repository");
  }
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n").map((p) => canon(isAbsolute(p) ? p : resolve(ws, p)));
  if (!gitDir || !commonDir || commonDir !== canon(expectedCommonDir) || !within(gitDir, commonDir)) {
    console.error(`changes ${ws}: git dir ${gitDir} / common dir ${commonDir}, expected ${expectedCommonDir}`);
    throw new ChangesError(409, "session worktree points to a different git repository");
  }
  if ((await git("rev-parse", "--verify", "--quiet", "HEAD^{commit}")).code !== 0) throw new ChangesError(409, "repository has no commits yet");

  const base = await originDefault(git, gitDir, commonDir);
  const rev = base ? (await must(`merge-base with ${base}`, "merge-base", base, "HEAD")).trim() : "HEAD";

  // One git call for status and counts, so both describe the same moment.
  const files: ChangedFile[] = parseDiff(await must("git diff", "diff", "-M", "--raw", "--numstat", "-z", rev));

  let opened = 0;
  let countsCapped = false;
  for (const path of (await must("listing untracked files", "ls-files", "--others", "--exclude-standard", "-z")).split("\0")) {
    if (!path) continue;
    const nameNotUtf8 = path.includes("�");
    let lines: { lines: number; bytes: number } | null = null;
    // A lossy-decoded name is not the file's real name — opening it could hit a different file.
    if (!nameNotUtf8) {
      if (opened >= maxFiles || budget <= 0) countsCapped = true;
      else {
        opened++;
        lines = await untrackedLines(ws, path, Math.min(maxUntracked, budget));
        if (lines) budget -= lines.bytes;
      }
    }
    files.push({ path, status: "untracked", added: lines?.lines ?? null, removed: lines ? 0 : null, ...(nameNotUtf8 ? { nameNotUtf8: true as const } : {}) });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = { files: files.length, added: 0, removed: 0 };
  for (const f of files) { totals.added += f.added ?? 0; totals.removed += f.removed ?? 0; }
  return {
    base: base ?? "HEAD", files: files.slice(0, maxFiles), totals,
    ...(files.length > maxFiles ? { truncated: true as const } : {}),
    ...(countsCapped ? { countsCapped: true as const } : {}),
  };
}

/** "origin/<default>" or null when origin has no default branch here. */
async function originDefault(git: Git, gitDir: string, commonDir: string): Promise<string | null> {
  const sym = await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
  // Session worktrees sit on a bare clone (clone.ts/trackRemote), which has no origin/HEAD;
  // the bare clone's own HEAD names the default branch. Only for a linked worktree — in an
  // ordinary repo the common dir's HEAD is the current branch, not the default one.
  if (gitDir === commonDir) return null;
  const head = await git("-c", `safe.directory=${commonDir}`, "--git-dir", commonDir, "symbolic-ref", "--quiet", "--short", "HEAD");
  const name = head.stdout.trim();
  if (head.code !== 0 || !name) return null;
  const remote = `origin/${name}`;
  return (await git("rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`)).code === 0 ? remote : null;
}

const STATUS: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", U: "modified" };

/**
 * `git diff --raw --numstat -z`: first a raw record per file (`:<modes> <shas> X\0path\0`, or
 * `... R<score>\0old\0new\0`), then a numstat record per file in the same order (`a\tr\tpath\0`,
 * or `a\tr\t\0old\0new\0`; `-` = binary). Paired by position, not by name: a name that is not
 * UTF-8 is decoded lossily and two such names could otherwise collide.
 */
export function parseDiff(out: string): ChangedFile[] {
  const t = out.split("\0");
  let i = 0;
  const raw: { path: string; status: ChangeStatus; oldPath?: string }[] = [];
  while (i < t.length && t[i]!.startsWith(":")) {
    const code = t[i]!.slice(t[i]!.lastIndexOf(" ") + 1);
    const status = STATUS[code[0]!];
    if (!status) throw new ChangesError(500, `unexpected git diff status ${JSON.stringify(code)}`);
    if (code[0] === "R") { raw.push({ path: t[i + 2]!, status, oldPath: t[i + 1]! }); i += 3; }
    else { raw.push({ path: t[i + 1]!, status }); i += 2; }
  }
  const files: ChangedFile[] = [];
  for (const r of raw) {
    const tab = (t[i] ?? "").split("\t");
    if (tab.length < 3) throw new ChangesError(500, "git diff output is malformed");
    let path = tab.slice(2).join("\t");
    if (path) i += 1;
    else { path = t[i + 2] ?? ""; i += 3; }
    if (path !== r.path) throw new ChangesError(500, "git diff output is malformed");
    const num = (s: string) => (s === "-" ? null : Number(s));
    files.push({
      path: r.path, status: r.status, added: num(tab[0]!), removed: num(tab[1]!),
      ...(r.oldPath ? { oldPath: r.oldPath } : {}),
      ...(r.path.includes("�") || r.oldPath?.includes("�") ? { nameNotUtf8: true as const } : {}),
    });
  }
  return files;
}

const canon = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Line count of an untracked file, like `git diff --numstat` would count it; null when it is not
 * a regular file inside the worktree, larger than `max`, binary (NUL byte) or unreadable.
 *
 * devd runs as root and the agent can swap any path component for a symlink at any time.
 * O_NOFOLLOW only guards the last component, so after opening we check that the opened file IS
 * the file at that path inside the worktree: the path's realpath must stay inside the worktree's and
 * name the same inode as the open fd. A parent swapped before the open fails the realpath check
 * (or, if swapped back before it, the inode check). Same guarantee as reading
 * /proc/self/fd/<fd>, but it also works where /proc does not exist (macOS dev machines).
 */
export async function untrackedLines(ws: string, path: string, max: number): Promise<{ lines: number; bytes: number } | null> {
  let realWs: string;
  let fh: Awaited<ReturnType<typeof open>>;
  try { realWs = await realpath(ws); } catch { return null; }
  // O_NONBLOCK: a FIFO would otherwise block the open forever.
  try { fh = await open(join(realWs, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    const real = await realpath(join(realWs, path));
    if (!within(real, realWs)) return null;
    const at = await stat(real);
    if (at.dev !== st.dev || at.ino !== st.ino) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    if (bytesRead !== st.size || buf.includes(0)) return null;
    let lines = 0;
    for (const b of buf) if (b === 0x0a) lines++;
    if (bytesRead > 0 && buf[bytesRead - 1] !== 0x0a) lines++;
    return { lines, bytes: bytesRead };
  } catch { return null; } finally { await fh.close(); }
}
