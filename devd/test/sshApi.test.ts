import { expect, test } from "bun:test";
import { getConnInfo } from "hono/bun";
import { createApp } from "../src/api";
import { memoAsyncStrict } from "../src/cache";
import { OpRateLimited } from "../src/opRateLimit";
import { fakeDeps } from "./helpers/apiHarness";
import { insertSession } from "../src/db";
import { AgentEventHub } from "../src/agentEvents";
import { APPROVAL_TTL_MS, pendingSshLabel } from "../src/sshApprovals";

function harness(over: Partial<Parameters<typeof fakeDeps>[0]> = {}) {
  const activated: string[] = [];
  const killed: Array<{ session: string; title?: string }> = [];
  const deps = fakeDeps({
    opToken: "tok",
    sshApprovalEnabled: true,
    sshAgents: {
      activate: async (s: string) => { activated.push(s); return { agentSock: "/run/devd/ssh-agent.sock" }; },
      kill: async (session: string, title?: string) => { killed.push({ session, title }); },
      sockPathFor: () => "/ctl/x",
    },
    sshKeyLister: async () => [{ title: "shop", vault: "Private" }],
    ...over,
  });
  return { app: createApp(deps), db: deps.db, activated, killed };
}
const json = (body: unknown, session = "dev-web-app") => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-devbox-session": session },
  body: JSON.stringify(body),
});

/* ==================== GET /api/op/ssh-keys ==================== */
// Review finding: the route used to call listSshKeys(d.opToken) directly — Bun.spawnSync
// blocks devd's ENTIRE event loop for the duration of the `op` call (including the network round-trip to 1P),
// and the route is reachable from any container without arguments (`image/srv`) and
// without a rate limit. Fix: the route goes through an injected sshKeyLister (in production behind
// memoAsyncStrict), same as POST /api/ssh-approvals.

test("GET /api/op/ssh-keys returns keys from sshKeyLister", async () => {
  const { app } = harness({ sshKeyLister: async () => [{ title: "shop", vault: "Private" }, { title: "other", vault: "Private" }] });
  const r = await app.request("/api/op/ssh-keys");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ keys: [{ title: "shop", vault: "Private", servers: [] }, { title: "other", vault: "Private", servers: [] }] });
});

test("GET /api/op/ssh-keys goes through the cache (memoAsyncStrict) — repeated calls do not spam op", async () => {
  let calls = 0;
  const lister = memoAsyncStrict(async () => { calls++; return [{ title: "shop", vault: "Private" }]; }, 10_000);
  const { app } = harness({ sshKeyLister: lister });
  for (let i = 0; i < 3; i++) expect((await app.request("/api/op/ssh-keys")).status).toBe(200);
  expect(calls).toBe(1);
});

test("GET /api/op/ssh-keys without sshKeyLister is 503 (1Password not configured)", async () => {
  const { app } = harness({ sshKeyLister: undefined });
  expect((await app.request("/api/op/ssh-keys")).status).toBe(503);
});

test("GET /api/op/ssh-keys: lister outage is 502", async () => {
  const { app } = harness({ sshKeyLister: async () => { throw new Error("op failed"); } });
  expect((await app.request("/api/op/ssh-keys")).status).toBe(502);
});

test("1Password quota errors expose a safe 429 with reset time instead of a generic 502", async () => {
  const error = new OpRateLimited(Date.now() + 3_600_000, true);
  const { app, db } = harness({ sshKeyLister: async () => { throw error; } });
  for (const response of [await app.request("/api/op/ssh-keys"),
    await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))]) {
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(3500);
    expect(await response.json()).toMatchObject({ code: "OP_RATE_LIMITED", retryAt: error.retryAt, resetKnown: true });
  }
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("1Password quota errors during activation and grant reuse also return a structured 429", async () => {
  let fail = false;
  const { app } = harness({ sshAgents: {
    activate: async () => { if (fail) throw new OpRateLimited(Date.now() + 60_000, false); return { agentSock: "/sock" }; },
    kill: async () => {}, sockPathFor: () => "/sock",
  } });
  const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ grantMinutes: 60 }));
  fail = true;
  expect((await app.request(`/api/ssh-approvals/${id}/activate`, json({}))).status).toBe(429);
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "retry" }))).status).toBe(429);
});

test("without why it ends with 400 and nothing is created", async () => {
  const { app, db } = harness();
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app" }));
  expect(r.status).toBe(400);
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("a new request returns 202 and an id", async () => {
  const { app } = harness();
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "restart" }));
  expect(r.status).toBe(202);
  expect(((await r.json()) as { id: string }).id).toBeString();
});

