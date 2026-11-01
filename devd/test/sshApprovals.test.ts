import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  APPROVAL_TTL_MS, MAX_GRANT_TIMESTAMP, activateApproval, parseGrantDuration, createApproval, decideApproval,
  getApproval, liveGrant, liveKeyGrant, listGrants, reapExpiredGrants, revokeGrant, expiredGrants,
} from "../src/sshApprovals";
import { CONTAINER_UID, createSshAgents } from "../src/sshAgent";

const T0 = 1_700_000_000_000;
function db(): Database { return openDb(":memory:"); }
function mk(d: Database, over: Partial<Parameters<typeof createApproval>[1]> = {}) {
  return createApproval(d, {
    session: "dev-web-app", title: "shop", why: "restart hermes",
    cwd: "/workspace", target: "root@1.2.3.4", project: "web", repo: "app",
    ...over,
  }, T0);
}

test("a new request is pending and expires in 90 s", () => {
  const d = db();
  const id = mk(d);
  expect(getApproval(d, id, T0)!.status).toBe("pending");
  expect(getApproval(d, id, T0)!.expires_at).toBe(T0 + APPROVAL_TTL_MS);
  expect(getApproval(d, id, T0 + APPROVAL_TTL_MS + 1)!.status).toBe("expired");
});

test("expiry is computed lazily — approving after expiry does not help", () => {
  const d = db();
  const id = mk(d);
  const late = T0 + APPROVAL_TTL_MS + 1;
  expect(decideApproval(d, id, { status: "approved", by: "mac" }, late)).toBe(false);
  expect(getApproval(d, id, late)!.status).toBe("expired");
});

test("approval and activation; a second activation of the same id fails", () => {
  const d = db();
  const id = mk(d);
  expect(decideApproval(d, id, { status: "approved", by: "mac" }, T0 + 1000)).toBe(true);
  expect(getApproval(d, id, T0 + 1000)!.decided_by).toBe("mac");
  expect(activateApproval(d, id, "dev-web-app", T0 + 2000)).toBe(true);
  expect(getApproval(d, id, T0 + 2000)!.status).toBe("activated");
  expect(activateApproval(d, id, "dev-web-app", T0 + 3000)).toBe(false);
});

test("a foreign session does not activate the approval", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "ios" }, T0 + 1000);
  expect(activateApproval(d, id, "dev-other-repo", T0 + 2000)).toBe(false);
  expect(getApproval(d, id, T0 + 2000)!.status).toBe("approved");
});

test("a denied request is not activated", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "denied", by: "dashboard" }, T0 + 1000);
  expect(activateApproval(d, id, "dev-web-app", T0 + 2000)).toBe(false);
});

test("a grant applies only to its own session and title and only until grant_until", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(liveGrant(d, "dev-web-app", "shop", "root@1.2.3.4", T0 + 30_000)?.id).toBe(id);
  expect(liveGrant(d, "dev-web-app", "other-key", "root@1.2.3.4", T0 + 30_000)).toBeUndefined();
  expect(liveGrant(d, "dev-other", "shop", "root@1.2.3.4", T0 + 30_000)).toBeUndefined();
  expect(liveGrant(d, "dev-web-app", "shop", "root@1.2.3.4", T0 + 90_000)).toBeUndefined();
});

test("a grant can be revoked early and expired grants can be listed", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(listGrants(d, T0 + 10_000).map((g) => g.id)).toEqual([id]);
  expect(expiredGrants(d, T0 + 90_000).map((g) => g.id)).toEqual([id]);
  revokeGrant(d, id);
  expect(listGrants(d, T0 + 10_000)).toEqual([]);
  expect(expiredGrants(d, T0 + 90_000)).toEqual([]);
});

// I2 (review round 1): without a time cap activateApproval could pick up an approval
// arbitrarily late — even after the grant expired, even after it was revoked. Fix: `now > (grant_until
// ?? expires_at)` rejects.
test("activation inside a running grant passes", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(activateApproval(d, id, "dev-web-app", T0 + 30_000)).toBe(true);
  expect(getApproval(d, id, T0 + 30_000)!.status).toBe("activated");
});

test("activation after grant_until expires fails", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(activateApproval(d, id, "dev-web-app", T0 + 60_001)).toBe(false);
  expect(getApproval(d, id, T0 + 60_001)!.status).toBe("approved");
});

