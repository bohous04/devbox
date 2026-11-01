import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactArgv, run, timeoutFor, type RunResult } from "./proc";

// Network git subcommands get a longer cap (cloning a large repo takes minutes).
const NET = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
function groupFor(cmd: string[]): "GIT_NET" | "LOCAL" {
  const sub = cmd[0] === "git" ? cmd.find((a, i) => i > 0 && !a.startsWith("-") && cmd[i - 1] !== "-c" && cmd[i - 1] !== "-C") : undefined;
  return sub && NET.has(sub) ? "GIT_NET" : "LOCAL";
}

// A timeout is an error, not a state: a nonzero code with text is returned, so today's
// `if (r.code !== 0) throw new Error(\`… failed: ${r.stderr}\`)` at the callers
// carries the cause forward unchanged.
export async function shWith(cwd: string, authEnv: Record<string, string>, ...cmd: string[]): Promise<RunResult> {
  const group = groupFor(cmd);
  const ms = timeoutFor(group);
  const r = await run(cmd, { cwd, env: Object.keys(authEnv).length ? authEnv : undefined, timeoutMs: ms });
  // redactArgv: the clone URL may carry a token in userinfo (`https://user:tok@host/…`) and
  // this message ends up persisted in the DB (clone job → results[].error), not only in the log
  // — masking it only in the slow-subprocess warning in proc.ts is not enough.
  return r.timedOut ? { ...r, code: 124, stderr: `${redactArgv(cmd).join(" ")} timed out after ${Math.round(ms / 1000)} s` } : r;
}

export async function sh(cwd: string, ...cmd: string[]): Promise<RunResult> {
  return shWith(cwd, {}, ...cmd);
}

/**
 * Git config env for authenticating clone/fetch against a private Gitea instance.
 *
 * devd runs on the host (root) and its git — unlike the container's — has NO
 * gitea credential helper: `image/git-credential-devbox` exists only in the image. Otherwise the token
 * is used only for the Gitea API (listing repos). Without these env vars,
 * `git clone` of a private gitea repo would fail non-interactively with
 * "could not read Username" (exactly the error on the Cloning page).
 *
 * Gitea git-over-HTTP accepts Basic auth username=devbox / password=token (same
 * pattern as git-credential-devbox). We inject the header via GIT_CONFIG_*
 * (not `-c`) so that the token does not appear in argv (ps), and we scope it to the instance's
 * origin so it does not leak on a possible HTTP redirect to another host. The token is not
 * persisted anywhere — not even into the .git/config of the resulting clone.
 *
 * SECURITY (accepted risk): the token travels over the transport of the given instance URL. If the
 * instance is `http://` (not https), Basic auth — and with it the token — travels in plaintext.
 * Acceptable only on the tailnet / a private network; the real fix is HTTPS on Gitea, which
 * is an infra matter, not this code's. Scoping to the origin at least guarantees that we do not send
 * the token anywhere other than that one configured instance.
 */
export function giteaAuthEnv(url: string, token: string | undefined): Record<string, string> {
  if (!token) return {};
  let base: string;
  try { const u = new URL(url); base = `${u.protocol}//${u.host}/`; }
  catch { return {}; } // unparseable URL → better without auth than throwing
  const b64 = Buffer.from(`devbox:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${base}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64}`,
  };
}

/** Where the clone is right now — from `git clone --progress` (see parseCloneProgress). */
export interface CloneProgress { phase: string; percent: number; detail?: string }

// A git progress line: "Receiving objects:  45% (90888/201972), 3.21 GiB | 30.12 MiB/s",
// at the end of a phase additionally ", done.". `remote: ` marks phases counted by the server.
const PROGRESS_LINE = /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d+)%(?: \(\d+\/\d+\))?(?:, (?!done\.)(.+?))?(?:, done\.)?\s*$/;

export function parseProgressLine(line: string): CloneProgress | null {
  const m = PROGRESS_LINE.exec(line.trim());
  if (!m) return null;
  return { phase: m[1]!, percent: Number(m[2]), ...(m[3] ? { detail: m[3] } : {}) };
}

