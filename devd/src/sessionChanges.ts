import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ChangedFile, ChangesErrorCode, ChangeStatus, FileDiff, SessionChanges } from "../../shared/changes";
import { sh } from "./git";
import { run, timeoutFor } from "./proc";
import { countUntracked, readUntracked, RootOwnedError, type CounterDeps } from "./untrackedCounter";

/** An explicit failure the route maps to its HTTP status — never an empty list in its place.
 *  The message goes to the client, so it carries no host paths or git stderr (those are logged); `code` is the
 *  stable name clients match on (the message may be reworded). */
export class ChangesError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, readonly code: ChangesErrorCode, message: string) { super(message); }
}

const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
// Upper bound on what all untracked files together may make devd read per request.
const UNTRACKED_BUDGET = 32 * 1024 * 1024;
/** Cap of one file's diff (characters). */
export const MAX_DIFF = 256 * 1024;

type Git = (...args: string[]) => ReturnType<typeof sh>;
type Expected = { gitDir: string; commonDir: string };

interface Repo {
  ws: string;
  git: Git;
  must: (what: string, ...args: string[]) => Promise<string>;
  /** "origin/<default>" or null (then everything is compared to HEAD). */
  base: string | null;
  /** What `git diff` compares the working tree to: the merge-base, or HEAD — always a commit id,
   *  resolved once, so a commit made during the request cannot move it. */
  rev: string;
  /** Pinned git with a stdout cap (proc kills the child at the cap). */
  gitCapped: (maxStdout: number, ...args: string[]) => ReturnType<typeof run>;
}

/**
 * Opens the session repo for reading its changes against the merge-base with origin's default
 * branch (else HEAD).
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
 *  - untracked files are read by a child running as the worktree owner: see untrackedCounter.ts.
 */
