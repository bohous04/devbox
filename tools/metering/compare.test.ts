import { describe, expect, test } from "bun:test";
import { parseCompareArgs, runAll, schedule } from "./compare.ts";
import type { RunRecord } from "./meter.ts";
import { FatalError } from "./runners.ts";

describe("parseCompareArgs", () => {
  test("requires account and model", () => {
    expect(() => parseCompareArgs(["--model", "claude-opus-5-5"])).toThrow(/--account/);
    expect(() => parseCompareArgs(["--account", "a"])).toThrow(/--model/);
  });
  test("defaults runs to 5 and out to metering-report.json", () => {
    const a = parseCompareArgs(["--account", "a", "--model", "claude-opus-5-5"]);
    expect(a.runs).toBe(5);
    expect(a.out).toBe("metering-report.json");
  });
  test("rejects values that would break shell quoting", () => {
    expect(() => parseCompareArgs(["--account", "a", "--model", "m; rm -rf /"])).toThrow(/--model/);
  });
  test("rejects model aliases; transcripts record the full id", () => {
    for (const alias of ["opus", "sonnet", "haiku", "default"]) {
      expect(() => parseCompareArgs(["--account", "a", "--model", alias])).toThrow(/full model id/);
    }
    expect(parseCompareArgs(["--account", "a", "--model", "claude-opus-5-5"]).model).toBe("claude-opus-5-5");
  });
  test("rejects a bad run count and unknown flags", () => {
    expect(() => parseCompareArgs(["--account", "a", "--model", "claude-opus-5-5", "--runs", "0"])).toThrow(/--runs/);
    expect(() => parseCompareArgs(["--account", "a", "--model", "claude-opus-5-5", "--bogus", "1"])).toThrow(/unknown/);
  });
});

describe("schedule", () => {
  test("alternates the order per pair (ABBA) so neither path is always second", () => {
    expect(schedule(4).map((s) => `${s.path}${s.n}`)).toEqual([
      "tui1", "bridge1", "bridge2", "tui2", "tui3", "bridge3", "bridge4", "tui4",
    ]);
  });
});

describe("runAll", () => {
  const rec = (path: "tui" | "bridge", ok = true, reason?: string): RunRecord => ({
    path, ok, reason, before: { pct: 1, resetsAt: 9 }, after: { pct: 2, resetsAt: 9 },
    usage: { input: 1, output: 0, cacheCreation: 0, cacheRead: 0 }, model: "m",
  });
  /** `fail` maps an attempt index (0-based, across both paths) to how that attempt goes wrong. */
  function io(fail: Record<number, RunRecord["reason"] | Error> = {}) {
    const calls: string[] = [];
    const recorded: RunRecord[] = [];
    let idleChecks = 0;
    return {
      calls, recorded, idleChecks: () => idleChecks,
      checkIdle: async () => { idleChecks++; },
      measure: async (path: "tui" | "bridge", n: number) => {
        const i = calls.length;
        calls.push(`${path}${n}`);
        const f = fail[i];
        if (f instanceof Error) throw f;
        return f ? rec(path, false, f) : rec(path);
      },
      onRecord: (r: RunRecord) => { recorded.push(r); },
    };
  }

  test("runs the ABBA schedule and checks the account before every run", async () => {
    const x = io();
    const out = await runAll(2, x);
    expect(x.calls).toEqual(["tui1", "bridge1", "bridge2", "tui2"]);
    expect(x.idleChecks()).toBe(4);
    expect(out.map((r) => r.n)).toEqual([1, 1, 2, 2]);
    expect(x.recorded).toEqual(out);
  });
  test("repeats runs that failed for reasons unrelated to the path's cost", async () => {
    for (const reason of ["window-reset", "timeout", "model-mismatch", "no-transcript", "no-transcript-early"]) {
      const x = io({ 0: reason });
      const out = await runAll(1, x);
      expect(x.calls).toEqual(["tui1", "tui1", "bridge1"]);
      expect(out.map((r) => r.ok)).toEqual([false, true, true]);
    }
  });
  test("does not repeat a failure that is the path's own result", async () => {
    const x = io({ 1: "no-output" });
    const out = await runAll(1, x);
    expect(x.calls).toEqual(["tui1", "bridge1"]);
    expect(out[1]).toMatchObject({ ok: false, reason: "no-output" });
  });
  test("an exception in one run is recorded as run-error and repeated, not fatal", async () => {
    const x = io({ 1: new Error("docker: Error response from daemon") });
    const out = await runAll(1, x);
    expect(x.calls).toEqual(["tui1", "bridge1", "bridge1"]);
    expect(out[1]).toMatchObject({
      path: "bridge", n: 1, ok: false, reason: "run-error: docker: Error response from daemon",
      before: null, after: null, usage: null,
    });
    expect(out[2].ok).toBe(true);
  });
  test("stops with a clear message after 2 x runs attempts on one path", async () => {
    const all: Record<number, string> = {};
    for (let i = 0; i < 20; i++) all[i] = "timeout";
    const x = io(all);
    const p = runAll(2, x);
    await expect(p).rejects.toThrow(/tui: all 4 attempts used before 2 runs finished; stopping/);
    await expect(p).rejects.toBeInstanceOf(FatalError);
    expect(x.calls).toEqual(["tui1", "tui1", "tui1", "tui1"]);
    expect(x.recorded).toHaveLength(4);
  });
  test("a fatal error (account leased, token expired) stops at once", async () => {
    const x = io({ 1: new FatalError("access token of the account is expired") });
    await expect(runAll(2, x)).rejects.toThrow(/token/);
    expect(x.calls).toEqual(["tui1", "bridge1"]);
  });
  test("a failed account check stops before the run", async () => {
    const x = io();
    let checks = 0;
    const p = runAll(2, { ...x, checkIdle: async () => { if (++checks === 3) throw new FatalError("still leased"); } });
    await expect(p).rejects.toThrow(/still leased/);
    expect(x.calls).toEqual(["tui1", "bridge1"]);
  });
});
