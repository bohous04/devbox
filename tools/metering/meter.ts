import type { TokenUsage } from "../../image/agent-bridge/src/events.ts";

export interface UsageRead { pct: number; resetsAt: number | null }
export interface RunRecord {
  path: "tui" | "bridge"; ok: boolean; reason?: string;
  before: UsageRead; after: UsageRead; usage: TokenUsage | null; model: string | null;
}

export const GATE_RATIO = 1.15;
// Below this total delta the whole-percent meter granularity dominates the ratio.
export const LOW_SIGNAL_PCT = 10;

export function weightedTokens(u: TokenUsage): number {
  return u.input + u.cacheCreation * 1.25 + u.cacheRead * 0.1 + u.output * 5;
}

export function validateRun(r: RunRecord, expectedModel: string): RunRecord {
  if (!r.ok) return r;
  const fail = (reason: string): RunRecord => ({ ...r, ok: false, reason });
  if (!r.usage) return fail("missing-usage");
  if (r.before.resetsAt !== r.after.resetsAt) return fail("window-reset");
  if (r.after.pct < r.before.pct) return fail("negative-delta");
  if (r.model !== expectedModel) return fail("model-mismatch");
  return r;
}

/** Claude Code writes one transcript line per content block, and every line of a message repeats
 *  the message's usage, so usage is counted once per message id (the last line wins). */
export function transcriptUsage(jsonl: string): { done: boolean; usage: TokenUsage; model: string | null } {
  const byId = new Map<string, { usage: TokenUsage; model: string | null }>();
  let lastStop: string | null = null;
  let model: string | null = null;
  let anon = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // a line still being written
    if (e?.type !== "assistant" || !e.message?.usage) continue;
    const m = e.message;
    if (m.model === "<synthetic>") continue;
    lastStop = m.stop_reason ?? null;
    model = m.model ?? model;
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
  return { done: lastStop === "end_turn", usage, model };
}

function pctPerMTok(runs: RunRecord[], path: "tui" | "bridge"): { rate: number; delta: number } {
  const ok = runs.filter((r) => r.ok && r.path === path && r.usage);
  if (ok.length === 0) throw new Error(`no valid ${path} runs; cannot compute the gate`);
  const delta = ok.reduce((s, r) => s + (r.after.pct - r.before.pct), 0);
  const tokens = ok.reduce((s, r) => s + weightedTokens(r.usage!), 0);
  if (tokens <= 0) throw new Error(`${path} runs have zero weighted tokens`);
  return { rate: delta / (tokens / 1e6), delta };
}

export function gate(runs: RunRecord[]): {
  tuiPctPerMTok: number; bridgePctPerMTok: number; ratio: number; pass: boolean;
  tuiDeltaPct: number; bridgeDeltaPct: number; lowSignal: boolean;
} {
  const tui = pctPerMTok(runs, "tui");
  const bridge = pctPerMTok(runs, "bridge");
  if (tui.rate <= 0) throw new Error("tui consumed 0% of the window; the ratio is undefined");
  const ratio = bridge.rate / tui.rate;
  return {
    tuiPctPerMTok: tui.rate, bridgePctPerMTok: bridge.rate, ratio, pass: ratio <= GATE_RATIO,
    tuiDeltaPct: tui.delta, bridgeDeltaPct: bridge.delta,
    lowSignal: tui.delta < LOW_SIGNAL_PCT || bridge.delta < LOW_SIGNAL_PCT,
  };
}