/** Sink for stderr: git rewrites the line via `\r` and chunks from the pipe can split a line
 *  — an unfinished tail is therefore held until the next chunk. */
export function cloneProgressSink(onProgress: (p: CloneProgress) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    const parts = (rest + chunk).split(/[\r\n]/);
    rest = parts.pop() ?? "";
    let last: CloneProgress | null = null;
    for (const line of parts) last = parseProgressLine(line) ?? last;
    if (last) onProgress(last);
  };
}

// With `--progress` stderr is full of rewritten progress lines — only the rest belongs in the
// error message (it ends up in the DB and in the CLI).
function withoutProgress(stderr: string): string {
  return stderr.split(/[\r\n]/).filter((l) => l.trim() && !parseProgressLine(l)).join("\n").trim();
}

export async function cloneRepo(url: string, dest: string, authEnv: Record<string, string> = {}, onProgress?: (p: CloneProgress) => void): Promise<void> {
  return gitClone([], url, dest, authEnv, "git clone", onProgress);
}

// Clones into `<dest>.partial` and renames the finished clone to `dest` only at the end. Callers
// decide "clone?" by existsSync(dest) — an interrupted clone (timeout, devd restart)
// would otherwise leave a half-downloaded repo that the next open would take as finished.
async function gitClone(args: string[], url: string, dest: string, authEnv: Record<string, string>, label: string, onProgress?: (p: CloneProgress) => void): Promise<void> {
  const partial = `${dest}.partial`;
  rmSync(partial, { recursive: true, force: true }); // leftover from an earlier interruption
  const cmd = ["git", "clone", ...args, ...(onProgress ? ["--progress"] : []), "--", url, partial];
  const ms = timeoutFor("GIT_CLONE");
  const r = await run(cmd, {
    cwd: process.cwd(),
    env: Object.keys(authEnv).length ? authEnv : undefined,
    timeoutMs: ms,
    onStderr: onProgress ? cloneProgressSink(onProgress) : undefined,
  });
  if (r.code !== 0 || r.timedOut) {
    rmSync(partial, { recursive: true, force: true });
    // redactArgv: the URL may carry a token in userinfo and the message ends up in the DB (see shWith).
    const why = r.timedOut ? `${redactArgv(cmd).join(" ")} timed out after ${Math.round(ms / 1000)} s` : withoutProgress(r.stderr);
    throw new Error(`${label} failed: ${why}`);
  }
  renameSync(partial, dest);
}

export async function cloneRepoAsync(url: string, dest: string, authEnv: Record<string, string> = {}): Promise<void> {
  return gitClone([], url, dest, authEnv, "git clone");
}

/** A clone without a working directory. It has no branch checked out, so every
 *  worktree can take any of them — including the default one. */
export async function cloneBare(url: string, dest: string, authEnv: Record<string, string> = {}, onProgress?: (p: CloneProgress) => void): Promise<void> {
  return gitClone(["--bare"], url, dest, authEnv, "git clone --bare", onProgress);
}

export async function fetchAllAsync(dir: string, authEnv: Record<string, string> = {}): Promise<void> {
  // devd runs as root over workspaces owned by uid 1000 → without safe.directory
  // git would stop at "detected dubious ownership" (see collectGitStats).
  const r = await shWith(dir, authEnv, "git", "-c", `safe.directory=${dir}`, "fetch", "--all");
  if (r.code !== 0) throw new Error("git fetch failed");
}

export type PullResult =
  | { status: "clean" }
  | { status: "conflict"; files: string[] }
  | { status: "error"; message: string };

// Parallel checkout: a full checkout of a 9.6 GB / 124k-file tree took 30 s single-threaded and
// 11 s with 8 workers (measured on the VPS, 1 Nov 2026). Not "all cores" — sessions share the host.
export const PARALLEL_CHECKOUT = ["-c", "checkout.workers=8"];

/** Refreshes `origin/*` in a bare clone before a new worktree is cut from it. A failure is not fatal:
 *  the session starts from the last fetched state and the pull reports the problem as before. */
