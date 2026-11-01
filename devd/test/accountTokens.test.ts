import { expect, test } from "bun:test";
import {
  OAUTH_CLIENT_ID, TOKEN_URL, accessTokenExpired, normalizeCredentialsInput, parseCredentials, parseTierWeight,
  refreshAccessToken, refreshTokenDead, withTierLabel, type CredentialsBlob,
} from "../src/accountTokens";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const blob = (over: Partial<CredentialsBlob["claudeAiOauth"]> = {}): CredentialsBlob => ({
  claudeAiOauth: {
    accessToken: "acc-1", refreshToken: "ref-1",
    expiresAt: NOW + 8 * HOUR, refreshTokenExpiresAt: NOW + 28 * DAY,
    scopes: ["user:profile", "user:inference"], subscriptionType: "max", ...over,
  },
});

test("parseCredentials: valid blob, empty, nonsense, missing tokens", () => {
  expect(parseCredentials(JSON.stringify(blob()))!.claudeAiOauth.accessToken).toBe("acc-1");
  expect(parseCredentials("")).toBe(null);
  expect(parseCredentials("{{")).toBe(null);
  expect(parseCredentials("{}")).toBe(null);
  expect(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "a" } }))).toBe(null);  // refreshToken missing
});

// `cat` on a file without a trailing newline leaves an inverted `%` after the output in zsh.
// It gets copied along and `JSON.parse` fails on it — pasting credentials then looks
// like a broken field. This is exactly the input that came from the terminal.
test("normalizeCredentialsInput: survives terminal junk around the JSON", () => {
  const raw = JSON.stringify(blob());
  const ok = (input: string) => {
    const r = normalizeCredentialsInput(input);
    expect(r.ok).toBe(true);
    return r as Extract<ReturnType<typeof normalizeCredentialsInput>, { ok: true }>;
  };

  expect(ok(raw).text).toBe(raw);
  expect(ok(raw + "%").text).toBe(raw);                       // zsh end-of-line marker
  expect(ok(raw + "%\n").text).toBe(raw);
  expect(ok("  " + raw + "  ").text).toBe(raw);
  expect(ok("'" + raw + "'").text).toBe(raw);                 // apostrophes from a copied command
  expect(ok("~ % cat .credentials.json\n" + raw + "%").text).toBe(raw);   // even with the prompt above the output
  expect(ok(raw + "%").blob.claudeAiOauth.accessToken).toBe("acc-1");
});

// Two different causes, two different fixes: "it is not JSON" means a truncated copy,
// "it is JSON, but without tokens" means a different file. One shared message was
// half of the reason this could not be debugged.
test("normalizeCredentialsInput: the rejection reason distinguishes what it is", () => {
  expect(normalizeCredentialsInput("")).toEqual({ ok: false, reason: "empty" });
  expect(normalizeCredentialsInput("   ")).toEqual({ ok: false, reason: "empty" });
  expect(normalizeCredentialsInput("this is not JSON")).toEqual({ ok: false, reason: "not-json" });
  expect(normalizeCredentialsInput('{"claudeAiOauth":{"accessToken":"a"')).toEqual({ ok: false, reason: "not-json" });
  expect(normalizeCredentialsInput("{}")).toEqual({ ok: false, reason: "not-credentials" });
  expect(normalizeCredentialsInput('{"claudeAiOauth":{"accessToken":"a"}}')).toEqual({ ok: false, reason: "not-credentials" });
});

test("accessTokenExpired: 5 min margin ahead", () => {
  expect(accessTokenExpired(blob(), NOW)).toBe(false);
  expect(accessTokenExpired(blob({ expiresAt: NOW - 1 }), NOW)).toBe(true);
  // just before expiry it is "expired" too — a margin for the duration of the call
  expect(accessTokenExpired(blob({ expiresAt: NOW + 60_000 }), NOW)).toBe(true);
  expect(accessTokenExpired(blob({ expiresAt: NOW + 10 * 60_000 }), NOW)).toBe(false);
});

test("refreshTokenDead: after refreshTokenExpiresAt; never without the field", () => {
  expect(refreshTokenDead(blob(), NOW)).toBe(false);
  expect(refreshTokenDead(blob({ refreshTokenExpiresAt: NOW - 1 }), NOW)).toBe(true);
  expect(refreshTokenDead(blob({ refreshTokenExpiresAt: undefined }), NOW)).toBe(false);
});

