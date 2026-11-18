import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertAccountDisabled, readUsage, runBridge, runTui, measureRun,
  type Deps, type Exec, type ExecResult, type RunHandle,
} from "./runners.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const ACCT = "acct-test";
const handle: RunHandle = { name: "metering-tui-1-abc", cloneDir: "/clone", account: ACCT };

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
function deps(exec: Exec, f: typeof fetch = (async () => { throw new Error("no network"); }) as any): Deps {
  return { exec, fetch: f, ...clock() };
}
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

describe("assertAccountDisabled", () => {
  const accountsFetch = (disabled: boolean) => (async (url: string) => {
    expect(url).toBe("http://devd.test/api/accounts");
    return json({ accounts: [{ id: ACCT, disabled }, { id: "other", disabled: false }] });
  }) as any;

  test("refuses an account that is still in the pool", async () => {
    await expect(assertAccountDisabled(accountsFetch(false), "http://devd.test", ACCT))
      .rejects.toThrow(/disable it in the pool/i);
  });
  test("accepts a disabled account", async () => {
    await assertAccountDisabled(accountsFetch(true), "http://devd.test", ACCT);
  });
  test("fails on an unknown account", async () => {
    await expect(assertAccountDisabled(accountsFetch(true), "http://devd.test", "nope"))
      .rejects.toThrow(/not found/);
  });
});

