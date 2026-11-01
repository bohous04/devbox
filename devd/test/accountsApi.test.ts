import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ApiDeps } from "../src/api";
import { CloneQueue } from "../src/clone";
import { DEFAULT_CONFIG, resolveAccountPool } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import type { ProfileDeps } from "../src/accountProfiles";
import {
  getAccount, insertAccount, insertLease, insertSession, leaseHistory, openDb, setAccountDisabled, upsertAccountUsage, type AccountUsageRow,
} from "../src/db";
import { SessionManager } from "../src/sessions";

const HOUR = 3600_000;

// `poolOver` overrides the pool settings — without it we could only verify that the API
// returns defaults, not that it actually reads the config.
function app(profileRun?: ProfileDeps["run"], poolOver: Partial<ReturnType<typeof resolveAccountPool>> = {}) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-acct-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const listener = { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} };
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const dashboardDir = mkdtempSync(join(tmpdir(), "devd-dash-"));
  writeFileSync(join(dashboardDir, "index.html"), "HELLO");
  const calls: string[][] = [];
  const refreshed: string[] = [];
  const profiles: ProfileDeps = {
    run: profileRun ?? (async (cmd) => {
      calls.push(cmd);
      return cmd.includes("status")
        ? { code: 0, stdout: '{"loggedIn":true,"email":"pool@example.com","orgName":"INFRA","subscriptionType":"max"}', stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    }),
  };
  const deps: ApiDeps = {
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener, notify: () => {},
    stats: () => ({}), cloneQueue, configRepo, dashboardDir,
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    // switchAccount is never called in this test (no test here covers
    // `/api/sessions/:id/switch-account`, see accountSwitch.test.ts and
    // switchAccountApi.test.ts) — a stub just for the type.
    accounts: {
      profiles, leaseMaxAgeMs: () => 4 * HOUR,
      settings: () => ({ ...resolveAccountPool(DEFAULT_CONFIG.settings), ...poolOver }),
      switchAccount: async () => ({ status: "unknown-session" }),
      refresh: async (id) => { refreshed.push(id); },
    },
  };
  return { a: createApp(deps), db, calls, refreshed };
}

const usage = (id: string, five: number, over: Partial<AccountUsageRow> = {}): AccountUsageRow => ({
  account_id: id, five_hour_pct: five, five_hour_resets_at: Date.now() + HOUR,
  seven_day_pct: 10, seven_day_resets_at: Date.now() + 10 * HOUR,
  limits_json: '[{"kind":"session","percent":' + five + ',"severity":"ok","resetsAt":null,"modelName":null,"isActive":true}]',
  fetched_at: Date.now(), error: null, ...over,
});

function seed(db: ReturnType<typeof openDb>) {
  insertAccount(db, { id: "primary", label: "a@x.cz", disabled: 0, quarantined_at: null, added_at: 1 });
  insertAccount(db, { id: "backup", label: "b@x.cz", disabled: 0, quarantined_at: null, added_at: 2 });
  upsertAccountUsage(db, usage("primary", 70));
  upsertAccountUsage(db, usage("backup", 20));
}

test("GET /api/accounts: account state including limits[] and empty leases", async () => {
  const { a, db } = app();
  seed(db);
  const r = await a.request("/api/accounts");
  expect(r.status).toBe(200);
  const { accounts } = (await r.json()) as { accounts: { id: string; label: string; fiveHourPct: number; limits: unknown[]; leases: unknown[]; quarantined: boolean; fetchedAt: number | null; error: string | null }[] };
  expect(accounts.map((x) => x.id)).toEqual(["primary", "backup"]);
  expect(accounts[0].fiveHourPct).toBe(70);
  expect(accounts[0].limits.length).toBe(1);
  expect(accounts[0].leases).toEqual([]);
  expect(accounts[0].quarantined).toBe(false);
  // operator visibility (error/fetchedAt) — mitigation of a permanently failing account
  // relies on these fields (see toCandidates), they must really be visible in the response
  expect(accounts[0].error).toBeNull();
  expect(typeof accounts[0].fetchedAt).toBe("number");
});

