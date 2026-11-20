import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { createApp } from "../src/api";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { collectChanges } from "../src/sessionChanges";

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

/** origin (bare) with `main`, plus a `feat` branch pushed with an upstream. */
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

test("lists committed-unpushed, staged, unstaged and untracked changes against the upstream merge-base", async () => {
  const root = origin();
  const seed = join(root, "seed");
  git(seed, "checkout", "-qb", "feat");
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

  expect(await collectChanges(seed)).toEqual({
    base: "origin/feat",
    files: [
      { path: "committed.txt", status: "added", added: 2, removed: 0 },
      { path: "gone.txt", status: "deleted", added: 0, removed: 2 },
      { path: "keep.txt", status: "modified", added: 2, removed: 1 },
      { path: "logo.bin", status: "added", added: null, removed: null },
      { path: "new-name.txt", status: "renamed", added: 0, removed: 0, oldPath: "old-name.txt" },
      { path: "notes.md", status: "untracked", added: 3, removed: 0 },
      { path: "staged.txt", status: "added", added: 1, removed: 0 },
    ],
    totals: { files: 7, added: 8, removed: 3 },
  });
});

test("a session worktree over a bare clone without an upstream compares to origin's default branch", async () => {
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

  expect(await collectChanges(wt)).toEqual({
    base: "origin/main",
    files: [{ path: "keep.txt", status: "modified", added: 1, removed: 0 }],
    totals: { files: 1, added: 1, removed: 0 },
  });
});

test("without upstream or origin it compares to HEAD (uncommitted only) and says so", async () => {
  const dir = tmp("changes-local-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "a.txt"), "1\n2\n");

  expect(await collectChanges(dir)).toEqual({
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

  const r = await collectChanges(dir, { maxFiles: 2, maxUntrackedBytes: 50 });
  expect(r).toEqual({
    base: "HEAD",
    files: [
      { path: "b.txt", status: "untracked", added: 2, removed: 0 },
      { path: "big.txt", status: "untracked", added: null, removed: null },
    ],
    totals: { files: 3, added: 5, removed: 0 },
    truncated: true,
  });
});

const ROW: SessionRow = {
  id: "dev-harbor-api", folder: "acme", project: "harbor", repo: "api", container: "dev-harbor-api",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

function app(worktree: string) {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, worktree });
  return createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
  } as never);
}

test("GET /api/sessions/:id/changes returns the worktree's changes", async () => {
  const dir = tmp("changes-api-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "a.txt"), "2\n");
  const res = await app(dir).request(`/api/sessions/${ROW.id}/changes`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    base: "HEAD",
    files: [{ path: "a.txt", status: "modified", added: 1, removed: 1 }],
    totals: { files: 1, added: 1, removed: 1 },
  });
});

test("GET /api/sessions/:id/changes: 404 for an unknown session", async () => {
  const res = await app(tmp("changes-api-")).request("/api/sessions/dev-nope/changes");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "unknown session" });
});

test("GET /api/sessions/:id/changes: a missing worktree is a 409 with a message, not an empty list", async () => {
  const gone = join(tmp("changes-api-"), "harbor-missing");
  const res = await app(gone).request(`/api/sessions/${ROW.id}/changes`);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "session worktree is missing" });
});

test("GET /api/sessions/:id/changes: a directory that is not a git repo is a 409 with git's message", async () => {
  const res = await app(tmp("changes-api-")).request(`/api/sessions/${ROW.id}/changes`);
  expect(res.status).toBe(409);
  expect((await res.json() as { error: string }).error).toMatch(/not a git repository/);
});
