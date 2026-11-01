/** Real Docker + production SessionManager regression. No credentials or model turns.
 * Run on the Linux devbox with a staged production source root as its sole argument.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

assert.equal(process.platform, "linux");
assert.equal(process.getuid!(), 0);
const source = resolve(process.argv[2]!);
assert(source.includes("/codex-central-rollout/"), "Use an isolated staged production source tree");
const { SessionManager } = await import(join(source, "devd/src/sessions.ts"));
const { openDb, getSession } = await import(join(source, "devd/src/db.ts"));
const { DEFAULT_CONFIG } = await import(join(source, "devd/src/config.ts"));
const id = "dev-codex-proof-restore";
const run = (bin: string, ...args: string[]) => execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let preexisting = false;
try { run("docker", "inspect", id); preexisting = true; } catch {}
assert(!preexisting, "The dedicated proof container must not already exist");
const root = mkdtempSync(join(tmpdir(), "codex-restore-proof-"));
const seed = join(root, "seed"), cwd = join(root, "_sessions", id), bare = join(root, "codex/proof-restore.git");
mkdirSync(seed); mkdirSync(join(root, "codex")); mkdirSync(join(root, "_sessions"));
const git = (dir: string, ...args: string[]) => run("git", "-c", "safe.directory=*", "-C", dir, ...args);
const registry = join(root, "routes.json");
process.env.DEVD_CODEX_ROUTES_FILE = registry;
const db = openDb(join(root, "devd.sqlite"));
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.settings.portRangeStart = 48970; cfg.settings.portsPerSession = 1;
const mgr = new SessionManager({ db, cfg, root, image: "devbox:codex-remote-base", controlRoot: join(root, "control"),
  cmd: ["sleep", "infinity"], devdUrl: "http://127.0.0.1:9", dind: false });
const evidence: Record<string, unknown> = {};
try {
  git(seed, "init", "-b", "main"); git(seed, "config", "user.email", "fixture@example.invalid"); git(seed, "config", "user.name", "Fixture");
  writeFileSync(join(seed, "kept.txt"), "original\n"); git(seed, "add", "."); git(seed, "commit", "-m", "fixture");
  const head = git(seed, "rev-parse", "HEAD");
  git(seed, "clone", "--bare", seed, bare);
  writeFileSync(registry, JSON.stringify({ routes: [{ container: id, environment_id: `devbox_${id}`, cwd,
    thread_ids: ["00000000-0000-4000-8000-000000000001"], restore: { folder: "codex", project: "codex", repo: "proof-restore",
      solo: 0, worktree: cwd, bare, branch: "main" } }] }), { mode: 0o600 });
  assert(!getSession(db, id)); assert(!existsSync(cwd));
  const first = await mgr.resumeRemote(id);
  assert.equal(first.session.id, id); assert.equal(first.cwd, cwd); assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  evidence.removed_row_and_worktree_restored = true;
  const firstDocker = run("docker", "inspect", "--format", "{{.Id}}", id);
  const untouched = JSON.stringify(getSession(db, id));
  await mgr.resumeRemote(id);
  assert.equal(JSON.stringify(getSession(db, id)), untouched);
  assert.equal(run("docker", "inspect", "--format", "{{.Id}}", id), firstDocker);
  evidence.running_idempotent = true;
  writeFileSync(join(cwd, "kept.txt"), "staged\n"); git(cwd, "add", "kept.txt");
  writeFileSync(join(cwd, "kept.txt"), "unstaged\n"); writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
  const status = git(cwd, "status", "--porcelain");
  await mgr.stop(id); assert.equal(getSession(db, id).status, "stopped");
  await mgr.resumeRemote(id);
  assert.equal(run("docker", "inspect", "--format", "{{.Id}}", id), firstDocker);
  evidence.stopped_container_resumed = true;
  await mgr.end(id); assert(!getSession(db, id)); assert(existsSync(cwd));
  const restored = await mgr.resumeRemote(id);
  assert.equal(restored.session.id, id); assert.equal(restored.cwd, cwd);
  assert.notEqual(run("docker", "inspect", "--format", "{{.Id}}", id), firstDocker);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head); assert.equal(git(cwd, "status", "--porcelain"), status);
  assert.equal(git(cwd, "show", ":kept.txt"), "staged");
  assert.equal(readFileSync(join(cwd, "kept.txt"), "utf8"), "unstaged\n");
  assert.equal(readFileSync(join(cwd, "untracked.txt"), "utf8"), "untracked\n");
  evidence.end_then_recreate_preserves_head_index_and_dirty_files = true;
  evidence.no_model_or_credentials = true;
  console.log(JSON.stringify(evidence));
} finally {
  try { run("docker", "rm", "-f", id); } catch {}
  db.close(); rmSync(root, { recursive: true, force: true });
}
