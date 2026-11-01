import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../src/git";
import { buildUnpushedReport, discoverRepos, unpushedInRepo } from "../src/unpushed";

/** Origin (bare) + a working clone with one pushed commit — the default state
 *  "everything is pushed". Returns the paths so the test can add what it needs. */
async function fixture(root = mkdtempSync(join(tmpdir(), "devd-unpushed-"))) {
  const origin = join(root, "origin.git");
  await sh(root, "git", "init", "--bare", "-b", "main", origin);
  const work = join(root, "work");
  await sh(root, "git", "clone", origin, work);
  await identity(work);
  writeFileSync(join(work, "file.txt"), "base\n");
  await sh(work, "git", "add", "."); await sh(work, "git", "commit", "-q", "-m", "base"); await sh(work, "git", "push", "-q", "-u", "origin", "main");
  return { root, origin, work };
}

async function identity(dir: string) {
  await sh(dir, "git", "config", "user.email", "t@t"); await sh(dir, "git", "config", "user.name", "Tester");
}

async function commit(dir: string, msg: string) {
  writeFileSync(join(dir, `${msg.replace(/\W+/g, "_")}.txt`), `${msg}\n`);
  await sh(dir, "git", "add", "."); await sh(dir, "git", "commit", "-q", "-m", msg);
}

// ---------------------------------------------------------------- discoverRepos

test("discoverRepos finds a flat repo, a repo in a project and a bare clone; skips underscore and hidden folders", () => {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-tree-"));
  // apps/web — flat repo (project === folder)
  mkdirSync(join(root, "apps", "web", ".git"), { recursive: true });
  // acme/portal/api — repo in a project; next to it a bare clone web.git
  mkdirSync(join(root, "acme", "portal", "api", ".git"), { recursive: true });
  mkdirSync(join(root, "acme", "portal", "web.git"), { recursive: true });
  writeFileSync(join(root, "acme", "portal", "web.git", "HEAD"), "ref: refs/heads/main\n");
  // noise: session worktree, inbox, a file in the folder, a project without repos, a .git directory without HEAD
  mkdirSync(join(root, "_sessions", "dev-x", ".git"), { recursive: true });
  mkdirSync(join(root, "_inbox"), { recursive: true });
  writeFileSync(join(root, "apps", "notes.txt"), "x");
  mkdirSync(join(root, "acme", "empty-project", "docs"), { recursive: true });
  mkdirSync(join(root, "apps", "broken.git"), { recursive: true });
  mkdirSync(join(root, ".hidden", "repo", ".git"), { recursive: true });

  expect(discoverRepos(root)).toEqual([
    { folder: "acme", project: "portal", repo: "api", path: join(root, "acme", "portal", "api"), bare: false },
    { folder: "acme", project: "portal", repo: "web", path: join(root, "acme", "portal", "web.git"), bare: true },
    { folder: "apps", project: "apps", repo: "web", path: join(root, "apps", "web"), bare: false },
  ]);
});

test("discoverRepos on a nonexistent root returns empty instead of throwing", () => {
  expect(discoverRepos(join(tmpdir(), "devd-unpushed-neexistuje-" + Date.now()))).toEqual([]);
});

// ---------------------------------------------------------------- unpushedInRepo

test("clean clone: zero commits, no branches", async () => {
  const { work } = await fixture();
  const r = await unpushedInRepo(work);
  expect(r).toEqual({ noRemote: false, count: 0, branches: [] });
});

