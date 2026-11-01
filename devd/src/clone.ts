import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cloneBare, fetchAllAsync, trackRemote } from "./git";
import { barePath, workspacePath, type TreeProject } from "./tree";

export interface CloneResult { repo: string; ok: boolean; skipped?: boolean; error?: string }
export interface CloneJob { id: string; scope: string; status: "running" | "done" | "error"; total: number; done: number; results: CloneResult[] }
export type CloneScope = { kind: "all" } | { kind: "folder"; folder: string } | { kind: "project"; folder: string; project: string };

export interface CloneDeps {
  db: Database; root: string; tree: () => Promise<TreeProject[]>;
  // A repo that is not here in any form yet is cloned directly as bare — this mirrors
  // the rule `open()` follows (see the comment at `const worktree` in sessions.ts).
  // An existing repo (old workspace or new bare clone) is only fetched, not migrated.
  cloneBare?: (url: string, dest: string, authEnv?: Record<string, string>) => Promise<void>;
  // Mandatory companion of `cloneBare`: a bare clone has no tracking refspec, so without this
  // `git fetch` over it would be a no-op, `git checkout <branch>` in the worktree would pull
  // the frozen content from clone time and `@{u}..HEAD` would end in an error (→ stats silently
  // report zero). `open()` calls it right after its own clone for the same reason. Injectable
  // only for tests — like `cloneBare`.
  trackRemote?: (dir: string, authEnv?: Record<string, string>) => Promise<void>;
  fetchRepo?: (dir: string, authEnv?: Record<string, string>) => void | Promise<void>;
  // Per-repo git auth env keyed by clone URL (see giteaAuthEnv). Private gitea
  // repos otherwise fail with "could not read Username"; empty for github.
  credentials?: (url: string) => Record<string, string>;
  idFor?: () => string;
  // Pre-flight disk headroom check (spec §8/§18): when provided and usage is already
  // at/over the warn threshold, `start()` refuses to launch the clone/fetch loop at
  // all — a bulk clone is exactly the kind of operation that can push a nearly-full
  // disk over the edge.
  diskCheck?: () => { usedBytes: number; totalBytes: number; warnPercent: number };
  onDone?: (job: CloneJob) => void;
}

function persist(db: Database, j: CloneJob) {
  db.query(`INSERT INTO clone_jobs (id, ts, scope, status, total, done, results) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total, done=excluded.done, results=excluded.results`)
    .run(j.id, Date.now(), j.scope, j.status, j.total, j.done, JSON.stringify(j.results));
}

export class CloneQueue {
  private jobs = new Map<string, CloneJob>();
  private runs = new Map<string, Promise<void>>();
  private seq = 0;
  constructor(private d: CloneDeps) {}

  get(id: string): CloneJob | null {
    if (this.jobs.has(id)) return this.jobs.get(id)!;
    const row = this.d.db.query(`SELECT * FROM clone_jobs WHERE id=?`).get(id) as
      { id: string; scope: string; status: string; total: number; done: number; results: string } | null;
    return row ? { ...row, status: row.status as CloneJob["status"], results: JSON.parse(row.results) } : null;
  }

  wait(id: string): Promise<void> { return this.runs.get(id) ?? Promise.resolve(); }

  private matches(scope: CloneScope, p: TreeProject): boolean {
    if (scope.kind === "all") return true;
    if (scope.kind === "folder") return p.folder === scope.folder;
    return p.folder === scope.folder && p.project === scope.project;
  }

  // Resolves the tree, creates the job record, launches the loop in the background, returns the id promptly.
  async start(scope: CloneScope): Promise<string> {
    const id = this.d.idFor?.() ?? `job-${Date.now()}-${++this.seq}`;

    if (this.d.diskCheck) {
      const { usedBytes, totalBytes, warnPercent } = this.d.diskCheck();
      const pct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
      if (pct >= warnPercent) {
        const job: CloneJob = {
          id, scope: JSON.stringify(scope), status: "error", total: 0, done: 0,
          results: [{ repo: "(disk)", ok: false, error: "not enough disk space" }],
        };
        this.jobs.set(id, job);
        persist(this.d.db, job);
        this.d.onDone?.(job);
        this.runs.set(id, Promise.resolve());
        return id;
      }
    }

    const tree = await this.d.tree();
    const targets = tree.filter((p) => this.matches(scope, p))
      .flatMap((p) => p.repos.filter((r) => r.cloneUrl).map((r) => ({ folder: p.folder, project: p.project, repo: r })));
    const job: CloneJob = { id, scope: JSON.stringify(scope), status: "running", total: targets.length, done: 0, results: [] };
    this.jobs.set(id, job);
    persist(this.d.db, job);
    this.runs.set(id, this.run(job, targets).catch((e) => { console.error("clone run failed:", e); }));
    return id;
  }

  private async run(job: CloneJob, targets: { folder: string; project: string; repo: { name: string; cloneUrl?: string } }[]): Promise<void> {
    const doCloneBare = this.d.cloneBare ?? cloneBare;
    const doTrackRemote = this.d.trackRemote ?? trackRemote;
    const fetchRepo = this.d.fetchRepo ?? fetchAllAsync;
    for (const t of targets) {
      const bare = barePath(this.d.root, t.folder, t.project, t.repo.name);
      const ws = workspacePath(this.d.root, t.folder, t.project, t.repo.name);
      const authEnv = this.d.credentials?.(t.repo.cloneUrl!) ?? {};
      try {
        // A bare clone already exists → just fetch, not a second clone next to it (a stale copy
        // nobody fetches anymore). Otherwise an old workspace → fetch, behaves as today.
        // Otherwise the repo is not here in any form → cloned directly as bare (the new shape).
        if (existsSync(bare)) { await fetchRepo(bare, authEnv); job.results.push({ repo: t.repo.name, ok: true, skipped: true }); }
        else if (existsSync(ws)) { await fetchRepo(ws, authEnv); job.results.push({ repo: t.repo.name, ok: true, skipped: true }); }
        // `trackRemote` BELONGS to the clone, not to the fetch: it adds the refspec and upstream and cleans up
        // frozen local heads, which is safe only over a fresh clone (over an existing
        // repo it would delete branches of sessions with work in progress — see its comment in git.ts).
        else {
          mkdirSync(dirname(bare), { recursive: true });
          await doCloneBare(t.repo.cloneUrl!, bare, authEnv);
          await doTrackRemote(bare, authEnv);
          job.results.push({ repo: t.repo.name, ok: true });
        }
      } catch (e) { job.results.push({ repo: t.repo.name, ok: false, error: (e as Error).message }); }
      job.done++;
      persist(this.d.db, job);
    }
    job.status = job.results.some((r) => !r.ok) ? "error" : "done";
    persist(this.d.db, job);
    this.d.onDone?.(job);
  }
}
