import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAccountIdle, assertImageHasBridge, assertTokenLasts, FatalError, FIRST_TRANSCRIPT_MS,
  readTranscripts, readUsage, runBridge, runTui, measureRun, TRANSCRIPT_MOUNT, USAGE_RETRY_BACKOFF_MS,
  type Deps, type Exec, type ExecResult, type RunHandle,
} from "./runners.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const ACCT = "acct-test";

let dir: string;
let handle: RunHandle;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metering-test-"));
  handle = { name: "metering-tui-1-abc", cloneDir: "/clone", projectsDir: dir, account: ACCT };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeMain = (body: string) => writeFileSync(join(dir, "s.jsonl"), body);
const writeSub = (body: string) => {
  mkdirSync(join(dir, "s", "subagents"), { recursive: true });
  writeFileSync(join(dir, "s", "subagents", "agent-1.jsonl"), body);
};

/** `onSleep` runs after each sleep, i.e. between polls, so a test can let claude write. */
function clock(onSleep: (i: number) => void = () => {}) {
  let t = 1_000_000;
  let i = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleeps, sleep: async (ms: number) => { t += ms; sleeps.push(ms); onSleep(i++); } };
}
function deps(exec: Exec, f: typeof fetch = (async () => { throw new Error("no network"); }) as any, c = clock()): Deps & { sleeps: number[] } {
  return { exec, fetch: f, ...c };
}
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });
const blob = (expiresAt: number) => JSON.stringify({
  claudeAiOauth: { accessToken: "tok", refreshToken: "ref", expiresAt },
});

