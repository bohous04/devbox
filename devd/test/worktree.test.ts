import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, archiveBranch, cloneBare, defaultBranch, ensureWorktree, fetchBare, pullWithRebase, removeWorktree, trackRemote, worktreeBranch, worktreeChanges, worktreeHealthy } from "../src/git";
import { sh } from "./helpers/sh";
import { restoreBranch, sessionBranch, sessionWorktreePath, worktreeMounts } from "../src/sessions";

test("the worktree session lives outside the repo tree, under its id", () => {
  expect(sessionWorktreePath("/srv/dev", "dev-portal-web-2")).toBe("/srv/dev/_sessions/dev-portal-web-2");
});

// The branch name is decided at CREATION and is fixed. The session nickname is cosmetic —
// tying them together would mean a rename in the list silently runs a git operation.
test("the first session has no branch of its own, later ones do", () => {
  expect(sessionBranch("portal", "web", "dev-portal-web", true)).toBeNull();
  expect(sessionBranch("portal", "web", "dev-portal-web-2", false)).toBe("session/web-2");
  expect(sessionBranch("portal", "web", "dev-portal-web-3", false)).toBe("session/web-3");
});

// The first session ended, the second keeps running: `nextSessionId` hands back the bare id shape, but
// `isFirst` is correctly false. The number one is permanently free for this (numbering starts at two), so
// this must not produce `session/web-dev-portal-web`.
test("a bare id shape that is nevertheless not the first session gets number one", () => {
  expect(sessionBranch("portal", "web", "dev-portal-web", false)).toBe("session/web-1");
});

// A repo whose name itself ends with a dash and a digit. The id shape decides NOTHING here —
// `dev-portal-web-2` can be the second session of repo `web` or the first session of repo `web-2`.
// `isFirst` decides, which the caller determines from the DB by the columns (project, repo).
test("a repo whose name ends with a number is not taken for a second session", () => {
  // The first session of repo `web-2`, which got the bare id shape.
  expect(sessionBranch("portal", "web-2", "dev-portal-web-2", true)).toBeNull();
  // The first session of repo `web-2` when `dev-portal-web-2` is already taken by repo `web`
  // for its second session — the id comes out ugly, but the branch must still be the default.
  expect(sessionBranch("portal", "web-2", "dev-portal-web-2-2", true)).toBeNull();
  // Only the SECOND session of repo `web-2` gets its own branch.
  expect(sessionBranch("portal", "web-2", "dev-portal-web-2-3", false)).toBe("session/web-2-3");
});

// Without these two mounts git in a worktree session is dead ("not a git repository"),
// because `.git` in the worktree is a file with an absolute HOST path to the bare clone.
// It is also the only part of a worktree session that can be verified without docker.
test("a worktree session gets the bare clone and itself at the same path as on the host", () => {
  expect(worktreeMounts("/srv/dev/acme/portal/web.git", "/srv/dev/_sessions/dev-portal-web-2")).toEqual([
    "/srv/dev/acme/portal/web.git:/srv/dev/acme/portal/web.git",
    "/srv/dev/_sessions/dev-portal-web-2:/srv/dev/_sessions/dev-portal-web-2",
  ]);
});

