import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { createApp } from "../src/api";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { collectFileDiff, newFileDiff } from "../src/sessionChanges";
import { readUntracked } from "../src/untrackedCounter";
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
const CAP = 256 * 1024;

/** A clone of origin/main with every kind of change. */
function repo(): string {
  const root = tmp("diff-");
  const seed = join(root, "seed");
  git(root, "init", "-q", seed);
  writeFileSync(join(seed, "keep.txt"), "a\nb\n");
  writeFileSync(join(seed, "old-name.txt"), "x\ny\nz\n");
  writeFileSync(join(seed, "gone.txt"), "1\n");
  writeFileSync(join(seed, "logo.bin"), Buffer.from([1, 0, 2]));
  writeFileSync(join(seed, ".gitignore"), "*.log\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  const ws = join(root, "work");
  git(root, "clone", "-q", seed, ws);
  writeFileSync(join(ws, "keep.txt"), "a\nB\n");
  git(ws, "mv", "old-name.txt", "new-name.txt");
  rmSync(join(ws, "gone.txt"));
  writeFileSync(join(ws, "logo.bin"), Buffer.from([1, 0, 3]));
  writeFileSync(join(ws, "big.txt"), "line of text\n".repeat(30_000));
  git(ws, "add", "big.txt");
  git(ws, "commit", "-qm", "work");
  writeFileSync(join(ws, "notes.md"), "n1\nn2\nn3");
  writeFileSync(join(ws, "blob.dat"), Buffer.from([0x50, 0x00, 0x51]));
  writeFileSync(join(ws, "huge.txt"), "untracked line\n".repeat(30_000));
  writeFileSync(join(ws, "debug.log"), "ignored\n");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "inner.txt"), "i\n");
  return ws;
}

test("a modified tracked file: unified diff with 3 lines of context against the merge-base", async () => {
  const ws = repo();
  const r = await collectFileDiff(ws, plainGit(ws), "keep.txt");
  expect(r).toMatchObject({ path: "keep.txt", status: "modified", base: "origin/main", binary: false, truncated: false });
  expect(r.diff).toStartWith("diff --git a/keep.txt b/keep.txt\n");
  expect(r.diff).toContain("--- a/keep.txt\n+++ b/keep.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
});

test("a renamed file shows the rename, a deleted file its removal", async () => {
  const ws = repo();
  const ren = await collectFileDiff(ws, plainGit(ws), "new-name.txt");
  expect(ren.status).toBe("renamed");
  expect(ren.diff).toContain("rename from old-name.txt\nrename to new-name.txt\n");
  const del = await collectFileDiff(ws, plainGit(ws), "gone.txt");
  expect(del.status).toBe("deleted");
  expect(del.diff).toContain("deleted file mode 100644\n");
  expect(del.diff).toContain("@@ -1 +0,0 @@\n-1\n");
});

test("an untracked file becomes a new-file diff read by the owner child", async () => {
  const ws = repo();
  expect(await collectFileDiff(ws, plainGit(ws), "notes.md")).toEqual({
    path: "notes.md", status: "untracked", base: "origin/main", binary: false, truncated: false,
    diff: "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,3 @@\n+n1\n+n2\n+n3\n\\ No newline at end of file\n",
  });
  expect((await collectFileDiff(ws, plainGit(ws), "sub/inner.txt")).diff).toContain("@@ -0,0 +1 @@\n+i\n");
});

test("binary files, tracked or untracked, give binary:true and an empty diff", async () => {
  const ws = repo();
  expect(await collectFileDiff(ws, plainGit(ws), "logo.bin")).toMatchObject({ status: "modified", binary: true, truncated: false, diff: "" });
  expect(await collectFileDiff(ws, plainGit(ws), "blob.dat")).toMatchObject({ status: "untracked", binary: true, truncated: false, diff: "" });
});

test("big files are cut at 256 KB on a line boundary with truncated:true", async () => {
  const ws = repo();
  for (const path of ["big.txt", "huge.txt"]) {
    const r = await collectFileDiff(ws, plainGit(ws), path);
    expect(r.truncated).toBe(true);
    expect(r.binary).toBe(false);
    expect(r.diff.length).toBeLessThanOrEqual(CAP);
    expect(r.diff.length).toBeGreaterThan(CAP - 100);
    expect(r.diff).toEndWith("\n");
  }
  // The hunk header counts only the lines actually included.
  const huge = (await collectFileDiff(ws, plainGit(ws), "huge.txt")).diff;
  const n = Number(/^@@ -0,0 \+1,(\d+) @@$/m.exec(huge)![1]);
  expect(huge.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length).toBe(n);
});

test("hostile paths are rejected: absolute, traversal, NUL, empty", async () => {
  const ws = repo();
  for (const path of ["/etc/passwd", "../seed/keep.txt", "sub/../keep.txt", "./keep.txt", "keep.txt\0x", ""]) {
    await expect(collectFileDiff(ws, plainGit(ws), path)).rejects.toMatchObject({ status: 400 });
  }
});

test("a path not in the current listing is a 404: unchanged, ignored, missing, inside a symlinked dir", async () => {
  const ws = repo();
  const outside = tmp("diff-outside-");
  writeFileSync(join(outside, "secret"), "s\n");
  symlinkSync(outside, join(ws, "linked"));
  for (const path of [".gitignore", "debug.log", "nope.txt", "linked/secret", "sub"]) {
    await expect(collectFileDiff(ws, plainGit(ws), path)).rejects.toMatchObject({ status: 404, message: "file is not among the session's changes" });
  }
});

test("an untracked symlink is listed but not read: 409", async () => {
  const ws = repo();
  symlinkSync("/etc/hosts", join(ws, "hosts-link"));
  await expect(collectFileDiff(ws, plainGit(ws), "hosts-link")).rejects.toMatchObject({ status: 409, message: "file is not a readable regular file in the worktree" });
});

test("the reader child refuses a parent dir swapped for a symlink after listing, a symlinked file and a FIFO", async () => {
  const ws = tmp("diff-reader-");
  const outside = tmp("diff-outside-");
  writeFileSync(join(outside, "secret"), "s1\n");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "secret"), "ok\n");
  expect(await readUntracked(ws, "sub/secret", CAP)).toEqual({ ok: true, binary: false, truncated: false, exec: false, content: "ok\n" });
  rmSync(join(ws, "sub"), { recursive: true });
  symlinkSync(outside, join(ws, "sub"));
  expect(await readUntracked(ws, "sub/secret", CAP)).toEqual({ ok: false });
  symlinkSync(join(outside, "secret"), join(ws, "link"));
  expect(await readUntracked(ws, "link", CAP)).toEqual({ ok: false });
  sh(ws, "mkfifo", "pipe");
  expect(await readUntracked(ws, "pipe", CAP)).toEqual({ ok: false });
});