describe("readUsage", () => {
  const blob = (expiresAt: number) => JSON.stringify({
    claudeAiOauth: { accessToken: "tok", refreshToken: "ref", expiresAt },
  });
  const usageFetch = (async (_u: string, init: any) => {
    expect(init.headers.Authorization).toBe("Bearer tok");
    return json({ five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" } });
  }) as any;

  test("reads the credentials volume and returns pct and reset", async () => {
    const cmds: string[][] = [];
    const d = deps(async (c) => { cmds.push(c); return ok(blob(Date.now() + 3_600_000)); }, usageFetch);
    const r = await readUsage(d, ACCT);
    expect(r.pct).toBe(42);
    expect(r.resetsAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(cmds[0].join(" ")).toContain(`claude-acct-${ACCT}:/a:ro`);
  });
  test("an expired token fails and points at the poller, no refresh", async () => {
    const d = deps(async () => ok(blob(1)), usageFetch);
    await expect(readUsage(d, ACCT)).rejects.toThrow(/poller/);
  });
  test("unreadable credentials fail", async () => {
    const d = deps(async () => ok("garbage"), usageFetch);
    await expect(readUsage(d, ACCT)).rejects.toThrow(/credentials/);
  });
});

describe("runTui", () => {
  function tuiExec(polls: string[], seen: string[][] = []): Exec {
    let i = 0;
    return async (c) => {
      seen.push(c);
      const joined = c.join(" ");
      if (joined.includes("projects")) return ok(polls[Math.min(i++, polls.length - 1)]);
      return ok();
    };
  }

  test("launches claude in tmux and finishes once done and quiet for 30 s", async () => {
    const seen: string[][] = [];
    const inProgress = fx("transcript-in-progress.jsonl");
    const done = fx("transcript-end-turn.jsonl");
    const d = deps(tuiExec([inProgress, done], seen));
    const t0 = d.now();
    const r = await runTui(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(true);
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.usage).toEqual({ input: 110, output: 100, cacheCreation: 400, cacheRead: 2400 });
    // second poll (t+20s) sees the finished transcript, then 30 s of silence
    expect(d.now() - t0).toBe(50_000);
    const launch = seen.find((c) => c.includes("tmux"))!;
    expect(launch.join(" ")).toContain(
      `claude --dangerously-skip-permissions --model claude-opus-5-5 "$(cat /task.md)"`);
    expect(launch.join(" ")).not.toContain("remote-control");
  });
  test("a transcript that keeps growing is not done yet", async () => {
    const done = fx("transcript-end-turn.jsonl");
    // done-looking but one more line arrives every poll for a while
    const u = '{"type":"user"}';
    const grow = [done, `${done}\n${u}`, `${done}\n${u}\n${u}`];
    const d = deps(tuiExec(grow));
    const t0 = d.now();
    await runTui(d, handle, "claude-opus-5-5");
    expect(d.now() - t0).toBeGreaterThanOrEqual(60_000);
  });
  test("times out after 30 minutes", async () => {
    const d = deps(tuiExec([fx("transcript-in-progress.jsonl")]));
    const t0 = d.now();
    const r = await runTui(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
    expect(d.now() - t0).toBeGreaterThanOrEqual(30 * 60_000);
  });
  test("a missing /tmp/out.md fails the run", async () => {
    const base = tuiExec([fx("transcript-end-turn.jsonl")]);
    const d = deps(async (c) => c.join(" ").includes("/tmp/out.md") ? { code: 1, stdout: "", stderr: "" } : base(c));
    const r = await runTui(d, handle, "claude-opus-5-5");
    expect(r.reason).toBe("no-output");
  });
});

describe("runBridge", () => {
  const summary = { status: "completed", nativeThreadId: "t", model: "claude-opus-5-5",
    usage: { input: 5, output: 6, cacheCreation: 7, cacheRead: 8 } };

  test("runs agent-bridge once and takes usage and model from the summary line", async () => {
    const seen: string[][] = [];
    const d = deps(async (c) => {
      seen.push(c);
      return c.includes("agent-bridge") ? ok(`noise\n${JSON.stringify(summary)}\n`) : ok();
    });
    const r = await runBridge(d, handle, "claude-opus-5-5", "sdk-cli");
    expect(r).toMatchObject({ ok: true, model: "claude-opus-5-5", usage: summary.usage });
    const cmd = seen.find((c) => c.includes("agent-bridge"))!.join(" ");
    expect(cmd).toContain(
      "agent-bridge once --prompt-file /task.md --cwd /workspace --model claude-opus-5-5 --log /tmp/ev.jsonl --entrypoint sdk-cli");
  });
  test("omits --entrypoint when not given", async () => {
    const seen: string[][] = [];
    const d = deps(async (c) => { seen.push(c); return c.includes("agent-bridge") ? ok(JSON.stringify(summary)) : ok(); });
    await runBridge(d, handle, "claude-opus-5-5");
    expect(seen.find((c) => c.includes("agent-bridge"))!.join(" ")).not.toContain("--entrypoint");
  });
  test("a failed turn is a failed run", async () => {
    const d = deps(async (c) => c.includes("agent-bridge")
      ? { code: 1, stdout: JSON.stringify({ ...summary, status: "failed", usage: null }), stderr: "" } : ok());
    const r = await runBridge(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bridge-exit-1");
  });
  test("an unparseable summary is a failed run", async () => {
    const d = deps(async (c) => c.includes("agent-bridge") ? ok("not json") : ok());
    const r = await runBridge(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-summary");
  });
});

describe("measureRun", () => {
  test("removes the container and clone even when the run throws", async () => {
    const cmds: string[] = [];
    const exec: Exec = async (c) => {
      const j = c.join(" ");
      cmds.push(j);
      if (j.startsWith("mktemp")) return ok("/clone\n");
      if (j.includes("/a:ro")) return ok(JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }));
      if (j.includes("agent-bridge")) throw new Error("docker died");
      return ok();
    };
    const f = (async () => json({ five_hour: { utilization: 1, resets_at: "2030-01-01T00:00:00Z" } })) as any;
    await expect(measureRun(deps(exec, f), {
      account: ACCT, path: "bridge", n: 1, model: "m", commit: "abc", repo: "/repo", expectedModel: "m",
    })).rejects.toThrow("docker died");
    expect(cmds.some((c) => c.startsWith("docker rm -f metering-bridge-1-"))).toBe(true);
    expect(cmds).toContain("rm -rf /clone");
  });
});