test("approval and activation return the socket, never the key", async () => {
  const { app, activated } = harness();
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "restart" }))).json()) as { id: string };
  expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }))).status).toBe(200);
  const act = await app.request(`/api/ssh-approvals/${id}/activate`, json({}));
  const body = (await act.json()) as { agentSock: string };
  expect(body.agentSock).toBe("/run/devd/ssh-agent.sock");
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
  expect(activated).toEqual(["dev-web-app"]);
});

test("activation from a foreign session is 403", async () => {
  const { app } = harness();
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }));
  expect((await app.request(`/api/ssh-approvals/${id}/activate`, json({}, "dev-foreign"))).status).toBe(403);
});

test("a live grant hands out the socket directly, without a new pending request", async () => {
  const { app, db } = harness();
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac", grantMinutes: 60 }));
  await app.request(`/api/ssh-approvals/${id}/activate`, json({}));
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "second time" }));
  expect(r.status).toBe(200);
  expect(((await r.json()) as { agentSock: string }).agentSock).toBe("/run/devd/ssh-agent.sock");
});

test("a disabled gate hands out the socket without asking", async () => {
  const { app } = harness({ sshApprovalEnabled: false });
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }));
  expect(r.status).toBe(200);
  expect(((await r.json()) as { agentSock: string }).agentSock).toBe("/run/devd/ssh-agent.sock");
});

// Break-glass visibility: both the dashboard and iOS build a red banner on this (see spec
// "Break-glass") — without GET they would only notice a disabled gate because a key causes no prompt.
test("GET /api/ssh-gate reports both an enabled and a disabled gate", async () => {
  expect(await (await harness({ sshApprovalEnabled: true }).app.request("/api/ssh-gate")).json())
    .toEqual({ enabled: true });
  expect(await (await harness({ sshApprovalEnabled: false }).app.request("/api/ssh-gate")).json())
    .toEqual({ enabled: false });
});

test("GET /api/ssh-gate is enabled even without explicit sshApprovalEnabled (enabled by default)", async () => {
  const { app } = harness({ sshApprovalEnabled: undefined });
  expect(await (await app.request("/api/ssh-gate")).json()).toEqual({ enabled: true });
});

test("the endpoint returning the private key no longer exists", async () => {
  const { app } = harness();
  const r = await app.request("/api/op/ssh-key", json({ title: "shop" }));
  expect(r.status).toBe(404);
});

test("an unknown title is 400 and nothing is created (without leaking the key list)", async () => {
  const { app, db } = harness();
  const r = await app.request("/api/ssh-approvals", json({ title: "made-up-key", session: "dev-web-app", why: "x" }));
  expect(r.status).toBe(400);
  const body = (await r.json()) as { error: string };
  expect(body.error).not.toContain("shop");
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("without sshKeyLister the gate is fail-closed (503), nothing is created", async () => {
  const { app, db } = harness({ sshKeyLister: undefined });
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }));
  expect(r.status).toBe(503);
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("unavailable 1Password (lister throws) is 502, nothing is created", async () => {
  const { app, db } = harness({ sshKeyLister: async () => { throw new Error("op failed"); } });
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }));
  expect(r.status).toBe(502);
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("a malformed request (without why) does not call the lister at all — the cheap rejection comes before the expensive call", async () => {
  let calls = 0;
  const { app } = harness({ sshKeyLister: async () => { calls++; return [{ title: "shop", vault: "Private" }]; } });
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app" }));
  expect(r.status).toBe(400);
  expect(calls).toBe(0);
});

// Production wiring (index.ts) puts sshKeyLister behind memoAsyncStrict (see cache.ts) —
// these two tests use the same wiring through the real route to verify that
// the cache really prevents spamming `op` (not just in isolation, like cache.test.ts).

test("the cache holds a success within the TTL window — repeated requests do not call op again", async () => {
  let calls = 0;
  const lister = memoAsyncStrict(async () => { calls++; return [{ title: "shop", vault: "Private" }]; }, 10_000);
  const { app } = harness({ sshKeyLister: lister });
  for (let i = 0; i < 3; i++) {
    const r = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: `req ${i}` }));
    expect(r.status).toBe(202);
  }
  expect(calls).toBe(1);
});

test("an outage (throw) is not cached — the second request calls op again and succeeds", async () => {
  let calls = 0;
  const lister = memoAsyncStrict(async () => {
    calls++;
    if (calls === 1) throw new Error("op item list failed");
    return [{ title: "shop", vault: "Private" }];
  }, 10_000);
  const { app, db } = harness({ sshKeyLister: lister });

  const first = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }));
  expect(first.status).toBe(502);
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });

  const second = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "again" }));
  expect(second.status).toBe(202);
  expect(calls).toBe(2);
});

