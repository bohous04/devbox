// Price list of foreign models in USD per 1M tokens. The cost from cc is made up for these models
// (cc computes from ITS OWN price list), so devd computes it itself from tokens — see the spec
// the internal design notes and metrics.ts/harvesters.
// Meaning: "what it would cost on the API" — it is actually paid from a subscription.

export type TokenKind = "input" | "cacheRead" | "cacheWrite" | "output";
export const PRICE_CHECKED_AT = "2026-10-15";
type Rates = Record<TokenKind, number>;
// `rateChange`: an announced price list change from a date (Gemini 3.8 Flash has an introductory price until
// the end of 2026). The TOKEN's time decides, not the computation time — a backfill of old rows after
// 2027-01-01 thus still prices them at the introductory rate.
interface ModelPrice {
  rates: Rates;
  longContext?: { threshold: number; exclusive?: boolean; rates: Rates };
  rateChange?: { from: number; rates: Rates };
}

// Standard API-equivalent rates, verified 2026-09-10. Sources and limitations:
// docs/codex-stats-pricing.md. OpenAI >272k is exclusive; xAI >=200k inclusive.
// GPT-5.6+ bills cache writes at 1.25x ordinary input. These buckets must be
// exclusive (input excludes BOTH cache reads and writes).
const SOL: ModelPrice = {
  rates: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  longContext: { threshold: 272_000, exclusive: true, rates: { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 } },
};
const GPT55: ModelPrice = {
  rates: { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },
  longContext: { threshold: 272_000, exclusive: true, rates: { input: 10, cacheRead: 1, cacheWrite: 10, output: 45 } },
};
const MINI: ModelPrice = { rates: { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 4.5 } };
// Antigravity (agy) — ids exactly as reported by `agy models` / the `modelName` hook
// (live 2026-10-15); the -low/-medium/-high suffix is the reasoning level, not a different model,
// the price is the same. Sources: ai.google.dev/gemini-api/docs/pricing (Gemini, output
// including thinking tokens), platform.claude.com/docs/en/about-claude/pricing (Claude:
// cache read 0.05× input, 5m cache write, no long-context surcharge),
// cloud.google.com/vertex-ai/generative-ai/pricing (gpt-oss-120b). Neither Gemini nor
// gpt-oss charge for implicit cache writes — cacheWrite = input (agy does not
// report it anyway). gpt-oss-120b has no cache hit price: unknown is not free → full input.
const GEMINI_38_FLASH: ModelPrice = {
  rates: { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 3.75 },
  rateChange: { from: Date.UTC(2027, 0, 1), rates: { input: 1.5, cacheRead: 0.15, cacheWrite: 1.5, output: 7.5 } },
};
const OPUS_55: ModelPrice = { rates: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } };
const SONNET_55: ModelPrice = { rates: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 } };
const GPT_OSS_120B: ModelPrice = { rates: { input: 0.09, cacheRead: 0.09, cacheWrite: 0.09, output: 0.36 } };
const efforts = (base: string, price: ModelPrice, levels: string[]): Record<string, ModelPrice> =>
  Object.fromEntries(levels.map((l) => [`${base}-${l}`, price]));
const PRICES: Record<string, ModelPrice> = {
  "grok-4.6": {
    rates: { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 6 },
    longContext: { threshold: 200_000, rates: { input: 4, cacheRead: 1, cacheWrite: 4, output: 12 } },
  },
  "gpt-6-astra": {
    rates: { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
    longContext: { threshold: 272_000, exclusive: true, rates: { input: 20, cacheRead: 2, cacheWrite: 25, output: 75 } },
  },
  // GPT-6.x added 2026-10-14 from the official pricing page (Standard tier).
  "gpt-6.1-sol": {
    rates: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
    longContext: { threshold: 272_000, exclusive: true, rates: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 } },
  },
  "gpt-6-sol": {
    rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
    longContext: { threshold: 272_000, exclusive: true, rates: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 15 } },
  },
  "gpt-6-luna": {
    rates: { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
    longContext: { threshold: 272_000, exclusive: true, rates: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 } },
  },
  "gpt-5.6-sol": SOL,
  "gpt-5.6": SOL, // Explicit official alias, not a prefix/family guess.
  "gpt-5.6-terra": {
    rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
    longContext: { threshold: 272_000, exclusive: true, rates: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 18 } },
  },
  "gpt-5.6-luna": {
    rates: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
    longContext: { threshold: 272_000, exclusive: true, rates: { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 } },
  },
  "gpt-5.5": GPT55,
  "gpt-5.5-2026-04-23": GPT55,
  "gpt-5.4-mini": MINI,
  "gpt-5.4-mini-2026-03-17": MINI,
  "gpt-5.3-codex": { rates: { input: 1.75, cacheRead: 0.175, cacheWrite: 1.75, output: 14 } },
  // `gemini-3.8-flash-high` is also sent by Claude Code through the proxy (claude-gemini profile).
  ...efforts("gemini-3.8-flash", GEMINI_38_FLASH, ["low", "medium", "high"]),
  ...efforts("claude-opus-5-5", OPUS_55, ["low", "medium", "high"]),
  ...efforts("claude-sonnet-5-5", SONNET_55, ["low", "medium", "high"]),
  "gpt-oss-120b-medium": GPT_OSS_120B,
  // stealth/ox-alpha has no published current price. Unknown is not free.
};

export function hasPrice(model: string): boolean { return Object.hasOwn(PRICES, model); }

/** `promptTokens` = the request's prompt size, decides the long-context rate.
 *  Without it (OTLP ingestion does not know request boundaries) the standard rate is used — a deliberate
 *  approximation, also recorded in the spec. `at` = consumption time (ms) for `rateChange`. */
export function costOf(model: string, kind: TokenKind, tokens: number, promptTokens?: number, at: number = Date.now()): number | null {
  const p = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!p) return null;
  if (p.rateChange && at >= p.rateChange.from) return (tokens / 1_000_000) * p.rateChange.rates[kind];
  const rates = p.longContext && promptTokens !== undefined &&
    (p.longContext.exclusive ? promptTokens > p.longContext.threshold : promptTokens >= p.longContext.threshold)
    ? p.longContext.rates : p.rates;
  return (tokens / 1_000_000) * rates[kind];
}

/** Model without a price list: tokens are stored, the cost is not — and this is the only trace.
 *  Dedupe via a set of models, the same pattern as warnDroppedCost in metrics.ts. */
const warned = new Set<string>();
export function warnUnpricedModel(model: string): void {
  if (warned.has(model)) return;
  warned.add(model);
  console.warn(`pricing: model "${model}" is not in the price list — tokens are stored, cost is not. Add it to PRICES in pricing.ts.`);
}
export function resetPricingWarnings(): void { warned.clear(); }
