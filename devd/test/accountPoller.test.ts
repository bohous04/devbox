import { expect, test } from "bun:test";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";
import { errorBackoffMs, pollAccount, pollAllDue, pollDue, type PollerDeps } from "../src/accountPoller";
import type { ProfileDeps } from "../src/accountProfiles";
import {
  getAccount, getAccountUsage, insertAccount, insertLease, openDb, setAccountOrgId,
  upsertAccountUsage, type AccountUsageRow,
} from "../src/db";

const NOW = 1_800_000_000_000;
const S = ACCOUNT_POOL_DEFAULTS;
const HOUR = 3600_000;

const usage = (over: Partial<AccountUsageRow> = {}): AccountUsageRow => ({
  account_id: "primary", five_hour_pct: 20, five_hour_resets_at: NOW + HOUR,
  seven_day_pct: 30, seven_day_resets_at: NOW + 10 * HOUR,
  limits_json: "[]", fetched_at: NOW, error: null, ...over,
});

test("pollDue: a never-measured account is always due", () => {
  expect(pollDue(null, false, NOW, S)).toBe(true);
});

test("pollDue: active lease ~60 s, idle ~5 min", () => {
  expect(pollDue(usage({ fetched_at: NOW - 30_000 }), true, NOW, S)).toBe(false);
  expect(pollDue(usage({ fetched_at: NOW - 61_000 }), true, NOW, S)).toBe(true);
  expect(pollDue(usage({ fetched_at: NOW - 61_000 }), false, NOW, S)).toBe(false);
  expect(pollDue(usage({ fetched_at: NOW - 301_000 }), false, NOW, S)).toBe(true);
});

test("pollDue: an exhausted account is not polled until resets_at", () => {
  const spent = usage({ five_hour_pct: 95, five_hour_resets_at: NOW + HOUR, fetched_at: NOW - HOUR });
  expect(pollDue(spent, true, NOW, S)).toBe(false);
  // after the reset it is measured right away
  expect(pollDue(spent, true, NOW + HOUR + 1, S)).toBe(true);
});

// The backoff after an error ESCALATES. It used to be fixed (4× idle = 20 min) right from the first error,
// so a single 429 from `/api/oauth/usage` — which the endpoint returns when several clients
// measure the quota from one IP at once, and which passes by itself within a minute — left the dashboard
// showing "Usage unavailable" over stale numbers for twenty minutes.
test("errorBackoffMs: first error after 30 s, then doubling up to the cap of 4× idle", () => {
  expect(errorBackoffMs(1, S)).toBe(30_000);
  expect(errorBackoffMs(2, S)).toBe(60_000);
  expect(errorBackoffMs(3, S)).toBe(120_000);
  expect(errorBackoffMs(6, S)).toBe(960_000);
  expect(errorBackoffMs(7, S)).toBe(1_200_000);   // strop = 4 × 300 s
  expect(errorBackoffMs(99, S)).toBe(1_200_000);  // and stays there (no 2**n overflow)
});

// Rows from an older DB (before the error_count column) and a row written another way carry
// undefined/0 — this must not turn into an infinite backoff or NaN.
test("errorBackoffMs: a missing counter behaves as the first error", () => {
  expect(errorBackoffMs(0, S)).toBe(30_000);
});

test("pollDue: the first error is retried after 30 s, a repeated one only after a longer silence", () => {
  const first = usage({ error: "HTTP 429", error_count: 1, fetched_at: NOW - 20_000 });
  expect(pollDue(first, true, NOW, S)).toBe(false);
  expect(pollDue({ ...first, fetched_at: NOW - 31_000 }, true, NOW, S)).toBe(true);

  // The fifth error in a row = 8 min; ten minutes of silence is already due, half a minute is not.
  const fifth = usage({ error: "HTTP 429", error_count: 5, fetched_at: NOW - 31_000 });
  expect(pollDue(fifth, true, NOW, S)).toBe(false);
  expect(pollDue({ ...fifth, fetched_at: NOW - 600_000 }, true, NOW, S)).toBe(true);
});

test("pollDue: a long series of errors stays at the existing 4× idle, the last numbers remain", () => {
  const failed = usage({ error: "HTTP 500", error_count: 20, fetched_at: NOW - 600_000 });
  expect(pollDue(failed, true, NOW, S)).toBe(false);
  expect(pollDue(failed, true, NOW + 700_000, S)).toBe(true);
  expect(failed.five_hour_pct).toBe(20);
});