/* ==================== DELETE /api/ssh-grants/:id ==================== */
// Review finding: revokeGrant used to set a terminal status on ANY id — so DELETE
// could also be called on a `pending` request nobody had seen, silently
// denying it. The endpoint now acts only when the row HAS a live grant (see sshApprovals.ts).

test("revoking a live grant succeeds, returns ok and kills the agent with the right title", async () => {
  const { app, killed } = harness();
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac", grantMinutes: 60 }));

  const r = await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
  expect(killed).toContainEqual({ session: "dev-web-app", title: "shop" });
});

test("revoking a pending request (nobody has decided on it yet) is rejected and it stays pending", async () => {
  const { app, db } = harness();
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };

  const r = await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" });
  expect(r.status).toBe(409);
  expect((db.query("SELECT status FROM ssh_approvals WHERE id = ?").get(id) as { status: string }).status).toBe("pending");
});

test("revoking an already revoked grant behaves sensibly (the second DELETE is 409, not 200)", async () => {
  const { app } = harness();
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac", grantMinutes: 60 }));

  expect((await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" })).status).toBe(200);
  expect((await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" })).status).toBe(409);
});

test("revoking an unknown id is 404", async () => {
  const { app } = harness();
  expect((await app.request("/api/ssh-grants/missing", { method: "DELETE" })).status).toBe(404);
});

/* ==================== approvalGate: network allowlist on decision routes ====================
 * Review finding (C1): devd without a network guard — an agent inside a container called
 * host.docker.internal:4300 and could approve its own request (approve/deny),
 * read foreign `why`/`cwd`/`target` (list) and revoke a foreign grant (revoke). Fix: approve,
 * deny, DELETE grants and both lists (GET approvals, GET grants) now go through
 * `remoteAddr` → `isApprovalAllowed` (see network.ts) — loopback + tailnet (100.64.0.0/10)
 * + `DEVD_APPROVAL_ALLOW`. Create/poll/activate (`srv` flow) do NOT have this gate — that
 * is the regression test below. */

const DOCKER_BRIDGE_ADDR = "172.17.0.2";
const TAILNET_ADDR = "100.101.102.103";

test("approve from a docker-bridge address (container) is 403 and the request stays pending", async () => {
  const { app, db } = harness({ remoteAddr: () => DOCKER_BRIDGE_ADDR });
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  const r = await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }));
  expect(r.status).toBe(403);
  expect((db.query("SELECT status FROM ssh_approvals WHERE id = ?").get(id) as { status: string }).status).toBe("pending");
});

test("approve from loopback and from the tailnet passes (mac dialog and tailnet client)", async () => {
  for (const addr of ["127.0.0.1", "::1", TAILNET_ADDR]) {
    const { app } = harness({ remoteAddr: () => addr });
    const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
    expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }))).status).toBe(200);
  }
});

test("approve when the source address cannot be determined (remoteAddr missing/returns undefined) is fail-closed 403", async () => {
  const { app } = harness({ remoteAddr: () => undefined });
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }))).status).toBe(403);
});

// Review round 1 (fix): `getConnInfo(c)` (hono/bun) throws a TypeError when `c.env`
// does not carry a real Bun server — exactly this happens in the ENTIRE test suite
// (`app.request(...)` has no real server), and without catching it, it would break devd in production
// the same way whenever `getBunServer`/`requestIP` did not behave as
// expected. This test calls the REAL `getConnInfo` from `hono/bun` (the same function as
// index.ts) via `remoteAddr`, exactly the way index.ts wires it
// (try/catch → undefined) — it verifies it does not fall through as an unhandled 500 but
// reaches the same fail-closed 403 branch as "address cannot be determined" above.
test("remoteAddr wired as in index.ts (getConnInfo + try/catch) survives a missing Bun server and falls into 403, not 500", async () => {
  const { app } = harness({
    remoteAddr: (c) => {
      try { return getConnInfo(c).remote.address; }
      catch { return undefined; }
    },
  });
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  const r = await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }));
  expect(r.status).toBe(403);
});

test("deny from a docker-bridge address is 403", async () => {
  const { app } = harness({ remoteAddr: () => DOCKER_BRIDGE_ADDR });
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  expect((await app.request(`/api/ssh-approvals/${id}/deny`, json({ by: "mac" }))).status).toBe(403);
});

