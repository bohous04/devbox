import { appendFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gate, LOW_SIGNAL_PCT, tokenGate, type RunRecord } from "./meter.ts";
import {
  assertAccountIdle, assertImageHasBridge, assertTokenLasts, FatalError, measureRun, realExec, type Deps,
} from "./runners.ts";

export interface CompareArgs {
  account: string; model: string; runs: number; entrypoint?: string;
  commit?: string; repo?: string; out: string;
  /** window: 5-hour meter reads (needs a disabled, idle account); tokens: transcript tokens only. */
  mode: "window" | "tokens";
}

const SAFE = /^[A-Za-z0-9._-]+$/;
// Transcripts record the full model id; an alias (opus, sonnet) would make every run
// model-mismatch only after its window share is spent.
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]*$/;

export function parseCompareArgs(argv: string[]): CompareArgs {
  const v: Record<string, string> = {};
  const known = ["--account", "--model", "--runs", "--entrypoint", "--commit", "--repo", "--out", "--mode"];
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.includes(argv[i])) throw new Error(`unknown flag ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    v[argv[i]] = argv[i + 1];
  }
  for (const f of ["--account", "--model"]) if (!v[f]) throw new Error(`missing required flag ${f}`);
  // These end up inside a shell command line in the container.
  for (const f of ["--account", "--model", "--entrypoint", "--commit"]) {
    if (v[f] !== undefined && !SAFE.test(v[f])) throw new Error(`invalid value for ${f}`);
  }
  if (!MODEL_ID.test(v["--model"])) {
    throw new Error("--model must be a full model id such as claude-opus-5-5, not an alias");
  }
  const mode = v["--mode"] ?? "window";
  if (mode !== "window" && mode !== "tokens") throw new Error("--mode must be window or tokens");
  const runs = v["--runs"] === undefined ? 5 : Number(v["--runs"]);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return {
    account: v["--account"], model: v["--model"], runs, entrypoint: v["--entrypoint"],
    commit: v["--commit"], repo: v["--repo"], out: v["--out"] ?? "metering-report.json", mode,
  };
}

type Path = "tui" | "bridge";

/** ABBA order (tui, bridge, bridge, tui, …): whichever path runs second in a pair may hit the
 *  prompt cache the first one wrote, so neither path may always be second. */
export function schedule(runs: number): { n: number; path: Path }[] {
  const out: { n: number; path: Path }[] = [];
  for (let n = 1; n <= runs; n++) {
    const pair: Path[] = n % 2 === 1 ? ["tui", "bridge"] : ["bridge", "tui"];
    for (const path of pair) out.push({ n, path });
  }
  return out;
}

// Failures that say nothing about the path's cost, so the slot is measured again.
const REPEATABLE = ["window-reset", "timeout", "model-mismatch", "no-transcript", "no-transcript-early"];
const repeatable = (r: RunRecord) =>
  !r.ok && (REPEATABLE.includes(r.reason ?? "") || (r.reason ?? "").startsWith("run-error:"));

export interface RunAllIo {
  /** Throws when the account is no longer isolated; checked before every run. */
  checkIdle: () => Promise<void>;
  measure: (path: Path, n: number) => Promise<RunRecord>;
  onRecord: (r: RunRecord) => void;
}

export async function runAll(runs: number, io: RunAllIo): Promise<RunRecord[]> {
  // Bounds the window spent on a path that keeps failing (stuck dialog, broken image).
  const cap = 2 * runs;
  const attempts: Record<Path, number> = { tui: 0, bridge: 0 };
  const records: RunRecord[] = [];
  for (const slot of schedule(runs)) {
    for (;;) {
      if (attempts[slot.path] >= cap) {
        throw new FatalError(`${slot.path}: all ${cap} attempts used before ${runs} runs finished; stopping. The records so far are in the .runs.jsonl file next to the report; fix the cause of the failures listed there and start again.`);
      }
      attempts[slot.path]++;
      await io.checkIdle();
      let rec: RunRecord;
      try {
        rec = await io.measure(slot.path, slot.n);
      } catch (e) {
        if (e instanceof FatalError) throw e;
        rec = {
          path: slot.path, ok: false, reason: `run-error: ${e instanceof Error ? e.message : String(e)}`,
          before: null, after: null, usage: null, model: null,
        };
      }
      rec = { n: slot.n, ...rec };
      records.push(rec);
      io.onRecord(rec);
      if (!repeatable(rec)) break;
    }
  }
  return records;
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await realExec(["git", "-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

async function main() {
  const a = parseCompareArgs(process.argv.slice(2));
  const devdUrl = process.env.DEVD_URL;
  if (!devdUrl) throw new Error("DEVD_URL is not set");
  const here = dirname(new URL(import.meta.url).pathname);
  const commit = a.commit ?? await git(["rev-parse", "HEAD"], here);
  const repo = a.repo ?? await git(["rev-parse", "--show-toplevel"], here);
  const d: Deps = { exec: realExec, fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

  await assertImageHasBridge(d);
  const tokensOnly = a.mode === "tokens";
  // Tokens mode reads no usage meter, so other sessions on the same account cannot skew it.
  const checkIdle = tokensOnly ? async () => {} : () => assertAccountIdle(fetch, devdUrl, a.account);
  await checkIdle();
  // Also the check that the account's credentials exist at all.
  await assertTokenLasts(d, a.account, a.runs);

  const partial = `${a.out}.runs.jsonl`;
  writeFileSync(partial, "");
  const records = await runAll(a.runs, {
    checkIdle,
    measure: (path, n) => measureRun(d, {
      account: a.account, path, n, model: a.model, expectedModel: a.model,
      commit, repo, entrypoint: a.entrypoint, tokensOnly,
    }),
    onRecord: (rec) => {
      appendFileSync(partial, JSON.stringify(rec) + "\n");
      console.error(`${rec.path} #${rec.n}: ${rec.ok ? "ok" : `FAILED (${rec.reason})`}`);
    },
  });

  if (tokensOnly) {
    const t = tokenGate(records);
    const report = { account: "<redacted>", mode: a.mode, model: a.model, commit, entrypoint: a.entrypoint ?? null, gate: t, runs: records };
    writeFileSync(a.out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    const line = `bridge/tui weighted tokens per task ${t.ratio.toFixed(3)} (limit 1.15), cache-read share tui ${t.tuiCacheReadShare.toFixed(3)} bridge ${t.bridgeCacheReadShare.toFixed(3)}`;
    console.log(t.pass ? `PASS (tokens): ${line}` : `FAIL (tokens): ${line}`);
    if (!t.pass) process.exitCode = 1;
    return;
  }
  const g = gate(records);
  const report = { account: "<redacted>", model: a.model, commit, entrypoint: a.entrypoint ?? null, gate: g, runs: records };
  writeFileSync(a.out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  const ratios = `per-token ${g.ratio.toFixed(3)}, per-task ${g.perTaskRatio.toFixed(3)} (limit 1.15)`;
  if (g.lowSignal) {
    console.log(`INCONCLUSIVE (low signal): a path's total delta under ${LOW_SIGNAL_PCT}%, ${ratios}; rerun with more runs`);
    process.exitCode = 3;
  } else if (g.pass) {
    console.log(`PASS: bridge/tui ${ratios}`);
  } else {
    console.log(`FAIL: bridge/tui ${ratios}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error(`metering: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
