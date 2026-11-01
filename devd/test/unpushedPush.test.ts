import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../src/git";
import { baseBranch, buildUnpushedReport, createPr, parseRemote, pushBranch, remoteInfo, unpushedInRepo, unpushedOps } from "../src/unpushed";

async function fixture(defaultBranch = "main") {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-push-"));
  const origin = join(root, "origin.git");
  await sh(root, "git", "init", "-q", "--bare", "-b", defaultBranch, origin);
  const work = join(root, "work");
  await sh(root, "git", "clone", "-q", origin, work);
  await sh(work, "git", "config", "user.email", "t@t"); await sh(work, "git", "config", "user.name", "Tester");
  writeFileSync(join(work, "file.txt"), "base\n");
  await sh(work, "git", "add", "."); await sh(work, "git", "commit", "-q", "-m", "base");
  await sh(work, "git", "push", "-q", "-u", "origin", defaultBranch);
  return { root, origin, work };
}

async function commit(dir: string, msg: string) {
  writeFileSync(join(dir, `${msg.replace(/\W+/g, "_")}.txt`), `${msg}\n`);
  await sh(dir, "git", "add", "."); await sh(dir, "git", "commit", "-q", "-m", msg);
}

// ---------------------------------------------------------------- parseRemote

test("parseRemote recognizes GitHub over https and ssh", () => {
  expect(parseRemote("https://github.com/acme/VPSbetter.git", [])).toEqual({ provider: "github", url: "https://github.com/acme/VPSbetter.git", host: "github.com", owner: "acme", name: "VPSbetter" });
  expect(parseRemote("git@github.com:acme/VPSbetter.git", [])).toMatchObject({ provider: "github", host: "github.com", owner: "acme", name: "VPSbetter" });
});

test("parseRemote recognizes Gitea by the host of a configured instance (the port is ignored)", () => {
  const r = parseRemote("http://198.51.100.7:3000/bob/game_main.git", ["http://198.51.100.7:3000"]);
  expect(r).toMatchObject({ provider: "gitea", host: "198.51.100.7:3000", owner: "bob", name: "game_main" });
  expect(parseRemote("ssh://git@gitea.example:2222/owner/repo.git", ["https://gitea.example"])).toMatchObject({ provider: "gitea", owner: "owner", name: "repo" });
});

test("parseRemote: unknown host or local path = other, no PR", () => {
  expect(parseRemote("https://example.com/x/y", []).provider).toBe("other");
  expect(parseRemote("/tmp/origin.git", []).provider).toBe("other");
});

// ---------------------------------------------------------------- remoteInfo / baseBranch

test("remoteInfo reads origin; a repo without a remote returns null", async () => {
  const { origin, work } = await fixture();
  expect(await remoteInfo(work, [])).toMatchObject({ provider: "other", url: origin });
  const solo = mkdtempSync(join(tmpdir(), "devd-unpushed-solo-"));
  await sh(solo, "git", "init", "-q", "-b", "main");
  expect(await remoteInfo(solo, [])).toBeNull();
});

test("baseBranch is the remote's default branch — even when it is not called main", async () => {
  const { root, origin, work } = await fixture("trunk");
  // A clone has origin/HEAD set only when cloning a non-empty repo — set it manually so the test
  // verifies reading the symref, not a guess.
  await sh(work, "git", "remote", "set-head", "origin", "trunk");
  expect(await baseBranch(work)).toBe("trunk");
  const bare = join(root, "web.git");
  await sh(root, "git", "clone", "-q", "--bare", origin, bare);
  expect(await baseBranch(bare)).toBe("trunk");
});

test("baseBranch of a working clone without origin/HEAD is NOT the current branch but origin/main", async () => {
  const { work } = await fixture();
  // A clone of an empty origin (like every repo created via devd) has no origin/HEAD.
  expect((await sh(work, "git", "symbolic-ref", "-q", "refs/remotes/origin/HEAD")).code).not.toBe(0);
  await sh(work, "git", "checkout", "-q", "-b", "feat/x");
  await commit(work, "wip");
  expect(await baseBranch(work)).toBe("main");
});

// ---------------------------------------------------------------- pushBranch