test("GET /api/ssh-approvals (cross-session list) from a docker-bridge address is 403, from loopback 200", async () => {
  const blocked = harness({ remoteAddr: () => DOCKER_BRIDGE_ADDR });
  expect((await blocked.app.request("/api/ssh-approvals")).status).toBe(403);
  const allowed = harness({ remoteAddr: () => "127.0.0.1" });
  expect((await allowed.app.request("/api/ssh-approvals")).status).toBe(200);
});

test("GET /api/ssh-grants from a docker-bridge address is 403", async () => {
  const { app } = harness({ remoteAddr: () => DOCKER_BRIDGE_ADDR });
  expect((await app.request("/api/ssh-grants")).status).toBe(403);
});

test("DELETE /api/ssh-grants/:id from a docker-bridge address is 403 and the grant stays live", async () => {
  let addr = "127.0.0.1";
  const { app, killed } = harness({ remoteAddr: () => addr });
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac", grantMinutes: 60 }));

  addr = DOCKER_BRIDGE_ADDR;
  const r = await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" });
  expect(r.status).toBe(403);
  expect(killed).toEqual([]);
});

test("DEVD_APPROVAL_ALLOW (sshApprovalAllowExtra) also lets through an address outside loopback/tailnet", async () => {
  const CLOUDFLARED_ADDR = "203.0.113.9";
  const { app } = harness({ remoteAddr: () => CLOUDFLARED_ADDR, sshApprovalAllowExtra: [CLOUDFLARED_ADDR] });
  const { id } = (await (await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }))).json()) as { id: string };
  expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }))).status).toBe(200);
});

// Regression test: create/poll/activate are the `srv` flow inside the container and MUST NOT have
// approvalGate — otherwise the agent would never get to its own, already approved
// request (see the comments on those three routes in api.ts).
test("regression: POST create, GET /:id (poll) and POST /:id/activate work from a docker-bridge address", async () => {
  let addr: string = DOCKER_BRIDGE_ADDR;
  const { app } = harness({ remoteAddr: () => addr });
  const created = await app.request("/api/ssh-approvals", json({ title: "shop", session: "dev-web-app", why: "x" }));
  expect(created.status).toBe(202);
  const { id } = (await created.json()) as { id: string };

  const polled = await app.request(`/api/ssh-approvals/${id}`);
  expect(polled.status).toBe(200);

  // Approval must come from an allowed address (approve IS behind approvalGate) — activation
  // itself must however also work from a docker-bridge address, like create/poll above.
  addr = "127.0.0.1";
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac" }));

  addr = DOCKER_BRIDGE_ADDR;
  const activated = await app.request(`/api/ssh-approvals/${id}/activate`, json({}));
  expect(activated.status).toBe(200);
});

/* ==================== Gates: who may call the SSH routes (review finding) ==================== */
// Every container on `docker0` can reach 4300/tcp — even one that has nothing to do
// with the devbox (Coolify apps, gh-runner). `approvalGate` cannot be used here, `srv`
// calls them from a container; so sessionGate + limits apply.

const CONTAINER = "172.17.0.9";  // typical docker0 address — outside the allowlist

test("key listing: a foreign container without a session header is 403", async () => {
  const { app } = harness({ remoteAddr: () => CONTAINER });
  const r = await app.request("/api/op/ssh-keys");
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "this request must come from a running devbox session" });
});

test("key listing: a made-up session is 403 (the header is checked against the DB)", async () => {
  const { app } = harness({ remoteAddr: () => CONTAINER });
  const r = await app.request("/api/op/ssh-keys", { headers: { "x-devbox-session": "dev-vymyslena" } });
  expect(r.status).toBe(403);
});

test("key listing: a running session passes even from a container address", async () => {
  const { app, db } = harness({ remoteAddr: () => CONTAINER });
  insertSession(db, { id: "dev-a-b", folder: "f", project: "a", repo: "b", container: "dev-a-b", port_base: 40100,
    status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0, agent: "claude", worktree: null } as never);
  const r = await app.request("/api/op/ssh-keys", { headers: { "x-devbox-session": "dev-a-b" } });
  expect(r.status).toBe(200);
});

test("key listing: an approving address (mac/tailnet) passes even without a session", async () => {
  const { app } = harness({ remoteAddr: () => "100.64.1.2" });
  expect((await app.request("/api/op/ssh-keys")).status).toBe(200);
});

