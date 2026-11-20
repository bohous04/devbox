import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ChangedFile, ChangeStatus, SessionChanges } from "../../shared/changes";
import { sh } from "./git";
import { countUntracked, RootOwnedError, type CounterDeps } from "./untrackedCounter";

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
 *  - its `.git` file is agent-writable, so the repo git resolves must be `expected` (the session's
 *    registration `<bare>/worktrees/<name>` in the bare clone devd created, or `<ws>/.git` for a
 *    plain clone) — otherwise another repo on the host (another session, the config repo) would
 *    be listed. After that check every git call is pinned to the verified dirs with
 *    `--git-dir`/`--work-tree`, so rewriting `.git` afterwards changes nothing. The `commondir` file
 *    inside the registration lives in the bare clone, which the container mounts rw, so it could
 *    still be redirected after the check — the same class of race safeGit.ts already accepts for
 *    unrestricted sessions (only the agent itself can do it);
 *  - untracked files are counted by a child running as the worktree owner: see untrackedCounter.ts.
 */
export async function collectChanges(
  ws: string, expected: { gitDir: string; commonDir: string },
  limits: { maxFiles?: number; maxUntrackedBytes?: number; untrackedBudget?: number } = {},
  counterDeps?: CounterDeps,
): Promise<SessionChanges> {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  if (!isDir(ws)) throw new ChangesError(409, "session worktree is missing");
  // devd runs as root over a worktree owned by uid 1000 → safe.directory (same as collectGitStats).
  const discover: Git = (...args) => sh(ws, "git", "-c", `safe.directory=${ws}`, ...args);
  const must = async (what: string, ...args: string[]): Promise<string> => {
    const r = await git(...args);
    if (r.code !== 0) {
      console.error(`changes ${ws}: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
      throw new ChangesError(500, `${what} failed`);
    }
    return r.stdout;
  };

  const dirs = await discover("rev-parse", "--git-dir", "--git-common-dir");
  if (dirs.code !== 0) {
    console.error(`changes ${ws}: git rev-parse failed: ${dirs.stderr.trim()}`);
    throw new ChangesError(409, "session worktree is not a readable git repository");
  }
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n").map((p) => canon(isAbsolute(p) ? p : resolve(ws, p)));
  if (!gitDir || !commonDir || gitDir !== canon(expected.gitDir) || commonDir !== canon(expected.commonDir)) {
    console.error(`changes ${ws}: git dir ${gitDir} / common dir ${commonDir}, expected ${expected.gitDir} / ${expected.commonDir}`);
    throw new ChangesError(409, "session worktree points to a different git repository");
  }
  const git: Git = (...args) => sh(ws, "git", "-c", `safe.directory=${ws}`, "--git-dir", gitDir, "--work-tree", ws, ...args);
  if ((await git("rev-parse", "--verify", "--quiet", "HEAD^{commit}")).code !== 0) throw new ChangesError(409, "repository has no commits yet");

  const base = await originDefault(git, gitDir, commonDir);
  const rev = base ? (await must(`merge-base with ${base}`, "merge-base", base, "HEAD")).trim() : "HEAD";

  // One git call for status and counts, so both describe the same moment.
  const files: ChangedFile[] = parseDiff(await must("git diff", "diff", "-M", "--raw", "--numstat", "-z", rev));

  const untracked = (await must("listing untracked files", "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  // A lossy-decoded name is not the file's real name — opening it could hit a different file.
  const countable = untracked.filter((p) => !p.includes("\uFFFD"));
  const toCount = countable.slice(0, maxFiles);
  let countsCapped = countable.length > toCount.length;
  let countsUnavailable = false;
  let result;
  try {
    result = await countUntracked(ws, toCount, { maxBytes: limits.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES, budget: limits.untrackedBudget ?? UNTRACKED_BUDGET }, counterDeps);
  } catch (e) {
    if (e instanceof RootOwnedError) throw new ChangesError(409, e.message);
    throw e;
  }
  const lines = new Map<string, number | null>();
  if ("unavailable" in result) {
    console.error(`changes ${ws}: untracked files not counted: ${result.unavailable}`);
    countsUnavailable = true;
  } else {
    toCount.forEach((p, i) => lines.set(p, result.counts[i]!));
    countsCapped ||= result.capped;
  }
  for (const path of untracked) {
    const n = lines.get(path) ?? null;
    files.push({ path, status: "untracked", added: n, removed: n === null ? null : 0, ...(path.includes("\uFFFD") ? { nameNotUtf8: true as const } : {}) });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = { files: files.length, added: 0, removed: 0 };
  for (const f of files) { totals.added += f.added ?? 0; totals.removed += f.removed ?? 0; }
  return {
    base: base ?? "HEAD", files: files.slice(0, maxFiles), totals,
    ...(files.length > maxFiles ? { truncated: true as const } : {}),
    ...(countsCapped ? { countsCapped: true as const } : {}),
    ...(countsUnavailable ? { countsUnavailable: true as const } : {}),
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
  const head = await sh(commonDir, "git", "-c", `safe.directory=${commonDir}`, "--git-dir", commonDir, "symbolic-ref", "--quiet", "--short", "HEAD");
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
