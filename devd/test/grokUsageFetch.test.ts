import { expect, test } from "bun:test";
import {
  fetchGrokUsage, grokTokenStale, parseGrokAuthJson, parseGrokBilling, type GrokAuthTokens,
} from "../src/grokUsageFetch";

const NOW = 1_787_224_361_140;
const DAY = 86_400_000;

// The shape measured live on 23 Aug 2026 on the grok-home volume: a map keyed by issuer
// (`https://auth.x.ai::<client-id>`), credentials only inside the value.
const issuerAuth = JSON.stringify({
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    key: "jwt-key-1", auth_mode: "oidc", email: "user@example.com",
    team_id: "team-1", refresh_token: "r1", expires_at: new Date(NOW + DAY).toISOString(),
  },
});

test("parseGrokAuthJson: issuer-keyed map (today's grok CLI)", () => {
  const t = parseGrokAuthJson(issuerAuth)!;
  expect(t.key).toBe("jwt-key-1");
  expect(t.email).toBe("user@example.com");
  expect(t.expiresAt).toBe(new Date(NOW + DAY).toISOString());
});

// The older shape from the CodexBar documentation: credentials directly at the root. Supporting both
// shapes is cheap and without it an older login would look signed out.
test("parseGrokAuthJson: flat shape (older CLI) and rejection of nonsense", () => {
  const flat = JSON.stringify({ key: "k2", email: "e", team_id: "t", expires_at: null });
  expect(parseGrokAuthJson(flat)!.key).toBe("k2");
  expect(parseGrokAuthJson("not json")).toBe(null);
  expect(parseGrokAuthJson("{}")).toBe(null);
  expect(parseGrokAuthJson(JSON.stringify({ "https://auth.x.ai::x": { key: "" } }))).toBe(null);
});

test("grokTokenStale: by expires_at; an unreadable date means \"try it\"", () => {
  const t = (expiresAt: string | null): GrokAuthTokens => ({ key: "k", email: null, teamId: null, expiresAt });
  expect(grokTokenStale(t(new Date(NOW + DAY).toISOString()), NOW)).toBe(false);
  expect(grokTokenStale(t(new Date(NOW - 1000).toISOString()), NOW)).toBe(true);
  // Nothing to decide on = do NOT guess "expired" — let it try and bring the real error.
  expect(grokTokenStale(t(null), NOW)).toBe(false);
  expect(grokTokenStale(t("not-a-date"), NOW)).toBe(false);
});

// Semantics taken from CodexBar (GrokCreditsProxyFetcher.parseSnapshot), with one
// deliberate difference: where CodexBar reports 0 %, here usedPct is null — zero would claim
// "nothing used", which for SuperGrok is NOT a measured fact (see the live measurement of 23 Aug).
test("parseGrokBilling: creditUsagePercent takes precedence and is clamped to 0–100", () => {
  expect(parseGrokBilling({ config: { creditUsagePercent: 37.5 } })!.usedPct).toBe(37.5);
  expect(parseGrokBilling({ config: { creditUsagePercent: 140 } })!.usedPct).toBe(100);
  expect(parseGrokBilling({ config: { creditUsagePercent: -3 } })!.usedPct).toBe(0);
});

test("parseGrokBilling: fallback onDemandUsed/onDemandCap only when cap > 0", () => {
  const r = parseGrokBilling({ config: { onDemandCap: { val: 200 }, onDemandUsed: { val: 50 } } })!;
  expect(r.usedPct).toBe(25);
  // cap 0 (SuperGrok, live 23 Aug 2026) → percentage UNKNOWN, not zero
  const zero = parseGrokBilling({
    config: {
      onDemandCap: { val: 0 }, onDemandUsed: { val: 0 },
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-22T21:20:38.375047+00:00", end: "2026-08-29T21:20:38.375047+00:00" },
      billingPeriodEnd: "2026-08-29T21:20:38.375047+00:00",
    },
  })!;
  expect(zero.usedPct).toBe(null);
  expect(zero.resetsAt).toBe(Date.parse("2026-08-29T21:20:38.375047+00:00"));
});

test("parseGrokBilling: resetsAt takes currentPeriod.end, then billingPeriodEnd; null without config", () => {
  const only = parseGrokBilling({ config: { billingPeriodEnd: "2026-09-01T00:00:00+00:00" } })!;
  expect(only.resetsAt).toBe(Date.parse("2026-09-01T00:00:00+00:00"));
  expect(parseGrokBilling({})).toBe(null);
  expect(parseGrokBilling(null)).toBe(null);
});

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tokens: GrokAuthTokens = { key: "jwt-key-1", email: null, teamId: null, expiresAt: null };

test("fetchGrokUsage: billing + tier from settings", async () => {
  const f = (async (url: unknown) => String(url).includes("/settings")
    ? jsonRes({ subscription_tier_display: "SuperGrok" })
    : jsonRes({ config: { creditUsagePercent: 12, billingPeriodEnd: "2026-08-29T21:20:38+00:00" } })
  ) as unknown as typeof fetch;
  const r = await fetchGrokUsage(tokens, f);
  if (!r.ok) throw new Error(r.error);
  expect(r.usage.usedPct).toBe(12);
  expect(r.usage.tier).toBe("SuperGrok");
  expect(r.usage.resetsAt).toBe(Date.parse("2026-08-29T21:20:38+00:00"));
});

// Settings are only an enrichment (tier) — their outage must not take down the whole measurement,
// same as in CodexBar (2s optional enrichment).
test("fetchGrokUsage: failed settings leave tier null, the measurement passes", async () => {
  const f = (async (url: unknown) => String(url).includes("/settings")
    ? new Response("boom", { status: 500 })
    : jsonRes({ config: { creditUsagePercent: 12 } })
  ) as unknown as typeof fetch;
  const r = await fetchGrokUsage(tokens, f);
  if (!r.ok) throw new Error(r.error);
  expect(r.usage.tier).toBe(null);
  expect(r.usage.usedPct).toBe(12);
});

test("fetchGrokUsage: non-200 from billing is an error with the status code", async () => {
  const f = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
  const r = await fetchGrokUsage(tokens, f);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("401");
});

test("fetchGrokUsage: an unknown response shape is a named error", async () => {
  const f = (async (url: unknown) => String(url).includes("/settings")
    ? jsonRes({})
    : jsonRes({ nothing: true })
  ) as unknown as typeof fetch;
  const r = await fetchGrokUsage(tokens, f);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("unknown-shape");
});