test("GET /api/accounts/lease: picks the less loaded account and creates a lease", async () => {
  const { a, db } = app();
  seed(db);
  const r = await a.request("/api/accounts/lease?client=devbox&session=dev-x-y&label=x%2Fy");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ accountId: "backup", label: "b@x.cz", exhausted: false });
  const h = leaseHistory(db, "devbox", "dev-x-y");
  expect(h.length).toBe(1);
  expect(h[0].account_id).toBe("backup");
  expect(h[0].label).toBe("x/y");
});

// Regression test (review round 1, I1): DEVD_SESSION_ID is a container-level env,
// so main/main-2/main-3 in ONE container share the same sessionId and each
// requests its OWN lease on its agent launch. The endpoint once got (and review
// caught) a wrong fix that released ALL existing leases of the same sessionId
// before the insert — the second sub-session would drop the first one's lease, the poller
// would put the account into the idle cadence and switchAlerts would stop reporting the session
// that actually needs help. The endpoint no longer releases anything (the dedicated
// switchAccount does that, and only after a verified restart) — this test guards it.
test("lease: a second call with the same sessionId (sub-session main-2) does NOT release the first one's lease (main)", async () => {
  const { a, db } = app();
  seed(db);   // primary 70, backup 20
  const r1 = await a.request("/api/accounts/lease?client=devbox&session=dev-x-y&label=main");
  expect((await r1.json() as { accountId: string }).accountId).toBe("backup");
  // The account does not change in the meantime (both calls with the same sessionId), so the second
  // call lands on the SAME account — exactly this "same account, different sub-session"
  // case used to trigger the wrong release.
  const r2 = await a.request("/api/accounts/lease?client=devbox&session=dev-x-y&label=main-2");
  expect((await r2.json() as { accountId: string }).accountId).toBe("backup");

  const active = leaseHistory(db, "devbox", "dev-x-y").filter((l) => l.released_at === null);
  expect(active.length).toBe(2);
  expect(active.map((l) => l.label).sort()).toEqual(["main", "main-2"]);
});

test("lease: hysteresis keeps the current account, force overrides it", async () => {
  const { a, db } = app();
  seed(db);   // primary 70, backup 20
  // 1) the first lease lands on the less loaded backup
  const first = (await (await a.request("/api/accounts/lease?client=mac")).json()) as { accountId: string };
  expect(first.accountId).toBe("backup");
  // 2) primary drops to 15 — 5 pp better, which is BELOW the margin of 10
  upsertAccountUsage(db, usage("primary", 15));
  const stay = (await (await a.request("/api/accounts/lease?client=mac")).json()) as { accountId: string };
  expect(stay.accountId).toBe("backup");
  // 3) a manual switch overrides hysteresis
  const forced = (await (await a.request("/api/accounts/lease?client=mac&force=1")).json()) as { accountId: string };
  expect(forced.accountId).toBe("primary");
});

test("lease: all accounts above the threshold → nearest reset + exhausted, still 200", async () => {
  const { a, db } = app();
  seed(db);
  const now = Date.now();
  upsertAccountUsage(db, usage("primary", 95, { five_hour_resets_at: now + 3 * HOUR }));
  upsertAccountUsage(db, usage("backup", 99, { five_hour_resets_at: now + 1 * HOUR }));
  const r = await a.request("/api/accounts/lease?client=devbox&session=dev-x-y");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ accountId: "backup", label: "b@x.cz", exhausted: true });
});

test("lease: no account → accountId null and 200 (the client runs on the default profile)", async () => {
  const { a } = app();
  const r = await a.request("/api/accounts/lease?client=mac");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ accountId: null, label: null, exhausted: true });
});

test("lease: an invalid client is 400", async () => {
  const { a } = app();
  expect((await a.request("/api/accounts/lease?client=vps")).status).toBe(400);
  expect((await a.request("/api/accounts/lease")).status).toBe(400);
});