// Real git, no mock: "a command was issued" proves nothing here — the whole point of the worktree
// is which branch the session sits on and whether it can pull upstream.
function makeOrigin(): { root: string; url: string } {
  const root = mkdtempSync(join(tmpdir(), "devd-wt-"));
  const url = join(root, "origin.git");
  sh(root, "git", "init", "--bare", "-b", "main", url);
  const seed = join(root, "seed");
  sh(root, "git", "init", "-b", "main", seed);
  sh(seed, "git", "config", "user.email", "t@t"); sh(seed, "git", "config", "user.name", "t");
  writeFileSync(join(seed, "f.txt"), "x\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "init");
  sh(seed, "git", "push", url, "HEAD:main");
  return { root, url };
}

const branchOf = (dir: string) => sh(dir, "git", "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();

test("the first worktree sits on the default branch, the second on its own — and both can pull", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);                           // just like open() right after the clone
  expect(await defaultBranch(bare)).toBe("main");

  const first = join(root, "_sessions", "dev-p-app");
  await addWorktree(bare, first, null, await defaultBranch(bare));
  expect(branchOf(first)).toBe("main");
  expect(existsSync(join(first, "f.txt"))).toBe(true);

  // If the bare clone were not bare, its working directory would hold the default branch and this
  // step would fail with "main is already used by worktree".
  const second = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, second, "session/app-2", await defaultBranch(bare));
  expect(branchOf(second)).toBe("session/app-2");

  // The pullWithRebase decision: it runs on THAT session's worktree. `git clone --bare`
  // sets up neither a refspec nor tracking, so this is the only thing proving that the session
  // gets to fresh code at all — on the default branch by fast-forward, on the session branch
  // by rebasing its work onto upstream.
  const seed = join(root, "seed");
  writeFileSync(join(seed, "g.txt"), "y\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "remote");
  sh(seed, "git", "push", url, "HEAD:main");

  sh(second, "git", "config", "user.email", "t@t"); sh(second, "git", "config", "user.name", "t");
  writeFileSync(join(second, "local.txt"), "z\n");
  sh(second, "git", "add", "."); sh(second, "git", "commit", "-m", "session work");

  expect((await pullWithRebase(first)).status).toBe("clean");
  expect(existsSync(join(first, "g.txt"))).toBe(true);
  expect((await pullWithRebase(second)).status).toBe("clean");
  expect(existsSync(join(second, "g.txt"))).toBe(true);      // pulled upstream
  expect(existsSync(join(second, "local.txt"))).toBe(true);  // and did not throw away the session's work
  expect(branchOf(second)).toBe("session/app-2");
});

// `git clone --bare` creates neither tracking refs nor an upstream. Without filling them in the
// session would silently lose a piece of normal git compared to today: `git push` would end with "no
// upstream branch" and the dashboard would report zero unpushed commits (`@{u}` does not exist).
test("a worktree session has normal git: upstream, push and the unpushed count", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const first = join(root, "_sessions", "dev-p-app");
  const second = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, first, null, await defaultBranch(bare));
  await addWorktree(bare, second, "session/app-2", await defaultBranch(bare));

  for (const w of [first, second]) {
    sh(w, "git", "config", "user.email", "t@t"); sh(w, "git", "config", "user.name", "t");
    writeFileSync(join(w, "n.txt"), "n\n");
    sh(w, "git", "add", "."); sh(w, "git", "commit", "-m", "work");
    expect(sh(w, "git", "rev-list", "--count", "@{u}..HEAD").stdout.trim()).toBe("1");
  }

  // The default branch pushes as from an ordinary clone.
  expect(sh(first, "git", "push").code).toBe(0);
  // The session branch is rejected — its upstream is the default branch, so the session's work
  // cannot land in main by mistake. Standard git behaviour (push.default=simple).
  expect(sh(second, "git", "push").code).not.toBe(0);
  expect(sh(url, "git", "log", "--oneline", "-1", "main").stdout).toContain("work");
  expect(sh(url, "git", "branch", "--list").stdout).not.toContain("session/app-2");
});

const refs = (bare: string, ns: string) =>
  sh(bare, "git", "for-each-ref", "--format=%(refname:short)", ns).stdout.split("\n").map((l) => l.trim()).filter(Boolean);

