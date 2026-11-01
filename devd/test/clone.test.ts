import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { CloneQueue } from "../src/clone";
import { barePath } from "../src/tree";
import type { TreeProject } from "../src/tree";

const tree = async (): Promise<TreeProject[]> => [
  { folder: "acme", project: "shop", repos: [
    { name: "cms", cloneUrl: "https://x/cms.git", provider: "github", cloned: false },
    { name: "web", cloneUrl: "https://x/web.git", provider: "github", cloned: false },
  ]},
];

test("clone-all clones missing repos as bare and skips existing, records progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(root, "acme", "shop", "web"), { recursive: true }); // web already present (old layout)
  const clonedBare: string[] = []; const fetched: string[] = [];
  let n = 0;
  const q = new CloneQueue({
    db: openDb(":memory:"), root, tree,
    cloneBare: async (url, dest) => { clonedBare.push(url); mkdirSync(dest, { recursive: true }); },
    fetchRepo: (dir) => { fetched.push(dir); },
    idFor: () => `job-${++n}`,
  });
  const id = await q.start({ kind: "all" });
  await q.wait(id); // let the background loop finish
  const job = q.get(id)!;
  expect(job.status).toBe("done");
  expect(job.total).toBe(2);
  expect(job.done).toBe(2);
  expect(clonedBare).toEqual(["https://x/cms.git"]); // cms is brand new → straight to bare
  expect(job.results.find((r) => r.repo === "web")?.skipped).toBe(true);
  expect(existsSync(barePath(root, "acme", "shop", "cms"))).toBe(true);
});

test("a repo that already has a bare clone is neither fetched via the old workspace nor cloned again", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(barePath(root, "acme", "shop", "cms"), { recursive: true }); // cms is already cloned as bare
  const clonedBare: string[] = []; const fetched: string[] = [];
  const q = new CloneQueue({
    db: openDb(":memory:"), root, tree,
    cloneBare: async (url, dest) => { clonedBare.push(url); mkdirSync(dest, { recursive: true }); },
    fetchRepo: (dir) => { fetched.push(dir); },
    idFor: () => "job-bare",
  });
  const id = await q.start({ kind: "all" });
  await q.wait(id);
  const job = q.get(id)!;
  expect(job.status).toBe("done");
  expect(clonedBare).toEqual(["https://x/web.git"]); // cms MUST NOT be cloned again
  expect(fetched).toEqual([barePath(root, "acme", "shop", "cms")]); // only a fetch on the bare clone
  expect(job.results.find((r) => r.repo === "cms")?.skipped).toBe(true);
});

test("credentials(url) result is threaded to cloneBare (new) and fetch (existing) per repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(root, "acme", "shop", "web"), { recursive: true }); // web exists -> fetch path
  const cloneAuth: Array<Record<string, string> | undefined> = [];
  const fetchAuth: Array<Record<string, string> | undefined> = [];
  const q = new CloneQueue({
    db: openDb(":memory:"), root, tree,
    credentials: (url) => ({ url }), // echo the url so we can assert it was resolved per-repo
    cloneBare: async (_url, dest, authEnv) => { cloneAuth.push(authEnv); mkdirSync(dest, { recursive: true }); },
    fetchRepo: (_dir, authEnv) => { fetchAuth.push(authEnv); },
    idFor: () => "job-cred",
  });
  const id = await q.start({ kind: "all" });
  await q.wait(id);
  expect(cloneAuth).toEqual([{ url: "https://x/cms.git" }]); // cms was missing -> cloned
  expect(fetchAuth).toEqual([{ url: "https://x/web.git" }]); // web existed -> fetched
});

test("get unknown job returns null", () => {
  const q = new CloneQueue({ db: openDb(":memory:"), root: "/tmp", tree });
  expect(q.get("nope")).toBeNull();
});

test("start returns before the background loop finishes (delayed clone)", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new CloneQueue({ db: openDb(":memory:"), root, tree,
    cloneBare: async (_u, dest) => { mkdirSync(dest, { recursive: true }); await gate; },
    fetchRepo: () => {}, idFor: () => "job-d" });
  const id = await q.start({ kind: "all" });
  expect(q.get(id)!.status).toBe("running"); // NOT blocked by the clone
  release();
  await q.wait(id);
  expect(q.get(id)!.status).toBe("done");
});