test("lease: a pinned project gets its account even when it is more loaded", async () => {
  const { a, db } = app(undefined, { projectAccounts: { shop: "primary" } });
  seed(db);   // primary 70 %, backup 20 %
  insertSession(db, {
    id: "dev-shop-app", folder: "acme", project: "shop", repo: "app", container: "dev-shop-app",
    port_base: 41900, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });
  const r = await a.request("/api/accounts/lease?client=devbox&session=dev-shop-app&label=shop%2Fapp");
  expect((await r.json() as { accountId: string }).accountId).toBe("primary");
});

test("lease: mac (without a session) ignores pinning and does not get the reserved account", async () => {
  const { a, db } = app(undefined, { projectAccounts: { shop: "primary" } });
  seed(db);   // primary is more loaded, but above all it is RESERVED for shop
  const r = await a.request("/api/accounts/lease?client=mac");
  expect((await r.json() as { accountId: string }).accountId).toBe("backup");
});

test("POST /api/accounts: provisions the profile and names the account from claude auth status", async () => {
  const { a, db, calls } = app();
  const r = await a.request("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", credentials: '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1}}' }),
  });
  expect(r.status).toBe(201);
  expect(await r.json()).toEqual({ id: "primary", label: "pool@example.com (INFRA)" });
  expect(getAccount(db, "primary")!.label).toBe("pool@example.com (INFRA)");
  // credentials went to STDIN, not into argv
  expect(calls.flat().join(" ")).not.toContain("accessToken");
});

// Follow-up (weighted selection): it confused the operator that the SMALLER account is named "primary" —
// so the label carries the plan, derived from the same `rateLimitTier` that is also stored
// as `weight` for accountPolicy. Without credentials.claudeAiOauth.rateLimitTier
// (see the test above) both label and weight stay unchanged — this test extends it with a
// blob that DOES carry the tier.
test("POST /api/accounts: rateLimitTier is stored as the weight and appended to the label", async () => {
  const { a, db } = app();
  const r = await a.request("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "primary",
      credentials: '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1,"rateLimitTier":"default_claude_max_20x"}}',
    }),
  });
  expect(r.status).toBe(201);
  expect(await r.json()).toEqual({ id: "primary", label: "pool@example.com (INFRA) (Max 20x)" });
  const acct = getAccount(db, "primary")!;
  expect(acct.label).toBe("pool@example.com (INFRA) (Max 20x)");
  expect(acct.weight).toBe(20);
});

test("POST /api/accounts: a manual label also gets the plan suffix", async () => {
  const { a, db } = app();
  const r = await a.request("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "primary", label: "My name",
      credentials: '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1,"rateLimitTier":"default_claude_max_5x"}}',
    }),
  });
  expect((await r.json() as { label: string }).label).toBe("My name (Max 5x)");
  expect(getAccount(db, "primary")!.weight).toBe(5);
});

test("POST /api/accounts: unknown/missing rateLimitTier → weight NULL, label unchanged", async () => {
  const { a, db } = app();
  const r = await a.request("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "primary",
      credentials: '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1,"rateLimitTier":"some-other-tier"}}',
    }),
  });
  expect((await r.json() as { label: string }).label).toBe("pool@example.com (INFRA)");
  expect(getAccount(db, "primary")!.weight).toBe(null);
});

test("POST /api/accounts: validation of id, duplicates and missing credentials", async () => {
  const { a } = app();
  const post = (body: unknown) => a.request("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post({ id: "../evil", credentials: "{}" })).status).toBe(400);
  expect((await post({ id: "ok" })).status).toBe(400);
  expect((await post({ id: "ok", credentials: "not json" })).status).toBe(400);
  const good = { id: "ok", credentials: '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1}}' };
  expect((await post(good)).status).toBe(201);
  expect((await post(good)).status).toBe(409);   // duplicate
});

test("POST /api/accounts/:id/disable and DELETE /api/accounts/:id", async () => {
  const { a, db } = app();
  seed(db);
  const off = await a.request("/api/accounts/backup/disable", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: true }),
  });
  expect(off.status).toBe(204);
  expect(getAccount(db, "backup")!.disabled).toBe(1);
  // a disabled account must not end up in a lease
  const lease = (await (await a.request("/api/accounts/lease?client=mac")).json()) as { accountId: string };
  expect(lease.accountId).toBe("primary");

  const del = await a.request("/api/accounts/backup", { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(await del.json()).toEqual({ removal: "removed", leftoverVolume: null });
  expect(getAccount(db, "backup")).toBe(null);
  expect((await a.request("/api/accounts/unknown", { method: "DELETE" })).status).toBe(404);
  expect((await a.request("/api/accounts/unknown/disable", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: true }),
  })).status).toBe(404);
});