test("pushBranch sends the branch to origin under the same name; the commits are then not unpushed", async () => {
  const { origin, work } = await fixture();
  await sh(work, "git", "checkout", "-q", "-b", "feature");
  await commit(work, "work");
  expect((await unpushedInRepo(work)).count).toBe(1);

  const r = await pushBranch(work, "feature", {});
  expect(r).toEqual({ ok: true });
  expect((await sh(origin, "git", "rev-parse", "--verify", "refs/heads/feature")).code).toBe(0);
  expect((await unpushedInRepo(work)).count).toBe(0);
  // The upstream does NOT CHANGE: session branches deliberately have the upstream on the default branch
  // (pull --rebase at session start), the push must not switch it to origin/feature.
  expect((await sh(work, "git", "rev-parse", "--abbrev-ref", "feature@{u}")).stdout.trim()).toBe("");
});

test("pushBranch from a bare clone (session branch) works without a working directory", async () => {
  const { root, origin } = await fixture();
  const bare = join(root, "web.git");
  await sh(root, "git", "clone", "-q", "--bare", origin, bare);
  await sh(bare, "git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  await sh(bare, "git", "fetch", "-q", "origin");
  const wt = join(root, "_sessions", "dev-web-2");
  await sh(bare, "git", "worktree", "add", "-q", "-b", "session/web-2", wt, "main");
  await sh(wt, "git", "config", "user.email", "t@t"); await sh(wt, "git", "config", "user.name", "Tester");
  await commit(wt, "in session");
  expect(await pushBranch(bare, "session/web-2", {})).toEqual({ ok: true });
  expect((await sh(origin, "git", "rev-parse", "--verify", "refs/heads/session/web-2")).code).toBe(0);
});

test("pushBranch without a remote returns an error, not an exception", async () => {
  const solo = mkdtempSync(join(tmpdir(), "devd-unpushed-solo-"));
  await sh(solo, "git", "init", "-q", "-b", "main");
  const r = await pushBranch(solo, "main", {});
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- createPr

const gh = { provider: "github" as const, url: "https://github.com/o/n.git", host: "github.com", owner: "o", name: "n" };

test("createPr on GitHub calls gh pr create with repo/head/base/title/body and returns URL + number", async () => {
  let argv: string[] = [];
  const runner = async (_cwd: string, ...cmd: string[]) => { argv = cmd; return { code: 0, stdout: "https://github.com/o/n/pull/12\n", stderr: "" }; };
  const r = await createPr({ dir: "/x", branch: "feature", base: "main", title: "Title", body: "- work", remote: gh, giteaToken: undefined, ghRun: runner });
  expect(r).toEqual({ url: "https://github.com/o/n/pull/12", number: 12 });
  expect(argv).toEqual(["gh", "pr", "create", "--repo", "o/n", "--head", "feature", "--base", "main", "--title", "Title", "--body", "- work"]);
});

test("createPr on GitHub propagates the gh error as text (e.g. PR already exists)", async () => {
  const runner = async () => ({ code: 1, stdout: "", stderr: "a pull request for branch \"feature\" into branch \"main\" already exists:\nhttps://github.com/o/n/pull/3" });
  await expect(createPr({ dir: "/x", branch: "feature", base: "main", title: "T", body: "", remote: gh, giteaToken: undefined, ghRun: runner }))
    .rejects.toThrow(/already exists/);
});

test("createPr on Gitea POSTs /api/v1/repos/{owner}/{repo}/pulls with the token", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ number: 7, html_url: "http://g/o/n/pulls/7" }), { status: 201 });
  };
  const remote = { provider: "gitea" as const, url: "http://g:3000/o/n.git", host: "g:3000", owner: "o", name: "n" };
  const r = await createPr({ dir: "/x", branch: "feature", base: "main", title: "T", body: "B", remote, giteaToken: "tok", giteaUrl: "http://g:3000", fetcher });
  expect(r).toEqual({ url: "http://g/o/n/pulls/7", number: 7 });
  expect(seen!.url).toBe("http://g:3000/api/v1/repos/o/n/pulls");
  expect(seen!.init.method).toBe("POST");
  expect((seen!.init.headers as Record<string, string>).Authorization).toBe("token tok");
  expect(JSON.parse(String(seen!.init.body))).toEqual({ head: "feature", base: "main", title: "T", body: "B" });
});