// `git clone --bare` copies ALL remote heads into `refs/heads/*`, which fetch (filling
// only `refs/remotes/origin/*`) never reaches again. If they stayed there, `git checkout feature/x`
// in the session would land on the same-named LOCAL branch frozen at clone time instead of
// taking it from a fresh `origin/feature/x` — and nothing would point it out.
test("the bare clone does not keep frozen local branches", async () => {
  const { root, url } = makeOrigin();
  const seed = join(root, "seed");
  sh(seed, "git", "checkout", "-b", "feature/x");
  writeFileSync(join(seed, "x.txt"), "old\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "feature v1");
  sh(seed, "git", "push", url, "HEAD:feature/x");

  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  expect(refs(bare, "refs/heads/")).toContain("feature/x");   // the clone copied them here

  await trackRemote(bare);

  // Locally only the default branch stays, exactly as with an ordinary clone…
  expect(refs(bare, "refs/heads/")).toEqual(["main"]);
  // …and remote ones are tracked, so the session has somewhere to take them from.
  expect(refs(bare, "refs/remotes/")).toContain("origin/feature/x");
  expect(refs(bare, "refs/remotes/")).toContain("origin/main");

  // The consequence that matters: origin moves and the session gets a FRESH branch, not the one from the clone.
  writeFileSync(join(seed, "x.txt"), "new\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "feature v2");
  sh(seed, "git", "push", url, "HEAD:feature/x");
  const fresh = sh(seed, "git", "rev-parse", "HEAD").stdout.trim();

  const wt = join(root, "_sessions", "dev-p-app");
  await addWorktree(bare, wt, null, await defaultBranch(bare));
  sh(wt, "git", "fetch", "origin");
  sh(wt, "git", "checkout", "feature/x");
  expect(sh(wt, "git", "rev-parse", "HEAD").stdout.trim()).toBe(fresh);
  expect(readFileSync(join(wt, "x.txt"), "utf8")).toBe("new\n");
});

// Today's `git clone` can open an empty repo (workspace on an unborn branch). The new shape
// must handle it too, otherwise "create an empty repo and open a session in it right away" stops
// working — `worktree add <branch>` fails on it with "invalid reference".
test("a freshly created repo without a commit can be opened too", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-wt-empty-"));
  const url = join(root, "origin.git");
  sh(root, "git", "init", "--bare", "-b", "main", url);
  const bare = join(root, "app.git");
  await cloneBare(url, bare);

  const first = join(root, "_sessions", "dev-p-app");
  await addWorktree(bare, first, null, await defaultBranch(bare));
  expect(existsSync(join(first, ".git"))).toBe(true);
  // Unborn branch: `rev-parse --abbrev-ref` returns "HEAD" on it (there is nothing to point to),
  // so we ask for the symref — the session must sit on the default branch, not detached.
  expect(sh(first, "git", "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe("main");
});

// The worktree directory can disappear outside devd (manual cleanup, restore from backup). Its registration
// in the bare clone stays behind and keeps the branch taken — without `worktree prune` the session
// would not come up on reopen ("already used by worktree").
test("a worktree can be created again even after an orphaned registration", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const dest = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare));
  sh(root, "rm", "-rf", dest);                       // directory gone, registration stayed

  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare));
  expect(branchOf(dest)).toBe("session/app-2");
});

// A new session easily gets the number of an ended one (`nextSessionId` fills gaps from the bottom).
// Its branch remained from the predecessor — and must be TAKEN OVER with its work, not reset to the default
// branch. That is the whole reason end() does not delete branches: lost work is worse than an orphaned branch.
test("a reopened session slot takes over its branch along with work in progress", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const dest = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare));
  sh(dest, "git", "config", "user.email", "t@t"); sh(dest, "git", "config", "user.name", "t");
  writeFileSync(join(dest, "wip.txt"), "work\n");
  sh(dest, "git", "add", "."); sh(dest, "git", "commit", "-m", "work in progress");
  const work = sh(dest, "git", "rev-parse", "HEAD").stdout.trim();

  await removeWorktree(bare, dest);                  // session end (Task 6), the branch stays
  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare)); // a new session in the same slot

  expect(branchOf(dest)).toBe("session/app-2");
  expect(sh(dest, "git", "rev-parse", "HEAD").stdout.trim()).toBe(work);
  expect(existsSync(join(dest, "wip.txt"))).toBe(true);
});

test("removeWorktree deletes the directory but leaves the branch alone", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const dest = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare));

  await removeWorktree(bare, dest);
  expect(existsSync(dest)).toBe(false);
  // The branch may hold work in progress; an orphaned branch is an acceptable price, a lost one is not.
  expect(sh(bare, "git", "branch", "--list").stdout).toContain("session/app-2");
});