// Rebuilding the container is the only way to get a removed account's mount out of a RUNNING
// session (stop leaves the container in place with the mount, end deletes the worktree
// and the transcripts). The route must answer 404 to an unknown id, not try to build.
test("POST /api/sessions/:id/recreate: an unknown session is 404", async () => {
  const { a } = app();
  const r = await a.request("/api/sessions/missing/recreate", { method: "POST" });
  expect(r.status).toBe(404);
  expect((await r.json() as { error: string }).error).toContain("unknown session");
});

// Regression: on a devbox with running sessions EVERY container mounts ALL profiles,
// so `docker volume rm` refuses every time and removing an account ended with 502 — the account
// could not be removed while a single session was running. Now the profile stays as an empty
// shell, the row disappears and the response says which volume to delete after recreate.
test("DELETE /api/accounts/:id succeeds even when running sessions hold the volume", async () => {
  const cmds: string[][] = [];
  const { a, db } = app(async (cmd) => {
    cmds.push(cmd);
    return cmd[0] === "volume"
      ? { code: 1, stdout: "", stderr: "Error response from daemon: remove claude-acct-backup: volume is in use - [abc]" }
      : { code: 0, stdout: "", stderr: "" };
  });
  seed(db);
  const r = await a.request("/api/accounts/backup", { method: "DELETE" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ removal: "purged", leftoverVolume: "claude-acct-backup" });
  expect(getAccount(db, "backup")).toBe(null);
  expect(cmds.at(-1)).toContain("-delete");
});

// When docker fails for another reason we know nothing about the profile — the row MUST stay,
// otherwise a live refresh token would survive on disk with nothing pointing to it.
test("DELETE /api/accounts/:id: another docker failure is 502 and the account stays", async () => {
  const { a, db } = app(async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }));
  seed(db);
  expect((await a.request("/api/accounts/backup", { method: "DELETE" })).status).toBe(502);
  expect(getAccount(db, "backup")).not.toBe(null);
});

test("disable: missing/invalid 'disabled' is 400, NOT a silent enable", async () => {
  const { a, db } = app();
  seed(db);
  setAccountDisabled(db, "backup", 1);   // disabled manually, the request then tries to break it
  const post = (body?: string) => a.request("/api/accounts/backup/disable", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  expect((await post("this is not json")).status).toBe(400);
  expect((await post(JSON.stringify({}))).status).toBe(400);
  expect((await post(JSON.stringify({ disabled: "yes" }))).status).toBe(400);
  // none of the bad requests may silently re-enable the account
  expect(getAccount(db, "backup")!.disabled).toBe(1);
});

test("without a configured pool it returns 503, not a crash (older deployments)", async () => {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-acct2-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const noPool = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [],
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} },
    notify: () => {}, stats: () => ({}),
    cloneQueue: new CloneQueue({ db, root, tree: async () => [] }),
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: { build: async () => "/tmp/x", restore: async () => {} },
  });
  expect((await noPool.request("/api/accounts")).status).toBe(503);
  expect((await noPool.request("/api/accounts/lease?client=mac")).status).toBe(503);
  expect((await noPool.request("/api/accounts/nekdo", { method: "DELETE" })).status).toBe(503);
});