test("activation after revoking the grant falls back to the long-past expires_at and fails", () => {
  const d = db();
  const id = mk(d);
  // One-hour grant — without revoke it would still be running at T0+100_000 (100 000 << 3 600 000).
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 3_600_000 }, T0 + 1000);
  revokeGrant(d, id); // clears grant_until; falls back to expires_at = T0 + 90 000
  expect(activateApproval(d, id, "dev-web-app", T0 + 100_000)).toBe(false);
});

test("an approval without a grant can be activated right away (within the 90s TTL), not later", () => {
  const d = db();
  const idNow = mk(d);
  decideApproval(d, idNow, { status: "approved", by: "mac" }, T0 + 1000);
  expect(activateApproval(d, idNow, "dev-web-app", T0 + 2000)).toBe(true);

  const idLate = mk(d);
  decideApproval(d, idLate, { status: "approved", by: "mac" }, T0 + 1000);
  // expires_at = T0 + 90_000 (no grant); T0 + 90_001 is just past the deadline.
  expect(activateApproval(d, idLate, "dev-web-app", T0 + APPROVAL_TTL_MS + 1)).toBe(false);
});

// Review round 2 finding: revokeGrant used to only clear grant_until, the status
// stayed 'approved'. Revoking a fresh (not yet activated) approval inside the
// original 90s window therefore paradoxically did NOT PREVENT activation — activateApproval fell
// back to expires_at, which had not passed yet. Fix: revokeGrant also sets
// status='revoked', on which activateApproval fails right at the first condition.
test("activation after revokeGrant on a fresh grant fails (even inside the 90s TTL)", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 3_600_000 }, T0 + 1000);
  revokeGrant(d, id);
  // T0 + 2000 is deep inside the original 90s window (expires_at = T0 + 90_000) —
  // without the fix the activation would pass here, even though the grant was explicitly revoked.
  expect(activateApproval(d, id, "dev-web-app", T0 + 2000)).toBe(false);
  expect(getApproval(d, id, T0 + 2000)!.status).toBe("revoked");
});

test("a revoked row is not shown in listGrants", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(listGrants(d, T0 + 10_000).map((g) => g.id)).toEqual([id]);
  revokeGrant(d, id);
  expect(listGrants(d, T0 + 10_000)).toEqual([]);
});

test("a revoked row does not reappear in expiredGrants (the reaper does not loop)", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(expiredGrants(d, T0 + 90_000).map((g) => g.id)).toEqual([id]);
  revokeGrant(d, id);
  expect(expiredGrants(d, T0 + 90_000)).toEqual([]);
});

/* ==================== revokeGrant: guard against silent denial ==================== */
// Review round X finding (DELETE /api/ssh-grants/:id): revokeGrant used to set
// status='revoked' on ANY id, even on a fresh `pending` request the human
// had not even seen yet — that is a silent denial of a legitimate request. Fix: revokeGrant
// now changes the state only of a row that HAS a live/running grant (status IN
// ('approved','activated') AND grant_until IS NOT NULL), and returns whether it revoked anything.

test("revokeGrant on a pending request (grant_until NULL) is a no-op and returns false", () => {
  const d = db();
  const id = mk(d); // fresh, nobody has decided on it yet
  expect(revokeGrant(d, id)).toBe(false);
  expect(getApproval(d, id, T0)!.status).toBe("pending");
});

test("revokeGrant on a live grant (approved + grant_until) succeeds and returns true", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(revokeGrant(d, id)).toBe(true);
  expect(getApproval(d, id, T0 + 1000)!.status).toBe("revoked");
});

test("revokeGrant on an already revoked row behaves sensibly (the second call returns false)", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(revokeGrant(d, id)).toBe(true);
  expect(revokeGrant(d, id)).toBe(false); // nothing more to revoke, but it neither crashes nor breaks anything
  expect(getApproval(d, id, T0 + 1000)!.status).toBe("revoked");
});

test("revokeGrant on a denied request (grant_until also NULL) is a no-op", () => {
  const d = db();
  const id = mk(d);
  decideApproval(d, id, { status: "denied", by: "dashboard" }, T0 + 1000);
  expect(revokeGrant(d, id)).toBe(false);
  expect(getApproval(d, id, T0 + 1000)!.status).toBe("denied");
});