// A stricter sibling of the test above: here not an EMPTY worktree was deleted, but a worktree with
// work in progress, and it verifies DIRECTLY on the bare repo (without reattaching the worktree) that
// the branch after removeWorktree points exactly at THIS commit — not at the default branch, not
// anywhere else. This is the core of Task 6: an orphaned branch is an acceptable price, lost
// work is not, and this property must be verifiable without docker.
test("removeWorktree leaves exactly the work-in-progress commit that was on the branch", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const dest = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare));

  sh(dest, "git", "config", "user.email", "t@t"); sh(dest, "git", "config", "user.name", "t");
  writeFileSync(join(dest, "wip.txt"), "work\n");
  sh(dest, "git", "add", "."); sh(dest, "git", "commit", "-m", "work in progress");
  const work = sh(dest, "git", "rev-parse", "HEAD").stdout.trim();
  // It must differ from the default branch, otherwise the test could not tell "the commit survived" from
  // "the branch was reset to the default" — exactly the danger end() avoids.
  expect(work).not.toBe(sh(bare, "git", "rev-parse", await defaultBranch(bare)).stdout.trim());

  await removeWorktree(bare, dest);

  expect(existsSync(dest)).toBe(false);
  expect(sh(bare, "git", "rev-parse", "session/app-2").stdout.trim()).toBe(work);
});

// The basis for deciding whether the automatic cleanup after a scheduled run may delete the worktree
// (autoEnd.ts). Real git, because this is exactly about what git considers a change
// — and what is "don't know".
test("worktreeChanges: clean → [], work in progress → lines, missing directory → null", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const dest = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, dest, "session/app-2", await defaultBranch(bare));

  expect(await worktreeChanges(dest)).toEqual([]);

  // An untracked file is work in progress too — after a finished cron run it is often
  // exactly the output for which the directory must not be deleted.
  writeFileSync(join(dest, "scratch.txt"), "work in progress\n");
  expect(await worktreeChanges(dest)).toEqual(["?? scratch.txt"]);

  // A change to a tracked file.
  writeFileSync(join(dest, "f.txt"), "y\n");
  expect((await worktreeChanges(dest))!.sort()).toEqual(["?? scratch.txt", "M f.txt"]);

  // Committed work is no longer in progress — the tree is clean and may be deleted.
  sh(dest, "git", "config", "user.email", "t@t"); sh(dest, "git", "config", "user.name", "t");
  sh(dest, "git", "add", "."); sh(dest, "git", "commit", "-m", "done");
  expect(await worktreeChanges(dest)).toEqual([]);

  // A nonexistent path = "don't know", not "clean". The caller must treat it conservatively.
  expect(await worktreeChanges(join(root, "nothing"))).toBeNull();
});

// REGRESSION (2026-09-02, games/game_agents): the session looked running,
// but the container was in a restart loop on `fatal: not a git repository <bare>/worktrees/<id>`.
// The worktree registration was deleted by `git worktree prune`, which addWorktree runs when
// creating ANOTHER session of the same repo: the `gitdir` of that live registration held the path
// `/workspace/.git` (that is how `git worktree repair` run INSIDE the container rewrites it —
// exactly the fix the comment on worktreeMounts recommends), and that does not exist on the host,
// so prune judged it dead. Prevention: before prune, the registrations of
// sibling sessions are repaired to host paths.
test("prune when creating another session does not unregister a live worktree with a container path", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const first = join(root, "_sessions", "dev-p-app");
  await addWorktree(bare, first, null, await defaultBranch(bare));

  // A poisoned registration: the path as the container sees it, not the host.
  const admin = join(bare, "worktrees", "dev-p-app");
  writeFileSync(join(admin, "gitdir"), "/workspace/.git\n");

  const second = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, second, "session/app-2", await defaultBranch(bare), [first]);

  expect(existsSync(admin)).toBe(true);
  expect(await worktreeHealthy(first)).toBe(true);
  // And the repaired registration points back to the host path, so the next prune
  // will not shoot it down even without the sibling list.
  // realpathSync: on a mac /var is a symlink to /private/var and git records the canonical path.
  expect(readFileSync(join(admin, "gitdir"), "utf8").trim()).toBe(join(realpathSync(first), ".git"));
});