// Fix from review round 1 (item 4): `leaseMaxAgeMs` in index.ts used to be computed from the
// STARTUP config snapshot (`cfg.settings.autoStopHours`), while right next to it
// (`settings: () => resolveAccountPool(freshCfg().settings)`) the config is read
// fresh — a change of `autoStopHours` from the dashboard would only reach lease expiry
// after a devd restart. Fix: `leaseMaxAgeMs` is now a FUNCTION, called
// on every request — this test proves it with two consecutive
// requests with the same (90 min old) lease, only with a changed value in between.
test("GET /api/accounts: leaseMaxAgeMs is re-read on every request, not just once at startup", async () => {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-acct3-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  insertAccount(db, { id: "primary", label: "a@x.cz", disabled: 0, quarantined_at: null, added_at: 1 });
  // A MAC lease on purpose: since the activeLeases change (devbox follows the
  // session state, not the lease age) `leaseMaxAgeMs` applies ONLY to the mac client. With a devbox
  // lease this test would not measure config freshness, just that a row is missing
  // in `sessions`. The property under test — config is read on EVERY request, not
  // once at startup — stays unchanged.
  insertLease(db, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: Date.now() - 90 * 60_000, released_at: null });

  let maxAgeMs = 4 * HOUR;   // the 90-minute lease is inside
  const a = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [],
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} },
    notify: () => {}, stats: () => ({}),
    cloneQueue: new CloneQueue({ db, root, tree: async () => [] }),
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    accounts: {
      profiles: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      leaseMaxAgeMs: () => maxAgeMs,
      settings: () => resolveAccountPool(DEFAULT_CONFIG.settings),
      switchAccount: async () => ({ status: "unknown-session" }),
      refresh: async () => {},
    },
  });

  const before = (await (await a.request("/api/accounts")).json()) as { accounts: { leases: unknown[] }[] };
  expect(before.accounts[0].leases.length).toBe(1);

  maxAgeMs = 60 * 60_000;   // "dashboard" shortened the window below 90 minutes without a restart
  const after = (await (await a.request("/api/accounts")).json()) as { accounts: { leases: unknown[] }[] };
  expect(after.accounts[0].leases.length).toBe(0);
});

// I5 (review round 4): a sister test to the previous one, just for `thresholdPct`
// instead of `autoStopHours`. `d.cfg` is the startup SNAPSHOT (see the index.ts constructor)
// — if the lease endpoint still read ITS `settings`, a dashboard threshold change would
// only apply after a devd restart. A single account in the pool: `accountId` stays
// the same in both policy branches ("best" and "all-exhausted"), only `exhausted`
// differs depending on WHICH threshold was used — `true` proves a fresh read.
test("GET /api/accounts/lease: decides by the FRESH thresholdPct from acc.settings(), not the startup cfg.settings", async () => {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-acct4-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  insertAccount(db, { id: "primary", label: "a@x.cz", disabled: 0, quarantined_at: null, added_at: 1 });
  upsertAccountUsage(db, usage("primary", 92));   // 92 % — above the new threshold (90), below the old one (95)

  // The construction-time cfg snapshot says the threshold is 95 % — the bug before the fix would still
  // trust it, even though the dashboard meanwhile (without a devd restart) lowered it to 90 %.
  const staleCfg = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, accountPool: { ...resolveAccountPool(DEFAULT_CONFIG.settings), thresholdPct: 95 } } };
  const a = createApp({
    mgr, db, cfg: staleCfg, root, tree: async () => [],
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} },
    notify: () => {}, stats: () => ({}),
    cloneQueue: new CloneQueue({ db, root, tree: async () => [] }),
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    accounts: {
      profiles: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      leaseMaxAgeMs: () => 4 * HOUR,
      settings: () => ({ ...resolveAccountPool(DEFAULT_CONFIG.settings), thresholdPct: 90 }),
      switchAccount: async () => ({ status: "unknown-session" }),
      refresh: async () => {},
    },
  });

  const r = await a.request("/api/accounts/lease?client=devbox&session=dev-x-y");
  const body = (await r.json()) as { accountId: string | null; exhausted: boolean };
  expect(body.accountId).toBe("primary");
  expect(body.exhausted).toBe(true);
});

