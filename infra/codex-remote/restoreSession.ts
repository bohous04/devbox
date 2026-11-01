/** Exact, offline devbox restoration for a trusted native Remote route.
 * SessionManager supplies its normal lifecycle operations while holding repo + ID locks.
 * This module never selects a replacement ID, fetches, pulls, rebases, or runs a model.
 */
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentName, SessionRow } from "../../devd/src/db";
import { CanonicalWorkspaceError, inspectCanonicalWorkspace, type CanonicalWorkspaceContainer } from "../../devd/src/canonicalWorkspace";

const runFile = promisify(execFile);
export const DEFAULT_REMOTE_REGISTRY = "/etc/codex-devbox/routes.json";
export class RemoteRestoreError extends Error {
  constructor(message: string, public status: 404 | 409 | 502 = 409) { super(message); }
}
export interface RestoreDescriptor {
  folder: string; project: string; repo: string; solo: 0 | 1;
  worktree: string | null; bare: string | null; branch: string | null;
}
export interface RemoteRoute {
  container: string; cwd: string; environment_id: string; thread_ids: string[];
  restore: RestoreDescriptor;
  restore_error?: string;
}
export type RestoreRow = SessionRow & { worktree?: string | null };
const segment = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
const directory = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && value !== "/" && normalize(value) === value && !/[\0\r\n]/.test(value);

/** Resolve even an absent leaf through its existing ancestors; reject symlink escapes. */
export function canonicalPath(path: string): string {
  if (path === "/") return "/";
  if (!directory(path)) throw new RemoteRestoreError("Remote workspace path is invalid");
  if (existsSync(path)) return realpathSync(path);
  if (lstatExists(path)) throw new RemoteRestoreError("Remote workspace contains a dangling symlink");
  return join(canonicalPath(dirname(path)), path.slice(dirname(path).length + 1));
}
function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function workspace(root: string, d: RestoreDescriptor): string {
  return d.project === d.folder ? join(root, d.folder, d.repo) : join(root, d.folder, d.project, d.repo);
}

export function validateRemoteRoute(raw: unknown, id: string, root: string): RemoteRoute {
  const r = raw as RemoteRoute | undefined;
  const d = r?.restore;
  if (r?.restore_error) throw new RemoteRestoreError("Remote workspace metadata could not be verified; refusing stale restore coordinates");
  if (!/^dev-[A-Za-z0-9_.-]+$/.test(id) || !r || r.container !== id || r.environment_id !== `devbox_${id}` || !directory(r.cwd)
      || !d || !segment(d.folder) || !segment(d.project) || !segment(d.repo) || ![0, 1].includes(d.solo)) {
    throw new RemoteRestoreError(`Session ${id} has no valid exact Remote restore descriptor`);
  }
  if (!Array.isArray(r.thread_ids) || r.thread_ids.some(t => typeof t !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t))) {
    throw new RemoteRestoreError("Remote route has invalid thread ownership");
  }
  const base = `dev-${d.project}-${d.repo}`;
  if (id !== base && !(id.startsWith(`${base}-`) && /^(?:[2-9]|[1-9][0-9]+)$/.test(id.slice(base.length + 1)))) {
    throw new RemoteRestoreError("Remote session ID does not match its project and repository");
  }
  if (d.worktree !== null) {
    if (d.solo !== 0 || !directory(d.worktree) || !directory(d.bare)
        || typeof d.branch !== "string" || !d.branch || /[\0\r\n]/.test(d.branch)
        || canonicalPath(d.worktree) !== canonicalPath(join(root, "_sessions", id))
        || canonicalPath(d.bare) !== canonicalPath(`${workspace(root, d)}.git`)
        || d.worktree !== r.cwd) throw new RemoteRestoreError("Remote worktree descriptor does not match the exact session");
  } else if (d.bare !== null || d.branch !== null || r.cwd !== canonicalPath(workspace(root, d))) {
    throw new RemoteRestoreError("Remote legacy workspace descriptor does not match the exact session");
  }
  if (canonicalPath(r.cwd) !== r.cwd) throw new RemoteRestoreError("Remote workspace must remain at its recorded canonical path");
  return r;
}