// Second layer: even if the registration disappeared anyway (old state on disk, manual intervention),
// the container must not start on a dead git. ensureWorktree revives it, without touching
// the files — the session's uncommitted work is the only irreplaceable thing in that directory.
test("ensureWorktree revives a session whose registration vanished and leaves the files alone", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const wt = join(root, "_sessions", "dev-p-app");
  await addWorktree(bare, wt, null, await defaultBranch(bare));

  writeFileSync(join(wt, "f.txt"), "work in progress\n");   // a change in a tracked file
  writeFileSync(join(wt, "new.txt"), "new file\n");    // and an untracked one
  rmSync(join(bare, "worktrees", "dev-p-app"), { recursive: true, force: true });
  expect(await worktreeHealthy(wt)).toBe(false);

  await ensureWorktree(bare, wt, null, await defaultBranch(bare));

  expect(await worktreeHealthy(wt)).toBe(true);
  expect(branchOf(wt)).toBe("main");
  expect(readFileSync(join(wt, "f.txt"), "utf8")).toBe("work in progress\n");
  expect(readFileSync(join(wt, "new.txt"), "utf8")).toBe("new file\n");
  // The index was rebuilt from HEAD, so git sees that change as a change — not the whole tree as new.
  expect(sh(wt, "git", "status", "--porcelain").stdout.split("\n").filter(Boolean).sort())
    .toEqual([" M f.txt", "?? new.txt"]);
});

// A missing directory is still the original case: the worktree is simply created.
test("ensureWorktree creates the worktree when the directory does not exist yet", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const wt = join(root, "_sessions", "dev-p-app");
  await ensureWorktree(bare, wt, null, await defaultBranch(bare));
  expect(await worktreeHealthy(wt)).toBe(true);
  expect(existsSync(join(wt, "f.txt"))).toBe(true);
});

// The recorded branch takes precedence over the derived one: "is this the first session?" holds only at the moment
// of creation. On reopen the siblings may already be gone and derivation would return the default branch.
test("restoreBranch takes the branch recorded on the session, even if it would come out as the first today", () => {
  expect(restoreBranch("session/web-1", "portal", "web", "dev-portal-web", true)).toBe("session/web-1");
  expect(restoreBranch(null, "portal", "web", "dev-portal-web", true)).toBeNull();
  expect(restoreBranch(undefined, "portal", "web", "dev-portal-web-2", false)).toBe("session/web-2");
});

test("worktreeBranch reads the branch of a live worktree, returns null for a dead registration", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const wt = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, wt, "session/app-2", await defaultBranch(bare));
  expect(await worktreeBranch(wt)).toBe("session/app-2");
  rmSync(join(bare, "worktrees", "dev-p-app-2"), { recursive: true, force: true });
  expect(await worktreeBranch(wt)).toBeNull();
});

// The whole incident at the git level: registration gone, the caller passes the session's recorded branch →
// the worktree returns to it and the uncommitted work stays.
test("ensureWorktree with the session branch restores the registration on that branch", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const wt = join(root, "_sessions", "dev-p-app");
  await addWorktree(bare, wt, "session/app-1", await defaultBranch(bare));
  writeFileSync(join(wt, "f.txt"), "work in progress\n");
  rmSync(join(bare, "worktrees", "dev-p-app"), { recursive: true, force: true });

  await ensureWorktree(bare, wt, restoreBranch("session/app-1", "p", "app", "dev-p-app", true), await defaultBranch(bare));

  expect(branchOf(wt)).toBe("session/app-1");
  expect(readFileSync(join(wt, "f.txt"), "utf8")).toBe("work in progress\n");
});

