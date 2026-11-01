import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadRemoteRoute, prepareRemoteWorkspace, restoreExactSession, retainRemoteWorkspace, validateRemoteRoute,
  type ObservedContainer, type RemoteRoute, type RestoreOperations, type RestoreRow } from "../../infra/codex-remote/restoreSession";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-restore-"))); paths.push(root);
  mkdirSync(join(root, "_sessions")); mkdirSync(join(root, "apps"));
  const id = "dev-apps-app-2";
  const route: RemoteRoute = { container: id, environment_id: `devbox_${id}`, cwd: join(root, "_sessions", id),
    thread_ids: ["01a0818e-9366-7c83-a2c6-a0bba7f00d92"],
    restore: { folder: "apps", project: "apps", repo: "app", solo: 0, worktree: join(root, "_sessions", id), bare: join(root, "apps", "app.git"), branch: "session/app-2" } };
  const registry = join(root, "routes.json");
  const write = (routes: unknown[] = [route]) => writeFileSync(registry, JSON.stringify({ routes }), { mode: 0o600 });
  write();
  const row: RestoreRow = { id, container: id, folder: "apps", project: "apps", repo: "app", solo: 0,
    worktree: route.cwd, agent: "codex", status: "stopped", port_base: 41000, created_at: 1, last_active_at: 2, important: 1 };
  return { root, id, route, row, registry, write };
}
function operations(route: RemoteRoute, initial?: RestoreRow) {
  let row = initial ? { ...initial } : undefined;
  let observed: ObservedContainer = { state: initial ? "stopped" : "missing", workspace: initial ? route.cwd : undefined, canonicalMount: true };
  const calls: string[] = [];
  const ops: RestoreOperations = {
    get: () => row, inspect: async () => observed,
    prepareWorkspace: async () => { calls.push("workspace"); return false; },
    ensureOwned: async () => { calls.push("ownership"); }, clearPrompt: () => { calls.push("clear-prompt"); },
    ensureDind: async () => { calls.push("dind"); },
    start: async () => { calls.push("start"); observed = { state: "running", workspace: route.cwd, canonicalMount: true }; },
    removeStopped: async () => { calls.push("remove-stopped"); observed = { state: "missing" }; },
    create: async (created) => { calls.push(`create:${created.id}:${created.agent}`); observed = { state: "running", workspace: route.cwd, canonicalMount: true }; },
    allocatePort: () => 42000, insert: r => { calls.push(`insert:${r.id}`); row = { ...r }; },
    removeInserted: () => { calls.push("rollback"); row = undefined; },
    markRunning: recreated => { calls.push("running"); row = { ...row!, status: "running", last_active_at: 100, ...(recreated ? { agent: "codex" as const } : {}) }; },
    now: () => 100,
  };
  return { ops, calls, setObserved: (value: ObservedContainer) => { observed = value; } };
}