// Fix round 1, #1: an exhausted account with an UNKNOWN reset (both fields null) used to never
// be measured again — `resets.length > 0 && ...` was `false` forever. `parseUsage` returns
// `resetsAt: null` whenever the API omits or mangles the field, so this state is
// really reachable and cannot be fixed other than by a new measurement.
test("pollDue: an exhausted account with an unknown reset (null) is measured at the idle cadence, not never", () => {
  const spentUnknownReset = usage({
    five_hour_pct: 95, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null,
    fetched_at: NOW - 301_000,
  });
  expect(pollDue(spentUnknownReset, true, NOW, S)).toBe(true);
  expect(pollDue({ ...spentUnknownReset, fetched_at: NOW - 100_000 }, true, NOW, S)).toBe(false);
});

function deps(over: {
  creds?: string | null;
  fetchImpl?: typeof fetch;
} = {}) {
  const db = openDb(":memory:");
  insertAccount(db, { id: "primary", label: "a", disabled: 0, quarantined_at: null, added_at: 0 });
  const written: string[] = [];
  const profiles: ProfileDeps = {
    run: async (cmd, input) => {
      if (cmd.includes("cat")) {
        const c = over.creds === undefined
          ? JSON.stringify({ claudeAiOauth: { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: NOW + 5 * HOUR } })
          : over.creds;
        return c === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: c, stderr: "" };
      }
      if (input !== undefined) written.push(input);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const d: PollerDeps = {
    db, profiles,
    fetch: over.fetchImpl ?? ((async () => new Response(JSON.stringify({
      limits: [{ kind: "session", percent: 42, is_active: true }],
    }), { status: 200 })) as unknown as typeof fetch),
    now: () => NOW,
    settings: () => S,
    leaseMaxAgeMs: 4 * HOUR,
  };
  return { d, db, written };
}

test("pollAccount: stores the measured numbers and the raw limits_json", async () => {
  const { d, db } = deps();
  await pollAccount(d, "primary");
  const u = getAccountUsage(db, "primary")!;
  expect(u.five_hour_pct).toBe(42);
  expect(u.error).toBe(null);
  expect(u.fetched_at).toBe(NOW);
  expect(JSON.parse(u.limits_json!)[0].kind).toBe("session");
});

test("pollAccount: an error keeps the last numbers, only writes error", async () => {
  const { d, db } = deps({
    fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
  });
  upsertAccountUsage(db, usage({ five_hour_pct: 77 }));
  await pollAccount(d, "primary");
  const u = getAccountUsage(db, "primary")!;
  expect(u.five_hour_pct).toBe(77);      // the old value survived
  expect(u.error).toContain("500");
  expect(getAccount(db, "primary")!.quarantined_at).toBe(null);   // 500 is not quarantine
});

// Fix round 1, #2: `readProfileCredentials` returns `null` both for "the profile was never
// created" and for "docker/volume is unavailable right now" — the return
// value cannot tell them apart. Quarantine at this point would on a docker restart
// knock out both accounts at once; an error without quarantine keeps the account in rotation until
// it is tried again next time.
test("pollAccount: profile cannot be read (missing/docker unavailable) → NOT quarantine, just error", async () => {
  const { d, db } = deps({ creds: null });
  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.quarantined_at).toBe(null);
  expect(getAccountUsage(db, "primary")!.error).toContain("profile");
});

// Contrast to the test above: HERE the profile WAS READ (docker worked), only the content is not
// a valid credentials blob. That is a permanent state — no further poll will fix it —
// so quarantine is appropriate.
test("pollAccount: profile readable, but credentials corrupted → quarantine", async () => {
  const { d, db } = deps({ creds: "this is not JSON" });
  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.quarantined_at).toBe(NOW);
  expect(getAccountUsage(db, "primary")!.error).toContain("credentials");
});

