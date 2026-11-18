import type { TokenUsage } from "../../image/agent-bridge/src/events.ts";

export interface UsageRead { pct: number; resetsAt: number | null }
export interface RunRecord {
  path: "tui" | "bridge"; ok: boolean; reason?: string;
  before: UsageRead; after: UsageRead; usage: TokenUsage | null; model: string | null;
  /** Distinct models of the main transcript's assistant messages (both paths). */
  models?: string[];
  /** The bridge summary's own usage (all models); informational, the gate uses transcripts. */
  bridgeReportedUsage?: TokenUsage | null;
}

export const GATE_RATIO = 1.15;
// Per path. Each run's delta is the difference of two whole-percent reads, so it is off by up to
// ±1 point; at 10 points over 5 runs that error was about ±13 % on the ratio, as large as the 15 %
// margin being tested. At 30 points it stays well inside the margin.
export const LOW_SIGNAL_PCT = 30;

export function weightedTokens(u: TokenUsage): number {
  return u.input + u.cacheCreation * 1.25 + u.cacheRead * 0.1 + u.output * 5;
}

export function validateRun(r: RunRecord, expectedModel: string): RunRecord {
  if (!r.ok) return r;
  const fail = (reason: string): RunRecord => ({ ...r, ok: false, reason });
  if (!r.usage) return fail("missing-usage");
  if (r.before.resetsAt !== r.after.resetsAt) return fail("window-reset");
  if (r.after.pct < r.before.pct) return fail("negative-delta");
  if (r.model !== expectedModel || r.models?.some((x) => x !== expectedModel)) return fail("model-mismatch");
  return r;
}

/** Claude Code writes one transcript line per content block, and every line of a message repeats
 *  the message's usage, so usage is counted once per message id (the last line wins). */
export function transcriptUsage(jsonl: string): { done: boolean; usage: TokenUsage; model: string | null; models: string[] } {
  const byId = new Map<string, { usage: TokenUsage; model: string | null }>();
  let lastStop: string | null = null;
  let model: string | null = null;
  let anon = 0;
  const models = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // a line still being written
    if (e?.type !== "assistant" || !e.message?.usage) continue;
    const m = e.message;
    if (m.model === "<synthetic>") continue;
    lastStop = m.stop_reason ?? null;
    model = m.model ?? model;
    if (m.model) models.add(m.model);
    byId.set(m.id ?? `anon-${anon++}`, {
      model: m.model ?? null,
      usage: {
        input: m.usage.input_tokens ?? 0,
        output: m.usage.output_tokens ?? 0,
        cacheCreation: m.usage.cache_creation_input_tokens ?? 0,
        cacheRead: m.usage.cache_read_input_tokens ?? 0,
      },
    });
  }
  const usage: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const v of byId.values()) {
    usage.input += v.usage.input;
    usage.output += v.usage.output;
    usage.cacheCreation += v.usage.cacheCreation;
    usage.cacheRead += v.usage.cacheRead;
  }
  return { done: lastStop === "end_turn", usage, model, models: [...models] };
}

/** Poll output: one `FILE_MARK<path>` line per transcript, followed by its content. */
export const FILE_MARK = "##FILE ";

/** Subagent transcripts are separate files (`<session>/subagents/*.jsonl`); their usage counts
 *  against the same window and the bridge sums it, so the TUI side must too. Completion and
 *  model are judged on the main session only. */
export function sessionUsage(polled: string): { done: boolean; usage: TokenUsage; model: string | null; models: string[]; lines: number } {
  const files: { path: string; body: string }[] = [];
  for (const line of polled.split("\n")) {
    if (line.startsWith(FILE_MARK)) files.push({ path: line.slice(FILE_MARK.length), body: "" });
    else if (files.length) files[files.length - 1].body += line + "\n";
  }
  const usage: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let lines = 0;
  for (const f of files) {
    const u = transcriptUsage(f.body).usage;
    usage.input += u.input; usage.output += u.output;
    usage.cacheCreation += u.cacheCreation; usage.cacheRead += u.cacheRead;
    lines += f.body.split("\n").filter((l) => l.trim()).length;
  }
  const main = transcriptUsage(files.filter((f) => !f.path.includes("/subagents/")).map((f) => f.body).join("\n"));
  return { done: main.done, usage, model: main.model, models: main.models, lines };
}

function pctPerMTok(runs: RunRecord[], path: "tui" | "bridge"): { rate: number; delta: number; n: number; tokens: number } {
  const ok = runs.filter((r) => r.ok && r.path === path && r.usage);
  if (ok.length === 0) throw new Error(`no valid ${path} runs; cannot compute the gate`);
  const delta = ok.reduce((s, r) => s + (r.after.pct - r.before.pct), 0);
  const tokens = ok.reduce((s, r) => s + weightedTokens(r.usage!), 0);
  if (tokens <= 0) throw new Error(`${path} runs have zero weighted tokens`);
  return { rate: delta / (tokens / 1e6), delta, n: ok.length, tokens };
}

export function gate(runs: RunRecord[]): {
  tuiPctPerMTok: number; bridgePctPerMTok: number; ratio: number; perTaskRatio: number; pass: boolean;
  tuiDeltaPct: number; bridgeDeltaPct: number; tuiMeanDeltaPct: number; bridgeMeanDeltaPct: number;
  tuiMeanWeighted: number; bridgeMeanWeighted: number; lowSignal: boolean;
} {
  const tui = pctPerMTok(runs, "tui");
  const bridge = pctPerMTok(runs, "bridge");
  if (tui.rate <= 0) throw new Error("tui consumed 0% of the window; the ratio is undefined");
  const ratio = bridge.rate / tui.rate;
  // Per task, not only per token: a bridge that burns more tokens for the same task must fail too.
  const perTaskRatio = (bridge.delta / bridge.n) / (tui.delta / tui.n);
  const lowSignal = tui.delta < LOW_SIGNAL_PCT || bridge.delta < LOW_SIGNAL_PCT;
  return {
    tuiPctPerMTok: tui.rate, bridgePctPerMTok: bridge.rate, ratio, perTaskRatio,
    pass: !lowSignal && ratio <= GATE_RATIO && perTaskRatio <= GATE_RATIO,
    tuiDeltaPct: tui.delta, bridgeDeltaPct: bridge.delta,
    tuiMeanDeltaPct: tui.delta / tui.n, bridgeMeanDeltaPct: bridge.delta / bridge.n,
    tuiMeanWeighted: tui.tokens / tui.n, bridgeMeanWeighted: bridge.tokens / bridge.n,
    lowSignal,
  };
}
