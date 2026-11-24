import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/sessions";
import { getSession, insertSession, openDb } from "../src/db";
import { workspacePath } from "../src/tree";
import { sh } from "./helpers/sh";
import { DEFAULT_CONFIG } from "../src/config";

// The host's docker wrapper (infra/storage-guard/host-docker.py) lets `docker rm` of a session container through only
// once it is backed up offsite, and waits for that only 40 s: replacing a container that was never ended (a stopped
// session reopened with a new env, a recreate) timed out at 60 s every time while the backup ran on (2026-11-24).
// The backup now runs up front with its own long cap, as for an end.
test("recreate backs the old container up before it removes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  const log = join(root, "log");
  writeFileSync(log, "");
  writeFileSync(join(root, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> ${log}\nexit 0\n`);
  chmodSync(join(root, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async (c) => { appendFileSync(log, `preserve ${c}\n`); },
    });
    await mgr.recreate("dev-a-b", "test");
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l === "preserve dev-a-b" || l.startsWith("docker rm"));
    expect(lines[0]).toBe("preserve dev-a-b");
    expect(lines[1]).toStartWith("docker rm -f dev-a-b");
  } finally { process.env.PATH = orig; }
});

test("a failed backup before a replace says what it was for, and nothing is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  const log = join(root, "log");
  writeFileSync(log, "");
  writeFileSync(join(root, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> ${log}\nexit 0\n`);
  chmodSync(join(root, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async () => { throw new Error("backup before ending failed (journalctl -u x): borg died"); },
    });
    await expect(mgr.recreate("dev-a-b", "test")).rejects.toThrow(
      "dev-a-b: its old container must be backed up offsite before it is replaced, and that failed: backup before ending failed (journalctl -u x): borg died");
    expect(readFileSync(log, "utf8")).not.toContain("docker rm");
  } finally { process.env.PATH = orig; }
});

/** A fake docker: logs every call; `inspect --format` describes a stopped container whose workspace is `ws` but that
 *  lacks the canonical mount (an old one: restartSolo replaces it); `state` answers `inspect -f {{.State.Status}}`. */
function fakeDocker(root: string, ws: string, state = "exited") {
  const log = join(root, "log");
  writeFileSync(log, "");
  const inspect = JSON.stringify({ id: "a".repeat(64), state: "exited", running: false, mounts: [{ Type: "bind", Source: ws, Destination: "/workspace" }] });
  writeFileSync(join(root, "docker"), `#!/usr/bin/env bash
echo "docker $*" >> ${log}
case "$*" in
  *'--format'*) echo '${inspect}' ;;
  *'.State.Status'*) echo ${state} ;;
  *'.Config.Env'*) echo '[]' ;;
esac
exit 0
`);
  chmodSync(join(root, "docker"), 0o755);
  return log;
}

test("restartSolo backs the old container up before it replaces it (canonical-workspace migration)", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  const ws = workspacePath(root, "acme", "a", "claudeSolo");
  mkdirSync(ws, { recursive: true });
  const log = fakeDocker(root, ws);
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-claudeSolo", folder: "acme", project: "a", repo: "claudeSolo", container: "dev-a-claudeSolo", port_base: 41500,
      status: "stopped", solo: 1, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async (c) => { appendFileSync(log, `preserve ${c}\n`); },
    });
    await mgr.restartSolo("dev-a-claudeSolo");
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("preserve") || l.startsWith("docker rm"));
    expect(lines).toEqual(["preserve dev-a-claudeSolo", `docker rm ${"a".repeat(64)}`]);
  } finally { process.env.PATH = orig; }
});

// A failed backup leaves the container stopped (prepare-end stops it first): the row must not keep saying "running".
test("a failed backup before a replace leaves a stopped container's session stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  fakeDocker(root, "/unused");
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async () => { throw new Error("borg died"); },
    });
    await expect(mgr.recreate("dev-a-b", "test")).rejects.toThrow("borg died");
    expect(getSession(db, "dev-a-b")?.status).toBe("stopped");
  } finally { process.env.PATH = orig; }
});