test("pollAccount: an expired access token is refreshed and written back to the profile", async () => {
  const stale = JSON.stringify({
    claudeAiOauth: { accessToken: "old", refreshToken: "ref-1", expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW + 10 * 24 * HOUR },
  });
  const seenTokens: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "acc-new", refresh_token: "ref-2", expires_in: 28800 }), { status: 200 });
    }
    seenTokens.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ limits: [{ kind: "session", percent: 7, is_active: true }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const { d, db, written } = deps({ creds: stale, fetchImpl: f });
  await pollAccount(d, "primary");
  expect(seenTokens[0]).toBe("Bearer acc-new");
  expect(written.length).toBe(1);
  expect(JSON.parse(written[0]).claudeAiOauth.refreshToken).toBe("ref-2");
  expect(getAccountUsage(db, "primary")!.five_hour_pct).toBe(7);
  expect(getAccount(db, "primary")!.quarantined_at).toBe(null);
});

// Fix round 1, #3: a write failure used to be only logged and nothing in the DB kept a trace —
// the next cycle would hit quarantine with a message about the token endpoint, without anything
// pointing to this write a few minutes earlier. The test checks that the error SURVIVES even
// a successful quota read (the numbers are fresh, but `error` reports what failed).
test("pollAccount: a failure to write the refreshed token to the profile is recorded as error", async () => {
  const db = openDb(":memory:");
  insertAccount(db, { id: "primary", label: "a", disabled: 0, quarantined_at: null, added_at: 0 });
  const stale = JSON.stringify({
    claudeAiOauth: { accessToken: "old", refreshToken: "ref-1", expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW + 10 * 24 * HOUR },
  });
  const profiles: ProfileDeps = {
    run: async (cmd) => {
      if (cmd.includes("cat")) return { code: 0, stdout: stale, stderr: "" };
      return { code: 1, stdout: "", stderr: "disk full" };   // writing credentials fails
    },
  };
  const f = (async (url: string) => {
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "acc-new", refresh_token: "ref-2", expires_in: 28800 }), { status: 200 });
    }
    return new Response(JSON.stringify({ limits: [{ kind: "session", percent: 7, is_active: true }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const d: PollerDeps = { db, profiles, fetch: f, now: () => NOW, settings: () => S, leaseMaxAgeMs: 4 * HOUR };

  await pollAccount(d, "primary");
  const u = getAccountUsage(db, "primary")!;
  expect(u.five_hour_pct).toBe(7);              // the quota was still read fresh
  expect(u.error).toContain("writing");         // but error reports the failed write
  expect(getAccount(db, "primary")!.quarantined_at).toBe(null);   // it is not a reason for quarantine
});

// The most valuable missing test according to the review: a transient error (network/5xx from the token endpoint,
// `dead: false`) MUST NOT lead to quarantine — otherwise an outage of a few seconds would knock
// the account out of rotation completely needlessly.
test("pollAccount: a transient token refresh error (5xx) is NOT quarantine", async () => {
  const stale = JSON.stringify({
    claudeAiOauth: { accessToken: "old", refreshToken: "ref-1", expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW + 10 * 24 * HOUR },
  });
  const f = (async (url: string) => {
    if (String(url).includes("/oauth/token")) return new Response("service unavailable", { status: 503 });
    throw new Error("the quota should not have been called without a valid token");
  }) as unknown as typeof fetch;
  const { d, db } = deps({ creds: stale, fetchImpl: f });

  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.quarantined_at).toBe(null);
  expect(getAccountUsage(db, "primary")!.error).toContain("token refresh failed");
});

test("pollAccount: dead refresh token → quarantine, no usage call", async () => {
  const dead = JSON.stringify({
    claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW - 1 },
  });
  let usageCalls = 0;
  const f = (async (url: string) => {
    if (!String(url).includes("/oauth/token")) usageCalls++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const { d, db } = deps({ creds: dead, fetchImpl: f });
  await pollAccount(d, "primary");
  expect(usageCalls).toBe(0);
  expect(getAccount(db, "primary")!.quarantined_at).toBe(NOW);
  expect(getAccountUsage(db, "primary")!.error).toContain("refresh");
});

test("pollAllDue: skips disabled ones and those that are not due", async () => {
  const { d, db } = deps();
  insertAccount(db, { id: "off", label: "v", disabled: 1, quarantined_at: null, added_at: 1 });
  insertAccount(db, { id: "fresh", label: "c", disabled: 0, quarantined_at: null, added_at: 2 });
  upsertAccountUsage(db, usage({ account_id: "fresh", fetched_at: NOW - 10_000 }));
  insertLease(db, { account_id: "fresh", client: "mac", session_id: null, label: null, created_at: NOW, released_at: null });
  expect(await pollAllDue(d)).toEqual(["primary"]);
});

// Follow-up (weighted selection): rateLimitTier is part of EVERY successfully read
// credentials blob, not just of a token refresh — so the poller mirrors it into the DB (weight
// + label) on EVERY poll, so that a plan upgrade/downgrade shows up without manually
// re-adding the account (see accountsApi.test.ts for the registration path).
test("pollAccount: refreshes weight and label from rateLimitTier on EVERY successful poll", async () => {
  const { d, db } = deps({
    creds: JSON.stringify({
      claudeAiOauth: { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: NOW + 5 * HOUR, rateLimitTier: "default_claude_max_20x" },
    }),
  });
  await pollAccount(d, "primary");
  const acct = getAccount(db, "primary")!;
  expect(acct.weight).toBe(20);
  expect(acct.label).toBe("a (Max 20x)");
});

test("pollAccount: a repeated poll with the same tier does not pile up the label suffix", async () => {
  const { d, db } = deps({
    creds: JSON.stringify({
      claudeAiOauth: { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: NOW + 5 * HOUR, rateLimitTier: "default_claude_max_5x" },
    }),
  });
  await pollAccount(d, "primary");
  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.label).toBe("a (Max 5x)");
});

test("pollAccount: a plan upgrade between two polls shows up WITHOUT manually re-adding the account", async () => {
  let tier = "default_claude_max_5x";
  const profiles: ProfileDeps = {
    run: async (cmd, input) => {
      if (cmd.includes("cat")) {
        return {
          code: 0,
          stdout: JSON.stringify({ claudeAiOauth: { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: NOW + 5 * HOUR, rateLimitTier: tier } }),
          stderr: "",
        };
      }
      if (input !== undefined) { /* writing credentials — not checked in this test */ }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const db = openDb(":memory:");
  insertAccount(db, { id: "primary", label: "a", disabled: 0, quarantined_at: null, added_at: 0 });
  const d: PollerDeps = {
    db, profiles,
    fetch: (async () => new Response(JSON.stringify({ limits: [{ kind: "session", percent: 1, is_active: true }] }), { status: 200 })) as unknown as typeof fetch,
    now: () => NOW, settings: () => S, leaseMaxAgeMs: 4 * HOUR,
  };

  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.weight).toBe(5);
  expect(getAccount(db, "primary")!.label).toBe("a (Max 5x)");

  tier = "default_claude_max_20x";   // the operator upgraded the subscription in the meantime
  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.weight).toBe(20);
  expect(getAccount(db, "primary")!.label).toBe("a (Max 20x)");
});

test("pollAccount: unknown/missing rateLimitTier → weight NULL, label without suffix", async () => {
  const { d, db } = deps();   // deps() default has no rateLimitTier
  await pollAccount(d, "primary");
  const acct = getAccount(db, "primary")!;
  expect(acct.weight).toBe(null);
  expect(acct.label).toBe("a");
});

test("pollAllDue: a quarantined account is still tried (so it can dig itself out after a re-login)", async () => {
  const { d, db } = deps();
  insertAccount(db, { id: "isolated", label: "k", disabled: 0, quarantined_at: NOW - HOUR, added_at: 1 });
  expect((await pollAllDue(d)).sort()).toEqual(["isolated", "primary"]);
  expect(getAccount(db, "isolated")!.quarantined_at).toBe(null);   // the profile is readable → out of quarantine
});

// The error counter is the only thing that distinguishes "it hiccupped for the first time" from "it has been broken for a long time" —
// without it the backoff could not escalate and `pollDue` above would have nothing to compute from.
test("pollAccount: errors in a row increase error_count, a success resets it", async () => {
  let fail = true;
  const { d, db } = deps({
    fetchImpl: (async () => (fail
      ? new Response("rate limited", { status: 429 })
      : new Response(JSON.stringify({ limits: [{ kind: "session", percent: 5, is_active: true }] }), { status: 200 })
    )) as unknown as typeof fetch,
  });

  await pollAccount(d, "primary");
  expect(getAccountUsage(db, "primary")!.error_count).toBe(1);
  await pollAccount(d, "primary");
  expect(getAccountUsage(db, "primary")!.error_count).toBe(2);

  fail = false;
  await pollAccount(d, "primary");
  const ok = getAccountUsage(db, "primary")!;
  expect(ok.error).toBe(null);
  expect(ok.error_count).toBe(0);
  expect(ok.five_hour_pct).toBe(5);
});

// Special case: the quota WAS READ, but writing the rotated token to the profile failed.
// `error` is non-empty, so `pollDue` reaches for the backoff — if this state were not
// counted, the backoff would stay at 30 s and devd would keep poking the account forever.
test("pollAccount: an unwritten token counts towards the backoff even though the measurement succeeded", async () => {
  const stale = JSON.stringify({
    claudeAiOauth: { accessToken: "old", refreshToken: "ref-1", expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW + 10 * 24 * HOUR },
  });
  const db = openDb(":memory:");
  insertAccount(db, { id: "primary", label: "a", disabled: 0, quarantined_at: null, added_at: 0 });
  const profiles: ProfileDeps = {
    run: async (cmd) => (cmd.includes("cat")
      ? { code: 0, stdout: stale, stderr: "" }
      : { code: 1, stdout: "", stderr: "disk full" }),
  };
  const f = (async (url: string) => (String(url).includes("/oauth/token")
    ? new Response(JSON.stringify({ access_token: "acc-new", refresh_token: "ref-2", expires_in: 28800 }), { status: 200 })
    : new Response(JSON.stringify({ limits: [{ kind: "session", percent: 7, is_active: true }] }), { status: 200 })
  )) as unknown as typeof fetch;
  const d: PollerDeps = { db, profiles, fetch: f, now: () => NOW, settings: () => S, leaseMaxAgeMs: 4 * HOUR };

  await pollAccount(d, "primary");
  expect(getAccountUsage(db, "primary")!.error_count).toBe(1);
  await pollAccount(d, "primary");
  expect(getAccountUsage(db, "primary")!.error_count).toBe(2);
});

/* ---------- account identity ---------- */

const withOrg = (org: string) => (async () => new Response(
  JSON.stringify({ limits: [{ kind: "session", percent: 5, is_active: true }] }),
  { status: 200, headers: { "anthropic-organization-id": org } },
)) as unknown as typeof fetch;

// An account introduced before this column has no registered organization. The first measurement
// fills it in, otherwise there would be nothing to compare against — and the account would stay unchecked forever.
test("pollAccount: the first measurement fills in a missing registered organization", async () => {
  const { d, db } = deps({ fetchImpl: withOrg("org-A") });
  await pollAccount(d, "primary");
  expect(getAccount(db, "primary")!.org_id).toBe("org-A");
  expect(getAccountUsage(db, "primary")!.org_id).toBe("org-A");
});

// The CORE of the whole safeguard: when the profile gets logged in with a different account, the poller MUST NOT
// overwrite the registered identity with the new one. If it did, the mismatch would cover itself up and
// the swapped profile would pretend it had always been that way — exactly as happened for eight days
// with the max5 profile (11–19 Aug 2026).
test("pollAccount: a swapped profile DOES NOT OVERWRITE the registered organization, only writes the observed one", async () => {
  const { d, db } = deps({ fetchImpl: withOrg("org-A") });
  await pollAccount(d, "primary");
  setAccountOrgId(db, "primary", "org-ORIGINAL");

  const d2 = { ...d, fetch: withOrg("org-OTHER") };
  await pollAccount(d2, "primary");
  expect(getAccount(db, "primary")!.org_id).toBe("org-ORIGINAL");   // the registered one holds
  expect(getAccountUsage(db, "primary")!.org_id).toBe("org-OTHER"); // the observed one changes
});

// A measurement error must not throw away the observed organization — just as it does not throw away the percentages.
test("pollAccount: an error keeps the last known organization", async () => {
  const { d, db } = deps({ fetchImpl: withOrg("org-A") });
  await pollAccount(d, "primary");
  const d2 = { ...d, fetch: (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch };
  await pollAccount(d2, "primary");
  expect(getAccountUsage(db, "primary")!.org_id).toBe("org-A");
});