test("NO accounts endpoint returns a token", async () => {
  const { a, db } = app();
  seed(db);
  await a.request("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "treti", credentials: '{"claudeAiOauth":{"accessToken":"SECRET-TOKEN","refreshToken":"SECRET-REFRESH","expiresAt":1}}' }),
  });
  // Hono types `a.request()` as `Response | Promise<Response>` (a union) — a direct
  // `.then` on it does not pass tsc, hence an async IIFE that awaits it first.
  const bodies = await Promise.all([
    (async () => (await a.request("/api/accounts")).text())(),
    (async () => (await a.request("/api/accounts/lease?client=devbox&session=dev-x-y")).text())(),
  ]);
  for (const b of bodies) {
    expect(b).not.toContain("SECRET-TOKEN");
    expect(b).not.toContain("SECRET-REFRESH");
    expect(b).not.toContain("accessToken");
    expect(b).not.toContain("refreshToken");
  }
});

test("GET /api/accounts also returns the pool settings — the dashboard must not guess the threshold or the preference", async () => {
  // Non-default values on purpose: with defaults the test would pass even if the handler
  // hardcoded the numbers instead of taking them from the config.
  const { a, db } = app(undefined, {
    thresholdPct: 75, spilloverPct: 40, preferredAccountId: "backup",
    projectAccounts: { games: "backup" }, soloAccountId: "backup",
  });
  seed(db);
  const r = await a.request("/api/accounts");
  expect(r.status).toBe(200);
  const { pool } = (await r.json()) as {
    pool: {
      thresholdPct: number; spilloverPct: number; preferredAccountId: string | null;
      projectAccounts: Record<string, string>; soloAccountId: string | null;
    };
  };
  expect(pool).toEqual({
    thresholdPct: 75, spilloverPct: 40, preferredAccountId: "backup",
    projectAccounts: { games: "backup" }, soloAccountId: "backup",
  });
});

// The manual "Refresh" on the account card. It exists because the poller stays silent after an error (a 429 from
// `/api/oauth/usage` is common when several clients measure quota from one IP at once) and
// until the backoff ends the dashboard shows stale numbers under "Usage unavailable".
test("POST /api/accounts/:id/refresh: re-measures the account and returns its new view", async () => {
  const { a, db, refreshed } = app();
  seed(db);
  const r = await a.request("/api/accounts/primary/refresh", { method: "POST" });
  expect(r.status).toBe(200);
  expect(refreshed).toEqual(["primary"]);
  const { account } = (await r.json()) as { account: { id: string; fiveHourPct: number } };
  expect(account.id).toBe("primary");
  expect(account.fiveHourPct).toBe(70);
});

// A disabled account is NOT polled regularly (pollAllDue skips it) — a manual re-measure
// does make sense on it though: before returning it to rotation you want to see how much is left.
test("refresh: works on a disabled account too, an unknown id is 404", async () => {
  const { a, db, refreshed } = app();
  seed(db);
  setAccountDisabled(db, "backup", 1);
  expect((await a.request("/api/accounts/backup/refresh", { method: "POST" })).status).toBe(200);
  expect(refreshed).toEqual(["backup"]);
  expect((await a.request("/api/accounts/unknown/refresh", { method: "POST" })).status).toBe(404);
});

/* ---------- replacing credentials of an existing account ---------- */