test("the backup gets the session's container name, not its id", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  fakeDocker(root, "/unused", "running");
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b-box", port_base: 41500,
      status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const seen: string[] = [];
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async (c) => { seen.push(c); },
    });
    await mgr.recreate("dev-a-b", "test");
    expect(seen).toEqual(["dev-a-b-box"]);
  } finally { process.env.PATH = orig; }
});

// open() of an existing stopped session replaces its container in two ways: a new env (here the agent baked in
// differs from the one opened with) and a container without the canonical workspace mount. Real git, fake docker.
function openFixture() {
  const root = mkdtempSync(join(tmpdir(), "replace-open-"));
  const bare = join(root, "origin.git");
  sh(root, "git", "init", "--bare", "-b", "main", bare);
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  sh(seed, "git", "init", "-b", "main"); sh(seed, "git", "config", "user.email", "t@t"); sh(seed, "git", "config", "user.name", "t");
  writeFileSync(join(seed, "f.txt"), "x\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "init"); sh(seed, "git", "push", bare, "HEAD:main");
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const log = join(bin, "log"), inspect = join(bin, "inspect"), env = join(bin, "env");
  writeFileSync(log, "");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
echo "docker $*" >> ${log}
case "$*" in
  *'--format'*) [ -s ${inspect} ] && cat ${inspect} || { echo "Error: No such object" >&2; exit 1; } ;;
  *'.Config.Env'*) cat ${env} 2>/dev/null || echo '[]' ;;
  *'.State.Status'*) echo exited ;;
  exec*) echo 27.0 ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  const db = openDb(":memory:");
  const order: string[] = [];
  const mgr = new SessionManager({ db, cfg: structuredClone(DEFAULT_CONFIG), root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"],
    controlRoot: join(root, "ctl"), preserveForEnd: async (c) => { appendFileSync(log, `preserve ${c}\n`); } });
  /** The session's container is now stopped, at its worktree; `canonical`: it has the canonical mount. */
  const stopped = (canonical: boolean) => {
    const ws = getSession(db, "dev-acme-app")!.worktree!;
    const mounts = [{ Type: "bind", Source: ws, Destination: "/workspace" }, ...(canonical ? [{ Type: "bind", Source: ws, Destination: ws }] : [])];
    writeFileSync(inspect, JSON.stringify({ id: "b".repeat(64), state: "exited", running: false, mounts }));
    writeFileSync(log, "");
  };
  const replaced = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("preserve") || l.startsWith("docker rm"));
  return { db, mgr, bare, env, stopped, replaced, order };
}
const savedPath = process.env.PATH;

test("open of a stopped session with another agent baked in backs the container up before it removes it", async () => {
  const f = openFixture();
  try {
    await f.mgr.open({ folder: "acme", project: "acme", repo: "app", cloneUrl: f.bare });
    f.stopped(true);
    writeFileSync(f.env, JSON.stringify(["DEVD_AGENT=codex"]));
    await f.mgr.open({ folder: "acme", project: "acme", repo: "app" });
    expect(f.replaced()).toEqual(["preserve dev-acme-app", "docker rm -f dev-acme-app"]);
  } finally { process.env.PATH = savedPath; }
});

test("open of a stopped session without the canonical mount backs the container up before it removes it", async () => {
  const f = openFixture();
  try {
    await f.mgr.open({ folder: "acme", project: "acme", repo: "app", cloneUrl: f.bare });
    f.stopped(false);
    await f.mgr.open({ folder: "acme", project: "acme", repo: "app" });
    expect(f.replaced()).toEqual(["preserve dev-acme-app", `docker rm ${"b".repeat(64)}`]);
  } finally { process.env.PATH = savedPath; }
});