test("refreshAccessToken: success overwrites both tokens and the expiry", async () => {
  const seen: { url: string; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({
      access_token: "acc-2", refresh_token: "ref-2", expires_in: 28800,
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await refreshAccessToken(blob(), f);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.blob.claudeAiOauth.accessToken).toBe("acc-2");
  // refresh token rotation: the new one MUST be stored, otherwise the profile silently dies after a few refreshes
  expect(r.blob.claudeAiOauth.refreshToken).toBe("ref-2");
  expect(r.blob.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
  // the other fields stay (subscriptionType is used by the UI)
  expect(r.blob.claudeAiOauth.subscriptionType).toBe("max");
  expect(seen[0].url).toBe(TOKEN_URL);
  expect(seen[0].body).toContain("grant_type=refresh_token");
  expect(seen[0].body).toContain(`client_id=${OAUTH_CLIENT_ID}`);
  expect(seen[0].body).toContain("refresh_token=ref-1");
});

test("refreshAccessToken: a response without a new refresh token keeps the old one and its expiry", async () => {
  const f = (async () => new Response(JSON.stringify({ access_token: "acc-2", expires_in: 100 }), { status: 200 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f);
  if (!r.ok) throw new Error("should have passed");
  expect(r.blob.claudeAiOauth.refreshToken).toBe("ref-1");
  // the refresh token did not rotate → its expiry is still valid, it must not be lost
  expect(r.blob.claudeAiOauth.refreshTokenExpiresAt).toBe(NOW + 28 * DAY);
});

test("refreshAccessToken: refresh token rotation WITHOUT refresh_token_expires_in clears the old expiry (does not guess)", async () => {
  const f = (async () => new Response(JSON.stringify({
    access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600,
  }), { status: 200 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f, NOW);
  if (!r.ok) throw new Error("should have passed");
  // the old expiry belonged to token ref-1, which has just ceased to exist — keeping it would, ~28 days
  // after the ORIGINAL login, quarantine the account even though ref-2 is fine (see refreshTokenDead:
  // a missing field ≠ dead, unlike a stale field, which would lie).
  expect(r.blob.claudeAiOauth.refreshTokenExpiresAt).toBeUndefined();
});

test("refreshAccessToken: refresh token rotation WITH refresh_token_expires_in sets the new expiry", async () => {
  const f = (async () => new Response(JSON.stringify({
    access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600, refresh_token_expires_in: 30 * DAY / 1000,
  }), { status: 200 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f, NOW);
  if (!r.ok) throw new Error("should have passed");
  expect(r.blob.claudeAiOauth.refreshTokenExpiresAt).toBe(NOW + 30 * DAY);
});

test("refreshAccessToken: expiresAt is computed from the injected 'now', not from the real clock", async () => {
  const f = (async () => new Response(JSON.stringify({ access_token: "acc-2", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f, NOW);
  if (!r.ok) throw new Error("should have passed");
  expect(r.blob.claudeAiOauth.expiresAt).toBe(NOW + HOUR);
});

test("refreshAccessToken: 400 invalid_grant = dead refresh token → quarantine", async () => {
  const f = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.dead).toBe(true);
  expect(r.error).toContain("400");
});

test("refreshAccessToken: 500 and a network error are NOT a dead token (retry only)", async () => {
  const f500 = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const a = await refreshAccessToken(blob(), f500);
  expect(a.ok).toBe(false);
  if (a.ok) throw new Error("unreachable");
  expect(a.dead).toBe(false);

  const fNet = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const b = await refreshAccessToken(blob(), fNet);
  expect(b.ok).toBe(false);
  if (b.ok) throw new Error("unreachable");
  expect(b.dead).toBe(false);
  expect(b.error).toContain("ECONNREFUSED");
});

// Minor fix (review round 4): `dead` used to cover ALL 4xx, so 408
// (timeout) or 429 (rate limit) from the token endpoint sent a healthy account into
// quarantine ("Re-login needed"), even though the refresh token is fine and the error is
// only a temporary overload — exactly the same category as 500/network below.
test("refreshAccessToken: 408 and 429 are NOT a dead token (transient, not a re-login)", async () => {
  const f408 = (async () => new Response("timeout", { status: 408 })) as unknown as typeof fetch;
  const a = await refreshAccessToken(blob(), f408);
  expect(a.ok).toBe(false);
  if (a.ok) throw new Error("unreachable");
  expect(a.dead).toBe(false);

  const f429 = (async () => new Response('{"error":"rate_limited"}', { status: 429 })) as unknown as typeof fetch;
  const b = await refreshAccessToken(blob(), f429);
  expect(b.ok).toBe(false);
  if (b.ok) throw new Error("unreachable");
  expect(b.dead).toBe(false);
});

test("refreshAccessToken: a response without access_token is an error, not a silent write of nonsense", async () => {
  const f = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.dead).toBe(false);
});

test("refreshAccessToken: the error message takes only error/error_description, not the raw body", async () => {
  // The body contains other fields too (e.g. an echo of the request) — they must not end up in the error message
  // that the caller logs. We do not control the endpoint, so this is the only defence.
  const f = (async () => new Response(
    JSON.stringify({ error: "invalid_grant", refresh_token: "should-not-leak", extra: "also-not-leak" }),
    { status: 400 },
  )) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error).toContain("invalid_grant");
  expect(r.error).not.toContain("should-not-leak");
  expect(r.error).not.toContain("also-not-leak");
});

test("refreshAccessToken: an error response with a non-JSON body does not leak the body into the message", async () => {
  const f = (async () => new Response("token abc123 leaked in plaintext", { status: 400 })) as unknown as typeof fetch;
  const r = await refreshAccessToken(blob(), f);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error).not.toContain("abc123");
  expect(r.error).toBe("HTTP 400");
});

// parseTierWeight: rateLimitTier → plan multiple (accountPolicy then weighs the remaining
// capacity by this number). It must return `null`, not guess, whenever the shape
// does not match — otherwise a change of the tier format on Anthropic's side would silently send
// the account into the weighted policy with a nonsensical weight.
test("parseTierWeight: recognizes default_claude_max_Nx, otherwise null", () => {
  expect(parseTierWeight("default_claude_max_5x")).toBe(5);
  expect(parseTierWeight("default_claude_max_20x")).toBe(20);
  expect(parseTierWeight("default_claude_max_100x")).toBe(100);
});

test("parseTierWeight: unknown/unparseable tier, missing field → null", () => {
  expect(parseTierWeight("some-other-tier")).toBe(null);
  expect(parseTierWeight("default_claude_max_5x_extra")).toBe(null);
  expect(parseTierWeight("DEFAULT_CLAUDE_MAX_5X")).toBe(null);   // case-sensitive, does not guess
  expect(parseTierWeight("")).toBe(null);
  expect(parseTierWeight(undefined)).toBe(null);
  expect(parseTierWeight(null)).toBe(null);
});

// A multiple of 0 is nonsense (no real plan looks like that) — we treat it just as
// carefully as an unparseable one, not as "zero capacity", which in the weighted
// policy would effectively remove the account from rotation.
test("parseTierWeight: default_claude_max_0x is invalid, not a zero weight", () => {
  expect(parseTierWeight("default_claude_max_0x")).toBe(null);
});

// withTierLabel: the suffix is appended to the end of the label and is IDEMPOTENT — the poller calls it
// on EVERY successful poll (see accountPoller.ts), so a repeated call with the same
// weight must not duplicate the suffix, and a weight change (plan upgrade) must replace the old one.
test("withTierLabel: appends (Max Nx), does not add it twice without a weight change", () => {
  expect(withTierLabel("team@example.com", 5)).toBe("team@example.com (Max 5x)");
  expect(withTierLabel("team@example.com (Max 5x)", 5)).toBe("team@example.com (Max 5x)");
});

test("withTierLabel: a weight change replaces the old suffix, does not add a second one", () => {
  expect(withTierLabel("team@example.com (Max 5x)", 20)).toBe("team@example.com (Max 20x)");
});

test("withTierLabel: an unknown weight (null) leaves the label unchanged, but removes the old suffix", () => {
  expect(withTierLabel("team@example.com", null)).toBe("team@example.com");
  // the account degraded to an unknown tier (e.g. a broken blob) — the old boast no longer applies
  expect(withTierLabel("team@example.com (Max 5x)", null)).toBe("team@example.com");
});