describe("assertAccountIdle", () => {
  const accountsFetch = (disabled: boolean, leases: unknown[] = []) => (async (url: string) => {
    expect(url).toBe("http://devd.test/api/accounts");
    return json({ accounts: [{ id: ACCT, disabled, leases }, { id: "other", disabled: false, leases: [] }] });
  }) as any;

  test("refuses an account that is still in the pool", async () => {
    await expect(assertAccountIdle(accountsFetch(false), "http://devd.test", ACCT))
      .rejects.toThrow(/disable it in the pool/i);
  });
  test("accepts a disabled account without leases", async () => {
    await assertAccountIdle(accountsFetch(true), "http://devd.test", ACCT);
  });
  test("refuses a disabled account that is still leased", async () => {
    const lease = { client: "devbox", sessionId: "s1", label: null, createdAt: 1 };
    const p = assertAccountIdle(accountsFetch(true, [lease]), "http://devd.test", ACCT);
    await expect(p).rejects.toThrow(/still leased \(1 active lease/);
    await expect(p).rejects.toBeInstanceOf(FatalError);
  });
  test("fails on an unknown account", async () => {
    await expect(assertAccountIdle(accountsFetch(true), "http://devd.test", "nope"))
      .rejects.toThrow(/not found/);
  });
});

describe("assertTokenLasts", () => {
  test("passes when the token outlives runs x 2 x 10 min", async () => {
    const c = clock();
    // 5 runs → 100 min needed, plus the 5 min skew
    const d = deps(async () => ok(blob(c.now() + 106 * 60_000)), undefined, c);
    await assertTokenLasts(d, ACCT, 5);
  });
  test("fails fast with the re-enable instruction when it expires sooner", async () => {
    const c = clock();
    const d = deps(async () => ok(blob(c.now() + 90 * 60_000)), undefined, c);
    const p = assertTokenLasts(d, ACCT, 5);
    await expect(p).rejects.toThrow(/expires in 90 min, the comparison needs about 100 min/);
    await expect(p).rejects.toThrow(/Re-enable the account in the pool.*disable it again and restart/);
    await expect(p).rejects.toBeInstanceOf(FatalError);
  });
});

describe("readUsage", () => {
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
  test("an expired token is fatal, not retried, and says how to get a fresh one", async () => {
    const d = deps(async () => ok(blob(1)), usageFetch);
    const p = readUsage(d, ACCT);
    await expect(p).rejects.toThrow(/Re-enable the account in the pool/);
    await expect(p).rejects.toBeInstanceOf(FatalError);
    expect(d.sleeps).toEqual([]);
  });
  test("unreadable credentials fail without retries", async () => {
    const d = deps(async () => ok("garbage"), usageFetch);
    await expect(readUsage(d, ACCT)).rejects.toThrow(/credentials/);
    expect(d.sleeps).toEqual([]);
  });
  test("a transient 429 is retried with backoff", async () => {
    let calls = 0;
    const f = (async (...a: any[]) => (++calls <= 2 ? new Response("", { status: 429 }) : usageFetch(...a))) as any;
    const d = deps(async () => ok(blob(Date.now() + 3_600_000)), f);
    expect((await readUsage(d, ACCT)).pct).toBe(42);
    expect(d.sleeps).toEqual([5_000, 15_000]);
  });
  test("a docker hiccup reading the credentials is retried too", async () => {
    let calls = 0;
    const d = deps(async () => (++calls === 1 ? { code: 125, stdout: "", stderr: "daemon busy" } : ok(blob(Date.now() + 3_600_000))), usageFetch);
    expect((await readUsage(d, ACCT)).pct).toBe(42);
    expect(d.sleeps).toEqual([5_000]);
  });
  test("gives up after the last backoff", async () => {
    const f = (async () => new Response("", { status: 503 })) as any;
    const d = deps(async () => ok(blob(Date.now() + 3_600_000)), f);
    await expect(readUsage(d, ACCT)).rejects.toThrow(/HTTP 503/);
    expect(d.sleeps).toEqual(USAGE_RETRY_BACKOFF_MS);
    expect(USAGE_RETRY_BACKOFF_MS).toEqual([5_000, 15_000, 45_000]);
  });
});

describe("assertImageHasBridge", () => {
  test("checks the image for the bridge binary without spending quota", async () => {
    const cmds: string[] = [];
    await assertImageHasBridge(deps(async (c) => { cmds.push(c.join(" ")); return ok(); }));
    expect(cmds).toEqual(["docker run --rm --entrypoint test devbox:latest -x /usr/local/bin/agent-bridge"]);
  });
  test("fails fast when the image has no bridge", async () => {
    const p = assertImageHasBridge(deps(async () => ({ code: 1, stdout: "", stderr: "" })));
    await expect(p).rejects.toThrow(/no \/usr\/local\/bin\/agent-bridge/);
    await expect(p).rejects.toBeInstanceOf(FatalError);
  });
});

describe("readTranscripts", () => {
  test("reads the main session file and its subagents from the host dir", () => {
    writeMain(fx("transcript-end-turn.jsonl"));
    writeSub(fx("transcript-subagent.jsonl"));
    mkdirSync(join(dir, "other")); // a session dir without subagents
    const t = readTranscripts(dir);
    expect(t.hasMain).toBe(true);
    expect(t.done).toBe(true);
    expect(t.usage).toEqual({ input: 118, output: 112, cacheCreation: 450, cacheRead: 3450 });
  });
  test("an empty dir has no main transcript", () => {
    expect(readTranscripts(dir)).toMatchObject({ hasMain: false, lines: 0, done: false });
  });
});

describe("runTui", () => {
  /** Claude writes polls[i] after the i-th sleep, before the i-th poll. */
  const writer = (polls: string[]) => clock((i) => writeMain(polls[Math.min(i, polls.length - 1)]));
  const tuiExec = (seen: string[][] = []): Exec => async (c) => { seen.push(c); return ok(); };

  test("launches claude in tmux and finishes once done and quiet for 30 s", async () => {
    const seen: string[][] = [];
    const d = deps(tuiExec(seen), undefined, writer([fx("transcript-in-progress.jsonl"), fx("transcript-end-turn.jsonl")]));
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
    // claude is stopped before runTui returns, i.e. before the settle wait
    expect(seen.some((c) => c.includes("kill-server"))).toBe(true);
    // no marker and no find in the container any more
    expect(seen.some((c) => c.join(" ").includes("find") || c.includes("touch"))).toBe(false);
  });
  test("TUI usage includes subagent transcripts", async () => {
    writeSub(fx("transcript-subagent.jsonl"));
    const d = deps(tuiExec(), undefined, writer([fx("transcript-end-turn.jsonl")]));
    const r = await runTui(d, handle, "claude-opus-5-5");
    expect(r.usage).toEqual({ input: 118, output: 112, cacheCreation: 450, cacheRead: 3450 });
  });
  test("a transcript that keeps growing is not done yet", async () => {
    const done = fx("transcript-end-turn.jsonl");
    const u = '{"type":"user"}';
    const d = deps(tuiExec(), undefined, writer([done, `${done}\n${u}`, `${done}\n${u}\n${u}`]));
    const t0 = d.now();
    await runTui(d, handle, "claude-opus-5-5");
    expect(d.now() - t0).toBeGreaterThanOrEqual(60_000);
  });
  test("times out after 30 minutes", async () => {
    const seen: string[][] = [];
    const d = deps(tuiExec(seen), undefined, writer([fx("transcript-in-progress.jsonl")]));
    const t0 = d.now();
    const r = await runTui(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
    expect(seen.some((c) => c.includes("kill-server"))).toBe(true);
    expect(d.now() - t0).toBeGreaterThanOrEqual(30 * 60_000);
  });
  test("no main transcript within 3 minutes stops the run early", async () => {
    const seen: string[][] = [];
    // a subagent file alone does not count as the session having started
    writeSub(fx("transcript-subagent.jsonl"));
    const d = deps(tuiExec(seen));
    const t0 = d.now();
    const r = await runTui(d, handle, "claude-opus-5-5");
    expect(r).toMatchObject({ ok: false, reason: "no-transcript-early", usage: null });
    expect(d.now() - t0).toBe(FIRST_TRANSCRIPT_MS);
    expect(seen.some((c) => c.includes("kill-server"))).toBe(true);
  });
  test("a tmux server that is already gone is not an error", async () => {
    const exec: Exec = async (c) => c.includes("kill-server")
      ? { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" } : ok();
    const r = await runTui(deps(exec, undefined, writer([fx("transcript-end-turn.jsonl")])), handle, "claude-opus-5-5");
    expect(r.ok).toBe(true);
  });
  test("any other tmux failure still throws", async () => {
    const exec: Exec = async (c) => c.includes("kill-server") ? { code: 1, stdout: "", stderr: "permission denied" } : ok();
    await expect(runTui(deps(exec, undefined, writer([fx("transcript-end-turn.jsonl")])), handle, "claude-opus-5-5"))
      .rejects.toThrow(/stopping claude failed/);
  });
  test("a missing /tmp/out.md fails the run", async () => {
    const exec: Exec = async (c) => c.join(" ").includes("/tmp/out.md") ? { code: 1, stdout: "", stderr: "" } : ok();
    const r = await runTui(deps(exec, undefined, writer([fx("transcript-end-turn.jsonl")])), handle, "claude-opus-5-5");
    expect(r.reason).toBe("no-output");
  });
});

describe("runBridge", () => {
  const summary = { status: "completed", nativeThreadId: "t", model: "claude-opus-5-5",
    usage: { input: 5, output: 6, cacheCreation: 7, cacheRead: 8 } };
  const bridgeExec = (seen: string[][] = []): Exec => async (c) => {
    seen.push(c);
    if (c.includes("agent-bridge")) return ok(`noise\n${JSON.stringify(summary)}\n`);
    return ok();
  };
  const writeBoth = () => { writeMain(fx("transcript-end-turn.jsonl")); writeSub(fx("transcript-subagent.jsonl")); };

  test("runs agent-bridge once; usage and model come from the transcripts, summary kept as info", async () => {
    writeBoth();
    const seen: string[][] = [];
    const r = await runBridge(deps(bridgeExec(seen)), handle, "claude-opus-5-5", "sdk-cli");
    expect(r).toMatchObject({
      ok: true, model: "claude-opus-5-5", models: ["claude-opus-5-5"],
      usage: { input: 118, output: 112, cacheCreation: 450, cacheRead: 3450 },
      bridgeReportedUsage: summary.usage,
    });
    const cmd = seen.find((c) => c.includes("agent-bridge"))!.join(" ");
    expect(cmd).toContain(
      "agent-bridge once --prompt-file /task.md --cwd /workspace --model claude-opus-5-5 --log /tmp/ev.jsonl --entrypoint sdk-cli");
    expect(seen.some((c) => c.includes("touch"))).toBe(false);
  });
  test("omits --entrypoint when not given", async () => {
    writeBoth();
    const seen: string[][] = [];
    await runBridge(deps(bridgeExec(seen)), handle, "claude-opus-5-5");
    expect(seen.find((c) => c.includes("agent-bridge"))!.join(" ")).not.toContain("--entrypoint");
  });
  test("a failed turn is a failed run", async () => {
    const d = deps(async (c) => c.includes("agent-bridge")
      ? { code: 1, stdout: JSON.stringify({ ...summary, status: "failed", usage: null }), stderr: "" } : ok());
    const r = await runBridge(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bridge-exit-1");
  });
  test("no transcript written is a failed run", async () => {
    const r = await runBridge(deps(bridgeExec()), handle, "claude-opus-5-5");
    expect(r.reason).toBe("no-transcript");
  });
  test("a side-call model in the main transcript is reported for the model check", async () => {
    writeMain(fx("transcript-end-turn.jsonl").replace('"id":"m2","model":"claude-opus-5-5"', '"id":"m2","model":"claude-haiku-x"'));
    const r = await runBridge(deps(bridgeExec()), handle, "claude-opus-5-5");
    expect(r.models).toEqual(["claude-opus-5-5", "claude-haiku-x"]);
  });
  test("an unparseable summary is a failed run", async () => {
    const d = deps(async (c) => c.includes("agent-bridge") ? ok("not json") : ok());
    const r = await runBridge(d, handle, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-summary");
  });
});

describe("measureRun", () => {
  const usage = (async () => json({ five_hour: { utilization: 1, resets_at: "2030-01-01T00:00:00Z" } })) as any;
  const opts = { account: ACCT, path: "bridge" as const, n: 1, model: "m", commit: "abc", repo: "/repo", expectedModel: "m" };
  function exec(cmds: string[], over: (j: string) => ExecResult | undefined = () => undefined): Exec {
    let tmp = 0;
    return async (c) => {
      const j = c.join(" ");
      cmds.push(j);
      const o = over(j);
      if (o) return o;
      if (j.startsWith("mktemp")) return ok(tmp++ === 0 ? "/clone\n" : "/transcripts\n");
      if (j.includes("/a:ro")) return ok(blob(Date.now() + 3_600_000));
      if (j.includes("agent-bridge")) throw new Error("docker died");
      return ok();
    };
  }

  test("mounts a fresh, dev-writable transcript dir over projects/-workspace", async () => {
    const cmds: string[] = [];
    await expect(measureRun(deps(exec(cmds), usage), opts)).rejects.toThrow("docker died");
    expect(cmds).toContain("chmod 777 /transcripts");
    const run = cmds.find((c) => c.startsWith("docker run -d"))!;
    expect(run).toContain(`-v /transcripts:${TRANSCRIPT_MOUNT}`);
    expect(TRANSCRIPT_MOUNT).toBe("/home/dev/.claude/projects/-workspace");
  });
  test("removes the container, clone and transcript dir even when the run throws", async () => {
    const cmds: string[] = [];
    await expect(measureRun(deps(exec(cmds), usage), opts)).rejects.toThrow("docker died");
    expect(cmds.some((c) => c.startsWith("docker rm -f metering-bridge-1-"))).toBe(true);
    expect(cmds).toContain("rm -rf /clone");
    expect(cmds).toContain("rm -rf /transcripts");
  });
  test("a failing cleanup does not replace the run's own error", async () => {
    const cmds: string[] = [];
    const e = exec(cmds, (j) => j.startsWith("docker rm") || j.startsWith("rm -rf") ? { code: 1, stdout: "", stderr: "busy" } : undefined);
    await expect(measureRun(deps(e, usage), opts)).rejects.toThrow("docker died");
    expect(cmds).toContain("rm -rf /transcripts");
  });
  test("tokens mode never reads the usage endpoint", async () => {
    const cmds: string[] = [];
    let fetched = 0;
    const counting = (async () => { fetched++; return json({ five_hour: null }); }) as any;
    await expect(measureRun(deps(exec(cmds), counting), { ...opts, tokensOnly: true })).rejects.toThrow("docker died");
    expect(fetched).toBe(0);
    expect(cmds.some((c) => c.includes("/a:ro"))).toBe(false);
  });
  test("tokens mode returns a valid run without usage reads or the settle wait", async () => {
    writeFileSync(join(dir, "s.jsonl"), fx("transcript-end-turn.jsonl"));
    let fetched = 0;
    const counting = (async () => { fetched++; return json({ five_hour: null }); }) as any;
    const summary = { status: "completed", nativeThreadId: "t", model: "claude-opus-5-5",
      usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } };
    let tmp = 0;
    const e: Exec = async (c) => {
      const j = c.join(" ");
      if (j.startsWith("mktemp")) return ok(tmp++ === 0 ? "/clone\n" : `${dir}\n`);
      if (j.includes("agent-bridge")) return ok(JSON.stringify(summary));
      if (j.startsWith("rm -rf")) return ok(); // keep the test dir for afterEach
      return ok();
    };
    const d = deps(e, counting);
    const r = await measureRun(d, { ...opts, model: "claude-opus-5-5", expectedModel: "claude-opus-5-5", tokensOnly: true });
    expect(r).toMatchObject({ ok: true, before: null, after: null, model: "claude-opus-5-5" });
    expect(fetched).toBe(0);
    expect(d.sleeps).toEqual([]);
  });
});
