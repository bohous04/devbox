#!/usr/bin/env bun
// devbox-update — deploys exactly what is on origin/main, and only once CI passed on it.
//
// Run by devbox-update.timer every night (after the Claude Code upkeep window) or by hand
// (`devbox-update`). It never deploys another branch and never touches a checkout with local
// changes: those runs stop and notify instead, so "deployed something that is not main"
// cannot happen. Steps:
//
//   1. fetch origin/main; nothing new → done
//   2. refuse a dirty tree, another branch or diverged history (notify)
//   3. wait until every CI check on the new commit succeeded
//   4. fast-forward, then rebuild only what changed: dependencies, dashboard, session image
//   5. restart devd only if devd/ or shared/ changed, then require /api/health to report
//      the new commit; otherwise roll back to the previous commit and restart again
//
// Changes under infra/ (systemd units, setup.sh, storage guard) are not applied
// automatically: the run notifies that they need a review and `setup.sh`.
//
// Notifications go through devd /api/notify before a restart and through Pushover
// (/etc/devd/watch.env, like devd-watch) after it, because a restart locks the vault.

export interface Proc { code: number; stdout: string; stderr: string }
export type Run = (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<Proc>;
export type CiState = "success" | "pending" | "failure" | "none";

export interface Deps {
  run: Run;
  ciState: (sha: string) => Promise<CiState>;
  health: () => Promise<{ ok: boolean; commit: string | null } | null>;
  notify: (message: string, opts?: { afterRestart?: boolean }) => Promise<void>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  writeState: (state: DeployState) => void;
}

export interface Config {
  repoDir: string;
  branch: string;          // always "main" in production; tests may override
  image: string;           // devbox:latest
  healthTimeoutMs: number;
}

export interface DeployState { commit: string; previous: string | null; at: string; restarted: boolean; rolledBack?: boolean }

export interface Plan { install: boolean; dashboard: boolean; image: boolean; restart: boolean; infra: string[] }

/** What a set of changed paths requires. Pure, so it is easy to test. */
export function planFor(changed: string[]): Plan {
  const any = (re: RegExp) => changed.some((f) => re.test(f));
  return {
    install: any(/(^|\/)(package\.json|bun\.lock)$/),
    dashboard: any(/^(dashboard|shared)\//),
    image: any(/^image\//),
    restart: any(/^(devd|shared)\//) || any(/(^|\/)(package\.json|bun\.lock)$/),
    infra: changed.filter((f) => f.startsWith("infra/") && !/(\.test\.ts|\.md)$/.test(f) && !/(^|\/)test[-_]/.test(f)),
  };
}

export type Outcome =
  | { kind: "up-to-date" }
  | { kind: "blocked"; reason: string }
  | { kind: "waiting-for-ci"; commit: string; ci: CiState }
  | { kind: "deployed"; commit: string; previous: string; plan: Plan }
  | { kind: "rolled-back"; commit: string; previous: string; reason: string }
  | { kind: "failed"; reason: string };

const short = (sha: string) => sha.slice(0, 7);

export async function update(d: Deps, cfg: Config): Promise<Outcome> {
  const git = (...args: string[]) => d.run(["git", "-C", cfg.repoDir, ...args]);
  const out = async (...args: string[]) => {
    const r = await git(...args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.trim();
  };

  const fetched = await git("fetch", "--quiet", "origin", cfg.branch);
  if (fetched.code !== 0) return { kind: "failed", reason: `git fetch failed: ${fetched.stderr.trim()}` };
  const head = await out("rev-parse", "HEAD");
  const target = await out("rev-parse", `origin/${cfg.branch}`);
  if (head === target) return { kind: "up-to-date" };

  const branch = await out("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== cfg.branch) return blocked(d, `the server checkout is on "${branch}", not ${cfg.branch}`);
  const dirty = await out("status", "--porcelain", "--untracked-files=no");
  if (dirty) return blocked(d, `the server checkout has local changes:\n${dirty}`);
  if ((await git("merge-base", "--is-ancestor", head, target)).code !== 0)
    return blocked(d, `the server checkout has commits that are not on ${cfg.branch}`);

  const ci = await d.ciState(target);
  if (ci !== "success") {
    d.log(`CI on ${short(target)} is ${ci}; not deploying yet`);
    return { kind: "waiting-for-ci", commit: target, ci };
  }

  const changed = (await out("diff", "--name-only", `${head}..${target}`)).split("\n").filter(Boolean);
  const plan = planFor(changed);
  d.log(`deploying ${short(head)} → ${short(target)} (${changed.length} files): ${JSON.stringify(plan)}`);
  await out("merge", "--ff-only", "--quiet", target);

  const run = { previousTagged: false };
  try {
    await rebuild(d, cfg, plan, run);
  } catch (e) {
    // Nothing restarted yet: go back to the code the running devd was started from.
    await out("reset", "--hard", "--quiet", head);
    await rebuild(d, cfg, { ...plan, image: false }, run).catch(() => {});
    await restoreImage(d, cfg, run);
    const reason = `build failed: ${(e as Error).message}`;
    await d.notify(`devbox update to ${short(target)} failed and was reverted. ${reason}`);
    return { kind: "rolled-back", commit: target, previous: head, reason };
  }

  if (plan.infra.length)
    await d.notify(`devbox ${short(target)}: infra changed (${plan.infra.join(", ")}). Review and re-run infra/setup.sh if needed.`);

  if (!plan.restart) {
    d.writeState({ commit: target, previous: head, at: new Date().toISOString(), restarted: false });
    await d.notify(`devbox updated to ${short(target)} (no devd restart needed).`);
    return { kind: "deployed", commit: target, previous: head, plan };
  }

  await d.notify(`devbox updating to ${short(target)}; devd restarts now and the vault will need unlocking.`);
  if (await restartAndCheck(d, cfg, target)) {
    d.writeState({ commit: target, previous: head, at: new Date().toISOString(), restarted: true });
    await d.notify(`devbox updated to ${short(target)}. Unlock the vault in the dashboard.`, { afterRestart: true });
    return { kind: "deployed", commit: target, previous: head, plan };
  }

  // New devd did not come up healthy on the new commit: put the previous one back.
  await out("reset", "--hard", "--quiet", head);
  await rebuild(d, cfg, { ...plan, image: false }, run).catch(() => {});
  await restoreImage(d, cfg, run);
  const back = await restartAndCheck(d, cfg, head);
  d.writeState({ commit: head, previous: target, at: new Date().toISOString(), restarted: true, rolledBack: true });
  const reason = `devd did not report healthy on ${short(target)}${back ? "" : "; the rollback did not come up healthy either"}`;
  await d.notify(`devbox update rolled back to ${short(head)}: ${reason}.`, { afterRestart: true });
  return { kind: "rolled-back", commit: target, previous: head, reason };
}

async function blocked(d: Deps, reason: string): Promise<Outcome> {
  await d.notify(`devbox auto-update paused: ${reason}`);
  return { kind: "blocked", reason };
}

/** Put back the image this run moved aside — never an older :previous from another run. */
async function restoreImage(d: Deps, cfg: Config, run: { previousTagged: boolean }) {
  if (run.previousTagged) await d.run(["docker", "tag", `${cfg.image.split(":")[0]}:previous`, cfg.image]);
}

async function rebuild(d: Deps, cfg: Config, plan: Plan, run: { previousTagged: boolean }) {
  const step = async (label: string, cmd: string[], timeoutMs: number) => {
    d.log(label);
    const r = await d.run(cmd, { cwd: cfg.repoDir, timeoutMs });
    if (r.code !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  };
  if (plan.install) await step("bun install", ["bun", "install", "--frozen-lockfile"], 10 * 60_000);
  if (plan.dashboard) await step("dashboard build", ["bun", "run", "build:dashboard"], 10 * 60_000);
  if (plan.image) {
    const repo = cfg.image.split(":")[0];
    // Keep the running image as :previous for rollback, and pin the Claude Code version it
    // has (the nightly upkeep owns Claude Code upgrades, not this updater).
    if ((await d.run(["docker", "tag", cfg.image, `${repo}:previous`])).code === 0) run.previousTagged = true;
    const cc = await d.run(["docker", "run", "--rm", "--entrypoint", "claude", cfg.image, "--version"]);
    const ccVersion = cc.stdout.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? "latest";
    const tz = (await d.run(["timedatectl", "show", "-p", "Timezone", "--value"])).stdout.trim() || "UTC";
    await step("image build", ["docker", "build", "--build-arg", `CC_VERSION=${ccVersion}`, "--build-arg", `TZ=${tz}`,
      "-t", cfg.image, `${cfg.repoDir}/image`], 90 * 60_000);
  }
}

async function restartAndCheck(d: Deps, cfg: Config, commit: string): Promise<boolean> {
  await d.run(["systemctl", "restart", "devd"]);
  const deadline = Date.now() + cfg.healthTimeoutMs;
  while (Date.now() < deadline) {
    await d.sleep(3_000);
    const h = await d.health().catch(() => null);
    if (h?.ok && h.commit === commit) return true;
  }
  return false;
}

/* ------------------------------- production wiring ------------------------------- */

async function realRun(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Proc> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 120_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function readEnvFile(path: string): Record<string, string> {
  try {
    const text = require("node:fs").readFileSync(path, "utf8") as string;
    return Object.fromEntries(text.split("\n").map((l) => l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean)
      .map((m) => [m![1], m![2].replace(/^["']|["']$/g, "")]));
  } catch {
    return {};
  }
}

/** All check runs on the commit, via the GitHub API (token from `gh` when the repo is private). */
async function githubCi(repoDir: string, sha: string): Promise<CiState> {
  const remote = (await realRun(["git", "-C", repoDir, "remote", "get-url", "origin"])).stdout.trim();
  const slug = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/)?.[1];
  if (!slug) return "none";
  const token = (await realRun(["gh", "auth", "token"]).catch(() => null))?.stdout.trim();
  const res = await fetch(`https://api.github.com/repos/${slug}/commits/${sha}/check-runs?per_page=100`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) return "none";
  const runs = ((await res.json()) as { check_runs: { status: string; conclusion: string | null }[] }).check_runs;
  if (!runs.length) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return runs.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion ?? "")) ? "success" : "failure";
}

if (import.meta.main) {
  const repoDir = process.env.DEVBOX_REPO_DIR ?? "/opt/vps-dev-infra";
  const devd = process.env.DEVD_URL ?? "http://127.0.0.1:4300";
  const watch = readEnvFile("/etc/devd/watch.env");
  const pushover = async (message: string) => {
    if (!watch.PUSHOVER_TOKEN || !watch.PUSHOVER_USER) return;
    await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: watch.PUSHOVER_TOKEN, user: watch.PUSHOVER_USER, title: "devbox update", message }),
    }).catch(() => {});
  };
  const outcome = await update({
    run: realRun,
    ciState: (sha) => githubCi(repoDir, sha),
    health: async () => {
      const r = await fetch(`${devd}/api/health`, { signal: AbortSignal.timeout(5_000) });
      return r.ok ? ((await r.json()) as { ok: boolean; commit: string | null }) : null;
    },
    notify: async (message, opts) => {
      console.log(`notify: ${message}`);
      if (opts?.afterRestart) return pushover(message);
      const r = await fetch(`${devd}/api/notify`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "devbox update", message }),
      }).catch(() => null);
      if (!r?.ok) await pushover(message);
    },
    log: (line) => console.log(line),
    sleep: (ms) => Bun.sleep(ms),
    writeState: (state) => require("node:fs").writeFileSync("/var/lib/devd/deployed.json", JSON.stringify(state, null, 2) + "\n"),
  }, { repoDir, branch: "main", image: process.env.DEVD_IMAGE ?? "devbox:latest", healthTimeoutMs: 120_000 });
  console.log(JSON.stringify(outcome));
  process.exit(outcome.kind === "failed" ? 1 : 0);
}