test("key listing has a limit — the 31st attempt in the window is 429 with retry-after", async () => {
  const { app } = harness({ remoteAddr: () => "127.0.0.1" });
  for (let i = 0; i < 30; i++) expect((await app.request("/api/op/ssh-keys")).status).toBe(200);
  const r = await app.request("/api/op/ssh-keys");
  expect(r.status).toBe(429);
  expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("approvals have a limit — the 9th request in the window is 429, no dialog is created", async () => {
  const { app } = harness();
  for (let i = 0; i < 8; i++) {
    const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "restart" }));
    expect([200, 202]).toContain(r.status);
  }
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "restart" }));
  expect(r.status).toBe(429);
});

test("the approval limit is per session — another session did not lose its own window", async () => {
  const { app } = harness();
  for (let i = 0; i < 8; i++) await app.request("/api/ssh-approvals", json({ title: "shop", why: "restart" }, "dev-first"));
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "restart" }, "dev-first"))).status).toBe(429);
  const other = await app.request("/api/ssh-approvals", json({ title: "shop", why: "restart" }, "dev-second"));
  expect(other.status).not.toBe(429);
});

/* Duration choices and permanent grants, through the actual HTTP routes. */
test("HTTP grants preserve 960 and custom minutes, including reused socket expiry", async () => {
  for (const minutes of [960, 137]) {
    const { app } = harness();
    const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
    const before = Date.now();
    expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ grantMinutes: minutes }))).status).toBe(200);
    const row = await (await app.request(`/api/ssh-approvals/${id}`)).json() as { grant_until: number; grant_permanent: number };
    expect(row.grant_until).toBeGreaterThanOrEqual(before + minutes * 60_000);
    expect(row.grant_until).toBeLessThanOrEqual(Date.now() + minutes * 60_000);
    expect(row.grant_permanent).toBe(0);
    const reused = await app.request("/api/ssh-approvals", json({ title: "shop", why: "again" }));
    expect(reused.status).toBe(200);
    expect((await reused.json() as { expiresAt: number }).expiresAt).toBe(row.grant_until);
  }
});

test("HTTP permanent grants expose no expiration, reuse only their session/key, and revoke", async () => {
  const { app, db, killed } = harness({
    sshKeyLister: async () => [{ title: "shop", vault: "Private" }, { title: "other", vault: "Private" }],
  });
  const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
  expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ grantPermanent: true }))).status).toBe(200);
  const grants = await (await app.request("/api/ssh-grants")).json() as Array<{ id: string; grant_permanent: number; grant_until: number | null }>;
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ id, grant_permanent: 1, grant_until: null });
  db.query("UPDATE ssh_approvals SET expires_at=1 WHERE id=?").run(id);
  expect((await app.request(`/api/ssh-approvals/${id}/activate`, json({}, "dev-other"))).status).toBe(403);
  const activation = await app.request(`/api/ssh-approvals/${id}/activate`, json({}));
  expect(activation.status).toBe(200);
  expect((await activation.json() as { expiresAt: null }).expiresAt).toBeNull();
  const reused = await app.request("/api/ssh-approvals", json({ title: "shop", why: "again" }));
  expect(reused.status).toBe(200);
  expect((await reused.json() as { expiresAt: null }).expiresAt).toBeNull();
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "other session" }, "dev-other"))).status).toBe(202);
  expect((await app.request("/api/ssh-approvals", json({ title: "other", why: "other key" }))).status).toBe(202);
  expect((await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" })).status).toBe(200);
  expect(killed).toEqual([{ session: "dev-web-app", title: "shop" }]);
  expect(await (await app.request("/api/ssh-grants")).json()).toEqual([]);
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "after revoke" }))).status).toBe(202);
});

