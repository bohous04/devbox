import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFor, update, type CiState, type DeployState, type Deps, type Proc } from "./devbox-update";

const sh = (cmd: string[], cwd?: string): Proc => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

/** origin (bare) + a "server" clone on main, and a helper to push a new commit to origin. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devbox-update-"));
  const origin = join(root, "origin.git"), work = join(root, "work"), server = join(root, "server");
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  sh(["git", "clone", "-q", origin, work]);
  writeFileSync(join(work, "README.md"), "v1\n");
  sh(["git", "add", "-A"], work); sh(["git", "commit", "-q", "-m", "v1"], work); sh(["git", "push", "-q", "origin", "HEAD:main"], work);
  sh(["git", "clone", "-q", "-b", "main", origin, server]);
  const push = (files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), c); }
    sh(["git", "add", "-A"], work); sh(["git", "commit", "-q", "-m", "change"], work); sh(["git", "push", "-q", "origin", "HEAD:main"], work);
    return sh(["git", "rev-parse", "HEAD"], work).stdout.trim();
  };
  const head = () => sh(["git", "rev-parse", "HEAD"], server).stdout.trim();
  return { server, push, head };
}

/** Real git; bun/docker/systemctl/timedatectl are recorded and succeed unless told otherwise. */
function deps(over: Partial<Deps> & { ci?: CiState; healthyCommit?: () => string | null; fail?: RegExp } = {}) {
  const calls: string[] = [], notes: string[] = [], states: DeployState[] = [];
  const d: Deps = {
    run: async (cmd, opts) => {
      if (cmd[0] === "git") return sh(cmd, opts?.cwd);
      const line = cmd.join(" ");
      calls.push(line);
      if (over.fail?.test(line)) return { code: 1, stdout: "", stderr: "boom" };
      if (cmd[0] === "docker" && cmd[1] === "run") return { code: 0, stdout: "2.1.316 (Claude Code)\n", stderr: "" };
      if (cmd[0] === "timedatectl") return { code: 0, stdout: "Europe/Prague\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ciState: async () => over.ci ?? "success",
    health: async () => ({ ok: true, commit: over.healthyCommit ? over.healthyCommit() : null }),
    notify: async (m) => { notes.push(m); },
    log: () => {},
    sleep: async () => {},
    writeState: (s) => { states.push(s); },
    ...over,
  };
  return { d, calls, notes, states };
}
const cfg = (repoDir: string) => ({ repoDir, branch: "main", image: "devbox:latest", healthTimeoutMs: 50 });

test("planFor rebuilds only what changed", () => {
  expect(planFor(["dashboard/src/App.tsx"])).toMatchObject({ dashboard: true, image: false, restart: false, install: false });
  expect(planFor(["devd/src/api.ts"])).toMatchObject({ restart: true, dashboard: false, image: false });
  expect(planFor(["shared/usage.ts"])).toMatchObject({ restart: true, dashboard: true });
  expect(planFor(["image/Dockerfile"])).toMatchObject({ image: true, restart: false });
  expect(planFor(["bun.lock"])).toMatchObject({ install: true, restart: true });
  expect(planFor(["infra/setup.sh", "infra/devd-watch.test.ts", "infra/README.md"]).infra).toEqual(["infra/setup.sh"]);
});

test("nothing new on main: no work at all", async () => {
  const f = fixture(); const t = deps();
  expect(await update(t.d, cfg(f.server))).toEqual({ kind: "up-to-date" });
  expect(t.calls).toEqual([]);
});

test("waits while CI on the new commit is pending or failed", async () => {
  const f = fixture(); const before = f.head(); f.push({ "devd/src/a.ts": "x" });
  for (const ci of ["pending", "failure", "none"] as const) {
    const t = deps({ ci });
    expect((await update(t.d, cfg(f.server))).kind).toBe("waiting-for-ci");
    expect(f.head()).toBe(before);
    expect(t.calls).toEqual([]);
  }
});

test("a dashboard-only change rebuilds the dashboard and does not restart devd", async () => {
  const f = fixture(); const target = f.push({ "dashboard/src/x.ts": "x" }); const t = deps();
  const r = await update(t.d, cfg(f.server));
  expect(r.kind).toBe("deployed");
  expect(f.head()).toBe(target);
  expect(t.calls).toEqual(["bun run build:dashboard"]);
  expect(t.states.at(-1)).toMatchObject({ commit: target, restarted: false });
});

test("a devd change restarts devd and requires the new commit in /api/health", async () => {
  const f = fixture(); const target = f.push({ "devd/src/api.ts": "x" });
  const t = deps({ healthyCommit: () => f.head() });
  expect((await update(t.d, cfg(f.server))).kind).toBe("deployed");
  expect(t.calls).toContain("systemctl restart devd");
  expect(t.states.at(-1)).toMatchObject({ commit: target, restarted: true });
  expect(t.notes.some((n) => n.includes("restarts now"))).toBe(true);
});

test("unhealthy after restart: rolls back to the previous commit and restarts again", async () => {
  const f = fixture(); const before = f.head(); f.push({ "devd/src/api.ts": "x", "image/Dockerfile": "FROM x" });
  // The old commit comes up healthy, the new one never does.
  const t = deps({ healthyCommit: () => (f.head() === before ? before : null) });
  const r = await update(t.d, cfg(f.server));
  expect(r.kind).toBe("rolled-back");
  expect(f.head()).toBe(before);
  expect(t.calls.filter((c) => c === "systemctl restart devd")).toHaveLength(2);
  // The image this run built is replaced by the one it moved aside.
  expect(t.calls).toContain("docker tag devbox:latest devbox:previous");
  expect(t.calls.at(-2)).toBe("docker tag devbox:previous devbox:latest");
  expect(t.states.at(-1)).toMatchObject({ commit: before, rolledBack: true });
});

test("a failed build reverts the code before anything restarts", async () => {
  const f = fixture(); const before = f.head(); f.push({ "dashboard/src/x.ts": "x", "devd/src/a.ts": "y" });
  const t = deps({ fail: /build:dashboard/ });
  const r = await update(t.d, cfg(f.server));
  expect(r.kind).toBe("rolled-back");
  expect(f.head()).toBe(before);
  expect(t.calls).not.toContain("systemctl restart devd");
  // No image was moved aside in this run, so no older :previous is put back.
  expect(t.calls.some((c) => c.startsWith("docker tag"))).toBe(false);
});

test("never deploys over local changes, another branch or diverged history", async () => {
  const dirty = fixture(); dirty.push({ "devd/src/a.ts": "x" });
  writeFileSync(join(dirty.server, "README.md"), "edited on the server\n");
  let t = deps();
  expect(await update(t.d, cfg(dirty.server))).toMatchObject({ kind: "blocked" });
  expect(t.notes[0]).toContain("local changes");

  const other = fixture(); other.push({ "devd/src/a.ts": "x" });
  sh(["git", "checkout", "-q", "-b", "experiment"], other.server);
  t = deps();
  expect(await update(t.d, cfg(other.server))).toMatchObject({ kind: "blocked" });
  expect(t.notes[0]).toContain('"experiment"');

  const diverged = fixture(); diverged.push({ "devd/src/a.ts": "x" });
  writeFileSync(join(diverged.server, "local.txt"), "x");
  sh(["git", "add", "-A"], diverged.server);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "local"], diverged.server);
  t = deps();
  expect(await update(t.d, cfg(diverged.server))).toMatchObject({ kind: "blocked" });
  expect(t.notes[0]).toContain("not on main");
});

test("an image change pins the Claude Code version of the running image", async () => {
  const f = fixture(); f.push({ "image/Dockerfile": "FROM y" }); const t = deps();
  expect((await update(t.d, cfg(f.server))).kind).toBe("deployed");
  expect(t.calls.find((c) => c.startsWith("docker build"))).toContain("CC_VERSION=2.1.316");
  expect(t.calls.find((c) => c.startsWith("docker build"))).toContain("TZ=Europe/Prague");
});

test("infra changes are reported, not applied", async () => {
  const f = fixture(); f.push({ "infra/setup.sh": "#!/bin/sh" }); const t = deps();
  expect((await update(t.d, cfg(f.server))).kind).toBe("deployed");
  expect(t.notes.some((n) => n.includes("infra changed (infra/setup.sh)"))).toBe(true);
  expect(t.calls).toEqual([]);
});
