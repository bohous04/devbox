// Host git over agent-writable repos runs as the container uid, never as root: safeGit's layer 2
// (config probe, then run) is best-effort, the repo can change in between. These tests pin the
// argv/env that hardenGit produces when devd is root (injected uid 0; this machine is not root),
// plus one end-to-end run that only works as root on Linux (skipped elsewhere, with the reason).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenGit, setAgentGitRoots, AGENT_UID } from "../src/safeGit";
import type { RunOpts, RunResult } from "../src/proc";
import { sh } from "./helpers/sh";

afterEach(() => setAgentGitRoots(null));

const ok: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false };
function recorder() {
  const seen: { cmd: string[]; opts: RunOpts }[] = [];
  const raw = async (cmd: string[], opts: RunOpts) => { seen.push({ cmd, opts }); return ok; };
  return { seen, raw };
}
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "agentuid-")));

test("as root, git whose target is under an agent root runs via setpriv as the agent uid with a minimal env (probe too)", async () => {
  const r = root();
  setAgentGitRoots(() => [r]);
  const { seen, raw } = recorder();
  process.env.HARBOR_SECRET = "devd-only";
  try {
    const h = await hardenGit(["git", "-C", join(r, "acme", "api"), "fetch", "origin"], { timeoutMs: 1000, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://git.example/.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: x" } }, raw, 0);
    if (!("cmd" in h)) throw new Error("refused");
    const wrap = ["setpriv", `--reuid=${AGENT_UID}`, `--regid=${AGENT_UID}`, "--clear-groups"];
    expect(h.cmd.slice(0, 5)).toEqual([...wrap, "git"]);
    expect(seen[0]!.cmd.slice(0, 5)).toEqual([...wrap, "git"]);       // the config probe as well
    for (const o of [h.opts, seen[0]!.opts]) {
      expect(o.inheritEnv).toBe(false);
      expect(o.env).toMatchObject({ HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      expect(Object.keys(o.env!)).not.toContain("HARBOR_SECRET");
    }
    // The caller's explicit auth env reaches the network call.
    expect(h.opts.env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_VALUE_0: "Authorization: x" });
  } finally { delete process.env.HARBOR_SECRET; }
});

test("as root, --git-dir or --work-tree under an agent root is enough to switch to the agent uid", async () => {
  const r = root();
  setAgentGitRoots(() => [r]);
  const { raw } = recorder();
  const h = await hardenGit(["git", "--git-dir", join(r, "x.git"), "--work-tree", join(r, "x"), "status"], { cwd: "/", timeoutMs: 1000 }, raw, 0);
  if (!("cmd" in h)) throw new Error("refused");
  expect(h.cmd[0]).toBe("setpriv");
});

test("classification under the agent root: repos and _sessions run as the agent uid; devd's own _-dirs are refused, not run as root", async () => {
  const r = root();
  setAgentGitRoots(() => [r]);
  const { raw } = recorder();
  for (const dir of [join(r, "harbor", "api"), join(r, "harbor", "api", "api.git"), join(r, "_sessions", "dev-api")]) {
    const h = await hardenGit(["git", "-C", dir, "status"], { timeoutMs: 1000 }, raw, 0);
    if (!("cmd" in h)) throw new Error(`refused ${dir}`);
    expect(h.cmd[0]).toBe("setpriv");
  }
  for (const dir of [join(r, "_inbox", "x"), join(r, "_chat-archive", "dev-api-1"), join(r, "_cleanup-recovery", "a"), join(r, "_pre-migration-1", "app")]) {
    const h = await hardenGit(["git", "-C", dir, "status"], { timeoutMs: 1000 }, raw, 0);
    expect("result" in h).toBe(true);
    if ("result" in h) expect(h.result.stderr).toContain("devd's own directory");
  }
  // A --git-dir into such a dir is refused as well, even from a repo cwd.
  const g = await hardenGit(["git", "--git-dir", join(r, "_broken", "x.git"), "status"], { cwd: join(r, "harbor"), timeoutMs: 1000 }, raw, 0);
  expect("result" in g).toBe(true);
});

test("git outside the agent roots (devd's own checkout, config repo) stays as is", async () => {
  const r = root();
  setAgentGitRoots(() => [r]);
  const { raw } = recorder();
  const h = await hardenGit(["git", "-C", "/opt/devd", "pull"], { timeoutMs: 1000 }, raw, 0);
  if (!("cmd" in h)) throw new Error("refused");
  expect(h.cmd[0]).toBe("git");
  expect(h.opts.inheritEnv).toBeUndefined();
});

test("not root: no wrapping (nothing to drop, and a non-root process could not switch uid)", async () => {
  const r = root();
  setAgentGitRoots(() => [r]);
  const { raw } = recorder();
  const h = await hardenGit(["git", "-C", r, "status"], { timeoutMs: 1000 }, raw, 501);
  if (!("cmd" in h)) throw new Error("refused");
  expect(h.cmd[0]).toBe("git");
});

// End to end: only as root on Linux (the host run before deploy). It simulates losing layer 2's
// race: the probe sees a clean repo, then the repo is armed, then git runs. The planted code
// (credential.helper=!cmd, a merge driver, include.path, a filter clean) must actually run (so the
// test is not vacuous) and only as the agent uid, never root.
const asRootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
test.skipIf(!asRootOnLinux)("as root on Linux: repo code armed after the config probe runs as the agent uid, never root (needs root; skipped otherwise)", async () => {
  const { runRaw } = await import("../src/proc");
  const r = root();
  chmodSync(r, 0o755);
  setAgentGitRoots(() => [r]);
  const marker = join(r, "marker");
  const script = join(r, "planted.sh");
  writeFileSync(script, `#!/bin/sh\nid -u >> ${marker}\ncat\n`);
  chmodSync(script, 0o755);
  const ws = join(r, "ws");
  const g = (...a: string[]) => sh(r, "git", "-C", ws, "-c", "safe.directory=*", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a);
  sh(r, "git", "init", "-q", "-b", "main", ws);
  writeFileSync(join(ws, "a.txt"), "1\n");
  g("add", "."); g("commit", "-qm", "init");
  g("checkout", "-qb", "side"); writeFileSync(join(ws, "a.txt"), "side\n"); g("commit", "-qam", "side");
  g("checkout", "-q", "main"); writeFileSync(join(ws, "a.txt"), "main\n"); g("commit", "-qam", "main");
  sh(r, "chown", "-R", `${AGENT_UID}:${AGENT_UID}`, r);
  writeFileSync(join(ws, ".gitattributes"), "* filter=planted merge=planted\n");
  sh(r, "chown", "-R", `${AGENT_UID}:${AGENT_UID}`, r);
  // Each step arms only its own key, after the probe, and disarms it afterwards, so every probe
  // sees a clean repo (an armed key the probe sees is overridden, and nothing would run).
  const lose = async (cmd: string[], key: string, value: string, stdin?: string) => {
    let armed = false;
    const raw = async (c: string[], o: RunOpts) => {
      const res = await runRaw(c, o);
      if (!armed) { armed = true; g("config", key, value); }
      return res;
    };
    const h = await hardenGit(cmd, { cwd: ws, timeoutMs: 20_000, stdin }, raw, 0);
    if (!("cmd" in h)) throw new Error(h.result.stderr);
    expect(h.cmd[0]).toBe("setpriv");
    await runRaw(h.cmd, h.opts);
    g("config", "--unset-all", key);
  };
  writeFileSync(join(r, "inc.cfg"), `[filter "planted"]\n\tclean = ${script}\n`);
  writeFileSync(join(ws, "a.txt"), "dirty\n");
  sh(r, "chown", "-R", `${AGENT_UID}:${AGENT_UID}`, r);
  await lose(["git", "diff", "--numstat"], "include.path", join(r, "inc.cfg"));   // stats diff: filter clean via include.path
  await lose(["git", "credential", "fill"], "credential.helper", `!${script}`, "protocol=https\nhost=git.example\n\n");
  g("checkout", "-q", "--", "a.txt");
  await lose(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "merge", "side"], "merge.planted.driver", `${script} %O %A %B`);
  const uids = (await Bun.file(marker).text()).trim().split("\n");
  expect(uids.length).toBeGreaterThan(0);
  expect(uids.every((u) => u === String(AGENT_UID))).toBe(true);
  expect(statSync(marker).uid).toBe(AGENT_UID);
  rmSync(r, { recursive: true, force: true });
});

test.skipIf(!asRootOnLinux)("as root on Linux: clone and worktree add into root-owned parents work as the agent uid (needs root; skipped otherwise)", async () => {
  const { cloneBare, addWorktree } = await import("../src/git");
  const r = root();
  chmodSync(r, 0o755);
  setAgentGitRoots(() => [r]);
  const origin = join(r, "origin.git");
  sh(r, "git", "init", "-q", "--bare", origin);
  const seed = join(r, "seed");
  sh(r, "git", "clone", "-q", origin, seed);
  writeFileSync(join(seed, "a.txt"), "1\n");
  sh(seed, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
  sh(seed, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  sh(seed, "git", "push", "-q", "origin", "HEAD:main");
  sh(r, "chown", "-R", `${AGENT_UID}:${AGENT_UID}`, origin);
  const bare = join(r, "harbor", "api", "api.git");       // parents created by root, as in sessions.ts
  mkdirSync(join(r, "harbor", "api"), { recursive: true });
  await cloneBare(origin, bare);
  expect(statSync(bare).uid).toBe(AGENT_UID);
  const dest = join(r, "harbor", "api", "_sessions", "dev-api");
  await addWorktree(bare, dest, null, "main");
  expect(statSync(dest).uid).toBe(AGENT_UID);
  expect(statSync(join(dest, "a.txt")).uid).toBe(AGENT_UID);
  rmSync(r, { recursive: true, force: true });
});