test("two local commits on top of origin/main: list from the newest, with upstream", async () => {
  const { work } = await fixture();
  await commit(work, "first change");
  await commit(work, "second change");
  const r = await unpushedInRepo(work);
  expect(r.noRemote).toBe(false);
  expect(r.count).toBe(2);
  expect(r.branches).toHaveLength(1);
  const b = r.branches[0];
  expect(b.branch).toBe("main");
  expect(b.upstream).toBe("origin/main");
  expect(b.count).toBe(2);
  expect(b.truncated).toBe(false);
  expect(b.commits.map((c) => c.subject)).toEqual(["second change", "first change"]);
  expect(b.commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
  expect(b.commits[0].author).toBe("Tester");
  expect(b.commits[0].at).toBeGreaterThan(1_600_000_000_000); // ms, not seconds
});

test("a commit shared by two branches is counted only once — it goes to the base (the branch with fewer unpushed)", async () => {
  const { work } = await fixture();
  await commit(work, "on main");                       // main = origin/main + 1
  await sh(work, "git", "checkout", "-q", "-b", "feature");
  await commit(work, "on feature");                     // feature = main + 1 (HEAD)
  const r = await unpushedInRepo(work);
  expect(r.count).toBe(2);
  // main has 1 unpushed, feature 2 → main is the base and takes its commit first;
  // feature then reports only what is really its own. If HEAD (feature) went first,
  // "on main" would show under feature and main would look clean — not true.
  expect(r.branches.map((b) => [b.branch, b.count])).toEqual([["main", 1], ["feature", 1]]);
  expect(r.branches[0].commits.map((c) => c.subject)).toEqual(["on main"]);
  expect(r.branches[0].upstream).toBe("origin/main");
  expect(r.branches[1].commits.map((c) => c.subject)).toEqual(["on feature"]);
  expect(r.branches[1].upstream).toBeNull();
});

test("with an equal number of unpushed, the HEAD branch goes first", async () => {
  const { work } = await fixture();
  await sh(work, "git", "checkout", "-q", "-b", "a");
  await commit(work, "on a");
  await sh(work, "git", "checkout", "-q", "main");
  await sh(work, "git", "checkout", "-q", "-b", "b");
  await commit(work, "on b");                           // b is HEAD, both branches have 1
  const r = await unpushedInRepo(work);
  expect(r.branches.map((b) => b.branch)).toEqual(["b", "a"]);
});

test("a branch named the same as a tag: the branch counts, not the tag", async () => {
  const { work } = await fixture();
  await sh(work, "git", "tag", "hotfix");                // tag on the pushed base commit
  await sh(work, "git", "checkout", "-q", "-b", "hotfix");
  await commit(work, "fix");                             // branch hotfix = base + 1
  const r = await unpushedInRepo(work);
  // git resolves the short name "hotfix" in favour of the tag (refs/tags takes precedence) and would
  // report zero; via the full ref refs/heads/hotfix the one commit is found.
  expect(r.count).toBe(1);
  expect(r.branches.map((b) => [b.branch, b.count])).toEqual([["hotfix", 1]]);
});

test("bare clone: a session branch with commits not on origin is reported even without a working directory", async () => {
  const { root, origin } = await fixture();
  const bare = join(root, "web.git");
  await sh(root, "git", "clone", "--bare", origin, bare);
  await sh(bare, "git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  await sh(bare, "git", "fetch", "-q", "origin");
  const wt = join(root, "_sessions", "dev-web-2");
  await sh(bare, "git", "worktree", "add", "-q", "-b", "session/web-2", wt, "main");
  await sh(bare, "git", "branch", "--set-upstream-to=origin/main", "session/web-2");
  await identity(wt);
  await commit(wt, "work in session");
  const r = await unpushedInRepo(bare);
  expect(r.count).toBe(1);
  expect(r.branches.map((b) => [b.branch, b.upstream, b.count])).toEqual([["session/web-2", "origin/main", 1]]);
  expect(r.branches[0].commits[0].subject).toBe("work in session");
});

test("repo without a remote: everything is unpushed, noRemote=true, the list is clipped to the limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-unpushed-solo-"));
  await sh(dir, "git", "init", "-q", "-b", "main");
  await identity(dir);
  for (let i = 1; i <= 4; i++) await commit(dir, `commit ${i}`);
  const r = await unpushedInRepo(dir, { limit: 3 });
  expect(r.noRemote).toBe(true);
  expect(r.count).toBe(4);
  expect(r.branches[0].count).toBe(4);
  expect(r.branches[0].truncated).toBe(true);
  expect(r.branches[0].commits.map((c) => c.subject)).toEqual(["commit 4", "commit 3", "commit 2"]);
});

test("a broken repo does not throw but returns an error and zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-unpushed-broken-"));
  writeFileSync(join(dir, ".git"), "gitdir: /neexistuje/worktrees/x\n");
  const r = await unpushedInRepo(dir);
  expect(r.count).toBe(0);
  expect(r.branches).toEqual([]);
  expect(typeof r.error).toBe("string");
  expect(r.error!.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- buildUnpushedReport

test("report groups by folder, sums up and skips clean repos", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-report-"));
  // apps/web: 2 unpushed; acme/portal/api: clean; acme/portal/solo: no remote, 1 commit
  const originA = join(root, "_origins", "a.git"); mkdirSync(join(root, "_origins"), { recursive: true });
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", originA);
  const web = join(root, "apps", "web"); mkdirSync(join(root, "apps"), { recursive: true });
  await sh(root, "git", "clone", "-q", originA, web); await identity(web);
  await commit(web, "base"); await sh(web, "git", "push", "-q", "-u", "origin", "main");
  await commit(web, "wip 1"); await commit(web, "wip 2");

  const originB = join(root, "_origins", "b.git");
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", originB);
  const api = join(root, "acme", "portal", "api"); mkdirSync(join(root, "acme", "portal"), { recursive: true });
  await sh(root, "git", "clone", "-q", originB, api); await identity(api);
  await commit(api, "base"); await sh(api, "git", "push", "-q", "-u", "origin", "main");

  const solo = join(root, "acme", "portal", "solo");
  mkdirSync(solo); await sh(solo, "git", "init", "-q", "-b", "main"); await identity(solo); await commit(solo, "local only");

  const report = await buildUnpushedReport(root, { now: 1234 });
  expect(report.at).toBe(1234);
  expect(report.scanned).toBe(3);
  expect(report.total).toBe(3);
  expect(report.folders.map((f) => [f.folder, f.count, f.repos.map((r) => `${r.project}/${r.repo}:${r.count}`)])).toEqual([
    ["acme", 1, ["portal/solo:1"]],
    ["apps", 2, ["apps/web:2"]],
  ]);
  const soloRow = report.folders[0].repos[0];
  expect(soloRow.noRemote).toBe(true);
  expect(soloRow.bare).toBe(false);
  expect(soloRow.path).toBe(solo);
});

test("report on an empty root: zero of everything, no exception", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-empty-"));
  const report = await buildUnpushedReport(root);
  expect(report.total).toBe(0);
  expect(report.scanned).toBe(0);
  expect(report.folders).toEqual([]);
});
