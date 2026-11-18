import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FILE_MARK, gate, sessionUsage, tokenGate, transcriptUsage, validateRun, weightedTokens, type RunRecord } from "./meter.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

// 1M weighted tokens: 1_000_000 input only.
const MILLION = { input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 };

function run(path: "tui" | "bridge", delta: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    path, ok: true,
    before: { pct: 10, resetsAt: 1000 }, after: { pct: 10 + delta, resetsAt: 1000 },
    usage: MILLION, model: "claude-opus-5-5", ...over,
  };
}
const runs = (path: "tui" | "bridge", delta: number, n = 5) =>
  Array.from({ length: n }, () => run(path, delta));

describe("weightedTokens", () => {
  test("applies the price weights", () => {
    expect(weightedTokens({ input: 1000, output: 100, cacheCreation: 400, cacheRead: 10000 })).toBe(3000);
  });
});

describe("validateRun", () => {
  test("accepts a clean run", () => {
    expect(validateRun(run("tui", 3), "claude-opus-5-5").ok).toBe(true);
  });
  test("rejects a run without both usage reads", () => {
    expect(validateRun(run("tui", 3, { after: null }), "claude-opus-5-5").reason).toBe("missing-usage-read");
  });
  test("rejects a window reset", () => {
    const r = validateRun(run("tui", 3, { after: { pct: 2, resetsAt: 2000 } }), "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("window-reset");
  });
  test("rejects a model mismatch", () => {
    const r = validateRun(run("bridge", 3, { model: "claude-sonnet-x" }), "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("model-mismatch");
  });
  test("rejects missing usage", () => {
    const r = validateRun(run("bridge", 3, { usage: null }), "claude-opus-5-5");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-usage");
  });
  test("rejects a falling percentage", () => {
    const r = validateRun(run("tui", -1), "claude-opus-5-5");
    expect(r.reason).toBe("negative-delta");
  });
  test("rejects when any main-transcript message used another model", () => {
    const r = validateRun(run("tui", 3, { models: ["claude-opus-5-5", "claude-haiku-x"] }), "claude-opus-5-5");
    expect(r.reason).toBe("model-mismatch");
  });
  test("keeps the reason of a run the runner already failed", () => {
    const r = validateRun(run("tui", 3, { ok: false, reason: "timeout" }), "claude-opus-5-5");
    expect(r.reason).toBe("timeout");
  });
});

describe("transcriptUsage", () => {
  test("end-turn transcript is done, counts each message once", () => {
    const t = transcriptUsage(fx("transcript-end-turn.jsonl"));
    expect(t.done).toBe(true);
    expect(t.model).toBe("claude-opus-5-5");
    expect(t.usage).toEqual({ input: 110, output: 100, cacheCreation: 400, cacheRead: 2400 });
  });
  test("in-progress transcript is not done", () => {
    expect(transcriptUsage(fx("transcript-in-progress.jsonl")).done).toBe(false);
  });
  test("a half-written last line is ignored", () => {
    const t = transcriptUsage(fx("transcript-in-progress.jsonl") + '{"type":"assis');
    expect(t.done).toBe(false);
  });
});

describe("sessionUsage", () => {
  const section = (path: string, body: string) => `${FILE_MARK}${path}\n${body}\n`;
  const proj = "/c/projects/-workspace";

  test("sums the main transcript and subagent transcripts; done and model come from main", () => {
    const out =
      section(`${proj}/sess.jsonl`, fx("transcript-end-turn.jsonl")) +
      section(`${proj}/sess/subagents/agent-1.jsonl`, fx("transcript-subagent.jsonl"));
    const s = sessionUsage(out);
    expect(s.done).toBe(true);
    expect(s.model).toBe("claude-opus-5-5");
    // main 110/100/400/2400 + subagent (s1 once, s2) 8/12/50/1050
    expect(s.usage).toEqual({ input: 118, output: 112, cacheCreation: 450, cacheRead: 3450 });
  });
  test("a finished subagent does not make an unfinished main session done", () => {
    const out =
      section(`${proj}/sess.jsonl`, fx("transcript-in-progress.jsonl")) +
      section(`${proj}/sess/subagents/agent-1.jsonl`, fx("transcript-subagent.jsonl"));
    expect(sessionUsage(out).done).toBe(false);
  });
  test("no transcript yet is not done", () => {
    expect(sessionUsage("").done).toBe(false);
  });
});

describe("gate", () => {
  test("passes at equal cost", () => {
    const g = gate([...runs("tui", 6), ...runs("bridge", 6)]);
    expect(g.ratio).toBe(1);
    expect(g.perTaskRatio).toBe(1);
    expect(g.pass).toBe(true);
    expect(g.tuiDeltaPct).toBe(30);
  });
  test("fails above 15 percent", () => {
    const g = gate([...runs("tui", 6), ...runs("bridge", 7)]);
    expect(g.ratio).toBeCloseTo(1.1667, 3);
    expect(g.pass).toBe(false);
  });
  test("fails when per-token cost is equal but the bridge uses 1.3x tokens per task", () => {
    const heavy = { input: 1_300_000, output: 0, cacheCreation: 0, cacheRead: 0 };
    const bridge = Array.from({ length: 5 }, () => run("bridge", 7.8, { usage: heavy }));
    const g = gate([...runs("tui", 6), ...bridge]);
    expect(g.ratio).toBeCloseTo(1, 6);
    expect(g.perTaskRatio).toBeCloseTo(1.3, 6);
    expect(g.bridgeMeanWeighted).toBeCloseTo(1_300_000);
    expect(g.pass).toBe(false);
  });
  test("low signal is never a pass", () => {
    expect(gate([...runs("tui", 1), ...runs("bridge", 1)]).pass).toBe(false);
  });
  test("ignores failed runs", () => {
    const bad = run("bridge", 50, { ok: false, reason: "timeout" });
    const g = gate([...runs("tui", 3), ...runs("bridge", 3), bad]);
    expect(g.ratio).toBe(1);
  });
  test("flags low signal", () => {
    const g = gate([...runs("tui", 1.2), ...runs("bridge", 3)]);
    expect(g.tuiDeltaPct).toBeCloseTo(6);
    expect(g.lowSignal).toBe(true);
  });
  test("low signal is per path at 30 points", () => {
    // 29 points on one path: ±1 per whole-percent read still swings the ratio past the margin
    expect(gate([...runs("tui", 5.8), ...runs("bridge", 6)]).lowSignal).toBe(true);
    expect(gate([...runs("tui", 6), ...runs("bridge", 5.8)]).lowSignal).toBe(true);
    expect(gate([...runs("tui", 6), ...runs("bridge", 6)]).lowSignal).toBe(false);
  });
  test("refuses to judge without valid runs on both paths", () => {
    expect(() => gate(runs("tui", 3))).toThrow(/bridge/);
  });
});

describe("validateRun in tokens mode", () => {
  test("accepts a run without usage reads", () => {
    const r = run("tui", 0, { before: null, after: null });
    expect(validateRun(r, "claude-opus-5-5", { tokensOnly: true }).ok).toBe(true);
  });
  test("still rejects a model mismatch and missing usage", () => {
    expect(validateRun(run("tui", 0, { before: null, after: null, model: "claude-x" }), "claude-opus-5-5", { tokensOnly: true }).reason).toBe("model-mismatch");
    expect(validateRun(run("tui", 0, { before: null, after: null, usage: null }), "claude-opus-5-5", { tokensOnly: true }).reason).toBe("missing-usage");
  });
});

describe("tokenGate", () => {
  const tok = (path: "tui" | "bridge", input: number, cacheRead = 0) =>
    run(path, 0, { before: null, after: null, usage: { input, output: 0, cacheCreation: 0, cacheRead } });
  test("passes at equal tokens per task", () => {
    const g = tokenGate([tok("tui", 1000), tok("bridge", 1000), tok("tui", 1000), tok("bridge", 1000)]);
    expect(g.ratio).toBe(1);
    expect(g.pass).toBe(true);
  });
  test("fails when the bridge uses more than 15 percent more weighted tokens per task", () => {
    const g = tokenGate([tok("tui", 1000), tok("bridge", 1200)]);
    expect(g.ratio).toBeCloseTo(1.2, 5);
    expect(g.pass).toBe(false);
  });
  test("reports the cache-read share per path", () => {
    const g = tokenGate([tok("tui", 100, 900), tok("bridge", 1000, 0)]);
    expect(g.tuiCacheReadShare).toBeCloseTo(0.9, 5);
    expect(g.bridgeCacheReadShare).toBe(0);
  });
  test("ignores failed runs and refuses without valid runs on both paths", () => {
    const g = tokenGate([tok("tui", 1000), tok("bridge", 1000), { ...tok("bridge", 99999), ok: false, reason: "timeout" }]);
    expect(g.ratio).toBe(1);
    expect(() => tokenGate([tok("tui", 1000)])).toThrow(/bridge/);
  });
});
