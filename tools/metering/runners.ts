import { accessTokenExpired, parseCredentials } from "../../devd/src/accountTokens.ts";
import { fetchUsage } from "../../devd/src/accountUsage.ts";
import type { TokenUsage } from "../../image/agent-bridge/src/events.ts";
import { transcriptUsage, validateRun, type RunRecord, type UsageRead } from "./meter.ts";

export interface ExecResult { code: number; stdout: string; stderr: string }
/** Every docker/git/tmux side effect goes through this so tests never touch them. */
export type Exec = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;
export interface Deps {
  exec: Exec; fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>;
}
export interface RunHandle { name: string; cloneDir: string; account: string }
export interface RunOutcome { ok: boolean; reason?: string; usage: TokenUsage | null; model: string | null }

export const IMAGE = "devbox:latest";
export const POLL_MS = 10_000;
export const QUIET_MS = 30_000;
export const RUN_TIMEOUT_MS = 30 * 60_000;
// The 5h meter is updated server-side with a lag after the last request; reading the
// "after" percentage earlier would undercount the run.
export const SETTLE_MS = 60_000;
const MARKER = "/tmp/metering-start";

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

export async function assertAccountDisabled(f: typeof fetch, devdUrl: string, account: string): Promise<void> {
  const res = await f(`${devdUrl}/api/accounts`);
  if (!res.ok) throw new Error(`GET /api/accounts failed: HTTP ${res.status}`);
  const body = (await res.json()) as { accounts: { id: string; disabled: boolean }[] };
  const a = body.accounts.find((x) => x.id === account);
  if (!a) throw new Error(`account ${account} not found in devd`);
  if (!a.disabled) {
    throw new Error(`account ${account} is still active in the pool: other sessions would consume its 5h window and spoil the measurement. Disable it in the pool and run again.`);
  }
}

export async function readUsage(d: Deps, account: string): Promise<UsageRead> {
  // --entrypoint: the image entrypoint would start tmux and sleep instead of running cat.
  const r = await must(d, [
    "docker", "run", "--rm", "-u", "0", "--entrypoint", "cat",
    "-v", `claude-acct-${account}:/a:ro`, IMAGE, "/a/.credentials.json",
  ], "reading credentials");
  const blob = parseCredentials(r.stdout);
  if (!blob) throw new Error("credentials of the account are missing or unreadable");
  if (accessTokenExpired(blob, d.now())) {
    throw new Error("access token of the account is expired; devd's poller normally refreshes it. Let the poller run (or use the account once) and retry.");
  }
  const u = await fetchUsage(blob.claudeAiOauth.accessToken, d.fetch);
  if (u.fiveHourPct === null) throw new Error("usage endpoint returned no five-hour percentage");
  return { pct: u.fiveHourPct, resetsAt: u.fiveHourResetsAt };
}

const configDir = (account: string) => `/home/dev/.claude-accounts/${account}`;
const execIn = (h: RunHandle, ...cmd: string[]) => ["docker", "exec", "-u", "dev", h.name, ...cmd];

async function checkOutput(d: Deps, h: RunHandle): Promise<boolean> {
  return (await d.exec(execIn(h, "test", "-s", "/tmp/out.md"))).code === 0;
}

export async function runTui(d: Deps, h: RunHandle, model: string): Promise<RunOutcome> {
  await must(d, execIn(h, "touch", MARKER), "marker");
  await must(d, execIn(h, "tmux", "new-session", "-d", "-s", "m", "-c", "/workspace",
    `claude --dangerously-skip-permissions --model ${model} "$(cat /task.md)"`), "starting claude in tmux");

  const start = d.now();
  let lines = -1;
  let lastChange = start;
  // The volume keeps transcripts of earlier runs; only files newer than the marker are ours.
  const poll = execIn(h, "sh", "-c",
    `find "$CLAUDE_CONFIG_DIR/projects" -maxdepth 2 -name '*.jsonl' -newer ${MARKER} -print0 | xargs -0 -r cat`);
  for (;;) {
    await d.sleep(POLL_MS);
    const r = await d.exec(poll);
    if (r.code !== 0) throw new Error(`transcript poll failed (exit ${r.code}): ${r.stderr.trim()}`);
    const n = r.stdout.split("\n").filter((l) => l.trim()).length;
    if (n !== lines) { lines = n; lastChange = d.now(); }
    const t = transcriptUsage(r.stdout);
    if (t.done && d.now() - lastChange >= QUIET_MS) {
      if (!(await checkOutput(d, h))) return { ok: false, reason: "no-output", usage: t.usage, model: t.model };
      return { ok: true, usage: t.usage, model: t.model };
    }
    if (d.now() - start >= RUN_TIMEOUT_MS) return { ok: false, reason: "timeout", usage: null, model: t.model };
  }
}

export async function runBridge(d: Deps, h: RunHandle, model: string, entrypoint?: string): Promise<RunOutcome> {
  const cmd = execIn(h, "agent-bridge", "once", "--prompt-file", "/task.md", "--cwd", "/workspace",
    "--model", model, "--log", "/tmp/ev.jsonl", ...(entrypoint ? ["--entrypoint", entrypoint] : []));
  const r = await d.exec(cmd, { timeoutMs: RUN_TIMEOUT_MS });
  if (r.code === 124) return { ok: false, reason: "timeout", usage: null, model: null };
  if (r.code !== 0) return { ok: false, reason: `bridge-exit-${r.code}`, usage: null, model: null };
  const last = r.stdout.split("\n").filter((l) => l.trim()).pop() ?? "";
  let s: { status?: string; model?: string | null; usage?: TokenUsage | null };
  try { s = JSON.parse(last); } catch { return { ok: false, reason: "bad-summary", usage: null, model: null }; }
  if (s.status !== "completed") return { ok: false, reason: "bridge-not-completed", usage: null, model: null };
  if (!(await checkOutput(d, h))) return { ok: false, reason: "no-output", usage: s.usage ?? null, model: s.model ?? null };
  return { ok: true, usage: s.usage ?? null, model: s.model ?? null };
}

export interface MeasureOpts {
  account: string; path: "tui" | "bridge"; n: number; model: string; expectedModel: string;
  commit: string; repo: string; entrypoint?: string; taskFile?: string;
}

export async function measureRun(d: Deps, o: MeasureOpts): Promise<RunRecord> {
  const name = `metering-${o.path}-${o.n}-${crypto.randomUUID().slice(0, 8)}`;
  const cloneDir = (await must(d, ["mktemp", "-d"], "mktemp")).stdout.trim();
  const handle: RunHandle = { name, cloneDir, account: o.account };
  try {
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
      await must(d, ["docker", "rm", "-f", name], "docker rm");
    }
  } finally {
    await must(d, ["rm", "-rf", cloneDir], "removing clone");
  }
}