test("createPr on Gitea without a token or with a rejected token throws a clear error", async () => {
  const remote = { provider: "gitea" as const, url: "http://g:3000/o/n.git", host: "g:3000", owner: "o", name: "n" };
  await expect(createPr({ dir: "/x", branch: "f", base: "main", title: "T", body: "", remote, giteaToken: undefined, giteaUrl: "http://g:3000" }))
    .rejects.toThrow(/token/);
  const fetcher = async () => new Response("{}", { status: 401 });
  await expect(createPr({ dir: "/x", branch: "f", base: "main", title: "T", body: "", remote, giteaToken: "bad", giteaUrl: "http://g:3000", fetcher }))
    .rejects.toThrow(/401|rejected/);
});

test("createPr for a remote without a supported provider rejects", async () => {
  const remote = { provider: "other" as const, url: "/tmp/x.git", host: "", owner: "", name: "" };
  await expect(createPr({ dir: "/x", branch: "f", base: "main", title: "T", body: "", remote, giteaToken: undefined })).rejects.toThrow(/GitHub|Gitea/);
});

// ---------------------------------------------------------------- report carries remote + base

test("report for a repo with unpushed commits carries the remote and base branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-report-"));
  const origin = join(root, "_origins", "a.git");
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const web = join(root, "apps", "web");
  await sh(root, "git", "clone", "-q", origin, web);
  await sh(web, "git", "config", "user.email", "t@t"); await sh(web, "git", "config", "user.name", "Tester");
  await commit(web, "base"); await sh(web, "git", "push", "-q", "-u", "origin", "main");
  await commit(web, "wip");
  const report = await buildUnpushedReport(root, { giteaHosts: [] });
  const row = report.folders[0].repos[0];
  expect(row.remote).toMatchObject({ provider: "other", url: origin });
  expect(row.base).toBe("main");
});

// ---------------------------------------------------------------- unpushedOps (wiring)

test("unpushedOps.push rejects a path outside the workspace and an unknown branch, otherwise pushes", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-ops-"));
  const origin = join(root, "_origins", "a.git");
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const web = join(root, "apps", "web");
  await sh(root, "git", "clone", "-q", origin, web);
  await sh(web, "git", "config", "user.email", "t@t"); await sh(web, "git", "config", "user.name", "Tester");
  await commit(web, "base"); await sh(web, "git", "push", "-q", "-u", "origin", "main");
  await commit(web, "wip");

  const ops = unpushedOps(root, { authFor: () => ({}), giteaToken: () => undefined, giteaUrls: () => [] });
  await expect(ops.push("/etc", "main")).rejects.toThrow(/repo/);
  await expect(ops.push(web, "../x")).rejects.toThrow(/branch/);
  await expect(ops.push(web, "missing")).rejects.toThrow(/branch/);
  expect(await ops.push(web, "main")).toEqual({ ok: true });
  expect((await unpushedInRepo(web)).count).toBe(0);
});

test("unpushedOps.createPr works out the remote and base and passes them to the provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-unpushed-ops-"));
  const origin = join(root, "_origins", "a.git");
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const web = join(root, "apps", "web");
  await sh(root, "git", "clone", "-q", origin, web);
  await sh(web, "git", "config", "user.email", "t@t"); await sh(web, "git", "config", "user.name", "Tester");
  await commit(web, "base"); await sh(web, "git", "push", "-q", "-u", "origin", "main");
  // origin is a local path → provider other; we rewrite the remote URL to GitHub so the PR branch is tried
  await sh(web, "git", "remote", "set-url", "origin", "https://github.com/o/n.git");
  let argv: string[] = [];
  const ghRun = async (_cwd: string, ...cmd: string[]) => { argv = cmd; return { code: 0, stdout: "https://github.com/o/n/pull/1\n", stderr: "" }; };
  const ops = unpushedOps(root, { authFor: () => ({}), giteaToken: () => undefined, giteaUrls: () => [], ghRun });
  const r = await ops.createPr({ path: web, branch: "main", title: "T", body: "B" });
  expect(r).toEqual({ url: "https://github.com/o/n/pull/1", number: 1 });
  expect(argv.slice(0, 9)).toEqual(["gh", "pr", "create", "--repo", "o/n", "--head", "main", "--base", "main"]);
});