function readRegistry(path: string, requiredUid: number): { routes: unknown[] } {
  if (!directory(path)) throw new RemoteRestoreError("Remote registry path must be absolute");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== requiredUid || (info.mode & 0o022) || info.size > 16 * 1024 * 1024) {
      throw new RemoteRestoreError("Remote registry must be a root-owned regular file without group or other write access");
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    if (!parsed || !Array.isArray(parsed.routes)) throw new Error("invalid schema");
    return parsed;
  } catch (error) {
    if (error instanceof RemoteRestoreError) throw error;
    throw new RemoteRestoreError("Cannot read the trusted Remote registry");
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function remoteRegistryPath(): string { return process.env.DEVD_CODEX_ROUTES_FILE || DEFAULT_REMOTE_REGISTRY; }
export function loadRemoteRoute(id: string, root: string, path = remoteRegistryPath(), requiredUid = 0): RemoteRoute {
  const matches = readRegistry(path, requiredUid).routes.filter(r => (r as RemoteRoute)?.container === id);
  if (!matches.length) throw new RemoteRestoreError(`No retained Remote route for session ${id}`, 404);
  if (matches.length !== 1) throw new RemoteRestoreError("Remote registry contains duplicate session routes");
  return validateRemoteRoute(matches[0], id, root);
}

/** Called before end() removes anything. Registered history retains its exact files. */
export function retainRemoteWorkspace(row: RestoreRow, root: string, path = remoteRegistryPath(), requiredUid = 0): boolean {
  // An installation without Remote retains the established end behavior.
  if (!lstatExists(path)) return false;
  const matches = readRegistry(path, requiredUid).routes.filter(r => (r as RemoteRoute)?.container === row.id);
  if (!matches.length) return false;
  if (matches.length !== 1) throw new RemoteRestoreError("Remote registry contains duplicate session routes");
  const raw = matches[0] as RemoteRoute;
  if (Array.isArray(raw.thread_ids) && raw.thread_ids.length === 0) return false;
  const route = validateRemoteRoute(raw, row.id, root);
  assertRow(route, row);
  return route.thread_ids.length > 0;
}

export type ObservedContainer = CanonicalWorkspaceContainer;
export async function inspectRemoteContainer(id: string): Promise<ObservedContainer> {
  if (!/^dev-[A-Za-z0-9_.-]+$/.test(id)) throw new RemoteRestoreError("Invalid container ID");
  try {
    const observed = await inspectCanonicalWorkspace(id);
    return observed.workspace ? { ...observed, workspace: canonicalPath(observed.workspace) } : observed;
  } catch (error) {
    if (error instanceof RemoteRestoreError) throw error;
    if (error instanceof CanonicalWorkspaceError) throw new RemoteRestoreError(error.message, error.kind === "unsafe" ? 409 : 502);
    throw new RemoteRestoreError("Cannot inspect the exact Remote container", 502);
  }
}

async function git(dir: string, args: string[]) {
  return runFile("git", ["-C", dir, "-c", `safe.directory=${dir}`, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}
/** No repair/reset/clean fallback: existing files and index remain authoritative. */
export async function prepareRemoteWorkspace(route: RemoteRoute): Promise<boolean> {
  const d = route.restore;
  if (existsSync(route.cwd)) {
    if (!lstatSync(route.cwd).isDirectory()) throw new RemoteRestoreError("Retained Remote workspace is not a directory");
    if (d.worktree) {
      try {
        const common = (await git(route.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
        const top = (await git(route.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
        if (canonicalPath(common) !== canonicalPath(d.bare!) || canonicalPath(top) !== route.cwd) throw new Error("wrong worktree");
      } catch { throw new RemoteRestoreError("Retained Remote worktree needs Git metadata repair; its files were preserved"); }
    } else if (d.solo === 0) {
      try {
        const top = (await git(route.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
        if (canonicalPath(top) !== route.cwd) throw new Error("wrong repository root");
      } catch { throw new RemoteRestoreError("Retained Remote repository is not healthy at its recorded root; its files were preserved"); }
    }
    return false;
  }
  if (!d.worktree || !d.bare || !d.branch || !existsSync(d.bare)) {
    throw new RemoteRestoreError("Retained workspace is missing; refusing to create an empty replacement");
  }
  try {
    await git(d.bare, ["check-ref-format", `refs/heads/${d.branch}`]);
    await git(d.bare, ["rev-parse", "--verify", `refs/heads/${d.branch}^{commit}`]);
  } catch { throw new RemoteRestoreError("Recorded Remote branch is missing; refusing to restore from a different branch"); }
  try {
    // No prune or force: another live worktree holding this branch must prevent reuse.
    await git(d.bare, ["worktree", "add", "--", route.cwd, d.branch]);
  } catch { throw new RemoteRestoreError("Cannot restore the exact recorded worktree; no alternate branch was used"); }
  return true;
}

function assertRow(route: RemoteRoute, row: RestoreRow): void {
  const d = route.restore;
  if (row.id !== route.container || row.container !== route.container || row.folder !== d.folder || row.project !== d.project
      || row.repo !== d.repo || row.solo !== d.solo || (row.worktree ?? null) !== d.worktree) {
    throw new RemoteRestoreError("Session ID was reused for a different workspace; refusing to replace it");
  }
}
export interface RestoreOperations {
  get(): RestoreRow | null | undefined;
  inspect(): Promise<ObservedContainer>;
  prepareWorkspace(): Promise<boolean>;
  ensureOwned(createdWorkspace: boolean): Promise<void>;
  clearPrompt(): void;
  ensureDind(): Promise<void>;
  start(): Promise<void>;
  removeStopped(observed: ObservedContainer): Promise<void>;
  create(row: RestoreRow): Promise<void>;
  allocatePort(): number;
  insert(row: RestoreRow): void;
  removeInserted(): void;
  markRunning(recreated: boolean, agent?: AgentName): void;
  now(): number;
}
export async function restoreExactSession(route: RemoteRoute, ops: RestoreOperations): Promise<RestoreRow> {
  const existing = ops.get();
  if (existing) assertRow(route, existing);
  const observed = await ops.inspect();
  if (observed.state !== "missing" && observed.workspace !== route.cwd) throw new RemoteRestoreError("Container workspace differs from the retained Remote route");
  if (!existing && observed.state !== "missing") throw new RemoteRestoreError("Container exists without its session row; refusing to adopt unknown lifecycle metadata");
  if (observed.state === "running") {
    if (existing!.status !== "running") ops.markRunning(false);
    return ops.get()!; // no prompt, agent, auto-end, or activity change on a live session
  }
  const createdWorkspace = await ops.prepareWorkspace();
  await ops.ensureOwned(createdWorkspace);
  ops.clearPrompt();
  await ops.ensureDind();
  const migrateMount = observed.state === "stopped" && !observed.canonicalMount;
  const recreated = observed.state === "missing" || migrateMount;
  let inserted = false;
  try {
    let row = existing;
    if (!row) {
      const d = route.restore;
      row = { id: route.container, container: route.container, folder: d.folder, project: d.project, repo: d.repo,
        solo: d.solo, worktree: d.worktree, port_base: ops.allocatePort(), status: "stopped", agent: "codex",
        created_at: ops.now(), last_active_at: ops.now(), important: 0 };
      ops.insert(row); inserted = true;
    }
    const agent = migrateMount ? row.agent ?? "claude" : "codex";
    if (migrateMount) await ops.removeStopped(observed);
    if (recreated) await ops.create({ ...row, agent });
    else await ops.start();
    const after = await ops.inspect();
    if (after.state !== "running" || after.workspace !== route.cwd) throw new RemoteRestoreError("Restored container did not become running at the recorded workspace", 502);
    if (migrateMount && !after.canonicalMount) throw new RemoteRestoreError("Restored container still lacks its canonical workspace mount", 502);
    ops.markRunning(recreated, recreated ? agent : undefined);
    return ops.get()!;
  } catch (error) {
    // If docker run created a container before failing, retain its row for exact retry.
    if (inserted && (await ops.inspect()).state === "missing") ops.removeInserted();
    throw error;
  }
}
