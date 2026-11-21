import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { createApp } from "../src/api";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { collectChanges, parseDiff } from "../src/sessionChanges";
import { listRepoFiles, matchFiles } from "../src/sessionFiles";
import { countUntracked, type CounterDeps } from "../src/untrackedCounter";
import { run as procRun, type RunOpts } from "../src/proc";
import { createShare } from "../src/shares";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, "git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const plainGit = (ws: string) => ({ gitDir: join(ws, ".git"), commonDir: join(ws, ".git") });
const LIMITS = { maxBytes: 1024, budget: 1024 * 1024 };

/** origin (bare) with `main`. */
function origin(): string {
  const root = tmp("changes-");
  git(root, "init", "-q", "--bare", "harbor.git");
  const seed = join(root, "seed");
  git(root, "clone", "-q", join(root, "harbor.git"), seed);
  writeFileSync(join(seed, "keep.txt"), "a\nb\n");
  writeFileSync(join(seed, "old-name.txt"), "x\ny\nz\n");
  writeFileSync(join(seed, "gone.txt"), "1\n2\n");
  writeFileSync(join(seed, ".gitignore"), "*.log\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return root;
}

test("lists committed (pushed or not), staged, unstaged and untracked changes against the merge-base with origin's default branch", async () => {
  const root = origin();
  // A fresh clone has refs/remotes/origin/HEAD.
  const seed = join(root, "work");
  git(root, "clone", "-q", join(root, "harbor.git"), seed);
  git(seed, "checkout", "-qb", "feat");
  // Pushed to the branch's own upstream — still a change against origin/main.
  writeFileSync(join(seed, "pushed.txt"), "p\n");
  git(seed, "add", "pushed.txt");
  git(seed, "commit", "-qm", "pushed");
  git(seed, "push", "-qu", "origin", "feat");
  // Unpushed commit: a text file and a binary one.
  writeFileSync(join(seed, "committed.txt"), "c1\nc2\n");
  writeFileSync(join(seed, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  git(seed, "add", "committed.txt", "logo.bin");
  git(seed, "commit", "-qm", "unpushed");
  // Staged: a new file and a rename.
  writeFileSync(join(seed, "staged.txt"), "s\n");
  git(seed, "add", "staged.txt");
  git(seed, "mv", "old-name.txt", "new-name.txt");
  // Unstaged: a modification and a deletion.
  writeFileSync(join(seed, "keep.txt"), "a\nB\nc\n");
  rmSync(join(seed, "gone.txt"));
  // Untracked (no trailing newline still counts the last line) + an ignored file.
  writeFileSync(join(seed, "notes.md"), "n1\nn2\nn3");
  writeFileSync(join(seed, "debug.log"), "ignored\n");

  expect(await collectChanges(seed, plainGit(seed))).toEqual({
    base: "origin/main",
    files: [
      { path: "committed.txt", status: "added", added: 2, removed: 0 },
      { path: "gone.txt", status: "deleted", added: 0, removed: 2 },
      { path: "keep.txt", status: "modified", added: 2, removed: 1 },
      { path: "logo.bin", status: "added", added: null, removed: null },
      { path: "new-name.txt", status: "renamed", added: 0, removed: 0, oldPath: "old-name.txt" },
      { path: "notes.md", status: "untracked", added: 3, removed: 0 },
      { path: "pushed.txt", status: "added", added: 1, removed: 0 },
      { path: "staged.txt", status: "added", added: 1, removed: 0 },
    ],
    totals: { files: 8, added: 9, removed: 3 },
  });
});

test("a session worktree over a bare clone compares to origin's default branch even with its own upstream", async () => {
  const root = origin();
  // The shape clone.ts/trackRemote produce: bare clone, tracking refspec, no refs/remotes/origin/HEAD.
  const bare = join(root, "bare.git");
  git(root, "clone", "-q", "--bare", join(root, "harbor.git"), bare);
  git(bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(bare, "fetch", "-q", "origin");
  const wt = join(root, "harbor-1");
  git(bare, "worktree", "add", "-q", "-b", "session/harbor-1", wt, "main");
  writeFileSync(join(wt, "keep.txt"), "a\nb\nc\n");
  git(wt, "commit", "-qam", "work");
  git(wt, "push", "-qu", "origin", "session/harbor-1");

  expect(await collectChanges(wt, { gitDir: join(bare, "worktrees", "harbor-1"), commonDir: bare })).toEqual({
    base: "origin/main",
    files: [{ path: "keep.txt", status: "modified", added: 1, removed: 0 }],
    totals: { files: 1, added: 1, removed: 0 },
  });
});

test("without origin's default branch it compares to HEAD (uncommitted only) and says so", async () => {
  const dir = tmp("changes-local-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "a.txt"), "1\n2\n");

  expect(await collectChanges(dir, plainGit(dir))).toEqual({
    base: "HEAD",
    files: [{ path: "a.txt", status: "modified", added: 1, removed: 0 }],
    totals: { files: 1, added: 1, removed: 0 },
  });
});

test("the file list is capped with truncated:true while totals cover every file; large untracked files get null counts", async () => {
  const dir = tmp("changes-cap-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "b.txt"), "1\n2\n");
  writeFileSync(join(dir, "c.txt"), "1\n2\n3\n");
  writeFileSync(join(dir, "big.txt"), "x\n".repeat(100));

  const r = await collectChanges(dir, plainGit(dir), { maxFiles: 2, maxUntrackedBytes: 50 });
  expect(r).toEqual({
    base: "HEAD",
    files: [
      { path: "b.txt", status: "untracked", added: 2, removed: 0 },
      { path: "big.txt", status: "untracked", added: null, removed: null },
    ],
    totals: { files: 3, added: 2, removed: 0 },
    truncated: true,
    // c.txt was not opened: only maxFiles untracked files are read per request.
    countsCapped: true,
  });
});

test("the counter subprocess never follows a symlink: not the file, not a parent swapped after listing, not a FIFO", async () => {
  const ws = tmp("changes-links-");
  const outside = tmp("changes-outside-");
  writeFileSync(join(outside, "secret"), "s1\ns2\n");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "secret"), "ok\n");
  writeFileSync(join(ws, "plain.txt"), "a\nb");
  expect(await countUntracked(ws, ["sub/secret", "plain.txt"], LIMITS)).toEqual({ counts: [1, 2], capped: false });
  // The agent swaps the parent dir for a symlink to a host dir after `ls-files`.
  rmSync(join(ws, "sub"), { recursive: true });
  symlinkSync(outside, join(ws, "sub"));
  symlinkSync(join(outside, "secret"), join(ws, "link"));
  sh(ws, "mkfifo", "pipe");
  expect(await countUntracked(ws, ["sub/secret", "link", "pipe", "missing"], LIMITS)).toEqual({ counts: [null, null, null, null], capped: false });
});

test("the counter stops reading at the byte budget and says so", async () => {
  const ws = tmp("changes-budget-");
  writeFileSync(join(ws, "a"), "1\n2\n");
  writeFileSync(join(ws, "b"), "3\n4\n");
  expect(await countUntracked(ws, ["a", "b"], { maxBytes: 1024, budget: 6 })).toEqual({ counts: [2, null], capped: true });
});

test("the counter child loads no bunfig.toml preload or .env from the worktree and inherits no devd env", async () => {
  const ws = tmp("changes-bunfig-");
  const marker = join(tmp("changes-marker-"), "MARKER");
  writeFileSync(join(ws, "evil.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));\n`);
  writeFileSync(join(ws, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  writeFileSync(join(ws, ".env"), "HARBOR_FROM_DOTENV=1\n");
  writeFileSync(join(ws, "a.txt"), "1\n");
  process.env.HARBOR_CANARY = "secret";
  try {
    expect(await countUntracked(ws, ["a.txt"], LIMITS)).toEqual({ counts: [1], capped: false });
  } finally { delete process.env.HARBOR_CANARY; }
  expect(existsSync(marker)).toBe(false);
});

test("the counter child gets only PATH and HOME=/nonexistent, cwd /, and no config from cwd", async () => {
  const ws = tmp("changes-env-");
  const seen: { cmd: string[]; opts: RunOpts }[] = [];
  await countUntracked(ws, ["a"], LIMITS, { myUid: 501, ownerOf: () => ({ uid: 501, gid: 20 }), run: async (cmd, opts) => {
    seen.push({ cmd, opts });
    return { code: 0, stdout: JSON.stringify({ counts: [null], capped: false }), stderr: "", timedOut: false };
  } });
  const { cmd, opts } = seen[0]!;
  expect(cmd.slice(0, 5)).toEqual([process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", "-e"]);
  expect(opts.cwd).toBe("/");
  expect(opts.inheritEnv).toBe(false);
  expect(Object.keys(opts.env!).sort()).toEqual(["HOME", "PATH"]);
  expect(opts.env!.HOME).toBe("/nonexistent");
  expect(JSON.parse(opts.stdin!).root).toBe(realpathSync(ws));
});

test("run() with inheritEnv:false passes only the given env to the child", async () => {
  process.env.HARBOR_CANARY = "secret";
  try {
    const r = await procRun(["/usr/bin/env"], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, inheritEnv: false, timeoutMs: 5000 });
    expect(r.stdout.trim().split("\n").sort()).toEqual(["HOME=/nonexistent", "PATH=/usr/bin:/bin"]);
  } finally { delete process.env.HARBOR_CANARY; }
});

const asRoot = (owner: { uid: number; gid: number }, run: CounterDeps["run"]): CounterDeps => ({ myUid: 0, ownerOf: () => owner, run });

test("as root the counter runs under the worktree owner's uid/gid via setpriv", async () => {
  const ws = tmp("changes-owner-");
  const calls: string[][] = [];
  const r = await countUntracked(ws, ["a"], LIMITS, asRoot({ uid: 1000, gid: 1001 }, async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: JSON.stringify({ counts: [4], capped: false }), stderr: "", timedOut: false };
  }));
  expect(r).toEqual({ counts: [4], capped: false });
  expect(calls[0]!.slice(0, 5)).toEqual(["setpriv", "--reuid=1000", "--regid=1001", "--clear-groups", process.execPath]);
});

test("as root a root-owned worktree is refused with an explicit 409", async () => {
  const ws = tmp("changes-rootown-");
  git(ws, "init", "-q");
  writeFileSync(join(ws, "a.txt"), "1\n");
  git(ws, "add", ".");
  git(ws, "commit", "-qm", "init");
  writeFileSync(join(ws, "new.txt"), "1\n");
  const run: CounterDeps["run"] = async () => { throw new Error("must not spawn"); };
  await expect(collectChanges(ws, plainGit(ws), {}, asRoot({ uid: 0, gid: 0 }, run))).rejects.toMatchObject({
    status: 409, message: "session worktree is owned by root",
  });
});

test("a counter that cannot run gives null counts and countsUnavailable, not zeros", async () => {
  const ws = tmp("changes-nospawn-");
  git(ws, "init", "-q");
  writeFileSync(join(ws, "a.txt"), "1\n");
  git(ws, "add", ".");
  git(ws, "commit", "-qm", "init");
  writeFileSync(join(ws, "a.txt"), "2\n");
  writeFileSync(join(ws, "new.txt"), "1\n");
  const failing = asRoot({ uid: 1000, gid: 1000 }, async () => ({ code: 127, stdout: "", stderr: "setpriv: not found", timedOut: false }));
  expect(await collectChanges(ws, plainGit(ws), {}, failing)).toEqual({
    base: "HEAD",
    files: [
      { path: "a.txt", status: "modified", added: 1, removed: 1 },
      { path: "new.txt", status: "untracked", added: null, removed: null },
    ],
    totals: { files: 2, added: 1, removed: 1 },
    countsUnavailable: true,
  });
});

test("a worktree whose .git points to another repo is refused before any diff", async () => {
  const other = tmp("changes-other-");
  git(other, "init", "-q");
  writeFileSync(join(other, "private.txt"), "x\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "init");
  const ws = tmp("changes-hijack-");
  writeFileSync(join(ws, ".git"), `gitdir: ${join(other, ".git")}\n`);
  const bare = join(tmp("changes-bare-"), "harbor.git");
  await expect(collectChanges(ws, { gitDir: join(bare, "worktrees", "harbor-1"), commonDir: bare })).rejects.toMatchObject({
    status: 409, message: "session worktree points to a different git repository",
  });
});

const ROW: SessionRow = {
  id: "dev-harbor-api", folder: "acme", project: "harbor", repo: "api", container: "dev-harbor-api",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

/** devd root with the session's repo in the worktree layout: <root>/acme/harbor/api.git (bare) +
 *  a worktree; `plain` = an ordinary clone at <root>/acme/harbor/api instead. */
function layout(plain = false): { root: string; ws: string } {
  const root = tmp("changes-root-");
  const repoDir = join(root, "acme", "harbor");
  mkdirSync(repoDir, { recursive: true });
  const seed = join(root, "seed");
  git(root, "init", "-q", seed);
  writeFileSync(join(seed, "a.txt"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  if (plain) {
    git(root, "clone", "-q", seed, join(repoDir, "api"));
    return { root, ws: join(repoDir, "api") };
  }
  git(root, "clone", "-q", "--bare", seed, join(repoDir, "api.git"));
  const ws = join(root, "harbor-1");
  git(join(repoDir, "api.git"), "worktree", "add", "-q", "-b", "session/harbor-1", ws, "main");
  return { root, ws };
}

function app(root: string, row: Partial<SessionRow>, before: (db: ReturnType<typeof openDb>) => void = () => {}) {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, ...row });
  before(db);
  return createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root, tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: root,
  } as never);
}
const changes = (a: ReturnType<typeof app>, id = ROW.id) => a.request(`/api/sessions/${id}/changes`);

test("GET /api/sessions/:id/changes returns a worktree session's changes", async () => {
  const { root, ws } = layout();
  writeFileSync(join(ws, "a.txt"), "2\n");
  const res = await changes(app(root, { worktree: ws }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    base: "HEAD",
    files: [{ path: "a.txt", status: "modified", added: 1, removed: 1 }],
    totals: { files: 1, added: 1, removed: 1 },
  });
});

test("GET /api/sessions/:id/changes works for a plain (non-worktree) session", async () => {
  const { root, ws } = layout(true);
  writeFileSync(join(ws, "b.txt"), "1\n");
  const res = await changes(app(root, { worktree: null }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    base: "origin/main",
    files: [{ path: "b.txt", status: "untracked", added: 1, removed: 0 }],
    totals: { files: 1, added: 1, removed: 0 },
  });
});

test("GET /api/sessions/:id/changes: 404 for an unknown session", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: ws }), "dev-nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "unknown session", code: "unknown_session" });
});

test("GET /api/sessions/:id/changes: a missing worktree is a 409 with a message, not an empty list", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: join(ws, "harbor-missing") }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree is missing", code: "worktree_missing" });
});

test("GET /api/sessions/:id/changes: a directory that is not a git repo is a 409 without host paths", async () => {
  const { root } = layout();
  const res = await changes(app(root, { worktree: tmp("changes-api-") }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree is not a readable git repository", code: "not_a_repo" });
});

test("GET /api/sessions/:id/changes: a worktree pointing at another session's bare clone is a 409", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: ws, repo: "web" }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree points to a different git repository", code: "foreign_git_dir" });
});

test("GET /api/sessions/:id/changes: a repository without commits is a 409 the dashboard knows by its code", async () => {
  const { root, ws } = layout(true);
  rmSync(ws, { recursive: true, force: true });
  git(root, "init", "-q", ws);
  const res = await changes(app(root, { worktree: null }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "repository has no commits yet", code: "no_commits" });
});

test("GET /api/sessions/:id/changes: a shared session is 403", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: ws }, (db) => { createShare(db, ROW.id, 60); }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "session is shared — access restricted" });
});

