import { expect, test } from "bun:test";
import { normalizeResetsAt, parseCodexUsage } from "../src/codexUsage";

// The response shape is GUESSED from structures in the codex binary (RateLimitSnapshot,
// RateLimitWindow, CreditsSnapshot). Once the first live response arrives, replace this
// fixture with it — the difference will show in the diff and the tests will tell what diverged.
const snapshot = {
  limit_name: "codex",
  plan_type: "plus",
  primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1_787_242_200 },
  secondary: { used_percent: 12, window_duration_mins: 10_080, resets_at: 1_787_558_400 },
  credits: { has_credits: true, unlimited: false, balance: 17.5 },
  rate_limit_reached_type: null,
};

// A LIVE response, captured on 20 Aug 2026 from `GET https://chatgpt.com/backend-api/codex/usage`
// (stripped of user_id and e-mail). Until then the shape was guessed from strings in the binary
// and differed in everything that has a name: the windows are `primary_window`/`secondary_window`, the window
// length comes in SECONDS as `limit_window_seconds`, the reset is `reset_at` and `balance`
// is a STRING. What did match was the wrapping shape — scalars at the root, windows under
// `rate_limit` — i.e. exactly what the root fallback was created for.
const LIVE_RESPONSE = {
  account_id: "4d621e3b-c9b1-4c12-b2a1-61cf9bfbbcfe",
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 13, limit_window_seconds: 604_800, reset_after_seconds: 78_375, reset_at: 1_787_315_414 },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0", approx_local_messages: [0, 0] },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null,
  promo: null,
  rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
};

test("parseCodexUsage: live response from chatgpt.com", () => {
  const u = parseCodexUsage(LIVE_RESPONSE)!;
  expect(u.planType).toBe("plus");                       // scalar from the ROOT, windows one level lower
  expect(u.limitReached).toBe(null);
  expect(u.windows).toHaveLength(1);                     // secondary_window is null
  expect(u.windows[0]).toEqual({
    kind: "primary",
    usedPct: 13,
    windowMinutes: 10_080,                               // 604 800 s = 7 days
    resetsAt: 1_787_315_414_000,
  });
  expect(u.credits).toEqual({ balance: 0, unlimited: false, hasCredits: false });   // "0" is a string
});

// `rate_limit_reached_type` was null in the live response, but `limit_reached` is a separate
// boolean one level elsewhere. If only the string were checked, an exhausted quota would pass
// as "Active" — exactly the sentence the card must avoid.
test("parseCodexUsage: limit_reached: true is recognized even without rate_limit_reached_type", () => {
  const u = parseCodexUsage({
    ...LIVE_RESPONSE,
    rate_limit: { ...LIVE_RESPONSE.rate_limit, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1_787_315_414 } },
  })!;
  expect(u.limitReached).not.toBe(null);
  expect(u.windows[0].usedPct).toBe(100);
});

test("parseCodexUsage: both windows, both names of the window-length field", () => {
  const u = parseCodexUsage(snapshot)!;
  expect(u.planType).toBe("plus");
  expect(u.windows).toHaveLength(2);
  expect(u.windows[0]).toEqual({ kind: "primary", usedPct: 42.5, windowMinutes: 300, resetsAt: 1_787_242_200_000 });
  // secondary uses window_duration_mins — a different name, the same field
  expect(u.windows[1]).toEqual({ kind: "secondary", usedPct: 12, windowMinutes: 10_080, resetsAt: 1_787_558_400_000 });
  expect(u.credits).toEqual({ balance: 17.5, unlimited: false, hasCredits: true });
  expect(u.limitReached).toBe(null);
});

test("parseCodexUsage: three root variants, the first with a window wins", () => {
  expect(parseCodexUsage({ rate_limit: snapshot })!.windows).toHaveLength(2);
  expect(parseCodexUsage({ rate_limits: snapshot })!.windows).toHaveLength(2);
  expect(parseCodexUsage(snapshot)!.windows).toHaveLength(2);
});

// I1: precedence and fallback together — exactly the combination the previous test
// never tried (each shape separately), and which hid the bug with the lost plan_type.
test("parseCodexUsage: a root with a window wins even over rate_limit with the same window", () => {
  const payload = {
    primary: { used_percent: 1, window_minutes: 300 },
    rate_limit: { primary: { used_percent: 99, window_minutes: 300 } },
  };
  expect(parseCodexUsage(payload)!.windows[0].usedPct).toBe(1);
});

// I1: RateLimitStatusPayload — plan_type and rate_limit_reached_type sit at the ROOT,
// the window is wrapped under rate_limit. Verified by running the parser exactly on this
// shape (see finding I1) — without the root fallback it came out as planType: null and
// limitReached: null despite the gauge at 100 %.
test("parseCodexUsage: RateLimitStatusPayload — scalars at the root, window under rate_limit", () => {
  const payload = {
    plan_type: "plus",
    rate_limit: { primary: { used_percent: 100, window_minutes: 300 } },
    rate_limit_reached_type: "workspace_member_usage_limit_reached",
  };
  const u = parseCodexUsage(payload)!;
  expect(u.planType).toBe("plus");
  expect(u.windows[0].usedPct).toBe(100);
  expect(u.limitReached).toBe("workspace_member_usage_limit_reached");
});

// Zero is a VALID quota ("nothing used"). If a missing field fell back to 0,
// an empty gauge would read as full capacity — the opposite information to "I don't know".
test("parseCodexUsage: a missing field is null, not zero", () => {
  const u = parseCodexUsage({ primary: { window_minutes: 300 } })!;
  expect(u.windows[0].usedPct).toBe(null);
  expect(u.windows[0].resetsAt).toBe(null);
  expect(u.planType).toBe(null);
  expect(u.credits).toBe(null);
  const zero = parseCodexUsage({ primary: { used_percent: 0, window_minutes: 300 } })!;
  expect(zero.windows[0].usedPct).toBe(0);
});

test("parseCodexUsage: unrecognized shape → null", () => {
  expect(parseCodexUsage(null)).toBe(null);
  expect(parseCodexUsage("nope")).toBe(null);
  expect(parseCodexUsage({})).toBe(null);
  expect(parseCodexUsage({ detail: { code: "deactivated_workspace" } })).toBe(null);
});

test("parseCodexUsage: rate_limit_reached_type is passed through", () => {
  const u = parseCodexUsage({ ...snapshot, rate_limit_reached_type: "workspace_member_usage_limit_reached" })!;
  expect(u.limitReached).toBe("workspace_member_usage_limit_reached");
});

// 10^11 ms = the year 1973, 10^11 s = the year 5138 — no real date lies in between,
// so that boundary safely tells which unit the value came in.
test("normalizeResetsAt: seconds and milliseconds, nonsense → null", () => {
  expect(normalizeResetsAt(1_787_242_200)).toBe(1_787_242_200_000);
  expect(normalizeResetsAt(1_787_242_200_000)).toBe(1_787_242_200_000);
  expect(normalizeResetsAt(null)).toBe(null);
  expect(normalizeResetsAt("tomorrow")).toBe(null);
  expect(normalizeResetsAt(Number.NaN)).toBe(null);
});
