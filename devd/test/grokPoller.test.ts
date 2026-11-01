import { expect, test } from "bun:test";
import { openDb, getGrokUsage, type GrokUsageRow } from "../src/db";
import { buildGrokView, grokPollDue, pollGrok, type GrokPollerDeps } from "../src/grokPoller";

const NOW = 1_787_224_361_140;
const DAY = 86_400_000;
const RESET = "2026-08-29T21:20:38+00:00";

const authJson = JSON.stringify({
  "https://auth.x.ai::client-1": {
    key: "jwt-key-1", email: "user@example.com", team_id: "t1",
    refresh_token: "r1", expires_at: new Date(NOW + DAY).toISOString(),
  },
});

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const okFetch = (async (url: unknown) => String(url).includes("/settings")
  ? jsonRes({ subscription_tier_display: "SuperGrok" })
  : jsonRes({ config: { creditUsagePercent: 12, billingPeriodEnd: RESET } })
) as unknown as typeof fetch;

function deps(over: Partial<GrokPollerDeps> = {}): GrokPollerDeps {
  return {
    db: openDb(":memory:"),
    run: async () => ({ code: 0, stdout: authJson, stderr: "" }),
    fetch: okFetch,
    now: () => NOW,
    ...over,
  };
}

test("pollGrok: stores tier, percentage and reset", async () => {
  const d = deps();
  await pollGrok(d);
  const r = getGrokUsage(d.db)!;
  expect(r.state).toBe("ok");
  expect(r.tier).toBe("SuperGrok");
  expect(r.used_pct).toBe(12);
  expect(r.resets_at).toBe(Date.parse(RESET));
  expect(r.error).toBe(null);
});

test("pollGrok: without auth.json the state is signed-out, not an error", async () => {
  const d = deps({ run: async () => ({ code: 1, stdout: "", stderr: "No such file" }) });
  await pollGrok(d);
  expect(getGrokUsage(d.db)!.state).toBe("signed-out");
});

// I3 (same as codexPoller): a docker failure is NOT "not signed in" — the advice
// "sign in" could not fix a cause that lies in docker on the host.
test("pollGrok: docker failure → error with stderr, not signed-out", async () => {
  const d = deps({
    run: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }),
  });
  await pollGrok(d);
  const r = getGrokUsage(d.db)!;
  expect(r.state).toBe("error");
  expect(r.error).toContain("Docker daemon");
});

// devd DOES NOT REFRESH the token — the grok CLI in containers rotates the refresh token and two parties
// over one value mean a silent loss of login (same reason as Codex).
test("pollGrok: expired token → stale-login WITHOUT a network call", async () => {
  let called = 0;
  const stary = JSON.stringify({
    "https://auth.x.ai::client-1": { key: "k", expires_at: new Date(NOW - 1000).toISOString() },
  });
  const d = deps({
    run: async () => ({ code: 0, stdout: stary, stderr: "" }),
    fetch: (async () => { called++; return jsonRes({}); }) as unknown as typeof fetch,
  });
  await pollGrok(d);
  expect(getGrokUsage(d.db)!.state).toBe("stale-login");
  expect(called).toBe(0);
});

test("pollGrok: an error does not overwrite the last numbers", async () => {
  const d = deps();
  await pollGrok(d);
  const zly = deps({
    db: d.db,
    fetch: (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch,
  });
  await pollGrok(zly);
  const r = getGrokUsage(d.db)!;
  expect(r.state).toBe("error");
  expect(r.error).toContain("401");
  expect(r.tier).toBe("SuperGrok");
  expect(r.used_pct).toBe(12);
});

test("grokPollDue: signed-out/error waits an hour, ok/stale-login is always due", () => {
  const row = (state: GrokUsageRow["state"], fetchedAt: number): GrokUsageRow => ({
    singleton: 1, state, tier: null, used_pct: null, resets_at: null,
    fetched_at: fetchedAt, error: null,
  });
  expect(grokPollDue(null, NOW)).toBe(true);
  expect(grokPollDue(row("error", NOW - 30 * 60_000), NOW)).toBe(false);
  expect(grokPollDue(row("error", NOW - 61 * 60_000), NOW)).toBe(true);
  expect(grokPollDue(row("signed-out", NOW - 30 * 60_000), NOW)).toBe(false);
  expect(grokPollDue(row("ok", NOW - 30 * 60_000), NOW)).toBe(true);
  expect(grokPollDue(row("stale-login", NOW - 30 * 60_000), NOW)).toBe(true);
});

// Without the backoff a permanently broken Grok would start an ephemeral container 288×/day —
// the same reason as ERROR_BACKOFF_MS in codexPoller.ts.
test("pollGrok: a repeated error is not retried within an hour, after an hour it is", async () => {
  let runCalls = 0;
  const run = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
    runCalls++;
    return { code: 0, stdout: authJson, stderr: "" };
  };
  const fetch401 = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;

  const d = deps({ run, fetch: fetch401 });
  await pollGrok(d);
  expect(runCalls).toBe(1);
  expect(getGrokUsage(d.db)!.state).toBe("error");

  await pollGrok(deps({ db: d.db, run, fetch: fetch401, now: () => NOW + 5 * 60_000 }));
  expect(runCalls).toBe(1);

  await pollGrok(deps({ db: d.db, run, fetch: fetch401, now: () => NOW + 61 * 60_000 }));
  expect(runCalls).toBe(2);
});

test("buildGrokView: empty DB → null, otherwise the unpacked row", async () => {
  const d = deps();
  expect(buildGrokView(d.db)).toBe(null);
  await pollGrok(d);
  const v = buildGrokView(d.db)!;
  expect(v.state).toBe("ok");
  expect(v.tier).toBe("SuperGrok");
  expect(v.usedPct).toBe(12);
  expect(v.resetsAt).toBe(Date.parse(RESET));
  expect(v.fetchedAt).toBe(NOW);
});

test("Grok successful collector history separates changed login identity and excludes legacy monthly inference", async () => {
  let auth = authJson;
  let time = NOW;
  let calls = 0;
  const d = deps({ now: () => time, run: async () => ({code:0,stdout:auth,stderr:""}), fetch: (async (url: unknown) => {
    calls++;
    return String(url).includes("/settings") ? jsonRes({subscription_tier_display:"SuperGrok"}) : jsonRes({config:{creditUsagePercent:12,currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY",end:RESET}}});
  }) as unknown as typeof fetch });
  await pollGrok(d);
  auth = authJson.replace("user@example.com", "other@example.com"); time++;
  await pollGrok(d);
  expect(d.db.query("SELECT DISTINCT identity_key FROM weekly_usage_samples").all()).toHaveLength(2);
  expect(calls).toBe(4); // only the existing billing/settings requests
  expect(JSON.stringify(d.db.query("SELECT * FROM weekly_usage_samples").all())).not.toContain("@example.com");
});