async function openRepo(ws: string, expected: Expected): Promise<Repo> {
  if (!isDir(ws)) throw new ChangesError(409, "worktree_missing", "session worktree is missing");
  // devd runs as root over a worktree owned by uid 1000 → safe.directory (same as collectGitStats).
  const discover: Git = (...args) => sh(ws, "git", "-c", `safe.directory=${ws}`, ...args);
  const dirs = await discover("rev-parse", "--git-dir", "--git-common-dir");
  if (dirs.code !== 0) {
    console.error(`changes ${ws}: git rev-parse failed: ${dirs.stderr.trim()}`);
    throw new ChangesError(409, "not_a_repo", "session worktree is not a readable git repository");
  }
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n").map((p) => canon(isAbsolute(p) ? p : resolve(ws, p)));
  if (!gitDir || !commonDir || gitDir !== canon(expected.gitDir) || commonDir !== canon(expected.commonDir)) {
    console.error(`changes ${ws}: git dir ${gitDir} / common dir ${commonDir}, expected ${expected.gitDir} / ${expected.commonDir}`);
    throw new ChangesError(409, "foreign_git_dir", "session worktree points to a different git repository");
  }
  const pinned = ["git", "-c", `safe.directory=${ws}`, "--git-dir", gitDir, "--work-tree", ws];
  const git: Git = (...args) => sh(ws, ...pinned, ...args);
  const gitCapped = (maxStdout: number, ...args: string[]) => run([...pinned, ...args], { cwd: ws, timeoutMs: timeoutFor("LOCAL"), maxStdout });
  const must = async (what: string, ...args: string[]): Promise<string> => {
    const r = await git(...args);
    if (r.code !== 0) {
      console.error(`changes ${ws}: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
      throw new ChangesError(500, "git_failed", `${what} failed`);
    }
    return r.stdout;
  };
  const head = await git("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  if (head.code !== 0) throw new ChangesError(409, "no_commits", "repository has no commits yet");
  const base = await originDefault(git, gitDir, commonDir);
  const rev = base ? (await must(`merge-base with ${base}`, "merge-base", base, head.stdout.trim())).trim() : head.stdout.trim();
  return { ws, git, must, base, rev, gitCapped };
}

/** Tracked changes (status + counts in one git call, so both describe the same moment) and the
 *  untracked paths. */
async function listChanges(repo: Repo): Promise<{ tracked: ChangedFile[]; untracked: string[] }> {
  const tracked = parseDiff(await repo.must("git diff", "diff", "-M", "--raw", "--numstat", "-z", repo.rev));
  const untracked = (await repo.must("listing untracked files", "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  return { tracked, untracked };
}

const rethrowRootOwned = (e: unknown): never => {
  if (e instanceof RootOwnedError) throw new ChangesError(409, "root_owned", e.message);
  throw e;
};

/** The worktree's changes: committed (pushed or not) + staged + unstaged (one `git diff <rev>`
 *  against the working tree covers all) + untracked files, whose lines count as added. */
export async function collectChanges(
  ws: string, expected: Expected,
  limits: { maxFiles?: number; maxUntrackedBytes?: number; untrackedBudget?: number } = {},
  counterDeps?: CounterDeps,
): Promise<SessionChanges> {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const repo = await openRepo(ws, expected);
  const { tracked: files, untracked } = await listChanges(repo);

  // A lossy-decoded name is not the file's real name — opening it could hit a different file.
  const countable = untracked.filter((p) => !p.includes("\uFFFD"));
  const toCount = countable.slice(0, maxFiles);
  let countsCapped = countable.length > toCount.length;
  let countsUnavailable = false;
  const result = await countUntracked(ws, toCount, { maxBytes: limits.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES, budget: limits.untrackedBudget ?? UNTRACKED_BUDGET }, counterDeps)
    .catch(rethrowRootOwned);
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
    base: repo.base ?? "HEAD", files: files.slice(0, maxFiles), totals,
    ...(files.length > maxFiles ? { truncated: true as const } : {}),
    ...(countsCapped ? { countsCapped: true as const } : {}),
    ...(countsUnavailable ? { countsUnavailable: true as const } : {}),
  };
}

/** A repo-relative path as git lists it: no absolute path, no `.`/`..`/empty segment, no NUL,
 *  no lossy-decoded name. */
function validPath(path: string): boolean {
  return !!path && !path.includes("\0") && !path.includes("\uFFFD") && !path.startsWith("/")
    && path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * One changed file's unified diff (3 lines of context) against the same base as collectChanges.
 * Only a file in the current listing can be asked for. Tracked files go through the pinned,
 * hardened git (`--literal-pathspecs`, path after `--`); untracked files are read by the owner
 * child and rendered as a new-file diff. Capped at MAX_DIFF on a line boundary.
 */
export async function collectFileDiff(ws: string, expected: Expected, path: string, counterDeps?: CounterDeps): Promise<FileDiff> {
  if (!validPath(path)) throw new ChangesError(400, "invalid_path", "invalid path");
  const repo = await openRepo(ws, expected);
  const { tracked, untracked } = await listChanges(repo);
  const base = repo.base ?? "HEAD";
  const entry = tracked.find((f) => f.path === path);
  if (entry) {
    // numstat says `-` for what git treats as binary (incl. a `-diff` attribute).
    if (entry.added === null) return { path, status: entry.status, base, binary: true, truncated: false, diff: "" };
    // Root git never reads the working copy here (lstat-then-open would follow a swapped
    // symlink): the base side comes from the object store, the working side from the owner child.
    const result = (diff: string, truncated: boolean, binary = false): FileDiff => ({ path, status: entry.status, base, binary, truncated, diff });
    let cur = "";
    if (entry.status !== "deleted") {
      const file = await readWorking(ws, path, MAX_SIDE, counterDeps);
      if (file.binary) return result("", false, true);
      if (file.truncated) return result("", true);
      cur = file.content;
    }
    const old = entry.status === "added" ? "" : await baseBlob(repo, entry.oldPath ?? path);
    if (old === null) return result("", true);
    if (old.includes("\0")) return result("", false, true);
    const hunks = await unifiedHunks(ws, old, cur);
    const header = trackedHeader(entry.status, entry.oldPath ?? path, path);
    return capped(header + hunks, (diff, truncated) => result(diff, truncated));
  }
  if (!untracked.includes(path)) throw new ChangesError(404, "not_changed", "file is not among the session's changes");
  const file = await readWorking(ws, path, MAX_DIFF, counterDeps);
  if (file.binary) return { path, status: "untracked", base, binary: true, truncated: false, diff: "" };
  return { path, status: "untracked", base, binary: false, ...newFileDiff(path, file.content, file, MAX_DIFF) };
}

const toLastLine = (s: string): string => s.slice(0, s.lastIndexOf("\n") + 1);

/** A side larger than this is not diffed (truncated:true, empty diff): a diff of two prefixes
 *  would show changes that are not there. */
const MAX_SIDE = 1024 * 1024;

const capped = <T,>(diff: string, done: (diff: string, truncated: boolean) => T): T =>
  diff.length > MAX_DIFF ? done(toLastLine(diff.slice(0, MAX_DIFF)), true) : done(diff, false);

/** The working-copy content of `path`, read by the owner child (never by root). */
async function readWorking(ws: string, path: string, maxBytes: number, counterDeps?: CounterDeps) {
  const file = await readUntracked(ws, path, maxBytes, counterDeps).catch(rethrowRootOwned);
  if ("unavailable" in file) {
    console.error(`changes ${ws}: reading ${path} failed: ${file.unavailable}`);
    throw new ChangesError(500, "read_failed", "reading the file failed");
  }
  if (!file.ok) throw new ChangesError(409, "unreadable_file", "file is not a readable regular file in the worktree");
  return file;
}

/** `<rev>:<path>` from the object store, or null when it is larger than MAX_SIDE. `cat-file blob`
 *  applies no filters or textconv. The object lookup itself still honours the bare clone's
 *  objects/info/alternates (agent-writable), which could point at another repo's object store —
 *  the same accepted class of risk as the rest of safeGit.ts (it needs the agent's own rev/tree to
 *  name a foreign blob). */
async function baseBlob(repo: Repo, path: string): Promise<string | null> {
  // Size and content of one object id (repo.rev is already a commit id), with a stdout cap as
  // the backstop — nothing can make devd buffer more than MAX_SIDE.
  const oid = (await repo.must("resolving the base", "rev-parse", "--verify", "--quiet", `${repo.rev}:${path}`)).trim();
  const size = Number((await repo.must("reading the base size", "cat-file", "-s", oid)).trim());
  if (!Number.isFinite(size)) throw new ChangesError(500, "read_failed", "reading the base size failed");
  if (size > MAX_SIDE) return null;
  const r = await repo.gitCapped(MAX_SIDE + 1, "cat-file", "blob", oid);
  if (r.stdoutTruncated) return null;
  if (r.code !== 0) {
    console.error(`changes ${repo.ws}: git cat-file blob ${oid} failed: ${r.stderr.trim()}`);
    throw new ChangesError(500, "read_failed", "reading the base failed");
  }
  return r.stdout;
}

/** Hunks (from the first `@@`) of `old` → `cur`, by `git diff --no-index` over two files in a fresh
 *  root-owned temp dir — git sees only those two files, never the worktree or its config. */
async function unifiedHunks(ws: string, old: string, cur: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "devd-diff-"));
  try {
    writeFileSync(join(dir, "a"), old);
    writeFileSync(join(dir, "b"), cur);
    // GIT_CEILING_DIRECTORIES: git must not discover a repo above the temp dir.
    const r = await run(["git", "diff", "--no-index", "--no-color", "-U3", "--", "a", "b"],
      { cwd: dir, env: { GIT_CEILING_DIRECTORIES: tmpdir() }, timeoutMs: timeoutFor("LOCAL"), maxStdout: MAX_DIFF + 1 });
    // Exit 1 = "files differ"; a non-zero exit is otherwise accepted only after our own kill at maxStdout.
    if (r.code !== 0 && r.code !== 1 && !r.stdoutTruncated) {
      console.error(`changes ${ws}: git diff --no-index failed: ${r.stderr.trim()}`);
      throw new ChangesError(500, "git_failed", "git diff failed");
    }
    const at = r.stdout.search(/^@@/m);
    return at < 0 ? "" : r.stdout.slice(at);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** git's header for a tracked change (mode assumed 100644: modes are not part of the listing). */
function trackedHeader(status: ChangeStatus, oldPath: string, path: string): string {
  const head = `diff --git a/${oldPath} b/${path}\n`;
  if (status === "added") return `${head}new file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  if (status === "deleted") return `${head}deleted file mode 100644\n--- a/${path}\n+++ /dev/null\n`;
  if (status === "renamed") return `${head}rename from ${oldPath}\nrename to ${path}\n--- a/${oldPath}\n+++ b/${path}\n`;
  return `${head}--- a/${path}\n+++ b/${path}\n`;
}

/** `git diff` output for a new file with `content`, at most `cap` characters; a cut-off read
 *  (`truncated`) drops its last partial line. The hunk header counts only included lines. */
export function newFileDiff(path: string, content: string, read: { exec: boolean; truncated: boolean }, cap: number): { diff: string; truncated: boolean } {
  let diff = `diff --git a/${path} b/${path}\nnew file mode ${read.exec ? "100755" : "100644"}\n`;
  if (!content) return { diff, truncated: read.truncated };
  const noEol = !content.endsWith("\n") && !read.truncated;
  const lines = content.split("\n");
  lines.pop(); // after the last "\n": "" or a partial line (kept only when it is the real end)
  if (noEol) lines.push(content.slice(content.lastIndexOf("\n") + 1));
  diff += `--- /dev/null\n+++ b/${path}\n`;
  const tail = noEol ? "\\ No newline at end of file\n" : "";
  // The hunk header is up to ~30 characters; reserve it before filling the body.
  let room = cap - diff.length - 32 - tail.length;
  let body = "";
  let n = 0;
  let truncated = read.truncated;
  for (const l of lines) {
    if (l.length + 2 > room) { truncated = true; break; }
    body += `+${l}\n`;
    room -= l.length + 2;
    n++;
  }
  const endTail = n === lines.length ? tail : "";
  return { diff: `${diff}@@ -0,0 +${n === 1 ? "1" : `1,${n}`} @@\n${body}${endTail}`, truncated };
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
    if (!status) throw new ChangesError(500, "git_failed", `unexpected git diff status ${JSON.stringify(code)}`);
    if (code[0] === "R") { raw.push({ path: t[i + 2]!, status, oldPath: t[i + 1]! }); i += 3; }
    else { raw.push({ path: t[i + 1]!, status }); i += 2; }
  }
  const files: ChangedFile[] = [];
  for (const r of raw) {
    const tab = (t[i] ?? "").split("\t");
    if (tab.length < 3) throw new ChangesError(500, "git_failed", "git diff output is malformed");
    let path = tab.slice(2).join("\t");
    if (path) i += 1;
    else { path = t[i + 2] ?? ""; i += 3; }
    if (path !== r.path) throw new ChangesError(500, "git_failed", "git diff output is malformed");
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
