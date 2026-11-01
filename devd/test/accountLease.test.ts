import { expect, test } from "bun:test";
import { accountsBySession, currentAccount, lastSwitchAt } from "../src/accountLease";
import {
  activeLeases, insertAccount, insertLease, insertSession, isLeaseClient, leaseHistory,
  openDb, pruneAccountLeases, releaseLease, releaseLeasesForSession, type AccountLeaseRow,
} from "../src/db";

const HOUR = 3600_000;

// Since this change a devbox lease relies on the session's STATE, not on the lease's age, so
// a test devbox lease without a matching row in `sessions` would be fiction —
// it would never be active. The helper adds that row.
let portSeq = 40000;
function session(d: ReturnType<typeof openDb>, id: string, status: "running" | "stopped" = "running") {
  insertSession(d, {
    id, folder: "f", project: "p", repo: "r", container: id,
    port_base: (portSeq += 10),   // the column is UNIQUE, so each session gets its own
    status, solo: 0, created_at: 0, last_active_at: 0, important: 0,
  });
}

function db() {
  const d = openDb(":memory:");
  insertAccount(d, { id: "primary", label: "a", disabled: 0, quarantined_at: null, added_at: 0 });
  insertAccount(d, { id: "backup", label: "b", disabled: 0, quarantined_at: null, added_at: 0 });
  return d;
}

test("isLeaseClient lets through only mac and devbox", () => {
  expect(isLeaseClient("mac")).toBe(true);
  expect(isLeaseClient("devbox")).toBe(true);
  expect(isLeaseClient("vps")).toBe(false);
  expect(isLeaseClient(undefined)).toBe(false);
});

test("lease: creation, release, active selection", () => {
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-x-y");
  const a = insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-x-y", label: "x/y", created_at: now, released_at: null });
  const b = insertLease(d, { account_id: "backup", client: "mac", session_id: null, label: "vpsbetter", created_at: now, released_at: null });
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  expect(activeLeases(d, now, 4 * HOUR).map((l) => l.account_id).sort()).toEqual(["backup", "primary"]);

  releaseLease(d, a, now + 60_000);
  expect(activeLeases(d, now + 60_000, 4 * HOUR).map((l) => l.account_id)).toEqual(["backup"]);
});

test("lease: an abandoned one (older than maxAge) does not count as active", () => {
  const d = db();
  const now = 100 * HOUR;
  insertLease(d, { account_id: "backup", client: "mac", session_id: null, label: null, created_at: now - 5 * HOUR, released_at: null });
  insertLease(d, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: now - 1 * HOUR, released_at: null });
  expect(activeLeases(d, now, 4 * HOUR).map((l) => l.account_id)).toEqual(["primary"]);
});

test("lease: the maxAge boundary is INCLUSIVE — exactly at the boundary still active, a ms older no longer", () => {
  const d = db();
  const now = 100 * HOUR;
  // age exactly == maxAgeMs → NOT "older than" maxAge → still active
  insertLease(d, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: now - 4 * HOUR, released_at: null });
  // 1 ms older → IS older than maxAge → abandoned
  insertLease(d, { account_id: "backup", client: "mac", session_id: null, label: null, created_at: now - 4 * HOUR - 1, released_at: null });
  expect(activeLeases(d, now, 4 * HOUR).map((l) => l.account_id)).toEqual(["primary"]);
});

test("releaseLease a second time is a no-op — released_at stays from the first call", () => {
  const d = db();
  const now = 100 * HOUR;
  const a = insertLease(d, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: now, released_at: null });
  releaseLease(d, a, now + 1000);
  releaseLease(d, a, now + 5000); // the second call must not overwrite released_at from the first
  const found = leaseHistory(d, "mac", null).find((l) => l.id === a);
  expect(found?.released_at).toBe(now + 1000);
});

test("releaseLeasesForSession releases all leases of one session", () => {
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-x-y"); session(d, "dev-a-b");
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-x-y", label: null, created_at: now, released_at: null });
  insertLease(d, { account_id: "backup", client: "devbox", session_id: "dev-x-y", label: null, created_at: now, released_at: null });
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-a-b", label: null, created_at: now, released_at: null });
  releaseLeasesForSession(d, "dev-x-y", now + 10);
  expect(activeLeases(d, now + 10, 4 * HOUR).map((l) => l.session_id)).toEqual(["dev-a-b"]);
});

test("leaseHistory: newest first, filters by client and session", () => {
  const d = db();
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-x-y", label: null, created_at: 1, released_at: null });
  insertLease(d, { account_id: "backup", client: "devbox", session_id: "dev-x-y", label: null, created_at: 2, released_at: null });
  insertLease(d, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: 3, released_at: null });
  expect(leaseHistory(d, "devbox", "dev-x-y").map((l) => l.account_id)).toEqual(["backup", "primary"]);
  expect(leaseHistory(d, "mac", null).map((l) => l.account_id)).toEqual(["primary"]);
});

test("leaseHistory: the limit is clamped to <1,100> — 0/negative/non-integer/over 100", () => {
  const d = db();
  for (let i = 1; i <= 110; i++) {
    insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-many", label: null, created_at: i, released_at: null });
  }
  expect(leaseHistory(d, "devbox", "dev-many", 0).length).toBe(1);      // 0 → clamped up to 1
  expect(leaseHistory(d, "devbox", "dev-many", -5).length).toBe(1);     // negative → clamped up to 1
  expect(leaseHistory(d, "devbox", "dev-many", 2.9).length).toBe(2);    // non-integer → trunc to 2
  expect(leaseHistory(d, "devbox", "dev-many", 1000).length).toBe(100); // over 100 → clamped down to 100 (there are 110 rows)
  expect(leaseHistory(d, "devbox", "dev-many").length).toBe(20);        // default limit
});