test("revokeGrant on a non-existent id returns false", () => {
  const d = db();
  expect(revokeGrant(d, "missing")).toBe(false);
});

/* ==================== reapExpiredGrants ==================== */
// Previously no test — that is exactly why wrongly keying agents by the bare
// session (see sshAgent.ts) survived a whole review round. It is tested against the REAL
// createSshAgents (with fake run/rm), so the real behaviour of
// kill(session, title) can be verified, not just that it was called with the right arguments.

function fakeAgentDeps() {
  const calls: string[][] = [];
  let pid = 100;
  return {
    calls,
    deps: {
      controlDir: (s: string) => `/ctl/${s}`,
      readKey: (title: string) => `-----BEGIN ${title} KEY-----\n`,
      run: (cmd: string[]) => {
        calls.push(cmd);
        if (cmd[0] === "ssh-agent") return { code: 0, stdout: `SSH_AGENT_PID=${pid++}; export SSH_AGENT_PID;\n`, stderr: "" };
        if (cmd.includes("-L")) return { code: 0, stdout: "ssh-ed25519 AAAAFakeReaperTestIdentity\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      // Container uid → activate() starts ssh-agent/ssh-add directly (without the
      // setpriv wrapper), so cmd[0] === "ssh-agent" above still matches — the tests
      // here verify the reaper's kill/title semantics, not the privilege drop (that has
      // its own coverage in sshAgent.test.ts).
      getuid: () => CONTAINER_UID,
      rm: () => {},
    },
  };
}

test("the reaper does not kill the agent when the session has meanwhile switched to another key (title does not match)", async () => {
  const d = db();
  const idShop = mk(d, { title: "shop" });
  const idOtherKey = mk(d, { title: "other-key" });
  decideApproval(d, idShop, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);
  decideApproval(d, idOtherKey, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);

  const { deps, calls } = fakeAgentDeps();
  const agents = createSshAgents(deps);
  await agents.activate("dev-web-app", "shop");       // pid 100
  await agents.activate("dev-web-app", "other-key");   // cleans up pid 100, starts pid 101 — "other-key" is now active

  // The "shop" grant (idShop) has meanwhile run out — the reaper calls kill(session, "shop") for it,
  // but the running agent (pid 101) now serves "other-key".
  await reapExpiredGrants(d, agents, T0 + 10_000);
  expect(calls.some((c) => c[0] === "kill" && c[1] === "101")).toBe(false);

  // The agent for "other-key" must stay alive — verify it by an explicit kill with
  // the correct title only now actually killing it.
  await agents.kill("dev-web-app", "other-key");
  expect(calls.some((c) => c[0] === "kill" && c[1] === "101")).toBe(true);
});

test("the reaper kills the agent when the grant of the currently active key has expired", async () => {
  const d = db();
  const id = mk(d, { title: "shop" });
  decideApproval(d, id, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);

  const { deps, calls } = fakeAgentDeps();
  const agents = createSshAgents(deps);
  await agents.activate("dev-web-app", "shop"); // pid 100

  await reapExpiredGrants(d, agents, T0 + 10_000);
  expect(calls.some((c) => c[0] === "kill" && c[1] === "100")).toBe(true);
  expect(getApproval(d, id, T0 + 10_000)!.status).toBe("revoked");
});

test("the reaper leaves pending/live grants alone, reports one row's error via onError (not throw) and continues with the next expired row", async () => {
  const d = db();
  const idExpired = mk(d, { title: "shop" });
  const idExpired2 = mk(d, { title: "third-key" });
  const idLive = mk(d, { title: "other-key" });
  decideApproval(d, idExpired, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);
  decideApproval(d, idExpired2, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);
  decideApproval(d, idLive, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);

  const errors: string[] = [];
  // The real `kill` is now async and its realistic failure mode is a REJECTION, not
  // a synchronous throw (review finding) — so the fake here rejects for one specific
  // title and lets the other pass, so we can verify that one row's failure does not stop the other
  // (previously this could only be inferred from the loop not crashing the whole test — now there is
  // a second expired row that must actually succeed).
  const throwingAgents = {
    kill: async (_session: string, title?: string) => { if (title === "shop") throw new Error("EPERM"); },
  };
  await expect(reapExpiredGrants(d, throwingAgents, T0 + 10_000, (id) => errors.push(id))).resolves.toBeUndefined();
  expect(errors).toEqual([idExpired]); // only the failed row
  expect(getApproval(d, idExpired2, T0 + 10_000)!.status).toBe("revoked"); // the second expired row went through fine
  expect(getApproval(d, idLive, T0 + 10_000)!.status).toBe("approved"); // live grant untouched
});

// Final review PR 3 finding: `expiredGrants(db, now)` above is a snapshot taken ONCE,
// but the reaper loop then yields between rows (`await sshAgents.kill`) — in the meantime
// a NEW grant for the SAME session+title as the stale row can get activated,
// and the old implementation would wipe it out with the kill. The test replicates the interleaving
// as the review proposed: the fake `kill` of the first (other) row, while it runs,
// creates and activates a fresh grant for the session+title of the SECOND (stale) row
// — exactly what a real HTTP request could manage between the snapshot and the kill.
test("the reaper does not kill the agent of a grant activated BETWEEN the snapshot and the kill (interleaving)", async () => {
  const d = db();
  const idOther = mk(d, { title: "other-thing" }); // expired row 1 — its kill triggers the interleaving
  const idStale = mk(d, { title: "shop" });     // expired row 2 — the interleaving targets its session+title
  decideApproval(d, idOther, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);
  decideApproval(d, idStale, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);

  let idFresh = "";
  const killCalls: string[] = [];
  const agents = {
    kill: async (session: string, title?: string) => {
      killCalls.push(`${session}:${title}`);
      if (title === "other-thing") {
        // Simulates POST /api/ssh-approvals/:id/activate completing exactly in this
        // window — a new activation of the same session+title as the not yet processed
        // row idStale, with grant_until far in the future.
        idFresh = mk(d, { title: "shop" });
        decideApproval(d, idFresh, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 10_000);
        expect(activateApproval(d, idFresh, "dev-web-app", T0 + 10_000)).toBe(true);
      }
    },
  };

  await reapExpiredGrants(d, agents, T0 + 10_000);

  // kill was called only for the first (other-thing) row — for "shop" the liveGrant
  // re-check right before the kill skipped it, because a live grant appeared in the meantime.
  expect(killCalls).toEqual(["dev-web-app:other-thing"]);
  // The stale row is revoked anyway, even though its agent was not killed — otherwise
  // expiredGrants would keep picking it over and over.
  expect(getApproval(d, idStale, T0 + 10_000)!.status).toBe("revoked");
  // The freshly activated grant stays untouched.
  expect(getApproval(d, idFresh, T0 + 10_000)!.status).toBe("activated");
});

test("grant durations retain presets and custom whole minutes without truncation", () => {
  for (const minutes of [10, 60, 240, 480, 720, 960, 137, 999999]) {
    expect(parseGrantDuration({ grantMinutes: minutes }, T0))
      .toEqual({ grantMinutes: minutes, grantUntil: T0 + minutes * 60_000 });
  }
  expect(parseGrantDuration({}, T0)).toEqual({ grantMinutes: 0 });
  expect(parseGrantDuration({ grantMinutes: 0, grantPermanent: false }, T0)).toEqual({ grantMinutes: 0 });
  expect(parseGrantDuration({ grantPermanent: true }, T0)).toEqual({ grantMinutes: 0, grantPermanent: true });
});

test("malformed or conflicting durations never become permission", () => {
  for (const value of [null, [], "60", -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(parseGrantDuration({ grantMinutes: value }, T0)).toBeNull();
  }
  for (const value of [null, 1, "true", [], {}]) {
    expect(parseGrantDuration({ grantPermanent: value }, T0)).toBeNull();
  }
  for (const body of [null, [], true, { grantMinutes: 60, grantPermanent: true }]) {
    expect(parseGrantDuration(body, T0)).toBeNull();
  }
  const max = Math.floor((MAX_GRANT_TIMESTAMP - T0) / 60_000);
  expect(parseGrantDuration({ grantMinutes: max }, T0)?.grantUntil).toBeLessThanOrEqual(MAX_GRANT_TIMESTAMP);
  expect(parseGrantDuration({ grantMinutes: max + 1 }, T0)).toBeNull();
});

test("permanent approval survives DB reopen, keeps scope, activates late and can be revoked", () => {
  const dir = mkdtempSync(join(tmpdir(), "ssh-permanent-"));
  let d: Database | undefined;
  try {
    const path = join(dir, "devd.sqlite");
    d = openDb(path);
    const id = mk(d);
    expect(decideApproval(d, id, { status: "approved", by: "mac", grantPermanent: true }, T0 + 1000)).toBe(true);
    d.close();
    d = openDb(path);
    const later = T0 + 100 * 365 * 86_400_000;
    expect(getApproval(d, id, later)?.grant_permanent).toBe(1);
    expect(getApproval(d, id, later)?.grant_until).toBeNull();
    expect(liveGrant(d, "dev-web-app", "shop", "root@1.2.3.4", later)?.id).toBe(id);
    expect(liveGrant(d, "other-session", "shop", "root@1.2.3.4", later)).toBeUndefined();
    expect(liveGrant(d, "dev-web-app", "other-key", "root@1.2.3.4", later)).toBeUndefined();
    expect(listGrants(d, later).map((g) => g.id)).toEqual([id]);
    expect(expiredGrants(d, MAX_GRANT_TIMESTAMP)).toEqual([]);
    expect(activateApproval(d, id, "other-session", later)).toBe(false);
    expect(activateApproval(d, id, "dev-web-app", later)).toBe(true);
    expect(activateApproval(d, id, "dev-web-app", later)).toBe(false);
    expect(revokeGrant(d, id)).toBe(true);
    expect(liveGrant(d, "dev-web-app", "shop", "root@1.2.3.4", later)).toBeUndefined();
    expect(listGrants(d, later)).toEqual([]);
    expect(revokeGrant(d, id)).toBe(false);
    expect(getApproval(d, id, later)?.grant_permanent).toBe(0);
  } finally {
    d?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy DB migration preserves pending, timed and one-shot approvals without making them permanent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ssh-migration-"));
  const path = join(dir, "legacy.sqlite");
  let d = new Database(path);
  try {
    d.run(`CREATE TABLE ssh_approvals (
      id TEXT PRIMARY KEY, session_id TEXT, title TEXT NOT NULL, why TEXT NOT NULL,
      target TEXT, cwd TEXT, project TEXT, repo TEXT, status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL,
      grant_until INTEGER)`);
    // Raw INSERT, not createApproval — that one already writes later columns too (server).
    const legacy = (id: string) => {
      d.query(`INSERT INTO ssh_approvals (id, session_id, title, why, target, created_at, expires_at)
        VALUES (?, 'dev-web-app', 'shop', 'x', 'root@1.2.3.4', ?, ?)`).run(id, T0, T0 + APPROVAL_TTL_MS);
      return id;
    };
    const pending = legacy("pending");
    const timed = legacy("timed");
    const once = legacy("once");
    d.query("UPDATE ssh_approvals SET status='approved', grant_until=? WHERE id=?").run(T0 + 60_000, timed);
    d.query("UPDATE ssh_approvals SET status='approved' WHERE id=?").run(once);
    d.close();
    d = openDb(path);
    expect(getApproval(d, pending, T0)?.status).toBe("pending");
    expect(getApproval(d, timed, T0)?.grant_until).toBe(T0 + 60_000);
    expect([pending, timed, once].map((id) => getApproval(d, id, T0)?.grant_permanent)).toEqual([0, 0, 0]);
    expect(listGrants(d, T0).map((g) => g.id)).toEqual([timed]);
    expect(listGrants(d, T0 + 90_001)).toEqual([]);
  } finally {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permanent grant protects the same key from an old timed grant's reaper", async () => {
  const d = db();
  const timed = mk(d);
  const permanent = mk(d);
  decideApproval(d, timed, { status: "approved", by: "mac", grantUntil: T0 + 5000 }, T0 + 1000);
  decideApproval(d, permanent, { status: "approved", by: "mac", grantPermanent: true }, T0 + 1000);
  const calls: string[] = [];
  await reapExpiredGrants(d, { kill: async (session) => { calls.push(session); } }, T0 + 90_000);
  expect(calls).toEqual([]);
  expect(getApproval(d, timed, T0 + 90_000)?.status).toBe("revoked");
  expect(liveGrant(d, "dev-web-app", "shop", "root@1.2.3.4", T0 + 90_000)?.id).toBe(permanent);
});

test("permanent revoke before first activation is terminal; direct invalid decisions are rejected", () => {
  const d = db();
  const id = mk(d);
  for (const decision of [
    { grantPermanent: "true" }, { grantPermanent: true, grantUntil: T0 + 60_000 },
    { grantUntil: Infinity }, { grantUntil: MAX_GRANT_TIMESTAMP + 1 },
  ]) {
    expect(decideApproval(d, id, { status: "approved", by: "mac", ...decision } as never, T0 + 1000)).toBe(false);
    expect(getApproval(d, id, T0 + 1000)?.status).toBe("pending");
  }
  decideApproval(d, id, { status: "approved", by: "mac", grantPermanent: true }, T0 + 1000);
  expect(revokeGrant(d, id)).toBe(true);
  expect(activateApproval(d, id, "dev-web-app", T0 + 2000)).toBe(false);
});

/* ==================== target-bound grants ==================== */
// A grant covers (session, key, normalised target) — not the whole key. Kill paths, however,
// must take into account ANY live grant of the same key (liveKeyGrant): the per-session
// ssh-agent holds the key regardless of the target.

test("liveGrant matches the target exactly; a NULL target covers only a request without a target", () => {
  const d = db();
  const a = mk(d, { target: "root@a:22", server: "a" });
  const none = mk(d, { title: "other", target: null });
  decideApproval(d, a, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  decideApproval(d, none, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  expect(getApproval(d, a, T0)?.server).toBe("a");
  expect(liveGrant(d, "dev-web-app", "shop", "root@a:22", T0 + 2000)?.id).toBe(a);
  expect(liveGrant(d, "dev-web-app", "shop", "root@b:22", T0 + 2000)).toBeUndefined();
  expect(liveGrant(d, "dev-web-app", "shop", null, T0 + 2000)).toBeUndefined();
  expect(liveGrant(d, "dev-web-app", "other", null, T0 + 2000)?.id).toBe(none);
  expect(liveGrant(d, "dev-web-app", "other", "root@a:22", T0 + 2000)).toBeUndefined();
  expect(liveKeyGrant(d, "dev-web-app", "shop", T0 + 2000)?.id).toBe(a);
  expect(liveKeyGrant(d, "dev-web-app", "other", T0 + 2000)?.id).toBe(none);
  expect(liveKeyGrant(d, "dev-other", "shop", T0 + 2000)).toBeUndefined();
});

test("the reaper does not kill the agent when the grant for target A expired and the grant for target B of the same key is live", async () => {
  const d = db();
  const a = mk(d, { target: "root@a:22" });
  const b = mk(d, { target: "root@b:22" });
  decideApproval(d, a, { status: "approved", by: "mac", grantUntil: T0 + 5_000 }, T0 + 1000);
  decideApproval(d, b, { status: "approved", by: "mac", grantUntil: T0 + 60_000 }, T0 + 1000);
  const calls: string[] = [];
  await reapExpiredGrants(d, { kill: async (session) => { calls.push(session); } }, T0 + 10_000);
  expect(calls).toEqual([]);
  expect(getApproval(d, a, T0 + 10_000)?.status).toBe("revoked");
  expect(getApproval(d, b, T0 + 10_000)?.status).toBe("approved");
});

test("an existing DB without the server column is migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "ssh-server-migration-"));
  const path = join(dir, "legacy.sqlite");
  let d = new Database(path);
  try {
    d.run(`CREATE TABLE ssh_approvals (
      id TEXT PRIMARY KEY, session_id TEXT, title TEXT NOT NULL, why TEXT NOT NULL,
      target TEXT, cwd TEXT, project TEXT, repo TEXT, status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL,
      grant_until INTEGER, grant_permanent INTEGER NOT NULL DEFAULT 0 CHECK (grant_permanent IN (0, 1)))`);
    d.query(`INSERT INTO ssh_approvals (id, session_id, title, why, target, created_at, expires_at)
      VALUES ('old', 'dev-web-app', 'shop', 'x', 'root@a:22', ?, ?)`).run(T0, T0 + APPROVAL_TTL_MS);
    d.close();
    d = openDb(path);
    expect(getApproval(d, "old", T0)?.server).toBeNull();
    const fresh = mk(d, { server: "a", target: "root@a:22" });
    expect(getApproval(d, fresh, T0)?.server).toBe("a");
  } finally {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
