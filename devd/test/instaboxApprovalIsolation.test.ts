import { afterEach, expect, test } from "bun:test";
import { createApp } from "../src/api";
import { insertSession } from "../src/db";
import { loadInstaboxIps } from "../src/instabox/sessions";
import { addInstaboxIp, clearInstaboxIps, forgetInstaboxIp, isApprovalAllowed, isInstaboxAddress } from "../src/network";
import { isVmRoute, vmFetch } from "../src/vmListener";
import { fakeDeps } from "./helpers/apiHarness";

// C1 (final review): the InstaBox VM is in the tailnet (100.64.0.0/10) — without an exception it would pass
// the approval gates' allowlist and approve its own prod-db write, operation or SSH grant.

afterEach(() => clearInstaboxIps());

const IBX_IP = "100.100.0.7";
const post = { method: "POST", body: "{}", headers: { "content-type": "application/json" } };

test("isApprovalAllowed: a registered InstaBox IP does not pass, the rest of the tailnet does; also the mapped IPv6 form", () => {
  expect(isApprovalAllowed(IBX_IP)).toBe(true);
  addInstaboxIp(IBX_IP);
  expect(isApprovalAllowed(IBX_IP)).toBe(false);
  expect(isApprovalAllowed(`::ffff:${IBX_IP}`)).toBe(false);
  expect(isInstaboxAddress(`::ffff:${IBX_IP}`)).toBe(true);
  // not even an explicit DEVD_APPROVAL_ALLOW lets it through
  expect(isApprovalAllowed(IBX_IP, [`${IBX_IP}/32`])).toBe(false);
  expect(isApprovalAllowed("100.100.0.8")).toBe(true);
  expect(isApprovalAllowed("127.0.0.1")).toBe(true);
  forgetInstaboxIp(IBX_IP);
  expect(isApprovalAllowed(IBX_IP)).toBe(true);
});

test("loadInstaboxIps: after a devd restart the IPs of InstaBox sessions (paused ones too) are denied again", () => {
  const d = fakeDeps();
  const row = { folder: "f", project: "p", solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const };
  insertSession(d.db, { ...row, id: "dev-p-a", repo: "a", container: "dev-p-a", port_base: 40100, status: "stopped", host: "instabox", instabox_machine_id: "m_1" });
  insertSession(d.db, { ...row, id: "dev-p-v", repo: "v", container: "dev-p-v", port_base: 40110, status: "running" });
  d.db.run(`UPDATE sessions SET instabox_ts_ip='${IBX_IP}' WHERE id='dev-p-a'`);
  // a VPS session with an accidentally filled-in value is ignored
  d.db.run("UPDATE sessions SET instabox_ts_ip='100.100.0.99' WHERE id='dev-p-v'");
  loadInstaboxIps(d.db);
  expect(isInstaboxAddress(IBX_IP)).toBe(true);
  expect(isInstaboxAddress("100.100.0.99")).toBe(false);
});

test("approval routes from an InstaBox IP → 403 (operations, prod-db writes and requests, SSH approvals and grants)", async () => {
  addInstaboxIp(IBX_IP);
  const app = createApp(fakeDeps({ remoteAddr: () => IBX_IP }));
  const routes: [string, RequestInit][] = [
    ["/api/operations/1/approve", post], ["/api/operations/1/reject", post],
    ["/api/prod-db/writes/1/approve", post], ["/api/prod-db/writes/1/reject", post], ["/api/prod-db/writes/1/preview", {}],
    ["/api/prod-db/requests/1/reject", post],
    ["/api/ssh-approvals/x/approve", post], ["/api/ssh-approvals/x/deny", post], ["/api/ssh-approvals", {}],
    ["/api/ssh-grants/x", { method: "DELETE" }],
  ];
  for (const [path, init] of routes) expect([path, (await app.request(path, init)).status]).toEqual([path, 403]);
  // Control: the same routes from loopback do not return 403 (the gate really decides by address).
  const local = createApp(fakeDeps({ remoteAddr: () => "127.0.0.1" }));
  expect((await local.request("/api/operations/1/approve", post)).status).not.toBe(403);
});

test("cross-session read from an InstaBox IP without a session header → 403 (sessionGate does not accept the tailnet)", async () => {
  addInstaboxIp(IBX_IP);
  const app = createApp(fakeDeps({ remoteAddr: () => IBX_IP }));
  expect((await app.request("/api/operations")).status).toBe(403);
  expect((await app.request("/api/prod-db/writes")).status).toBe(403);
});

test("isVmRoute: only hooks, OTel, git proxy, health and lease", () => {
  expect(isVmRoute("GET", "/api/health")).toBe(true);
  expect(isVmRoute("POST", "/api/agent-event")).toBe(true);
  expect(isVmRoute("POST", "/v1/metrics")).toBe(true);
  expect(isVmRoute("GET", "/api/accounts/lease")).toBe(true);
  expect(isVmRoute("GET", "/git/infra/team/r.git/info/refs")).toBe(true);
  expect(isVmRoute("POST", "/git/infra/team/r.git/git-receive-pack")).toBe(true);
  for (const [m, p] of [
    ["POST", "/api/prod-db/writes/1/approve"], ["POST", "/api/operations/1/approve"], ["POST", "/api/ssh-approvals/x/approve"],
    ["GET", "/api/sessions"], ["POST", "/api/sessions"], ["GET", "/"], ["GET", "/api/agent-event"], ["DELETE", "/api/health"],
    ["GET", "/git/%2e%2e/api/sessions"], ["GET", "/git/x/..%2Fapi"],
  ] as const) expect([m, p, isVmRoute(m, p)]).toEqual([m, p, false]);
});

test("VM listener: allowed routes reach the app, others get 404 without touching the app", async () => {
  const app = createApp(fakeDeps({ remoteAddr: () => "127.0.0.1" }));
  const seen: string[] = [];
  const fetch = vmFetch((req: Request, env: unknown) => { seen.push(new URL(req.url).pathname); return app.fetch(req, env as never); });
  const call = (path: string, init: RequestInit = {}) => fetch(new Request(`http://100.1.1.1:4301${path}`, init), undefined);
  expect((await call("/api/health")).status).toBe(200);
  for (const path of ["/api/prod-db/writes/1/approve", "/api/operations/1/approve", "/api/ssh-approvals/x/approve"]) {
    const r = await call(path, post);
    expect([path, r.status]).toEqual([path, 404]);
  }
  expect((await call("/api/sessions")).status).toBe(404);
  expect((await call("/")).status).toBe(404);
  // a raw `..` in the path (without client normalisation) is rejected
  expect((await fetch({ url: "http://100.1.1.1:4301/git/../api/sessions", method: "GET" } as Request, undefined)).status).toBe(404);
  expect(seen).toEqual(["/api/health"]);
});
