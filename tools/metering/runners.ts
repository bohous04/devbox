import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accessTokenExpired, parseCredentials, type CredentialsBlob } from "../../devd/src/accountTokens.ts";
import { fetchUsage } from "../../devd/src/accountUsage.ts";
import type { TokenUsage } from "../../image/agent-bridge/src/events.ts";
import { FILE_MARK, sessionUsage, validateRun, type RunRecord, type UsageRead } from "./meter.ts";

export interface ExecResult { code: number; stdout: string; stderr: string }
/** Every docker/git/tmux side effect goes through this so tests never touch them. */
export type Exec = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;
export interface Deps {
  exec: Exec; fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>;
}
/** `projectsDir` is the host dir mounted over the container's transcript dir for /workspace. */
export interface RunHandle { name: string; cloneDir: string; projectsDir: string; account: string }
export interface RunOutcome {
  ok: boolean; reason?: string; usage: TokenUsage | null; model: string | null;
  models?: string[]; bridgeReportedUsage?: TokenUsage | null;
}

export const IMAGE = "devbox:latest";
export const POLL_MS = 10_000;
export const QUIET_MS = 30_000;
export const RUN_TIMEOUT_MS = 30 * 60_000;
// The 5h meter is updated server-side with a lag after the last request; reading the
// "after" percentage earlier would undercount the run.
export const SETTLE_MS = 60_000;
// Claude writes the transcript as soon as the prompt is submitted; none after this long means a
// first-run dialog (trust, bypass-permissions, onboarding) is waiting, which would otherwise burn
// the full timeout.
export const FIRST_TRANSCRIPT_MS = 3 * 60_000;
// The usage endpoint answers 429 under concurrent clients (devd/src/accounts.ts:20-23), which
// clears within a minute; a fixed short series avoids losing a run to it without stalling long.
export const USAGE_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];
// A run of tools/metering/task.md takes a few minutes; 10 min is a generous mean. The 30 min
// timeout as the estimate would demand more than the ~8 h an access token lives at 5+ runs.
export const RUN_ESTIMATE_MS = 10 * 60_000;
// cwd is /workspace in every container, so claude keeps its transcripts in projects/-workspace;
// devd mounts its per-session dir at the same spot (devd/src/sessions.ts:459-466, :705).
export const TRANSCRIPT_MOUNT = "/home/dev/.claude/projects/-workspace";

/** Stops the whole comparison instead of being recorded as a failed run: retrying cannot help. */
export class FatalError extends Error {}

const STALE_TOKEN_ADVICE = "Disabled accounts are not polled, so devd does not refresh their token " +
  "(devd/src/accountPoller.ts pollAllDue). Re-enable the account in the pool, wait until the dashboard " +
  "shows a fresh usage reading (the poller has refreshed the token), disable it again and restart.";

export const realExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = opts?.timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs) : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr };
};

async function must(d: Deps, cmd: string[], what: string): Promise<ExecResult> {
  const r = await d.exec(cmd);
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r;
}

export async function assertAccountIdle(f: typeof fetch, devdUrl: string, account: string): Promise<void> {
  const res = await f(`${devdUrl}/api/accounts`);
  if (!res.ok) throw new FatalError(`GET /api/accounts failed: HTTP ${res.status}`);
  // `leases` are the account's active leases (devd/src/accounts.ts buildAccountViews → activeLeases).
  const body = (await res.json()) as { accounts: { id: string; disabled: boolean; leases?: unknown[] }[] };
  const a = body.accounts.find((x) => x.id === account);
  if (!a) throw new FatalError(`account ${account} not found in devd`);
  if (!a.disabled) {
    throw new FatalError(`account ${account} is still active in the pool: other sessions would consume its 5h window and spoil the measurement. Disable it in the pool and run again.`);
  }
  // A session that leased the account before it was disabled keeps using it.
  if (!Array.isArray(a.leases) || a.leases.length > 0) {
    throw new FatalError(`account ${account} is disabled but still leased (${a.leases?.length ?? "unknown"} active lease(s)): a running session would add its usage to one path. Stop those sessions or wait for the leases to end, then run again.`);
  }
}

async function readCredentials(d: Deps, account: string): Promise<CredentialsBlob> {
  // --entrypoint: the image entrypoint would start tmux and sleep instead of running cat.
  const r = await must(d, [
    "docker", "run", "--rm", "-u", "0", "--entrypoint", "cat",
    "-v", `claude-acct-${account}:/a:ro`, IMAGE, "/a/.credentials.json",
  ], "reading credentials");
  const blob = parseCredentials(r.stdout);
  if (!blob) throw new FatalError("credentials of the account are missing or unreadable");
  return blob;
}

