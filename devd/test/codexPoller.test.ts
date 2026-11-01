import { expect, test } from "bun:test";
import { openDb, getCodexUsage, type CodexUsageRow } from "../src/db";
import { accessTokenStale, buildCodexView, codexPollDue, pollCodex, type CodexPollerDeps } from "../src/codexPoller";

const NOW = 1_787_224_361_140;
const DAY = 86_400_000;

const authJson = JSON.stringify({
  auth_mode: "chatgpt", last_refresh: new Date(NOW - DAY).toISOString(),
  tokens: { access_token: "acc-1", account_id: "bc0e4093", id_token: null, refresh_token: "ref-1" },
});

const snapshot = { plan_type: "plus", primary: { used_percent: 42, window_minutes: 300, resets_at: 1_787_242_200 } };

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deps(over: Partial<CodexPollerDeps> = {}): CodexPollerDeps {
  return {
    db: openDb(":memory:"),
    run: async () => ({ code: 0, stdout: authJson, stderr: "" }),
    fetch: (async () => jsonRes(snapshot)) as unknown as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

test("pollCodex: stores the quota and remembers the endpoint", async () => {
  const d = deps();
  await pollCodex(d);
  const r = getCodexUsage(d.db)!;
  expect(r.state).toBe("ok");
  expect(r.plan_type).toBe("plus");
  expect(r.error).toBe(null);
  expect(JSON.parse(r.windows_json)[0].usedPct).toBe(42);
  expect(r.endpoint_idx).toBe(0);
});

test("pollCodex: without auth.json the state is signed-out, not an error", async () => {
  const d = deps({ run: async () => ({ code: 1, stdout: "", stderr: "No such file" }) });
  await pollCodex(d);
  expect(getCodexUsage(d.db)!.state).toBe("signed-out");
});

// I3: a docker failure is NOT "not signed in". Previously EVERY non-zero exit fell back to
// signed-out, so the operator got the advice to run `codex login`, succeeded, and still
// saw "Not signed in" — the cause (daemon not running / image missing / pull failed) was
// elsewhere and `codex login` could not fix it.
test("pollCodex: docker failure (not a missing file) → error with stderr, not signed-out", async () => {
  const d = deps({
    run: async () => ({
      code: 1, stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    }),
  });
  await pollCodex(d);
  const r = getCodexUsage(d.db)!;
  expect(r.state).toBe("error");
  expect(r.error).toContain("Docker daemon");
});

// devd DOES NOT REFRESH the token — OpenAI rotates the refresh token on use and the Codex CLI
// in containers rotates it too. Two parties over one value = silent loss of
// login. An expired token therefore ends up as a state, not as a refresh attempt.
test("pollCodex: expired token → stale-login WITHOUT a network call", async () => {
  let called = 0;
  const stary = JSON.stringify({
    auth_mode: "chatgpt", last_refresh: new Date(NOW - 40 * DAY).toISOString(),
    tokens: { access_token: "acc-1", account_id: "b", id_token: null, refresh_token: "r" },
  });
  const d = deps({
    run: async () => ({ code: 0, stdout: stary, stderr: "" }),
    fetch: (async () => { called++; return jsonRes(snapshot); }) as unknown as typeof fetch,
  });
  await pollCodex(d);
  expect(getCodexUsage(d.db)!.state).toBe("stale-login");
  expect(called).toBe(0);
});

// The last known numbers survive an error. Otherwise the card would go blank on the first 402 and
// the operator would not know whether they had 5 % or 95 % when it broke.
test("pollCodex: an error does not overwrite the last numbers", async () => {
  const d = deps();
  await pollCodex(d);
  const zly = deps({
    db: d.db,
    fetch: (async () => jsonRes({ detail: { code: "deactivated_workspace" } }, 402)) as unknown as typeof fetch,
  });
  await pollCodex(zly);
  const r = getCodexUsage(d.db)!;
  expect(r.state).toBe("error");
  expect(r.error).toBe("deactivated_workspace (HTTP 402)");
  expect(r.plan_type).toBe("plus");
  expect(JSON.parse(r.windows_json)[0].usedPct).toBe(42);
});

// Measured on a live profile on 20 Aug 2026: `id_token` expired at 13:15, `access_token`
// was valid until 30 Aug — i.e. TEN DAYS longer. The poller still reported "stale-login" and
// refused to call, so for ten days the card advised logging in again over a token that
// worked. `id_token` is a short-lived proof of identity, not a measure of access lifetime;
// asking it about that is a mix-up, not an approximation.
test("accessTokenStale: access_token decides, not the short-lived id_token", () => {
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  const expired = Math.floor((NOW - DAY) / 1000);
  const valid = Math.floor((NOW + 10 * DAY) / 1000);

  // exactly the live case: id_token after expiry, access_token still valid for a long time
  expect(accessTokenStale({
    accessToken: jwt(valid), accountId: null, idToken: jwt(expired), lastRefresh: null,
  }, NOW)).toBe(false);

  // and vice versa: an expired access_token is expired, even if id_token is fresh
  expect(accessTokenStale({
    accessToken: jwt(expired), accountId: null, idToken: jwt(valid), lastRefresh: null,
  }, NOW)).toBe(true);

  // an access_token that is not a JWT (exp cannot be read from it) → falls back to id_token
  expect(accessTokenStale({
    accessToken: "not-jwt", accountId: null, idToken: jwt(expired), lastRefresh: null,
  }, NOW)).toBe(true);
});

test("accessTokenStale: by exp in id_token, otherwise by the age of last_refresh", () => {
  const jwt = (exp: number) =>
    `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  expect(accessTokenStale({ accessToken: "a", accountId: null, idToken: jwt(Math.floor((NOW + DAY) / 1000)), lastRefresh: null }, NOW)).toBe(false);
  expect(accessTokenStale({ accessToken: "a", accountId: null, idToken: jwt(Math.floor((NOW - DAY) / 1000)), lastRefresh: null }, NOW)).toBe(true);
  expect(accessTokenStale({ accessToken: "a", accountId: null, idToken: null, lastRefresh: new Date(NOW - DAY).toISOString() }, NOW)).toBe(false);
  expect(accessTokenStale({ accessToken: "a", accountId: null, idToken: null, lastRefresh: new Date(NOW - 40 * DAY).toISOString() }, NOW)).toBe(true);
  // Nothing to decide on = do NOT guess "expired". Let it try and bring the real error.
  expect(accessTokenStale({ accessToken: "a", accountId: null, idToken: null, lastRefresh: null }, NOW)).toBe(false);
});

test("codexPollDue: signed-out/error waits an hour, ok/stale-login is always due", () => {
  const row = (state: CodexUsageRow["state"], fetchedAt: number): CodexUsageRow => ({
    singleton: 1, state, plan_type: null, windows_json: "[]", credits_json: null,
    limit_reached: null, endpoint_idx: null, fetched_at: fetchedAt, error: null,
  });
  expect(codexPollDue(null, NOW)).toBe(true);
  expect(codexPollDue(row("error", NOW - 30 * 60_000), NOW)).toBe(false);
  expect(codexPollDue(row("error", NOW - 61 * 60_000), NOW)).toBe(true);
  expect(codexPollDue(row("signed-out", NOW - 30 * 60_000), NOW)).toBe(false);
  expect(codexPollDue(row("ok", NOW - 30 * 60_000), NOW)).toBe(true);
  expect(codexPollDue(row("stale-login", NOW - 30 * 60_000), NOW)).toBe(true);
});

// Backoff for a permanently broken Codex (today's state of the live login: 402 on
// a deactivated workspace). Without it EVERY tick would start a docker run and EVERY failure
// would hammer chatgpt.com again — on a devbox where Codex is permanently dead that happens
// 288×/day needlessly.
test("pollCodex: a repeated error is not retried within an hour, after an hour it is", async () => {
  let runCalls = 0;
  const run = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
    runCalls++;
    return { code: 0, stdout: authJson, stderr: "" };
  };
  const fetch402 = (async () => jsonRes({ detail: { code: "deactivated_workspace" } }, 402)) as unknown as typeof fetch;

  const d = deps({ run, fetch: fetch402 });
  await pollCodex(d);
  expect(runCalls).toBe(1);
  expect(getCodexUsage(d.db)!.state).toBe("error");

  await pollCodex(deps({ db: d.db, run, fetch: fetch402, now: () => NOW + 5 * 60_000 }));
  expect(runCalls).toBe(1);   // not within the hour — not even docker run was started

  await pollCodex(deps({ db: d.db, run, fetch: fetch402, now: () => NOW + 61 * 60_000 }));
  expect(runCalls).toBe(2);
});

test("buildCodexView: empty DB → null, otherwise the unpacked row", async () => {
  const d = deps();
  expect(buildCodexView(d.db)).toBe(null);
  await pollCodex(d);
  const v = buildCodexView(d.db)!;
  expect(v.state).toBe("ok");
  expect(v.windows[0].windowMinutes).toBe(300);
  expect(v.fetchedAt).toBe(NOW);
});

test("named Codex pool poll records its own weekly history without touching default usage", async () => {
  let saved: CodexUsageRow | null = null;
  const d = deps({ accountId: "backup", accountLabel: "Backup account", store: { get: () => saved, put: (r) => { saved = r; } }, fetch: (async () => jsonRes({ ...snapshot, secondary: { used_percent: 23, window_minutes: 10080, resets_at: NOW / 1000 + DAY / 1000 } })) as unknown as typeof fetch });
  await pollCodex(d);
  expect(getCodexUsage(d.db)).toBeNull();
  const rows = d.db.query("SELECT account_id,window,percent_used FROM weekly_usage_samples").all();
  expect(rows).toEqual([{account_id:"backup",window:"secondary",percent_used:23}]);
});