test("GET /api/sessions/:id/changes: an InstaBox session is 409", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: ws, host: "instabox" }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "Changed files is VPS-only (InstaBox session)", code: "instabox" });
});

test("diff output pairs status and counts by position, so names that are not UTF-8 cannot collide", () => {
  // Two different byte names that both decode to "�.txt".
  const raw = ":100644 100644 aaa bbb M\0�.txt\0:000000 100644 000 ccc A\0�.txt\0:100644 100644 ddd eee R090\0old.txt\0new.txt\0";
  const num = "1\t0\t�.txt\0" + "2\t0\t�.txt\0" + "3\t1\t\0old.txt\0new.txt\0";
  expect(parseDiff(raw + num)).toEqual([
    { path: "�.txt", status: "modified", added: 1, removed: 0, nameNotUtf8: true },
    { path: "�.txt", status: "added", added: 2, removed: 0, nameNotUtf8: true },
    { path: "new.txt", status: "renamed", added: 3, removed: 1, oldPath: "old.txt" },
  ]);
});

// --- GET /api/sessions/:id/files: the composer's @ file picker -------------------------------------------------------

const files = (a: ReturnType<typeof app>, query = "", id = ROW.id) => a.request(`/api/sessions/${id}/files${query}`);

test("GET /api/sessions/:id/files lists tracked and untracked files, not ignored ones, repo-relative", async () => {
  const { root, ws } = layout();
  mkdirSync(join(ws, "src", "deep"), { recursive: true });
  writeFileSync(join(ws, "src", "deep", "harbor.ts"), "x\n");
  writeFileSync(join(ws, ".gitignore"), "*.log\n");
  writeFileSync(join(ws, "debug.log"), "x\n");
  const res = await files(app(root, { worktree: ws }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ files: [".gitignore", "a.txt", "src/deep/harbor.ts"] });
});

