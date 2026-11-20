import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { createApp } from "../src/api";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { collectChanges, parseDiff, untrackedLines } from "../src/sessionChanges";
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

  expect(await collectChanges(seed, join(seed, ".git"))).toEqual({
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

  expect(await collectChanges(wt, bare)).toEqual({
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

  expect(await collectChanges(dir, join(dir, ".git"))).toEqual({
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

  const r = await collectChanges(dir, join(dir, ".git"), { maxFiles: 2, maxUntrackedBytes: 50 });
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

test("untracked line counting never follows a symlink: not the file, not a parent swapped after listing, not a FIFO", async () => {
  const ws = tmp("changes-links-");
  const outside = tmp("changes-outside-");
  writeFileSync(join(outside, "secret"), "s1\ns2\n");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "secret"), "ok\n");
  expect(await untrackedLines(ws, "sub/secret", 1024)).toEqual({ lines: 1, bytes: 3 });
  // The agent swaps the parent dir for a symlink to a host dir after `ls-files`.
  rmSync(join(ws, "sub"), { recursive: true });
  symlinkSync(outside, join(ws, "sub"));
  expect(await untrackedLines(ws, "sub/secret", 1024)).toBeNull();
  symlinkSync(join(outside, "secret"), join(ws, "link"));
  expect(await untrackedLines(ws, "link", 1024)).toBeNull();
  sh(ws, "mkfifo", "pipe");
  expect(await untrackedLines(ws, "pipe", 1024)).toBeNull();
});

test("a worktree whose .git points to another repo is refused before any diff", async () => {
  const other = tmp("changes-other-");
  git(other, "init", "-q");
  writeFileSync(join(other, "private.txt"), "x\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "init");
  const ws = tmp("changes-hijack-");
  writeFileSync(join(ws, ".git"), `gitdir: ${join(other, ".git")}\n`);
  await expect(collectChanges(ws, join(tmp("changes-bare-"), "harbor.git"))).rejects.toMatchObject({
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
  expect(await res.json()).toEqual({ error: "unknown session" });
});

test("GET /api/sessions/:id/changes: a missing worktree is a 409 with a message, not an empty list", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: join(ws, "harbor-missing") }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree is missing" });
});

test("GET /api/sessions/:id/changes: a directory that is not a git repo is a 409 without host paths", async () => {
  const { root } = layout();
  const res = await changes(app(root, { worktree: tmp("changes-api-") }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree is not a readable git repository" });
});

test("GET /api/sessions/:id/changes: a worktree pointing at another session's bare clone is a 409", async () => {
  const { root, ws } = layout();
  const res = await changes(app(root, { worktree: ws, repo: "web" }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree points to a different git repository" });
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
  expect(await res.json()).toEqual({ error: "Changed files is VPS-only (InstaBox session)" });
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
