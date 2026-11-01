// Shared construction of metric rows for the usage harvesters (Grok Build, Codex).
// Metric names and the attrs shape are THE SAME as for OTLP ingestion from cc — Stats then
// does not distinguish the new source and everything (leaderboards, filters, cards) works by itself.
import { costOf, hasPrice, warnUnpricedModel, PRICE_CHECKED_AT, type TokenKind } from "./pricing";
import type { MetricRow } from "./db";

export interface TokenTotals { input: number; cacheRead: number; cacheWrite: number; output: number }
export interface UsageEvent {
  ts: number; model: string | null;
  agent?: "codex" | "grok" | "agy"; sourceId?: string;
  session: { id: string; project: string; repo: string } | null;
  totals: TokenTotals; promptTokens?: number;
}

// cc marks token kinds with the `type` attribute; a cache write is named cacheCreation in cc.
const KIND_TO_CC_TYPE: Record<TokenKind, string> = {
  input: "input", cacheRead: "cacheRead", cacheWrite: "cacheCreation", output: "output",
};
const KINDS: TokenKind[] = ["input", "cacheRead", "cacheWrite", "output"];

export function usageMetricRows(u: UsageEvent): MetricRow[] {
  const base: Record<string, string> = { "devbox.host": "devbox" };
  // Provenance is independent of model: Claude Code can also run through a GPT proxy.
  if (u.agent) base["devbox.agent"] = u.agent;
  if (u.sourceId) base["devbox.usage.source_id"] = u.sourceId;
  if (u.session) Object.assign(base, { "devbox.session.id": u.session.id, project: u.session.project, repo: u.session.repo });
  if (u.model) base["model"] = u.model;
  const rows: MetricRow[] = [];
  const priced = u.model !== null && hasPrice(u.model);
  if (u.model !== null && !priced) warnUnpricedModel(u.model);
  for (const kind of KINDS) {
    const tokens = u.totals[kind];
    if (tokens <= 0) continue; // zero kinds are noise — cc does not send zeros either
    const attrs = JSON.stringify({ ...base, type: KIND_TO_CC_TYPE[kind] });
    const sid = u.session?.id ?? null;
    rows.push({ ts: u.ts, session_id: sid, name: "claude_code.token.usage", value: tokens, attrs });
    if (priced) {
      const c = costOf(u.model!, kind, tokens, u.promptTokens, u.ts)!;
      if (c > 0) rows.push({ ts: u.ts, session_id: sid, name: "claude_code.cost.usage", value: c,
        attrs: JSON.stringify({ ...JSON.parse(attrs), "devbox.cost.basis": "standard-api-estimate", "devbox.cost.price_date": PRICE_CHECKED_AT }) });
    }
  }
  return rows;
}