export async function fetchBare(bare: string, authEnv: Record<string, string> = {}): Promise<void> {
  const r = await shWith(bare, authEnv, "git", "-C", bare, "-c", `safe.directory=${bare}`, "fetch", "--quiet", "origin");
  if (r.code !== 0) console.error(`git fetch in ${bare} failed: ${r.stderr.trim()}`);
}

/** Locks a session's worktree registration against `git worktree prune`. A prune — devd's own in
 *  addWorktree, a manual one on the host, or an agent's inside a container, where the host path in
 *  `gitdir` does not exist — otherwise deletes a LIVE session's registration: git in it then says
 *  "not a git repository" until someone rebuilds HEAD and the index by hand (1 Nov 2026: six
 *  sessions of one repo, four of them broken for days). The marker is the file git itself writes
 *  for `git worktree lock`; written directly because `worktree lock <path>` cannot find a
 *  registration whose gitdir holds the container path. */
export function lockWorktree(bare: string, dest: string): void {
  const marker = join(bare, "worktrees", basename(dest), "locked");
  try {
    if (existsSync(dirname(marker)) && !existsSync(marker)) writeFileSync(marker, "devbox session (container path /workspace)\n");
  } catch (e) { console.error(`locking worktree ${dest} failed:`, e); }
}

export async function pullWithRebase(dir: string, authEnv: Record<string, string> = {}): Promise<PullResult> {
  // safe.directory: devd runs as root, but the workspace is owned by the container user
  // (uid 1000). Without it git refuses with "detected dubious ownership" (exit 128) and
  // the pull would silently fail → the session would run on old code.
  // authEnv: host git has no gitea credential helper → without it a pull of a private
  // gitea repo right after cloning would end with an auth error (see giteaAuthEnv). Only pull
  // touches the network; the local diff needs no auth.
  const safe = ["-c", `safe.directory=${dir}`];
  const r = await shWith(dir, authEnv, "git", ...safe, ...PARALLEL_CHECKOUT, "pull", "--rebase", "--autostash");
  if (r.code === 0) return { status: "clean" };
  const unmerged = await sh(dir, "git", ...safe, "diff", "--name-only", "--diff-filter=U");
  const files = unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (files.length > 0) return { status: "conflict", files };
  return { status: "error", message: (r.stderr || r.stdout).trim() };
}

/** Brings a bare clone up to what an ordinary clone has: tracking refs (`origin/*`) and the upstream
 *  of the default branch. `git clone --bare` sets NEITHER (no fetch refspec, no
 *  `branch.<b>.merge`) and without them the session would silently lose a piece of ordinary git compared to today:
 *  `git push` ends with "current branch has no upstream branch" and `@{u}` does not exist, so the
 *  dashboard reports zero unpushed commits. Both verified by experiment.
 *
 *  Failure is non-critical: a session without tracking refs is still usable, a session without
 *  a working directory is not. */