test("HTTP rejects malformed durations without changing pending approval", async () => {
  const { app } = harness();
  const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
  for (const duration of [
    null, [], { grantMinutes: "960" }, { grantMinutes: -1 }, { grantMinutes: 1.25 },
    { grantMinutes: null }, { grantMinutes: 1e300 }, { grantPermanent: "true" },
    { grantPermanent: 1 }, { grantPermanent: null }, { grantPermanent: true, grantMinutes: 60 },
  ]) {
    const response = await app.request(`/api/ssh-approvals/${id}/approve`, json(duration));
    expect(response.status).toBe(400);
    expect((await (await app.request(`/api/ssh-approvals/${id}`)).json() as { status: string }).status).toBe("pending");
  }
  const malformed = await app.request(`/api/ssh-approvals/${id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{",
  });
  expect(malformed.status).toBe(400);
  expect((await app.request(`/api/ssh-approvals/${id}/approve`, json({ grantMinutes: 0 }))).status).toBe(200);
});

test("Mac callback persists permanent grants and rejects ambiguous duration payloads", async () => {
  for (const answer of [
    { decision: "approve", grantMinutes: 0, grantPermanent: true },
    { decision: "approve", grantMinutes: 60, grantPermanent: true },
  ]) {
    const listener = fakeDeps().listener;
    listener.sshApproval = async (_row, decide) => { decide(answer as never); };
    const { app } = harness({ listener });
    const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
    const row = await (await app.request(`/api/ssh-approvals/${id}`)).json() as { status: string; grant_permanent: number };
    expect(row.status).toBe(answer.grantMinutes === 0 ? "approved" : "pending");
    expect(row.grant_permanent).toBe(answer.grantMinutes === 0 ? 1 : 0);
  }
});

test("revoking permanent permission while key loading prevents activation and grant reuse responses", async () => {
  for (const reuse of [false, true]) {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const killed: string[] = [];
    const { app } = harness({ sshAgents: {
      activate: async () => { started.resolve(); await finish.promise; return { agentSock: "/run/devd/ssh-agent.sock" }; },
      kill: async (session) => { killed.push(session); },
      sockPathFor: () => "/ctl/x",
    } });
    const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
    await app.request(`/api/ssh-approvals/${id}/approve`, json({ grantPermanent: true }));
    const pending = reuse
      ? app.request("/api/ssh-approvals", json({ title: "shop", why: "again" }))
      : app.request(`/api/ssh-approvals/${id}/activate`, json({}));
    await started.promise;
    expect((await app.request(`/api/ssh-grants/${id}`, { method: "DELETE" })).status).toBe(200);
    finish.resolve();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("agentSock");
    expect(killed).toContain("dev-web-app");
  }
});

test("revoking an overlapping timed grant leaves permanent permission and its agent intact", async () => {
  const { app, killed } = harness();
  const created = [] as string[];
  for (let i = 0; i < 2; i++) {
    const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "work" }))).json() as { id: string };
    created.push(id);
  }
  await app.request(`/api/ssh-approvals/${created[0]}/approve`, json({ grantMinutes: 60 }));
  await app.request(`/api/ssh-approvals/${created[1]}/approve`, json({ grantPermanent: true }));
  expect((await app.request(`/api/ssh-grants/${created[0]}`, { method: "DELETE" })).status).toBe(200);
  expect(killed).toEqual([]);
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "again" }))).status).toBe(200);
});

/* ==================== target-bound grants ==================== */
const SERVERS = [
  { name: "prod", key: "shop", user: "root", host: "A.example", port: 22, note: "main" },
  { name: "stage", key: "shop", user: "deploy", host: "b.example", port: 2222 },
  { name: "elsewhere", key: "other", user: "root", host: "c.example", port: 22 },
];

async function grantFor(app: ReturnType<typeof harness>["app"], body: Record<string, unknown>) {
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", ...body }));
  expect(r.status).toBe(202);
  const { id } = (await r.json()) as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ by: "mac", grantMinutes: 60 }));
  expect((await app.request(`/api/ssh-approvals/${id}/activate`, json({}))).status).toBe(200);
  return id;
}

test("GET /api/op/ssh-keys returns the servers from config for a key", async () => {
  const { app } = harness({
    sshKeyLister: async () => [{ title: "shop", vault: "Private" }, { title: "none", vault: "Private" }],
    sshServers: () => SERVERS,
  });
  const r = await app.request("/api/op/ssh-keys");
  expect(await r.json()).toEqual({ keys: [
    { title: "shop", vault: "Private", servers: [
      { name: "prod", user: "root", host: "A.example", port: 22 },
      { name: "stage", user: "deploy", host: "b.example", port: 2222 },
    ] },
    { title: "none", vault: "Private", servers: [] },
  ] });
});

test("sshServers are read fresh on every request", async () => {
  let servers: typeof SERVERS = [];
  const { app } = harness({ sshServers: () => servers });
  const keys = async () => ((await (await app.request("/api/op/ssh-keys")).json()) as { keys: { servers: unknown[] }[] }).keys;
  expect((await keys())[0].servers).toEqual([]);
  servers = SERVERS;
  expect((await keys())[0].servers).toHaveLength(2);
});

test("a grant for root@a:22 does not cover root@b:22 (202 + new row), root@a:22 again passes (200)", async () => {
  const { app, db } = harness();
  await grantFor(app, { target: "root@A" });
  const other = await app.request("/api/ssh-approvals", json({ title: "shop", why: "elsewhere", target: "root@b:22" }));
  expect(other.status).toBe(202);
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 2 });
  const { id } = (await other.json()) as { id: string };
  expect(db.query("SELECT target, server FROM ssh_approvals WHERE id = ?").get(id)).toEqual({ target: "root@b:22", server: null });
  const same = await app.request("/api/ssh-approvals", json({ title: "shop", why: "again", target: "root@a:22" }));
  expect(same.status).toBe(200);
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 2 });
});

test("a request without a target is not covered by a target grant (202)", async () => {
  const { app } = harness();
  await grantFor(app, { target: "root@a:22" });
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "no target" }))).status).toBe(202);
});

test("a server alias fills in target, and a free-form target matching a server fills in server", async () => {
  const { app, db } = harness({ sshServers: () => SERVERS });
  const byName = await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", server: "prod" }));
  expect(byName.status).toBe(202);
  const a = ((await byName.json()) as { id: string }).id;
  expect(db.query("SELECT server, target FROM ssh_approvals WHERE id = ?").get(a)).toEqual({ server: "prod", target: "root@a.example:22" });
  const byTarget = await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", target: "deploy@B.example:2222" }));
  const b = ((await byTarget.json()) as { id: string }).id;
  expect(db.query("SELECT server, target FROM ssh_approvals WHERE id = ?").get(b)).toEqual({ server: "stage", target: "deploy@b.example:2222" });
});

test("a grant via alias also covers a request for the same server via a free-form target", async () => {
  const { app } = harness({ sshServers: () => SERVERS });
  await grantFor(app, { server: "prod" });
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", target: "root@a.example" }))).status).toBe(200);
});

test("a server that does not belong to the key is 400 and nothing is created", async () => {
  const { app, db } = harness({ sshServers: () => SERVERS });
  for (const server of ["foreign", "elsewhere"]) {
    const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", server }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(`server ${server} does not belong to key shop`);
  }
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("the notification carries the server, else the target, else 'no target'", async () => {
  const notes: string[] = [];
  const { app } = harness({ sshServers: () => SERVERS, notify: (_t: string, body: string) => { notes.push(body); } });
  await app.request("/api/ssh-approvals", json({ title: "shop", why: "a", server: "prod" }));
  await app.request("/api/ssh-approvals", json({ title: "shop", why: "b", target: "root@x" }));
  await app.request("/api/ssh-approvals", json({ title: "shop", why: "c" }));
  expect(notes).toEqual([
    "shop → prod · dev-web-app: a",
    "shop → root@x:22 · dev-web-app: b",
    "shop → no target · dev-web-app: c",
  ]);
});

test("revoking the grant for target A does not kill the agent while the grant for target B of the same key lives", async () => {
  const { app, killed } = harness();
  const a = await grantFor(app, { target: "root@a:22" });
  await grantFor(app, { target: "root@b:22" });
  expect((await app.request(`/api/ssh-grants/${a}`, { method: "DELETE" })).status).toBe(200);
  expect(killed).toEqual([]);
});

test("recheck in issue(): grant for target A revoked during activation → 403, but the agent lives because the grant for target B lives", async () => {
  let duringActivate: (() => Promise<void>) | null = null;
  const killed: string[] = [];
  const { app } = harness({ sshAgents: {
    activate: async () => { const hook = duringActivate; duringActivate = null; if (hook) await hook(); return { agentSock: "/run/devd/ssh-agent.sock" }; },
    kill: async (session) => { killed.push(session); },
    sockPathFor: () => "/ctl/x",
  } });
  const a = await grantFor(app, { target: "root@a:22" });
  await grantFor(app, { target: "root@b:22" });
  duringActivate = async () => {
    expect((await app.request(`/api/ssh-grants/${a}`, { method: "DELETE" })).status).toBe(200);
  };
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "again", target: "root@a:22" }));
  expect(duringActivate).toBeNull();
  expect(r.status).toBe(403);
  expect(await r.json()).not.toHaveProperty("agentSock");
  expect(killed).toEqual([]);
});

test("target/server that are not strings are 400 and nothing is created", async () => {
  const { app, db } = harness();
  for (const extra of [{ target: 42 }, { target: null }, { server: ["prod"] }, { server: { a: 1 } }]) {
    const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", ...extra }));
    expect(r.status).toBe(400);
  }
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
});

test("a target longer than 255 characters or with a space/control character is 400", async () => {
  const { app, db } = harness();
  for (const target of [`root@${"a".repeat(251)}`, "root@a b", "root@a\nb", "root@a\tb", "root@a\x1b[31m", "root@a\x7f"]) {
    const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", target }));
    expect(r.status).toBe(400);
  }
  expect(db.query("SELECT COUNT(*) c FROM ssh_approvals").get()).toEqual({ c: 0 });
  // exactly 255 characters still passes
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "x", target: `root@${"a".repeat(250)}` }))).status).toBe(202);
});

test("the SSH request notification carries the sshApprovals target with the request id and blocked", async () => {
  const extras: unknown[] = [];
  const { app } = harness({ notify: (_t: string, _b: string, extra?: unknown) => { extras.push(extra); } });
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "w", target: "root@x" }));
  const id = ((await r.json()) as { id: string }).id;
  expect(extras).toEqual([{ target: { kind: "sshApprovals", id }, blocked: true }]);
});

test("a raw target is truncated to 120 characters in the notification text", async () => {
  const notes: string[] = [];
  const { app } = harness({ notify: (_t: string, body: string) => { notes.push(body); } });
  const target = `${"u".repeat(200)}`; // without "@" → stays raw, not normalized
  expect((await app.request("/api/ssh-approvals", json({ title: "shop", why: "w", target }))).status).toBe(202);
  expect(notes).toEqual([`shop → ${"u".repeat(120)} · dev-web-app: w`]);
});

test("Live Activity: an open SSH request = session is waiting; approval, denial and expiry all end the wait", async () => {
  const deps = fakeDeps({
    opToken: "tok", sshApprovalEnabled: true,
    sshAgents: { activate: async () => ({ agentSock: "/sock" }), kill: async () => {}, sockPathFor: () => "/ctl/x" },
    sshKeyLister: async () => [{ title: "shop", vault: "Private" }],
  });
  const hub = new AgentEventHub({ db: deps.db, notify: () => {} });
  const app = createApp({ ...deps, agentEvents: hub });
  const ask = async () => ((await (await app.request("/api/ssh-approvals",
    json({ title: "shop", why: "deploy", target: "root@1.2.3.4:22" }))).json()) as { id: string }).id;

  const first = await ask();
  expect(hub.liveSnapshot("dev-web-app")).toMatchObject({ status: "waiting", reason: "Approve SSH key: shop · root@1.2.3.4:22" });
  expect((await app.request(`/api/ssh-approvals/${first}/approve`, json({ by: "mac" }))).status).toBe(200);
  expect(hub.liveSnapshot("dev-web-app")).toBeNull();

  const second = await ask();
  expect(hub.liveSnapshot("dev-web-app")?.status).toBe("waiting");
  expect((await app.request(`/api/ssh-approvals/${second}/deny`, json({ by: "mac" }))).status).toBe(200);
  expect(hub.liveSnapshot("dev-web-app")).toBeNull();

  await ask();
  expect(pendingSshLabel(deps.db, "dev-web-app")).toBe("shop · root@1.2.3.4:22");
  // Expiry is cleaned up by the periodic tick in index.ts with the same call.
  expect(pendingSshLabel(deps.db, "dev-web-app", Date.now() + APPROVAL_TTL_MS + 1)).toBeNull();
});

/* ==================== final review I4: requests from a shared/tainted session ==================== */

test("I4: an SSH request from a shared session is labelled in both the notification and the dialog; an old grant is not used", async () => {
  const notes: string[] = [];
  const rows: { shared?: boolean }[] = [];
  const base = fakeDeps().listener;
  const { app, db } = harness({
    dind: true,
    notify: (title: string) => { notes.push(title); },
    listener: { ...base, sshApproval: async (row: { shared?: boolean }) => { rows.push(row); } },
  });
  insertSession(db, { id: "dev-web-app", folder: "f", project: "web", repo: "app", container: "dev-web-app", port_base: 44100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 });
  // Grant approved by the owner before the session was shared.
  const { id } = await (await app.request("/api/ssh-approvals", json({ title: "shop", why: "before sharing" }))).json() as { id: string };
  await app.request(`/api/ssh-approvals/${id}/approve`, json({ grantMinutes: 60 }));
  expect(notes).toEqual(["SSH key awaiting approval"]);
  expect(rows[0]?.shared).toBeUndefined();
  const share = await app.request("/api/sessions/dev-web-app/shares", json({ minutes: 30 }));
  expect(share.status).toBe(201);
  const r = await app.request("/api/ssh-approvals", json({ title: "shop", why: "after sharing" }));
  expect(r.status).toBe(202); // a new request to the owner, not a silent grant
  expect(notes[1]).toBe("SSH key awaiting approval (from a shared session)");
  expect(rows[1]?.shared).toBe(true);
});