/** Fails fast when the access token would expire before the whole comparison ends. */
export async function assertTokenLasts(d: Deps, account: string, runs: number): Promise<void> {
  const blob = await readCredentials(d, account);
  const needed = runs * 2 * RUN_ESTIMATE_MS;
  if (accessTokenExpired(blob, d.now() + needed)) {
    const left = Math.max(0, Math.round((blob.claudeAiOauth.expiresAt - d.now()) / 60_000));
    throw new FatalError(`access token of the account expires in ${left} min, the comparison needs about ${needed / 60_000} min. ${STALE_TOKEN_ADVICE}`);
  }
}

async function readUsageOnce(d: Deps, account: string): Promise<UsageRead> {
  const blob = await readCredentials(d, account);
  if (accessTokenExpired(blob, d.now())) throw new FatalError(`access token of the account is expired. ${STALE_TOKEN_ADVICE}`);
  const u = await fetchUsage(blob.claudeAiOauth.accessToken, d.fetch);
  if (u.fiveHourPct === null) throw new Error("usage endpoint returned no five-hour percentage");
  return { pct: u.fiveHourPct, resetsAt: u.fiveHourResetsAt };
}

export async function readUsage(d: Deps, account: string): Promise<UsageRead> {
  for (let i = 0; ; i++) {
    try { return await readUsageOnce(d, account); }
    catch (e) {
      if (e instanceof FatalError || i >= USAGE_RETRY_BACKOFF_MS.length) throw e;
      console.error(`usage read failed (${(e as Error).message}); retrying in ${USAGE_RETRY_BACKOFF_MS[i] / 1000} s`);
      await d.sleep(USAGE_RETRY_BACKOFF_MS[i]);
    }
  }
}

/** Run before any window is spent: a missing bridge only shows after the first TUI run otherwise. */
export async function assertImageHasBridge(d: Deps): Promise<void> {
  const r = await d.exec(["docker", "run", "--rm", "--entrypoint", "test", IMAGE, "-x", "/usr/local/bin/agent-bridge"]);
  if (r.code !== 0) {
    throw new FatalError(`${IMAGE} has no /usr/local/bin/agent-bridge (exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}); deploy or build the image with the bridge first.`);
  }
}

const configDir = (account: string) => `/home/dev/.claude-accounts/${account}`;
const execIn = (h: RunHandle, ...cmd: string[]) => ["docker", "exec", "-u", "dev", h.name, ...cmd];

async function checkOutput(d: Deps, h: RunHandle): Promise<boolean> {
  return (await d.exec(execIn(h, "test", "-s", "/tmp/out.md"))).code === 0;
}

/** Reads the run's own transcript dir on the host: the main session file(s) and
 *  `<session>/subagents/*.jsonl`. */
export function readTranscripts(dir: string) {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".jsonl")) files.push(join(dir, e.name));
    else if (e.isDirectory()) {
      const sub = join(dir, e.name, "subagents");
      if (!existsSync(sub)) continue;
      for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
    }
  }
  const polled = files.map((f) => `${FILE_MARK}${f}\n${readFileSync(f, "utf8")}`).join("\n");
  return { ...sessionUsage(polled), hasMain: files.some((f) => !f.includes("/subagents/")) };
}

// Both paths are counted from the transcripts claude itself writes (main + subagents), so they
// are measured the same way; the bridge summary's usage is not comparable (it includes side calls).
function fromTranscripts(t: ReturnType<typeof readTranscripts>): Pick<RunOutcome, "usage" | "model" | "models"> {
  return { usage: t.usage, model: t.model, models: t.models };
}