test("diskCheck at/over warnPercent refuses to start the clone loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  const clonedBare: string[] = []; const fetched: string[] = [];
  const q = new CloneQueue({
    db: openDb(":memory:"), root, tree,
    cloneBare: async (url, dest) => { clonedBare.push(url); mkdirSync(dest, { recursive: true }); },
    fetchRepo: (dir) => { fetched.push(dir); },
    idFor: () => "job-disk",
    diskCheck: () => ({ usedBytes: 95, totalBytes: 100, warnPercent: 80 }),
  });
  const id = await q.start({ kind: "all" });
  await q.wait(id);
  const job = q.get(id)!;
  expect(job.status).toBe("error");
  expect(job.results).toEqual([{ repo: "(disk)", ok: false, error: "not enough disk space" }]);
  expect(clonedBare).toEqual([]);
  expect(fetched).toEqual([]);
});

test("diskCheck under warnPercent lets the clone loop run normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  const clonedBare: string[] = [];
  const q = new CloneQueue({
    db: openDb(":memory:"), root, tree,
    cloneBare: async (url, dest) => { clonedBare.push(url); mkdirSync(dest, { recursive: true }); },
    fetchRepo: () => {},
    idFor: () => "job-disk-ok",
    diskCheck: () => ({ usedBytes: 10, totalBytes: 100, warnPercent: 80 }),
  });
  const id = await q.start({ kind: "all" });
  await q.wait(id);
  expect(q.get(id)!.status).toBe("done");
  expect(clonedBare.sort()).toEqual(["https://x/cms.git", "https://x/web.git"]);
});

test("folder scope filters and any failure marks error", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  const q = new CloneQueue({ db: openDb(":memory:"), root, tree,
    cloneBare: async (u, dest) => { if (u.includes("web")) throw new Error("boom"); mkdirSync(dest, { recursive: true }); },
    fetchRepo: () => {}, idFor: () => "job-f" });
  const id = await q.start({ kind: "folder", folder: "acme" });
  await q.wait(id);
  const job = q.get(id)!;
  expect(job.status).toBe("error");
  expect(job.results.find((r) => r.repo === "web")?.ok).toBe(false);
});

test("onDone fires once with the finished job", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  const done: string[] = [];
  const q = new CloneQueue({ db: openDb(":memory:"), root, tree,
    cloneBare: async (_u, dest) => { mkdirSync(dest, { recursive: true }); },
    fetchRepo: () => {}, idFor: () => "job-od", onDone: (j) => done.push(j.status) });
  const id = await q.start({ kind: "all" });
  await q.wait(id);
  expect(done).toEqual(["done"]);
});

test("disk-preflight rejection still fires onDone", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  const done: string[] = [];
  const q = new CloneQueue({ db: openDb(":memory:"), root, tree,
    cloneBare: async () => {}, fetchRepo: () => {}, idFor: () => "job-dr",
    diskCheck: () => ({ usedBytes: 95, totalBytes: 100, warnPercent: 80 }),
    onDone: (j) => done.push(j.status) });
  const id = await q.start({ kind: "all" });
  await q.wait(id);
  expect(done).toEqual(["error"]);
  expect(q.get(id)!.results[0].error).toContain("disk space");
});

// C2 from review: `open()` always calls `trackRemote` after `cloneBare` (refspec, upstream,
// cleanup of stale local heads). The queue clones bare too, but did not call `trackRemote` —
// and since `open()` skips that block when the bare clone already exists, a repo cloned
// by the queue would NEVER get it. Without the refspec `git fetch --all` on a bare clone is a no-op
// (so is "updating existing ones" in the queue), `git checkout feature/x` in the worktree
// pulls the frozen content from clone time and `@{u}..HEAD` fails with an error that stats
// silently turn into zero — the dashboard then reports 0 unpushed commits.
test("a bare clone from the queue gets trackRemote; a fetch of an existing repo does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-track-"));
  mkdirSync(join(root, "acme", "shop", "web"), { recursive: true }); // web is already here (old layout)
  const tracked: string[] = []; const trackAuth: (Record<string, string> | undefined)[] = [];
  const q = new CloneQueue({
    db: openDb(":memory:"), root, tree,
    cloneBare: async (_url, dest) => { mkdirSync(dest, { recursive: true }); },
    trackRemote: async (dir, authEnv) => { tracked.push(dir); trackAuth.push(authEnv); },
    fetchRepo: () => {},
    credentials: () => ({ GIT_ASKPASS: "x" }),
    idFor: () => "job-track",
  });
  await q.wait(await q.start({ kind: "all" }));
  // Only the freshly cloned `cms` — `web` was only fetched and `trackRemote` would delete its
  // local branches (see its comment: safe ONLY right after the clone).
  expect(tracked).toEqual([barePath(root, "acme", "shop", "cms")]);
  expect(trackAuth[0]).toEqual({ GIT_ASKPASS: "x" });   // same auth as the clone, otherwise fetch fails
});