// Why the endpoint exists at all: a switched profile (logged in with a different account than the one
// it is registered under) could not be fixed otherwise. `POST /api/accounts` on an existing id returns 409,
// `DELETE` deletes the VOLUME and `docker volume rm` refuses to delete it while a single
// session is running — each one mounts all profiles. Fixing it would mean taking down the whole devbox.
test("POST /api/accounts/:id/credentials: overwrites the profile and re-stamps the identity", async () => {
  const written: (string | undefined)[] = [];
  const { a, db, refreshed } = app(async (cmd, input) => {
    if (cmd.includes("status")) {
      return { code: 0, stdout: '{"loggedIn":true,"email":"spravny@example.com","orgName":"INFRA","orgId":"org-SPRAVNA","subscriptionType":"max"}', stderr: "" };
    }
    written.push(input);
    return { code: 0, stdout: "", stderr: "" };
  });
  insertAccount(db, { id: "max5", label: "puvodni@x.cz (Max 20x)", disabled: 0, quarantined_at: 12345, added_at: 1, weight: 20, org_id: "org-STARA" });

  const blob = '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1,"rateLimitTier":"default_claude_max_5x"}}';
  const r = await a.request("/api/accounts/max5/credentials", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credentials: blob }),
  });
  expect(r.status).toBe(200);

  expect(written).toContain(blob);                 // the blob went into the profile…
  const row = getAccount(db, "max5")!;
  // …and the old reference point for the identity watcher is gone. Only the poller may fill it in
  // from a measurement (`refresh` below), not `claude auth status`: that reports the PERSONAL organization
  // of the logged-in e-mail, whereas the watcher compares the organization the quota is BILLED to.
  // For a seat in a foreign organization the two differ permanently and the card would report "Profile
  // switched accounts" even on a healthy account.
  expect(row.org_id).toBe(null);
  expect(row.label).toContain("spravny@example.com");
  expect(row.weight).toBe(5);                      // plan from the new blob
  expect(row.quarantined_at).toBe(null);           // a new login clears the quarantine reason
  expect(refreshed).toEqual(["max5"]);             // re-measured right away so the card does not show leftovers
});

// The input came from the terminal with a trailing `%`, which zsh draws after output without
// a newline. `JSON.parse` used to die on it and the field reported "must be the contents of
// .credentials.json with claudeAiOauth" over text that was exactly that. Also, the cleaned blob
// must go into the profile — with the leftover Claude Code in the container would not read it.
test("replacing credentials: a trailing % from the terminal passes and a clean blob goes into the profile", async () => {
  const written: (string | undefined)[] = [];
  const { a, db } = app(async (cmd, input) => {
    if (cmd.includes("status")) return { code: 0, stdout: '{"loggedIn":true,"email":"x@example.com","orgId":"org-1"}', stderr: "" };
    written.push(input);
    return { code: 0, stdout: "", stderr: "" };
  });
  seed(db);
  const blob = '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1}}';
  const r = await a.request("/api/accounts/primary/credentials", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credentials: blob + "%" }),
  });
  expect(r.status).toBe(200);
  expect(written).toContain(blob);
  expect(written.join("")).not.toContain("%");
});

// The message must say WHAT it is — otherwise for a pasted blob you cannot tell whether
// the copy got cut off or it is a completely different file.
test("replacing credentials: the message distinguishes broken JSON from a different file", async () => {
  const { a, db } = app();
  seed(db);
  const post = (creds: string) => a.request("/api/accounts/primary/credentials", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credentials: creds }),
  });
  expect(await (await post("{\"claudeAiOauth\":")).json()).toMatchObject({ error: expect.stringContaining("are not valid JSON") });
  expect(await (await post('{"something":"else"}')).json()).toMatchObject({ error: expect.stringContaining("claudeAiOauth") });
  expect(await (await post("   ")).json()).toMatchObject({ error: expect.stringContaining("are empty") });
});

test("replacing credentials: unknown account 404, nonsense blob 400, the profile is not touched", async () => {
  const written: (string | undefined)[] = [];
  const { a, db } = app(async (cmd, input) => {
    if (!cmd.includes("status")) written.push(input);
    return { code: 0, stdout: '{"loggedIn":true}', stderr: "" };
  });
  seed(db);
  const post = (id: string, body: unknown) => a.request(`/api/accounts/${id}/credentials`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post("missing", { credentials: "{}" })).status).toBe(404);
  expect((await post("primary", { credentials: "this is not JSON" })).status).toBe(400);
  expect((await post("primary", {})).status).toBe(400);
  expect(written).toEqual([]);
});
