import { appendFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gate, type RunRecord } from "./meter.ts";
import { assertAccountDisabled, measureRun, realExec, type Deps } from "./runners.ts";

export interface CompareArgs {
  account: string; model: string; runs: number; entrypoint?: string;
  commit?: string; repo?: string; out: string;
}

const SAFE = /^[A-Za-z0-9._-]+$/;

export function parseCompareArgs(argv: string[]): CompareArgs {
  const v: Record<string, string> = {};
  const known = ["--account", "--model", "--runs", "--entrypoint", "--commit", "--repo", "--out"];
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
  const runs = v["--runs"] === undefined ? 5 : Number(v["--runs"]);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return {
    account: v["--account"], model: v["--model"], runs, entrypoint: v["--entrypoint"],
    commit: v["--commit"], repo: v["--repo"], out: v["--out"] ?? "metering-report.json",
  };
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

  await assertAccountDisabled(fetch, devdUrl, a.account);

  const records: RunRecord[] = [];
  const partial = `${a.out}.runs.jsonl`;
  writeFileSync(partial, "");
  for (let n = 1; n <= a.runs; n++) {
    for (const path of ["tui", "bridge"] as const) {
      const rec = await measureRun(d, {
        account: a.account, path, n, model: a.model, expectedModel: a.model,
        commit, repo, entrypoint: a.entrypoint,
      });
      records.push(rec);
      appendFileSync(partial, JSON.stringify(rec) + "\n");
      console.error(`${path} #${n}: ${rec.ok ? "ok" : `FAILED (${rec.reason})`}`);
    }
  }

  const g = gate(records);
  const report = { account: "<redacted>", model: a.model, commit, entrypoint: a.entrypoint ?? null, gate: g, runs: records };
  writeFileSync(a.out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  const ratios = `per-token ${g.ratio.toFixed(3)}, per-task ${g.perTaskRatio.toFixed(3)} (limit 1.15)`;
  if (g.lowSignal) {
    console.log(`INCONCLUSIVE (low signal): total delta under 10%, ${ratios}; rerun with more runs`);
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
