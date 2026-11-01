import type { MetricRow } from "./db";
import { costOf, hasPrice, warnUnpricedModel, PRICE_CHECKED_AT, type TokenKind } from "./pricing";

export interface DataPoint { name: string; value: number; timeUnixNano: number; attributes: Record<string, string | number> }

function attrList(list: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!Array.isArray(list)) return out;
  for (const a of list as { key?: string; value?: Record<string, unknown> }[]) {
    if (!a?.key || !a.value) continue;
    const v = a.value;
    if (typeof v.stringValue === "string") out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = Number(v.doubleValue);
    else if (typeof v.boolValue === "boolean") out[a.key] = String(v.boolValue);
  }
  return out;
}

function pointValue(dp: Record<string, unknown>): number | null {
  if (dp.asInt !== undefined) return Number(dp.asInt);
  if (dp.asDouble !== undefined) return Number(dp.asDouble);
  return null;
}

export function parseOtlpMetrics(payload: unknown): DataPoint[] {
  const out: DataPoint[] = [];
  const rm = (payload as { resourceMetrics?: unknown })?.resourceMetrics;
  if (!Array.isArray(rm)) return out;
  for (const res of rm as Record<string, unknown>[]) {
    const resAttrs = attrList((res.resource as { attributes?: unknown })?.attributes);
    const sm = res.scopeMetrics;
    if (!Array.isArray(sm)) continue;
    for (const scope of sm as Record<string, unknown>[]) {
      const metrics = scope.metrics;
      if (!Array.isArray(metrics)) continue;
      for (const m of metrics as Record<string, unknown>[]) {
        const name = typeof m.name === "string" ? m.name : null;
        const agg = (m.sum ?? m.gauge) as { dataPoints?: unknown } | undefined;
        if (!name || !agg || !Array.isArray(agg.dataPoints)) continue; // ignore histograms/unknown
        for (const dp of agg.dataPoints as Record<string, unknown>[]) {
          const value = pointValue(dp);
          if (value === null || Number.isNaN(value)) continue;
          out.push({
            name, value,
            timeUnixNano: Number(dp.timeUnixNano ?? 0),
            attributes: { ...resAttrs, ...attrList(dp.attributes) },
          });
        }
      }
    }
  }
  return out;
}

const COST_METRIC = "claude_code.cost.usage";
// Family of Claude models for which the cost from claude_code.cost.usage makes sense.
const CLAUDE_MODEL_RE = /claude|opus|sonnet|haiku|fable/i;

/** Under a proxy, Claude Code runs on a foreign model and computes the cost from ITS OWN price list
 *  for a model that is not in it — the number would be made up and also misleading, because it is
 *  actually paid from a subscription. Tokens and hours remain, so the model is still visible in Stats,
 *  just without a cost. Points without a model (older exporters) are left alone. */
export function costIsMeaningful(name: string, attributes: Record<string, unknown>): boolean {
  if (name !== COST_METRIC) return true;
  const model = attributes["model"];
  if (typeof model !== "string" || model === "") return true;
  return CLAUDE_MODEL_RE.test(model);
}

/** The model Claude Code uses to mark locally produced messages (error message, interruption).
 *  There is no API call behind them and usage is all zeros — verified in the claude binary
 *  2.1.237: such messages are created with `model:"<synthetic>"` and zero usage, and
 *  telemetry takes the model directly from them. Dropping them is right (cost 0 changes nothing),
 *  but reporting them is NOT: it would be a permanent message about something that is fine, and it would drown
 *  the one that matters. */
const SYNTHETIC_MODEL = "<synthetic>";

/** Models whose drop has already been reported. Without dedupe it would be logged on EVERY
 *  export (every 10 s per proxy session) and the evidence would turn into noise. The set is
 *  bounded by the number of distinct models, not by the number of points. */
const warnedModels = new Set<string>();

/** Dropping a cost row is irreversible and otherwise completely silent: if CLAUDE_MODEL_RE
 *  did not match a new Claude model, its cost would simply vanish from Stats and no trace of it
 *  would remain anywhere. This is the only place where it can be caught. */
function warnDroppedCost(model: unknown): void {
  const m = typeof model === "string" ? model : "";
  if (m === SYNTHETIC_MODEL || warnedModels.has(m)) return;
  warnedModels.add(m);
  console.warn(`metrics: price for model "${m}" is discarded (does not match CLAUDE_MODEL_RE). ` +
    "If this is a Claude model, fix that regex in metrics.ts — otherwise its price never reaches Stats.");
}

/** Tests only: dedupe is module-level and without a reset a second test would report nothing. */
export function resetCostWarnings(): void { warnedModels.clear(); }

const TOKEN_METRIC = "claude_code.token.usage";
// Mapping of the cc `type` attribute to a cost kind; cc labels cache writes "cacheCreation".
const CC_TYPE_TO_KIND: Record<string, TokenKind> = {
  input: "input", cacheRead: "cacheRead", cacheCreation: "cacheWrite", output: "output",
};

/** Synthetic cost.usage row for a token.usage point of a FOREIGN model. cc cannot price
 *  such a model (see costIsMeaningful) — this is the only place where the cost comes from.
 *  Returns null for Claude models (cc's cost is correct), points without a model/type
 *  and models without a price list (those are reported by warnUnpricedModel). */
function syntheticCost(p: DataPoint): DataPoint | null {
  if (p.name !== TOKEN_METRIC) return null;
  const model = p.attributes["model"];
  if (typeof model !== "string" || model === "" || CLAUDE_MODEL_RE.test(model)) return null;
  const kind = CC_TYPE_TO_KIND[String(p.attributes["type"])];
  if (!kind) return null;
  if (!hasPrice(model)) { warnUnpricedModel(model); return null; }
  const cost = costOf(model, kind, p.value, undefined, p.timeUnixNano > 0 ? Math.round(p.timeUnixNano / 1e6) : Date.now())!;
  // A free model in the price list (rate 0) would otherwise produce a zero
  // cost.usage row FOR EVERY token.usage point — pure noise under high traffic
  // in the metrics table, and also inconsistent with harvest.ts (which does not write zero rows).
  if (cost === 0) return null;
  return { ...p, name: COST_METRIC, value: cost, attributes: {
    ...p.attributes, "devbox.cost.basis": "standard-api-estimate", "devbox.cost.price_date": PRICE_CHECKED_AT,
  } };
}

export function pointsToRows(points: DataPoint[]): MetricRow[] {
  return points
    .flatMap((p) => {
      if (!costIsMeaningful(p.name, p.attributes)) {
        // Foreign cc cost: ALWAYS dropped (the number is wrong). The message only makes sense
        // for a model without a price list — otherwise the synthetic row fully replaced it.
        if (!hasPrice(String(p.attributes["model"] ?? ""))) warnDroppedCost(p.attributes["model"]);
        return [];
      }
      const cost = syntheticCost(p);
      return cost ? [p, cost] : [p];
    })
    .map((p) => ({
      ts: p.timeUnixNano > 0 ? Math.round(p.timeUnixNano / 1e6) : Date.now(),
      // devbox's own resource attribute, non-colliding with Claude Code's own
      // datapoint-level `session.id` (its conversation UUID) — see sessions.ts runOpts.
      session_id: typeof p.attributes["devbox.session.id"] === "string" ? (p.attributes["devbox.session.id"] as string) : null,
      name: p.name, value: p.value, attrs: JSON.stringify(p.attributes),
    }));
}