// Follow-up (docs/account-pool-followups.md): account_leases grows by a few rows
// on every session start and is never pruned. Same pattern as pruneEvents/
// pruneCriticReviews/pruneDiskStats (DELETE by age, called by the periodic stats
// loop in index.ts) — with ONE difference: an active (unreleased) lease MUST NOT
// be deleted regardless of the age of `created_at`, otherwise activeLeases/leaseHistory
// would lose the record of the account the session is actually on. So it prunes by
// `released_at`, not by `created_at`, and only where `released_at` exists at all.
test("pruneAccountLeases: deletes only LONG-closed ones; active (unreleased) and freshly closed survive", () => {
  const d = db();
  const oldClosed = insertLease(d, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: 1000, released_at: 1000 });
  const stillActive = insertLease(d, { account_id: "backup", client: "mac", session_id: null, label: null, created_at: 1000, released_at: null });
  const recentlyClosed = insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-x-y", label: null, created_at: 1000, released_at: Date.now() });

  pruneAccountLeases(d, 60_000); // 1-minute window

  const ids = (d.query("SELECT id FROM account_leases ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  expect(ids).toEqual([stillActive, recentlyClosed]);
  expect(ids).not.toContain(oldClosed);
});

const row = (account_id: string, created_at: number): AccountLeaseRow =>
  ({ id: created_at, account_id, client: "mac", session_id: null, label: null, created_at, released_at: null });

test("currentAccount is the account of the newest lease", () => {
  expect(currentAccount([])).toBe(null);
  expect(currentAccount([row("backup", 30), row("primary", 20)])).toBe("backup");
});

test("lastSwitchAt: when the current account started; null without a switch", () => {
  // still the same account → never switched
  expect(lastSwitchAt([row("primary", 30), row("primary", 20), row("primary", 10)])).toBe(null);
  // backup runs since 20, primary before → the switch at 20 (not at 30)
  expect(lastSwitchAt([row("backup", 30), row("backup", 20), row("primary", 10)])).toBe(20);
  expect(lastSwitchAt([])).toBe(null);
  expect(lastSwitchAt([row("primary", 5)])).toBe(null);
});

// ---------------------------------------------------------------------------
// A devbox lease is governed by the session's STATE, not by the lease's age. Without that every
// session running longer than `maxAgeMs` (= autoStopHours, 4 h) dropped out of the dashboard's
// and the poller's view — measured live: 4 sessions ran for 22–26 h and both accounts reported
// `lease=0`.
// ---------------------------------------------------------------------------

test("a devbox lease of a running session is active even after many times maxAge", () => {
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-long");
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-long", label: null, created_at: now - 26 * HOUR, released_at: null });
  expect(activeLeases(d, now, 4 * HOUR).map((l) => l.account_id)).toEqual(["primary"]);
});

test("a devbox lease of a STOPPED session is not active, even if the lease is fresh", () => {
  // The opposite direction: age on its own must not decide in favour either.
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-stopped", "stopped");
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-stopped", label: null, created_at: now, released_at: null });
  expect(activeLeases(d, now, 4 * HOUR)).toEqual([]);
});

test("a devbox lease without a row in sessions (deleted session) is not active", () => {
  // LEFT JOIN gives status NULL → not included. An orphaned lease would otherwise keep the account
  // occupied forever.
  const d = db();
  const now = 100 * HOUR;
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-missing", label: null, created_at: now, released_at: null });
  expect(activeLeases(d, now, 4 * HOUR)).toEqual([]);
});

test("a mac lease is still governed by the time window — the shim reports no state", () => {
  const d = db();
  const now = 100 * HOUR;
  insertLease(d, { account_id: "primary", client: "mac", session_id: null, label: null, created_at: now - 1 * HOUR, released_at: null });
  insertLease(d, { account_id: "backup", client: "mac", session_id: null, label: null, created_at: now - 5 * HOUR, released_at: null });
  expect(activeLeases(d, now, 4 * HOUR).map((l) => l.account_id)).toEqual(["primary"]);
});

test("a released lease is not active even for a running session", () => {
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-running");
  const id = insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-running", label: null, created_at: now, released_at: null });
  releaseLease(d, id, now + 10);
  expect(activeLeases(d, now + 10, 4 * HOUR)).toEqual([]);
});

// ---------------------------------------------------------------------------
// liveStats() in index.ts (not testable directly — the module has side effects and
// starts the server) builds a session→account map from activeLeases() by calling
// accountsBySession. The real function is tested here, not a copy of it, so that
// a mutation of the production code (e.g. removing the guard on mac leases) reliably
// breaks the test.
// ---------------------------------------------------------------------------

test("accountsBySession: a devbox lease is mapped, a mac lease (session_id NULL) is skipped", () => {
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-x-y");
  insertLease(d, { account_id: "primary", client: "devbox", session_id: "dev-x-y", label: null, created_at: now, released_at: null });
  insertLease(d, { account_id: "backup", client: "mac", session_id: null, label: null, created_at: now, released_at: null });

  const map = accountsBySession(activeLeases(d, now, 4 * HOUR));
  expect(map.get("dev-x-y")).toBe("primary");
  expect(map.size).toBe(1); // the mac lease added no entry
});

test("accountsBySession: a session without an active lease is missing from it (accountId will be null)", () => {
  const d = db();
  const now = 100 * HOUR;
  session(d, "dev-no-account");
  const map = accountsBySession(activeLeases(d, now, 4 * HOUR));
  expect(map.has("dev-no-account")).toBe(false);
});