test("removed row restores the exact recorded ID, new port and original workspace", async () => {
  const f = fixture(), o = operations(f.route);
  const restored = await restoreExactSession(f.route, o.ops);
  expect(restored).toMatchObject({ id: f.id, container: f.id, worktree: f.route.cwd, status: "running", agent: "codex", port_base: 42000 });
  expect(o.calls).toEqual(["workspace", "ownership", "clear-prompt", "dind", `insert:${f.id}`, `create:${f.id}:codex`, "running"]);
});
test("live exact container is untouched, including activity and current agent", async () => {
  const f = fixture(); f.row.status = "running"; f.row.agent = "claude";
  const o = operations(f.route, f.row); o.setObserved({ state: "running", workspace: f.route.cwd });
  expect(await restoreExactSession(f.route, o.ops)).toEqual(f.row);
  expect(o.calls).toEqual([]);
});
test("stopped exact container starts without recreation and keeps its port", async () => {
  const f = fixture(), o = operations(f.route, f.row);
  expect(await restoreExactSession(f.route, o.ops)).toMatchObject({ id: f.id, port_base: 41000, status: "running" });
  expect(o.calls).toEqual(["workspace", "ownership", "clear-prompt", "dind", "start", "running"]);
});
test("missing container with existing row reuses exact metadata and recreates Codex", async () => {
  const f = fixture(); f.row.agent = "claude";
  const o = operations(f.route, f.row); o.setObserved({ state: "missing" });
  expect(await restoreExactSession(f.route, o.ops)).toMatchObject({ id: f.id, created_at: 1, important: 1, port_base: 41000, agent: "codex" });
  expect(o.calls).not.toContain(`insert:${f.id}`);
});
test("reused DB identity and mismatching Docker mounts fail before any mutation", async () => {
  const f = fixture(), wrong = operations(f.route, { ...f.row, repo: "other" });
  await expect(restoreExactSession(f.route, wrong.ops)).rejects.toThrow("ID was reused"); expect(wrong.calls).toEqual([]);
  const o = operations(f.route, f.row); o.setObserved({ state: "running", workspace: join(f.root, "other") });
  await expect(restoreExactSession(f.route, o.ops)).rejects.toThrow("workspace differs"); expect(o.calls).toEqual([]);
});
test("unknown orphan container is never adopted and failed creation rolls back only absent Docker", async () => {
  const f = fixture(), o = operations(f.route); o.setObserved({ state: "running", workspace: f.route.cwd });
  await expect(restoreExactSession(f.route, o.ops)).rejects.toThrow("without its session row"); expect(o.calls).toEqual([]);
  o.setObserved({ state: "missing" }); o.ops.create = async () => { throw new Error("failed"); };
  await expect(restoreExactSession(f.route, o.ops)).rejects.toThrow("failed"); expect(o.ops.get()).toBeUndefined();
  const second = operations(f.route);
  second.ops.create = async () => { second.setObserved({ state: "stopped", workspace: f.route.cwd }); throw new Error("partial create"); };
  await expect(restoreExactSession(f.route, second.ops)).rejects.toThrow("partial create"); expect(second.ops.get()?.id).toBe(f.id);
});
test("registry requires exact authority, canonical paths, uniqueness and file ownership", () => {
  const f = fixture(), uid = process.getuid!();
  expect(loadRemoteRoute(f.id, f.root, f.registry, uid)).toEqual(f.route);
  expect(() => loadRemoteRoute("dev-missing", f.root, f.registry, uid)).toThrow("No retained Remote route");
  expect(() => loadRemoteRoute(f.id, f.root, f.registry, uid + 1)).toThrow("root-owned");
  chmodSync(f.registry, 0o666); expect(() => loadRemoteRoute(f.id, f.root, f.registry, uid)).toThrow("root-owned"); chmodSync(f.registry, 0o600);
  f.write([f.route, f.route]); expect(() => loadRemoteRoute(f.id, f.root, f.registry, uid)).toThrow("duplicate");
  expect(() => validateRemoteRoute({ ...f.route, cwd: "/workspace" }, f.id, f.root)).toThrow("descriptor");
  expect(() => validateRemoteRoute({ ...f.route, restore_error: "capture failed" }, f.id, f.root)).toThrow("stale restore");
  expect(() => validateRemoteRoute({ ...f.route, restore: { ...f.route.restore, repo: "different" } }, f.id, f.root)).toThrow("project and repository");
  const link = join(f.root, "alias"); symlinkSync(f.registry, link); expect(() => loadRemoteRoute(f.id, f.root, link, uid)).toThrow("trusted Remote registry");
});
test("end retains registered native worktree or solo files, unregistered sessions follow normal cleanup", () => {
  const f = fixture(), uid = process.getuid!();
  expect(retainRemoteWorkspace(f.row, f.root, f.registry, uid)).toBe(true);
  f.write([{ ...f.route, thread_ids: [] }]); expect(retainRemoteWorkspace(f.row, f.root, f.registry, uid)).toBe(false);
  f.write([]); expect(retainRemoteWorkspace(f.row, f.root, f.registry, uid)).toBe(false);
  writeFileSync(f.registry, "{bad"); expect(() => retainRemoteWorkspace(f.row, f.root, f.registry, uid)).toThrow("trusted Remote registry");
  const solo = { ...f.route, cwd: join(f.root, "apps", "app"), restore: { ...f.route.restore, solo: 1 as const, worktree: null, bare: null, branch: null } };
  f.write([solo]); expect(retainRemoteWorkspace({ ...f.row, solo: 1, worktree: null }, f.root, f.registry, uid)).toBe(true);
});
test("missing legacy/solo workspace and missing recorded branch cannot become empty or default workspace", async () => {
  const f = fixture();
  const solo: RemoteRoute = { ...f.route, cwd: join(f.root, "apps", "app"), restore: { ...f.route.restore, solo: 1, worktree: null, bare: null, branch: null } };
  await expect(prepareRemoteWorkspace(solo)).rejects.toThrow("empty replacement");
  execFileSync("git", ["init", "--bare", f.route.restore.bare!], { stdio: "ignore" });
  await expect(prepareRemoteWorkspace(f.route)).rejects.toThrow("Recorded Remote branch is missing");
});
test("existing legacy repository must be healthy at exactly its recorded root", async () => {
  const f = fixture(); const cwd = join(f.root, "apps", "app"); mkdirSync(cwd);
  const legacy: RemoteRoute = { ...f.route, cwd, restore: { ...f.route.restore, worktree: null, bare: null, branch: null } };
  await expect(prepareRemoteWorkspace(legacy)).rejects.toThrow("not healthy");
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  expect(await prepareRemoteWorkspace(legacy)).toBe(false);
  const nested = join(cwd, "nested"); mkdirSync(nested);
  await expect(prepareRemoteWorkspace({ ...legacy, cwd: nested })).rejects.toThrow("recorded root");
});
test("real offline Git restore keeps recorded branch commit and preserves dirty existing files and index", async () => {
  const f = fixture(), seed = join(f.root, "seed"); mkdirSync(seed);
  const git = (...args: string[]) => execFileSync("git", ["-C", seed, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(join(seed, "kept.txt"), "original\n"); git("add", "."); git("commit", "-m", "fixture");
  const expected = git("rev-parse", "HEAD"); git("branch", "session/app-2");
  git("clone", "--bare", seed, f.route.restore.bare!);
  expect(await prepareRemoteWorkspace(f.route)).toBe(true);
  const cwdGit = (...args: string[]) => execFileSync("git", ["-C", f.route.cwd, ...args], { encoding: "utf8" }).trim();
  expect(cwdGit("rev-parse", "HEAD")).toBe(expected);
  expect(cwdGit("branch", "--show-current")).toBe("session/app-2");
  writeFileSync(join(f.route.cwd, "kept.txt"), "staged\n"); cwdGit("add", "kept.txt");
  writeFileSync(join(f.route.cwd, "kept.txt"), "unstaged\n"); const before = cwdGit("status", "--porcelain");
  expect(await prepareRemoteWorkspace(f.route)).toBe(false);
  expect(readFileSync(join(f.route.cwd, "kept.txt"), "utf8")).toBe("unstaged\n"); expect(cwdGit("status", "--porcelain")).toBe(before);
  expect(cwdGit("show", ":kept.txt")).toBe("staged"); expect(cwdGit("rev-parse", "HEAD")).toBe(expected);
});
