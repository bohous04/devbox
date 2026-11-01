// Reading the Grok quota from the network. Path and parsing semantics taken from CodexBar
// (docs/grok.md + GrokCreditsProxyFetcher.swift, verified live on 23 Aug 2026):
// bearer from auth.json on the grok-home volume → cli-chat-proxy.grok.com. Separated from the
// poller so the parsing can be tested without the network.
//
// One deliberate difference from CodexBar: when the API cannot give a percentage (SuperGrok —
// creditUsagePercent is missing and onDemandCap is 0), CodexBar reports 0 %, here
// usedPct is null. Zero would claim "nothing used", which is not a measured fact;
// the card draws a dash for null and the percentage lights up by itself once xAI starts filling it.

import { toEpochMs } from "./accountUsage";

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

export interface GrokAuthTokens {
  key: string;
  email: string | null;
  teamId: string | null;
  expiresAt: string | null;   // ISO; the grok CLI rotates the token itself (~7 days validity)
}

export interface GrokUsage {
  weekly?: { usedPct: number; resetsAt: number | null };
  usedPct: number | null;     // null = the API does not expose a percentage (SuperGrok)
  resetsAt: number | null;    // ms epoch of the end of the regular window
  tier: string | null;        // "SuperGrok" from settings; null when settings fail
}

export type GrokFetchResult =
  | { ok: true; usage: GrokUsage }
  | { ok: false; error: string };

/** `null` = auth.json is missing, is not JSON, or has no usable key in it — in all
 *  cases "signed out". Today's grok CLI keeps credentials in a map keyed by
 *  issuer (`https://auth.x.ai::<client-id>`), the older shape had them directly at the root
 *  (CodexBar docs/grok.md) — supporting both is cheap and thanks to it an older login
 *  does not look signed out. */
export function parseGrokAuthJson(raw: string): GrokAuthTokens | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (j === null || typeof j !== "object") return null;
  const root = j as Record<string, unknown>;
  // The root and nested values as candidates at once — the loop filters out unsuitable shapes
  // by itself by checking `key`.
  const candidates = [root, ...Object.values(root).filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object")];
  for (const c of candidates) {
    if (typeof c.key !== "string" || c.key === "") continue;
    return {
      key: c.key,
      email: typeof c.email === "string" ? c.email : null,
      teamId: typeof c.team_id === "string" ? c.team_id : null,
      expiresAt: typeof c.expires_at === "string" ? c.expires_at : null,
    };
  }
  return null;
}

/** Expired according to `expires_at`. An unreadable or missing date is NOT "expired" —
 *  let the poller try anyway and bring back the real error (same principle as
 *  accessTokenStale in codexPoller.ts). */
export function grokTokenStale(t: GrokAuthTokens, now: number): boolean {
  if (t.expiresAt === null) return false;
  const exp = Date.parse(t.expiresAt);
  return Number.isNaN(exp) ? false : exp <= now;
}

function grokHeaders(t: GrokAuthTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${t.key}`,
    // Without this header the proxy rejects the bearer — taken from CodexBar, verified live.
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "devd",
  };
}

const num = (v: unknown): number | null => {
  const n = (v as { val?: unknown } | null)?.val;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** CodexBar semantics: creditUsagePercent → fallback onDemandUsed/onDemandCap
 *  (only when cap > 0) → percentage unknown. A `null` return = the response has no `config`,
 *  i.e. an unknown shape. */
export function parseGrokBilling(body: unknown): { usedPct: number | null; resetsAt: number | null; weekly?: { usedPct: number; resetsAt: number | null } } | null {
  const config = (body as { config?: unknown } | null)?.config;
  if (config === null || config === undefined || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;

  const resetsAt = toEpochMs((c.currentPeriod as { end?: unknown } | undefined)?.end) ?? toEpochMs(c.billingPeriodEnd);

  const pct = typeof c.creditUsagePercent === "number" && Number.isFinite(c.creditUsagePercent)
    ? c.creditUsagePercent : null;
  if (pct !== null) return { usedPct: Math.min(100, Math.max(0, pct)), resetsAt,
    ...((c.currentPeriod as {type?:unknown} | undefined)?.type === "USAGE_PERIOD_TYPE_WEEKLY" && pct >= 0 && pct <= 100
      ? { weekly: { usedPct: pct, resetsAt: toEpochMs((c.currentPeriod as {end?:unknown}).end) } } : {}) };

  const cap = num(c.onDemandCap);
  const used = num(c.onDemandUsed);
  if (cap !== null && cap > 0 && used !== null)
    return { usedPct: Math.min(100, Math.max(0, (used / cap) * 100)), resetsAt };

  return { usedPct: null, resetsAt };
}

/** Billing is the measurement and its failure is an error; settings are just enrichment (the tier
 *  name) and their outage leaves `tier: null` — the same split as in
 *  CodexBar (there settings are a 2s optional enrichment). */
export async function fetchGrokUsage(t: GrokAuthTokens, f: typeof fetch): Promise<GrokFetchResult> {
  // Settings start concurrently with billing (they are independent — this saves one RTT
  // on the happy path) and are evaluated only after a successful billing; catch right here so that
  // the billing error branch does not leave an unhandled rejection hanging.
  const settings = (async (): Promise<string | null> => {
    const s = await f(GROK_SETTINGS_URL, { headers: grokHeaders(t) });
    if (!s.ok) return null;
    const body = (await s.json().catch(() => null)) as { subscription_tier_display?: unknown } | null;
    return typeof body?.subscription_tier_display === "string" ? body.subscription_tier_display : null;
  })().catch(() => null);

  let res: Response;
  try {
    res = await f(GROK_BILLING_URL, { headers: grokHeaders(t) });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!res.ok) {
    // Stored data field — it ends up in the English card (subscriptionsView.ts).
    const body = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `HTTP ${res.status}${body ? ` ${body}` : ""}` };
  }
  const parsed = parseGrokBilling(await res.json().catch(() => null));
  if (parsed === null) return { ok: false, error: "unknown-shape" };

  return { ok: true, usage: { ...parsed, tier: await settings } };
}