test("archiveBranch sets aside the branch of an ended session and a new session then starts from the default branch", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const dest = join(root, "_sessions", "dev-p-app-3");
  await addWorktree(bare, dest, "session/app-3", await defaultBranch(bare));
  sh(dest, "git", "config", "user.email", "t@t"); sh(dest, "git", "config", "user.name", "t");
  writeFileSync(join(dest, "old.txt"), "squashed long ago\n");
  sh(dest, "git", "add", "."); sh(dest, "git", "commit", "-m", "old work");
  const old = sh(dest, "git", "rev-parse", "HEAD").stdout.trim();
  await removeWorktree(bare, dest);                  // end(): directory gone, the branch stays

  const archived = await archiveBranch(bare, "session/app-3", new Date("2026-10-05T19:25:40Z"));
  expect(archived).toBe("ended/session/app-3-20261005-192540");
  expect(sh(bare, "git", "rev-parse", archived!).stdout.trim()).toBe(old); // the commits did not disappear

  await addWorktree(bare, dest, "session/app-3", await defaultBranch(bare));
  expect(branchOf(dest)).toBe("session/app-3");
  expect(sh(dest, "git", "rev-parse", "HEAD").stdout.trim()).toBe(sh(bare, "git", "rev-parse", "main").stdout.trim());
  expect(existsSync(join(dest, "old.txt"))).toBe(false);
});

test("archiveBranch leaves alone a nonexistent branch and a branch held by a live worktree", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  expect(await archiveBranch(bare, "session/app-9", new Date())).toBeNull();
  const live = join(root, "_sessions", "dev-p-app-2");
  await addWorktree(bare, live, "session/app-2", await defaultBranch(bare));
  expect(await archiveBranch(bare, "session/app-2", new Date())).toBeNull();
  expect(branchOf(live)).toBe("session/app-2");
});

// 1 Nov 2026: the local default branch of a bare clone is never fetched into, so on the biggest
// repo it was six weeks old. A new session checked out that tree and the first pull then rebased
// it onto origin through ~100k changed files — most of the time of opening a session.
test("a new session branch starts from the freshly fetched origin, not from the stale local default", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const seed = join(root, "seed");
  writeFileSync(join(seed, "g.txt"), "new upstream\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "upstream moved");
  sh(seed, "git", "push", url, "HEAD:main");
  const upstream = sh(seed, "git", "rev-parse", "HEAD").stdout.trim();

  await fetchBare(bare);
  expect(sh(bare, "git", "rev-parse", "refs/heads/main").stdout.trim()).not.toBe(upstream);   // local main stays behind
  const wt = join(root, "_sessions", "dev-p-app-2");
  await ensureWorktree(bare, wt, "session/app-2", await defaultBranch(bare));
  expect(sh(wt, "git", "rev-parse", "HEAD").stdout.trim()).toBe(upstream);
  expect(existsSync(join(wt, "g.txt"))).toBe(true);
  // Upstream is still the default branch, so the session's pull rebases onto it as before.
  expect(sh(wt, "git", "rev-parse", "--abbrev-ref", "@{u}").stdout.trim()).toBe("origin/main");
  expect((await pullWithRebase(wt)).status).toBe("clean");
});

// A prune with no sibling list — an agent's `git worktree prune` inside a container, where the
// registration's host path does not exist — deleted live sessions' registrations.
test("ensureWorktree locks the registration, so even a blind prune leaves a live session alone", async () => {
  const { root, url } = makeOrigin();
  const bare = join(root, "app.git");
  await cloneBare(url, bare);
  await trackRemote(bare);
  const wt = join(root, "_sessions", "dev-p-app-2");
  await ensureWorktree(bare, wt, "session/app-2", await defaultBranch(bare));
  const admin = join(bare, "worktrees", "dev-p-app-2");
  expect(existsSync(join(admin, "locked"))).toBe(true);

  writeFileSync(join(admin, "gitdir"), "/workspace/.git\n");   // the path as a container sees it
  sh(bare, "git", "worktree", "prune");
  expect(existsSync(admin)).toBe(true);

  // A session that already exists gets the lock on its next open, too.
  rmSync(join(admin, "locked"));
  writeFileSync(join(admin, "gitdir"), `${join(realpathSync(wt), ".git")}\n`);
  expect(await ensureWorktree(bare, wt, "session/app-2", "main")).toBe("ok");
  expect(existsSync(join(admin, "locked"))).toBe(true);

  // Ending the session still removes it.
  await removeWorktree(bare, wt);
  expect(existsSync(wt)).toBe(false);
  expect(existsSync(admin)).toBe(false);
});