test("newFileDiff: empty file has no hunk, executable mode, single line", () => {
  expect(newFileDiff("e", "", { exec: false, truncated: false }, CAP)).toEqual({ diff: "diff --git a/e b/e\nnew file mode 100644\n", truncated: false });
  expect(newFileDiff("run.sh", "x\n", { exec: true, truncated: false }, CAP).diff)
    .toBe("diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+x\n");
});

/* ------------------------------ route ------------------------------ */

const ROW: SessionRow = {
  id: "dev-harbor-api", folder: "acme", project: "harbor", repo: "api", container: "dev-harbor-api",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

/** <root>/acme/harbor/api.git (bare) + a worktree with one modified file. */
function layout(): { root: string; ws: string } {
  const root = tmp("diff-root-");
  const repoDir = join(root, "acme", "harbor");
  mkdirSync(repoDir, { recursive: true });
  const seed = join(root, "seed");
  git(root, "init", "-q", seed);
  writeFileSync(join(seed, "a.txt"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(root, "clone", "-q", "--bare", seed, join(repoDir, "api.git"));
  const ws = join(root, "harbor-1");
  git(join(repoDir, "api.git"), "worktree", "add", "-q", "-b", "session/harbor-1", ws, "main");
  writeFileSync(join(ws, "a.txt"), "2\n");
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
const diff = (a: ReturnType<typeof app>, path: string | null, id = ROW.id) =>
  a.request(`/api/sessions/${id}/changes/diff${path === null ? "" : `?path=${encodeURIComponent(path)}`}`);

test("GET /api/sessions/:id/changes/diff returns one file's diff", async () => {
  const { root, ws } = layout();
  const res = await diff(app(root, { worktree: ws }), "a.txt");
  expect(res.status).toBe(200);
  const body = await res.json() as { path: string; status: string; base: string; binary: boolean; truncated: boolean; diff: string };
  expect(body).toMatchObject({ path: "a.txt", status: "modified", base: "HEAD", binary: false, truncated: false });
  expect(body.diff).toContain("@@ -1 +1 @@\n-1\n+2\n");
});

test("GET /api/sessions/:id/changes/diff: missing path 400, traversal 400, unlisted 404, unknown session 404", async () => {
  const { root, ws } = layout();
  const a = app(root, { worktree: ws });
  expect((await diff(a, null)).status).toBe(400);
  expect((await diff(a, "../../seed/a.txt")).status).toBe(400);
  const unlisted = await diff(a, "nope.txt");
  expect(unlisted.status).toBe(404);
  expect(await unlisted.json()).toEqual({ error: "file is not among the session's changes" });
  expect((await diff(a, "a.txt", "dev-nope")).status).toBe(404);
});

test("GET /api/sessions/:id/changes/diff: restricted 403, InstaBox 409, foreign git dir 409", async () => {
  const { root, ws } = layout();
  expect((await diff(app(root, { worktree: ws }, (db) => { createShare(db, ROW.id, 60); }), "a.txt")).status).toBe(403);
  expect((await diff(app(root, { worktree: ws, host: "instabox" }), "a.txt")).status).toBe(409);
  const foreign = await diff(app(root, { worktree: ws, repo: "web" }), "a.txt");
  expect(foreign.status).toBe(409);
  expect(await foreign.json()).toEqual({ error: "session worktree points to a different git repository" });
});