test("GET /api/sessions/:id/files?q=: name matches first, then path matches; at most `limit` (50 at most), `more` when cut", async () => {
  const { root, ws } = layout();
  for (const f of ["harbor/x.ts", "src/harbor.ts", "src/myharbor.ts", "docs/harbor-notes.md"]) {
    mkdirSync(join(ws, f, ".."), { recursive: true });
    writeFileSync(join(ws, f), "x\n");
  }
  const a = app(root, { worktree: ws });
  expect(await (await files(a, "?q=HARBOR")).json()).toEqual({ files: ["src/harbor.ts", "docs/harbor-notes.md", "src/myharbor.ts", "harbor/x.ts"] });
  expect(await (await files(a, "?q=harbor&limit=2")).json()).toEqual({ files: ["src/harbor.ts", "docs/harbor-notes.md"], more: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(ws, `f${i}.txt`), "x\n");
  const big = (await (await files(app(root, { worktree: ws }), "?limit=500")).json()) as { files: string[]; more?: true };
  expect(big.files).toHaveLength(50);
  expect(big.more).toBe(true);
  expect((await files(a, "?limit=abc")).status).toBe(400);
  expect((await files(a, "?limit=0")).status).toBe(400);
});

test("GET /api/sessions/:id/files: a symlink to a directory outside the repo is listed as itself, nothing behind it; ../ finds nothing outside", async () => {
  const { root, ws } = layout();
  const outside = tmp("files-outside-");
  writeFileSync(join(outside, "secret.txt"), "s\n");
  symlinkSync(outside, join(ws, "elsewhere"));
  const a = app(root, { worktree: ws });
  expect(await (await files(a)).json()).toEqual({ files: ["a.txt", "elsewhere"] });
  expect(await (await files(a, "?q=secret")).json()).toEqual({ files: [] });
  expect(await (await files(a, `?q=${encodeURIComponent("../")}`)).json()).toEqual({ files: [] });
});

test("GET /api/sessions/:id/files has the changes routes' guards: another repo's git dir, unknown, shared and InstaBox sessions", async () => {
  const { root, ws } = layout();
  const foreign = await files(app(root, { worktree: ws, repo: "web" }));
  expect(foreign.status).toBe(409);
  expect(await foreign.json()).toEqual({ error: "session worktree points to a different git repository", code: "foreign_git_dir" });
  expect((await files(app(root, { worktree: ws }), "", "dev-nope")).status).toBe(404);
  expect((await files(app(root, { worktree: ws }, (db) => { createShare(db, ROW.id, 60); }))).status).toBe(403);
  const ibx = await files(app(root, { worktree: ws, host: "instabox" }));
  expect(ibx.status).toBe(409);
  expect(await ibx.json()).toEqual({ error: "File search is VPS-only (InstaBox session)", code: "instabox" });
});

test("GET /api/sessions/:id/files works in a repository without commits", async () => {
  const { root, ws } = layout(true);
  rmSync(ws, { recursive: true, force: true });
  git(root, "init", "-q", ws);
  writeFileSync(join(ws, "new.txt"), "x\n");
  const res = await files(app(root, { worktree: null }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ files: ["new.txt"] });
});

test("GET /api/sessions/:id/files: the listing is reused for 10 s, then read again", async () => {
  const { root, ws } = layout();
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const a = app(root, { worktree: ws });
    expect(await (await files(a)).json()).toEqual({ files: ["a.txt"] });
    writeFileSync(join(ws, "b.txt"), "x\n");
    now += 9_000;
    expect(await (await files(a)).json()).toEqual({ files: ["a.txt"] });
    now += 2_000;
    expect(await (await files(a)).json()).toEqual({ files: ["a.txt", "b.txt"] });
  } finally { Date.now = realNow; }
});

test("listRepoFiles: a listing over the byte cap is cut at the last whole name and says so", async () => {
  const { ws } = layout(true);
  for (const f of ["b-one.txt", "c-two.txt", "d-three.txt"]) writeFileSync(join(ws, f), "x\n");
  // git prints the untracked names first: "b-one.txt\0c-two.txt\0d-three.txt\0a.txt\0".
  expect(await listRepoFiles(ws, plainGit(ws))).toEqual({ paths: ["b-one.txt", "c-two.txt", "d-three.txt", "a.txt"], capped: false });
  // 22 characters: "b-one.txt\0c-two.txt\0d-", two whole names and a cut one.
  expect(await listRepoFiles(ws, plainGit(ws), { maxBytes: 22 })).toEqual({ paths: ["b-one.txt", "c-two.txt"], capped: true });
});

test("matchFiles: an empty query lists in path order; names git could not decode are left out", () => {
  expect(matchFiles(["b", "a/\uFFFD.txt", "a"], "", 50)).toEqual({ files: ["a", "b"] });
});