export async function trackRemote(bare: string, authEnv: Record<string, string> = {}): Promise<void> {
  const safe = ["-c", `safe.directory=${bare}`];
  await sh(bare, "git", ...safe, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const fetched = await shWith(bare, authEnv, "git", "-C", bare, ...safe, "fetch", "origin");
  if (fetched.code !== 0) {
    console.error(`git fetch in ${bare} failed: ${fetched.stderr.trim()}`);
    return;
  }
  const head = await defaultBranch(bare);
  // An empty repo has nothing to track — the tracking ref appears only with the first push. It is not
  // an error, so it is not even reported.
  if ((await sh(bare, "git", ...safe, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${head}`)).code === 0) {
    await setUpstream(bare, head, head);
  }
  // `git clone --bare` copies ALL remote heads straight into `refs/heads/*`, but
  // the refspec set above then fills only `refs/remotes/origin/*` — so those local heads are
  // never updated by anyone again. An ordinary clone has only the default branch locally, so
  // `git checkout feature/x` does DWIM from a fresh `origin/feature/x`; here git would find
  // the LOCAL branch of the same name and silently land on the commit from clone time. The older the clone, the
  // older the code, and nothing would warn about it.
  //
  // Deleting is safe ONLY because of WHEN this is called: both calls (`open()` in sessions.ts
  // and the clone queue in clone.ts) sit inside the "bare clone does not exist yet" branch, right
  // after `cloneBare`. So it runs exactly once for a given repo and no
  // `session/<repo>-<n>` branch exists at that moment yet.
  // DO NOT GENERALIZE to "call this on every open" — that would delete
  // a session's work in progress.
  const frozen = (await sh(bare, "git", ...safe, "for-each-ref", "--format=%(refname:short)", "refs/heads/"))
    .stdout.split("\n").map((l) => l.trim()).filter((b) => b && b !== head);
  if (frozen.length) {
    // The default branch is protected ONLY by the `b !== head` filter one line above. In a bare repo git
    // does not protect it itself — `branch -D` on the branch HEAD points to succeeds there (unlike in a
    // non-bare repo). The filter is therefore not redundant: without it every clone would leave
    // a bare clone without a single local branch and the first session of every repo would get an empty
    // orphan workspace.
    const r = await sh(bare, "git", ...safe, "branch", "-D", ...frozen);
    // Non-critical, like the rest of this function: a session with uncleaned branches is still
    // usable, a session without a working directory is not.
    if (r.code !== 0) console.error(`cleanup of stale branches in ${bare} failed: ${r.stderr.trim()}`);
  }
}

/** Branch upstream to `origin/<remoteBranch>`. Failure is only logged: a session without
 *  an upstream is still usable, a session without a working directory is not. */
export async function setUpstream(bare: string, branch: string, remoteBranch: string): Promise<void> {
  const r = await sh(bare, "git", "-c", `safe.directory=${bare}`, "branch", `--set-upstream-to=origin/${remoteBranch}`, branch);
  if (r.code !== 0) console.error(`upstream for ${branch} not set: ${r.stderr.trim()}`);
}

/** Default branch of the bare clone — what its HEAD points to (`git clone` sets it
 *  according to the remote). The first session must check it out BY NAME: `worktree add … HEAD`
 *  would give a detached head, i.e. a session whose commits belong nowhere.
 *
 *  Without a symref (broken clone) we fall back to "main". It is a guess, not a solution: when the repo has no
 *  `main`, `addWorktree` evaluates the branch as unborn and the session gets an empty
 *  orphan branch over a non-empty repo — i.e. a workspace without files that looks like an empty
 *  repo. That is why it at least does not happen silently. */
export async function defaultBranch(bare: string): Promise<string> {
  const r = await sh(bare, "git", "-c", `safe.directory=${bare}`, "symbolic-ref", "--short", "HEAD");
  const name = r.stdout.trim();
  if (!name) console.error(`could not read HEAD in ${bare} (${r.stderr.trim() || "empty symref"}), using "main"`);
  return name || "main";
}

/** Is git alive in the working tree `dir`? The mere existence of `.git` is NOT ENOUGH: it is a file
 *  with a path into the bare clone (`gitdir: <bare>/worktrees/<id>`) and that registration may be gone
 *  (see repairWorktrees). Such a directory looks like a repo on disk, but EVERY git command
 *  in it ends with "not a git repository" — in the container this makes the entrypoint fail over and over. */
export async function worktreeHealthy(dir: string): Promise<boolean> {
  return (await sh(dir, "git", "-c", `safe.directory=${dir}`, "rev-parse", "--git-dir")).code === 0;
}

/** Branch the worktree sits on; null when git in it is dead or HEAD is detached. */
export async function worktreeBranch(dir: string): Promise<string | null> {
  const r = await sh(dir, "git", "-c", `safe.directory=${dir}`, "symbolic-ref", "--quiet", "--short", "HEAD");
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Aligns the worktree registrations in the bare clone with the host paths. Repairs the direction
 *  that `git worktree prune` reads: `<bare>/worktrees/<id>/gitdir`. Non-critical — failure
 *  is only logged (`repair` returns a nonzero code even when ONE of the paths cannot be repaired).
 *  Paths without `.git` are skipped: they do not represent any live session. */
export async function repairWorktrees(bare: string, paths: string[]): Promise<void> {
  const live = paths.filter((p) => existsSync(join(p, ".git")));
  if (!live.length) return;
  const r = await sh(bare, "git", "-c", `safe.directory=${bare}`, "worktree", "repair", ...live);
  if (r.code !== 0) console.error(`git worktree repair in ${bare} partially failed: ${r.stderr.trim()}`);
}

/** The ref a revived session should stand on: its own branch, otherwise the default one. Returns
 *  the content for `HEAD` (symref), or null when neither branch exists — then the
 *  registration is not fabricated and the caller resorts to addWorktree. */
async function worktreeHead(bare: string, branch: string | null, from: string): Promise<string | null> {
  const safe = ["-c", `safe.directory=${bare}`];
  const has = async (ref: string) => (await sh(bare, "git", ...safe, "rev-parse", "--verify", "--quiet", ref)).code === 0;
  for (const b of [branch, from]) if (b && await has(`refs/heads/${b}`)) return `ref: refs/heads/${b}`;
  return null;
}

/** Recreates a LOST worktree registration without touching the files. Why not simply
 *  `worktree add`: it wants an empty directory, so the session's uncommitted work would first have
 *  to be moved aside — and that is the only irreplaceable thing in that directory.
 *
 *  Minimal registration = `commondir` + `gitdir` (back to the host path, not to
 *  `/workspace`) + `HEAD`. The index is not copied, because there is none; `git reset` recomputes it
 *  from HEAD — a mixed reset without paths does NOT CHANGE the working tree, only the index, so changes show
 *  up as changes instead of the whole tree appearing as new files. */
async function reregisterWorktree(bare: string, dest: string, head: string): Promise<boolean> {
  const admin = join(bare, "worktrees", basename(dest));
  try {
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "commondir"), "../..\n");
    writeFileSync(join(admin, "gitdir"), `${join(dest, ".git")}\n`);
    writeFileSync(join(admin, "HEAD"), `${head}\n`);
    writeFileSync(join(dest, ".git"), `gitdir: ${admin}\n`);
  } catch (e) {
    console.error(`restoring the registration of worktree ${dest} failed:`, e);
    return false;
  }
  if (!await worktreeHealthy(dest)) return false;
  const r = await sh(dest, "git", "-c", `safe.directory=${dest}`, "reset", "-q");
  if (r.code !== 0) console.error(`could not rebuild the index of worktree ${dest}: ${r.stderr.trim()}`);
  return true;
}

export type WorktreeState = "ok" | "created" | "repaired";

/** Guarantees that `dest` is a USABLE worktree — not merely that a `.git` lies in it. This is the
 *  place that keeps the promise "a session never starts over dead git":
 *
 *  1. alive → nothing (the vast majority of opens),
 *  2. the directory does not exist at all → `addWorktree` as before,
 *  3. the directory exists, but git in it does not work → `worktree repair` (the registration exists, it just
 *     points elsewhere), then fabricating the registration (the registration is gone) — both keep the
 *     files,
 *  4. even that did not help → the directory is MOVED ASIDE (not deleted!) and the worktree is created from scratch; better
 *     a session that starts, plus a backup next to it, than a container in a restart loop.
 *
 *  The return value tells the caller whether git metadata was touched (for the chown to the container's
 *  uid): "ok" = nothing happened. */
export async function ensureWorktree(
  bare: string, dest: string, branch: string | null, from: string, siblings: string[] = [],
): Promise<WorktreeState> {
  const state = await ensureWorktreeUnlocked(bare, dest, branch, from, siblings);
  lockWorktree(bare, dest);
  return state;
}

async function ensureWorktreeUnlocked(
  bare: string, dest: string, branch: string | null, from: string, siblings: string[],
): Promise<WorktreeState> {
  const born = async (): Promise<WorktreeState> => {
    await addWorktree(bare, dest, branch, from, siblings);
    return "created";
  };
  if (!existsSync(join(dest, ".git"))) return await born();
  if (await worktreeHealthy(dest)) return "ok";

  console.error(`worktree ${dest} has a broken registration — trying to repair`);
  await repairWorktrees(bare, [dest]);
  if (await worktreeHealthy(dest)) return "repaired";

  const head = await worktreeHead(bare, branch, from);
  if (head && await reregisterWorktree(bare, dest, head)) {
    console.error(`worktree ${dest}: registration restored at ${head}`);
    return "repaired";
  }

  const aside = `${dest}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(dest, aside);
    console.error(`worktree ${dest} could not be revived, moved aside to ${aside}`);
  } catch (e) {
    throw new Error(`worktree ${dest} is broken and cannot even be moved aside: ${e}`);
  }
  return await born();
}

/** Worktree for a session. `branch === null` = the first session in the repo; it takes the default
 *  branch, which nobody holds in the bare clone (that is exactly why the clone is bare).
 *
 *  safe.directory: devd runs as root, but the bare clone belongs to the container user
 *  (uid 1000) — without it the operation ends with "detected dubious ownership" (exit 128),
 *  i.e. a session without a working directory. Verified by experiment: `worktree add` as root over
 *  someone else's repo fails, with safe.directory it succeeds. */
/** Sets aside the branch of an ended session under `ended/<branch>-<time>`, so that a new session with the same
 *  number starts from scratch. Returns the new name, or `null` when there was nothing to set aside (the branch
 *  does not exist) or it is not possible (another worktree holds it — then it behaves as before). */
export async function archiveBranch(bare: string, branch: string, at: Date): Promise<string | null> {
  const safe = ["-c", `safe.directory=${bare}`];
  if ((await sh(bare, "git", "-C", bare, ...safe, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code !== 0) return null;
  const used = await sh(bare, "git", "-C", bare, ...safe, "worktree", "list", "--porcelain");
  if (used.stdout.split("\n").includes(`branch refs/heads/${branch}`)) return null;
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const target = `ended/${branch}-${stamp}`;
  const r = await sh(bare, "git", "-C", bare, ...safe, "branch", "-m", branch, target);
  if (r.code !== 0) throw new Error(`git branch -m ${branch} failed: ${r.stderr.trim()}`);
  return target;
}

export async function addWorktree(bare: string, dest: string, branch: string | null, from: string, siblings: string[] = []): Promise<void> {
  const safe = ["-c", `safe.directory=${bare}`];
  // An orphaned registration (someone deleted the worktree directory outside devd) keeps the branch occupied and
  // `worktree add` on it then fails with "already used by worktree" — i.e. a session that
  // does not start. `prune` deletes ONLY entries whose directory has vanished, so it cannot
  // endanger live sessions.
  // …except that "the directory has vanished" is judged by the path written in the registration, and that may be
  // a path from the CONTAINER (`/workspace/.git`) — that is how `git worktree repair` run
  // inside the session rewrites it. It does not exist on the host, so prune would unregister a LIVE session
  // (and its container would end up in a restart loop on "not a git
  // repository" at the next start). That is why the registrations of sibling sessions are first repaired to
  // host paths and only then pruned. Verified by a regression test, not by guesswork.
  await repairWorktrees(bare, siblings);
  await sh(bare, "git", ...safe, "worktree", "prune");
  // An empty repo (created, but without a single commit) has nothing for `from` to point to and
  // `worktree add` on it fails with "invalid reference". Today's `git clone` can open such a repo
  // (workspace on an unborn branch), so the new shape must be able to as well — otherwise
  // "create an empty repo and open a session in it right away" would stop working.
  const has = async (ref: string) => (await sh(bare, "git", ...safe, "rev-parse", "--verify", "--quiet", ref)).code === 0;
  const unborn = !await has(`${from}^{commit}`);
  // An existing branch is ADOPTED, not reset. `-B` would also not fail on repeatedly creating a session with
  // the same number (`nextSessionId` fills gaps from the bottom), but
  // it would move the branch to `from` — i.e. discard the ended session's commits into the reflog.
  // That is exactly why end() deliberately does not delete branches: an orphaned branch is an acceptable price, lost
  // work is not. A new session may thus inherit the previous one's work in progress; that is visible
  // and the user can deal with it, whereas vanished commits are seen by no one.
  // A NEW session branch starts from `origin/<from>`, not from the local `<from>`: a bare clone's
  // local heads are never fetched into (see trackRemote), so the local default branch was six
  // weeks old on the biggest repo — the session checked out that tree and the first pull then
  // rebased it onto origin through ~100k changed files. The caller fetches right before this.
  const start = branch && await has(`refs/remotes/origin/${from}^{commit}`) ? `origin/${from}` : from;
  const add = ["-C", bare, ...safe, ...PARALLEL_CHECKOUT, "worktree", "add"];
  const args = branch && await has(`refs/heads/${branch}`)
    ? [...add, dest, branch]
    : unborn
      ? [...add, "--orphan", "-b", branch ?? from, dest]
      : branch
        ? [...add, "--no-track", "-b", branch, dest, start]
        : [...add, dest, from];
  const r = await sh(bare, "git", ...args);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  // The session branch's upstream is the DEFAULT branch, not the remote of the same name (that one does not exist):
  // `pull --rebase` should rebase the session onto a fresh upstream, exactly as today in the
  // shared workspace. Without this, pull would end with "no tracking information" as soon as
  // the bare clone has a refspec set. `git push`, on the other hand, stays safely rejected
  // ("upstream branch name doesn't match"), so the session's work cannot accidentally land
  // in the default branch. The default branch itself is handled by trackRemote.
  if (branch && await has(`refs/remotes/origin/${from}`)) await setUpstream(bare, branch, from);
}

/** Uncommitted work in the worktree, as seen from the HOST. Returns the lines of `git status --porcelain`
 *  (empty array = clean tree), or `null` when the state COULD NOT be determined.
 *
 *  `null` is NOT "clean": the caller must take it as "don't know" and behave conservatively
 *  (keep the directory). It happens with a deleted directory, a broken worktree registration or
 *  when git fails for another reason.
 *
 *  Deliberately on the host and not via `docker exec`: this is asked at a moment when the session's container
 *  is often no longer running, and exec would then silently return nothing — i.e. look "clean".
 *  devd runs as root and the worktree lies on the host filesystem, so git works
 *  even for a stopped session.
 *
 *  `safe.directory` is required: without it git fails on "dubious ownership" (verified
 *  with GIT_TEST_ASSUME_DIFFERENT_OWNER=1). The worktree path is enough — the bare clone need not
 *  be listed, git takes the repository name for that check from the working tree.
 *
 *  Ignored files (node_modules, builds) are not counted — `--porcelain` does not list them without
 *  `--ignored`, which is exactly what we want: that is not work in progress. */
export async function worktreeChanges(dir: string): Promise<string[] | null> {
  const r = await sh(dir, "git", "-C", dir, "-c", `safe.directory=${dir}`, "status", "--porcelain");
  if (r.code !== 0) {
    console.error(`git status ${dir} failed: ${r.stderr.trim()}`);
    return null;
  }
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function removeWorktree(bare: string, dest: string): Promise<void> {
  // `--force`: the worktree of a running session contains uncommitted changes and git would otherwise
  // refuse to delete it. Ending a session is a conscious user step (F9 → End), so here
  // this is the correct behavior, not bypassing a safeguard.
  // Twice: a session's registration is locked (lockWorktree) and a single --force does not remove a locked one.
  const r = await sh(bare, "git", "-C", bare, "-c", `safe.directory=${bare}`, "worktree", "remove", "--force", "--force", dest);
  if (r.code !== 0) {
    // Non-critical: the container is already gone, an orphaned directory must not prevent deleting the row.
    console.error(`git worktree remove ${dest} failed: ${r.stderr.trim()}`);
  }
}

export function conflictPrompt(files: string[]): string {
  return (
    `A git pull resulted in a conflict (rebase in progress). ` +
    `Conflicted files: ${files.join(", ")}. ` +
    `Resolve the conflicts — preserve the local work in progress while incorporating the remote changes. ` +
    `When resolved, continue the rebase and verify the project still builds.`
  );
}