export async function runTui(d: Deps, h: RunHandle, model: string): Promise<RunOutcome> {
  await must(d, execIn(h, "tmux", "new-session", "-d", "-s", "m", "-c", "/workspace",
    `claude --dangerously-skip-permissions --model ${model} "$(cat /task.md)"`), "starting claude in tmux");

  const start = d.now();
  let lines = -1;
  let lastChange = start;
  // Stop claude before the usage settle wait: a live process could make background requests
  // that count against the window but not against the transcript tokens.
  const stop = async () => {
    const r = await d.exec(execIn(h, "tmux", "kill-server"));
    // claude may already have exited (auth error, dialog closed) and taken the tmux server with it.
    if (r.code !== 0 && !/no server running|error connecting to/.test(r.stderr)) {
      throw new Error(`stopping claude failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
  };
  for (;;) {
    await d.sleep(POLL_MS);
    const t = readTranscripts(h.projectsDir);
    if (!t.hasMain && d.now() - start >= FIRST_TRANSCRIPT_MS) {
      await stop();
      return { ok: false, reason: "no-transcript-early", usage: null, model: null };
    }
    if (t.lines !== lines) { lines = t.lines; lastChange = d.now(); }
    if (t.done && d.now() - lastChange >= QUIET_MS) {
      await stop();
      if (!(await checkOutput(d, h))) return { ok: false, reason: "no-output", ...fromTranscripts(t) };
      return { ok: true, ...fromTranscripts(t) };
    }
    if (d.now() - start >= RUN_TIMEOUT_MS) {
      await stop();
      return { ok: false, reason: "timeout", usage: null, model: t.model };
    }
  }
}

export async function runBridge(d: Deps, h: RunHandle, model: string, entrypoint?: string): Promise<RunOutcome> {
  const cmd = execIn(h, "agent-bridge", "once", "--prompt-file", "/task.md", "--cwd", "/workspace",
    "--model", model, "--log", "/tmp/ev.jsonl", ...(entrypoint ? ["--entrypoint", entrypoint] : []));
  const r = await d.exec(cmd, { timeoutMs: RUN_TIMEOUT_MS });
  if (r.code === 124) return { ok: false, reason: "timeout", usage: null, model: null };
  if (r.code !== 0) return { ok: false, reason: `bridge-exit-${r.code}`, usage: null, model: null };
  const last = r.stdout.split("\n").filter((l) => l.trim()).pop() ?? "";
  let s: { status?: string; usage?: TokenUsage | null };
  try { s = JSON.parse(last); } catch { return { ok: false, reason: "bad-summary", usage: null, model: null }; }
  if (s.status !== "completed") return { ok: false, reason: "bridge-not-completed", usage: null, model: null };
  const t = readTranscripts(h.projectsDir);
  const base = { ...fromTranscripts(t), bridgeReportedUsage: s.usage ?? null };
  if (!t.hasMain) return { ok: false, reason: "no-transcript", ...base };
  if (!(await checkOutput(d, h))) return { ok: false, reason: "no-output", ...base };
  return { ok: true, ...base };
}

export interface MeasureOpts {
  account: string; path: "tui" | "bridge"; n: number; model: string; expectedModel: string;
  commit: string; repo: string; entrypoint?: string; taskFile?: string;
}

/** Cleanup must not replace the error of the run itself, so a failed step only warns. */
async function cleanup(d: Deps, cmd: string[]): Promise<void> {
  try {
    const r = await d.exec(cmd);
    if (r.code !== 0) console.error(`cleanup ${cmd.join(" ")} failed (exit ${r.code}): ${r.stderr.trim()}`);
  } catch (e) { console.error(`cleanup ${cmd.join(" ")} failed: ${(e as Error).message}`); }
}

export async function measureRun(d: Deps, o: MeasureOpts): Promise<RunRecord> {
  const name = `metering-${o.path}-${o.n}-${crypto.randomUUID().slice(0, 8)}`;
  const cloneDir = (await must(d, ["mktemp", "-d"], "mktemp")).stdout.trim();
  let projectsDir = "";
  try {
    // A fresh dir per run: the shared claude-home collects every container's transcripts in
    // projects/-workspace, and the profile's `projects` symlink hides them from a plain find.
    projectsDir = (await must(d, ["mktemp", "-d"], "mktemp")).stdout.trim();
    // claude runs as dev (uid 1000), the host side may be another user; the dir is disposable.
    await must(d, ["chmod", "777", projectsDir], "chmod transcript dir");
    const handle: RunHandle = { name, cloneDir, projectsDir, account: o.account };
    await must(d, ["git", "clone", "--quiet", o.repo, cloneDir], "git clone");
    await must(d, ["git", "-C", cloneDir, "checkout", "--quiet", o.commit], "git checkout");
    // The container user differs from the host user; the clone is disposable.
    await must(d, ["chmod", "-R", "a+rwX", cloneDir], "chmod clone");
    const taskFile = o.taskFile ?? new URL("./task.md", import.meta.url).pathname;
    try {
      await must(d, [
        "docker", "run", "-d", "--name", name, "-u", "dev", "--entrypoint", "sleep",
        "-e", `CLAUDE_CONFIG_DIR=${configDir(o.account)}`,
        "-v", `claude-acct-${o.account}:${configDir(o.account)}`,
        "-v", "claude-home:/home/dev/.claude",
        "-v", `${projectsDir}:${TRANSCRIPT_MOUNT}`,
        "-v", `${cloneDir}:/workspace`, "-v", `${taskFile}:/task.md:ro`,
        IMAGE, "infinity",
      ], "docker run");
      const before = await readUsage(d, o.account);
      const outcome = o.path === "tui"
        ? await runTui(d, handle, o.model)
        : await runBridge(d, handle, o.model, o.entrypoint);
      await d.sleep(SETTLE_MS);
      const after = await readUsage(d, o.account);
      return validateRun({ path: o.path, ...outcome, before, after }, o.expectedModel);
    } finally {
      await cleanup(d, ["docker", "rm", "-f", name]);
    }
  } finally {
    await cleanup(d, ["rm", "-rf", cloneDir]);
    if (projectsDir) await cleanup(d, ["rm", "-rf", projectsDir]);
  }
}
