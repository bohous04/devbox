import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApp } from "../src/api";
import {
  ContainerIdentity, dockerContainerIps, dockerContainerSnapshot, SHARED_DENIED, SharedSessions, sharedContainerAllowed, watchDockerEvents,
} from "../src/containerIdentity";
import { markTainted } from "../src/shareTaint";
import { insertSession, type SessionRow } from "../src/db";
import { createShare, revokeShare } from "../src/shares";
import { createApproval } from "../src/sshApprovals";
import { addInstaboxIp, clearInstaboxIps } from "../src/network";
import { fakeDeps } from "./helpers/apiHarness";

const S = "dev-p-shared";
const T = "dev-p-other";
const IP_S = "172.18.0.5";
const IP_T = "172.19.0.7";

/* ==================== ContainerIdentity: IP → session ==================== */

function identity(snapshots: Map<string, string>[], opts: { now?: () => number } = {}) {
  let calls = 0;
  const id = new ContainerIdentity({
    snapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)]!,
    now: opts.now, minIntervalMs: 0,
  });
  return { id, calls: () => calls };
}

test("ContainerIdentity: the first query loads the map from docker, later ones take it from cache", async () => {
  const { id, calls } = identity([new Map([[IP_S, S]])]);
  expect(id.sessionForSourceIp(IP_S)).toBeNull(); // nothing loaded yet
  expect(await id.identify(IP_S)).toBe(S);
  expect(await id.identify(IP_S)).toBe(S);
  expect(await id.identify("172.18.0.99")).toBeNull(); // unknown IP on a fresh map → no further inspect
  expect(calls()).toBe(1);
  expect(id.sessionForSourceIp(IP_S)).toBe(S);
});

test("ContainerIdentity: IPv4 wrapped in IPv6 (::ffff:) is normalized", async () => {
  const { id } = identity([new Map([[IP_S, S]])]);
  expect(await id.identify(`::ffff:${IP_S}`)).toBe(S);
  expect(id.sessionForSourceIp(`::ffff:${IP_S}`)).toBe(S);
});

test("ContainerIdentity: container start/recreate (markChanged) forces a new inspect", async () => {
  const { id, calls } = identity([new Map([[IP_S, S]]), new Map([[IP_S, T]])]);
  expect(await id.identify(IP_S)).toBe(S);
  id.markChanged(); // the IP was freed and another session's container got it
  expect(await id.identify(IP_S)).toBe(T);
  expect(calls()).toBe(2);
});

test("ContainerIdentity: a stale map (maxAge) is refreshed even without an event", async () => {
  let now = 1000;
  const { id, calls } = identity([new Map([[IP_S, S]]), new Map([[IP_S, S], [IP_T, T]])], { now: () => now });
  expect(await id.identify(IP_T)).toBeNull();
  now += 61_000;
  expect(await id.identify(IP_T)).toBe(T);
  expect(calls()).toBe(2);
});

test("ContainerIdentity: concurrent queries share one inspect", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const id = new ContainerIdentity({ snapshot: async () => { calls++; await gate; return new Map([[IP_S, S]]); } });
  const all = Promise.all([id.identify(IP_S), id.identify(IP_S), id.identify(IP_T)]);
  release();
  expect(await all).toEqual([S, S, null]);
  expect(calls).toBe(1);
});

test("ContainerIdentity: a docker failure keeps the last known map", async () => {
  let fail = false;
  const id = new ContainerIdentity({ snapshot: async () => { if (fail) throw new Error("docker down"); return new Map([[IP_S, S]]); }, minIntervalMs: 0 });
  expect(await id.identify(IP_S)).toBe(S);
  fail = true; id.markChanged();
  expect(await id.identify(IP_S)).toBe(S);
});

test("ContainerIdentity: a forced refresh is limited by minIntervalMs", async () => {
  let calls = 0, now = 0;
  const id = new ContainerIdentity({ snapshot: async () => { calls++; return new Map([[IP_S, S]]); }, now: () => now, minIntervalMs: 1000 });
  await id.identify(IP_S);
  await id.identify(IP_S, { fresh: true });
  expect(calls).toBe(1); // fresher than minInterval → no further inspect
  now += 1500;
  await id.identify(IP_S, { fresh: true });
  expect(calls).toBe(2);
});

/* ==================== dockerContainerIps: docker inspect ==================== */

test("dockerContainerIps: the session container and its dind sidecar → session; InstaBox is ignored", async () => {
  const d = fakeDeps().db;
  addSession(d, S); addSession(d, T, "instabox");
  let argv: string[] = [];
  const map = await dockerContainerIps(d, async (cmd) => {
    argv = cmd;
    return { code: 1, timedOut: false, stderr: "Error: No such container: x",
      stdout: `/${S} cid-s ${IP_S} \n/dind-${S} cid-dind 172.18.0.2 \n/stopped cid-x  \n` };
  });
  expect(argv.slice(0, 4)).toEqual(["docker", "inspect", "--type", "container"]);
  expect(argv).toContain(S);
  expect(argv).toContain(`dind-${S}`);
  expect(argv).not.toContain(T);
  expect([...map]).toEqual([[IP_S, S], ["172.18.0.2", S]]);
});

test("dockerContainerSnapshot: docker id of the session container (not the sidecar), even when stopped", async () => {
  const d = fakeDeps().db;
  addSession(d, S); addSession(d, "dev-p-stopped");
  let argv: string[] = [];
  const snap = await dockerContainerSnapshot(d, async (cmd) => {
    argv = cmd;
    return { code: 0, timedOut: false, stderr: "", stdout: `/${S} cid-s ${IP_S} \n/dind-${S} cid-dind 172.18.0.2 \n/dev-p-stopped cid-stopped  \n` };
  });
  expect(argv.join(" ")).toContain("{{.Id}}");
  expect([...snap.containerIds]).toEqual([[S, "cid-s"], ["dev-p-stopped", "cid-stopped"]]);
  expect([...snap.ips]).toEqual([[IP_S, S], ["172.18.0.2", S]]);
});

/* ==================== sharedContainerAllowed: allowlist ==================== */

test("sharedContainerAllowed: routes the container calls pass for its own session", () => {
  const own: [string, string][] = [
    ["POST", "/api/agent-event"], ["POST", "/v1/metrics"], ["POST", "/api/preview"],
    ["GET", "/api/op/ssh-keys"], ["POST", "/api/ssh-approvals"], ["GET", "/api/ssh-approvals/abc-1"],
    ["POST", "/api/ssh-approvals/abc-1/activate"], ["GET", "/api/prod-db/catalog"], ["GET", "/api/prod-db/app_db/url"],
    ["POST", "/api/prod-db/app_db/write"], ["GET", "/api/prod-db/writes/12"], ["POST", "/api/prod-db/requests"],
    ["GET", "/api/prod-db/requests/3"], ["POST", "/api/prod-db/requests/3/prepare"], ["POST", "/api/prod-db/requests/3/resume"],
    ["GET", "/api/accounts/lease"],
  ];
  for (const [m, p] of own) expect(`${m} ${p} ${sharedContainerAllowed(m, p, S, S)}`).toBe(`${m} ${p} true`);
  // Not bound to a session (identity elsewhere or none):
  for (const [m, p] of [["GET", "/api/health"], ["GET", "/api/codex-accounts/select"],
    ["GET", "/git/gitea/org/repo.git/info/refs"], ["POST", "/git/gitea/org/repo.git/git-receive-pack"]] as const) {
    expect(`${m} ${p} ${sharedContainerAllowed(m, p, S, null)}`).toBe(`${m} ${p} true`);
  }
});

test("sharedContainerAllowed: a foreign target session → denied even on an allowed route", () => {
  expect(sharedContainerAllowed("POST", "/api/agent-event", S, T)).toBe(false);
  expect(sharedContainerAllowed("GET", "/api/health", S, T)).toBe(false);
  expect(sharedContainerAllowed("GET", "/git/gitea/org/repo.git/info/refs", S, T)).toBe(false);
});

test("sharedContainerAllowed: a session-bound route without session identification → denied", () => {
  expect(sharedContainerAllowed("POST", "/api/agent-event", S, null)).toBe(false);
  expect(sharedContainerAllowed("GET", "/api/op/ssh-keys", S, null)).toBe(false);
  expect(sharedContainerAllowed("GET", "/api/accounts/lease", S, null)).toBe(false);
});

test("sharedContainerAllowed: admin, terminal and approvals → denied", () => {
  for (const [m, p] of [
    ["GET", `/api/sessions/${T}/terminal`], ["GET", `/api/sessions/${S}/terminal`], ["GET", "/api/config"], ["PUT", "/api/config"],
    ["POST", "/api/ssh-approvals/abc/approve"], ["GET", "/api/ssh-approvals"], ["POST", "/api/prod-db/writes/1/approve"],
    ["POST", "/api/operations/1/approve"], ["POST", `/api/sessions/${S}/shares`], ["GET", "/api/shares"],
    ["GET", "/"], ["GET", "/api/sessions"], ["POST", "/api/agent-event/x"], ["GET", "/api/agent-event"],
    ["GET", "/git/../api/config"], ["GET", "/git/gitea/%2e%2e/x"], ["GET", "/api/prod-db/app_db/url/x"],
    // Controller decision (review round 1): no Mac clipboard and no notifications to the owner.
    ["GET", "/api/clipboard/text"], ["GET", "/api/clipboard/targets"], ["GET", "/api/clipboard/file"], ["POST", "/api/notify"],
    // Final review C3: /api/open would launch a .command/.app on the Mac from the workspace.
    ["POST", "/api/open"],
  ] as const) expect(`${m} ${p} ${sharedContainerAllowed(m, p, S, S)}`).toBe(`${m} ${p} false`);
});

/* ==================== middleware in createApp ==================== */

const BASE: Omit<SessionRow, "id" | "repo" | "container" | "port_base" | "host"> = {
  folder: "f", project: "p", status: "running", solo: 0, created_at: Date.now(), last_active_at: Date.now(), important: 0,
};
let port = 42000;
function addSession(d: Database, id: string, host: "vps" | "instabox" = "vps") {
  insertSession(d, { ...BASE, id, repo: id, container: id, port_base: port++, host });
}

/** App with containers S (IP_S) and T (IP_T); `shared` = S has an active share. */
function setup({ shared = true, ip = IP_S as string | undefined, identity = undefined as ContainerIdentity | undefined, allowExtra = undefined as string[] | undefined } = {}) {
  const src: { ip: string | undefined } = { ip };
  const deps = fakeDeps({
    dind: true,
    sshApprovalAllowExtra: allowExtra,
    remoteAddr: () => src.ip,
    containerIdentity: identity ?? new ContainerIdentity({ snapshot: async () => new Map([[IP_S, S], [IP_T, T]]) }),
  });
  addSession(deps.db, S); addSession(deps.db, T);
  const share = shared ? createShare(deps.db, S, 60) : null;
  const app = createApp(deps);
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    return app.request(`http://x${path}`, json === undefined ? rest
      : { method: "POST", ...rest, headers: { "content-type": "application/json", ...(rest.headers ?? {}) }, body: JSON.stringify(json) });
  };
  return { deps, app, call, share, src };
}

async function denied(res: Response | Promise<Response>): Promise<boolean> {
  const r = await res;
  if (r.status !== 403) return false;
  return ((await r.json()) as { error?: string }).error === SHARED_DENIED;
}

test("shared S: terminal of foreign session T → 403", async () => {
  const { call } = setup();
  expect(await denied(call(`/api/sessions/${T}/terminal`))).toBe(true);
});

test("shared S: admin /api/config → 403 with the exact message", async () => {
  const { call } = setup();
  const r = await call("/api/config");
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "session is shared — access restricted" });
});

test("shared S: /api/agent-event with sessionId S passes, with sessionId T → 403", async () => {
  const { call } = setup();
  const own = await call("/api/agent-event", { json: { sessionId: S, event: "stop" } });
  expect(own.status).not.toBe(403);
  expect(await denied(call("/api/agent-event", { json: { sessionId: T, event: "stop" } }))).toBe(true);
});

test("shared S: spoofed x-devbox-session T header from IP S → 403", async () => {
  const { call } = setup();
  expect(await denied(call("/api/op/ssh-keys", { headers: { "x-devbox-session": T } }))).toBe(true);
  expect(await denied(call("/api/health", { headers: { "x-devbox-session": T } }))).toBe(true);
  expect(await denied(call("/api/prod-db/catalog", { headers: { "x-devbox-session": T } }))).toBe(true);
  // Its own header gets through to the route.
  expect(await denied(call("/api/prod-db/catalog", { headers: { "x-devbox-session": S } }))).toBe(false);
});

test("shared S: clipboard and notify → 403 even for its own session; lease only with its own session", async () => {
  const { call } = setup();
  expect(await denied(call(`/api/clipboard/text?session=${S}`))).toBe(true);
  expect(await denied(call(`/api/clipboard/targets?session=${S}`))).toBe(true);
  expect(await denied(call(`/api/clipboard/file?session=${S}&target=shared`))).toBe(true);
  expect(await denied(call("/api/notify", { json: { title: "t", message: "m" } }))).toBe(true);
  expect(await denied(call(`/api/accounts/lease?client=devbox&session=${S}`))).toBe(false);
  expect(await denied(call(`/api/accounts/lease?client=devbox&session=${T}`))).toBe(true);
  expect(await denied(call(`/api/accounts/lease?client=mac`))).toBe(true);
});

test("shared S: /api/open → 403 even for its own session (launching a .command on the Mac)", async () => {
  const { call } = setup();
  expect(await denied(call("/api/open", { json: { sessionId: S, path: "/workspace/x.command" } }))).toBe(true);
});

test("shared S: OTel metrics only with its own devbox.session.id", async () => {
  const { call } = setup();
  const otlp = (sid: string) => ({ resourceMetrics: [{ resource: { attributes: [{ key: "devbox.session.id", value: { stringValue: sid } }] },
    scopeMetrics: [{ metrics: [{ name: "claude_code.cost.usage", sum: { dataPoints: [{ asDouble: 1, timeUnixNano: "1700000000000000000", attributes: [] }] } }] }] }] });
  const own = await call("/v1/metrics", { json: otlp(S) });
  expect(own.status).toBe(200);
  expect(await denied(call("/v1/metrics", { json: otlp(T) }))).toBe(true);
});

test("shared S: status of a foreign SSH request (GET /api/ssh-approvals/:id) → 403, its own passes", async () => {
  const { call, deps } = setup();
  const foreign = createApproval(deps.db, { session: T, title: "k", why: "w" });
  const own = createApproval(deps.db, { session: S, title: "k", why: "w" });
  expect(await denied(call(`/api/ssh-approvals/${foreign}`))).toBe(true);
  const r = await call(`/api/ssh-approvals/${own}`);
  expect(r.status).toBe(200);
});

test("shared S: ssh request body with a foreign session → 403", async () => {
  const { call } = setup();
  expect(await denied(call("/api/ssh-approvals", { json: { title: "k", why: "w", session: T } }))).toBe(true);
});

test("unshared S: everything as before (admin and foreign sessionId)", async () => {
  const { call } = setup({ shared: false });
  expect((await call("/api/config")).status).toBe(200);
  expect(await denied(call("/api/agent-event", { json: { sessionId: T, event: "stop" } }))).toBe(false);
  expect(await denied(call("/api/op/ssh-keys", { headers: { "x-devbox-session": T } }))).toBe(false);
});

test("another container (T) and loopback are not affected by sharing S", async () => {
  expect((await setup({ ip: IP_T }).call("/api/config")).status).toBe(200);
  expect((await setup({ ip: "127.0.0.1" }).call("/api/config")).status).toBe(200);
});

/* ==================== final review C1: unknown source IP ==================== */

test("C1: active share + IP outside the container map → treated like a shared session", async () => {
  const { call } = setup({ ip: "172.20.0.9" });
  expect(await denied(call("/api/config"))).toBe(true);
  expect(await denied(call(`/api/sessions/${T}/terminal`))).toBe(true);
  expect(await denied(call("/api/agent-event", { json: { sessionId: T, event: "stop" } }))).toBe(true);
  expect(await denied(call("/api/agent-event", { json: { sessionId: S, event: "stop" } }))).toBe(true);
  expect(await denied(call("/api/op/ssh-keys", { headers: { "x-devbox-session": S } }))).toBe(true);
  // Routes not bound to a session pass (same as for a shared session).
  expect((await call("/api/health")).status).not.toBe(403);
});

test("C1: link-local IPv6 outside the map → also restricted", async () => {
  expect(await denied(setup({ ip: "fe80::1" }).call("/api/config"))).toBe(true);
});

test("C1: without a restricted session an unknown IP passes as before", async () => {
  expect((await setup({ ip: "172.20.0.9", shared: false }).call("/api/config")).status).toBe(200);
});

/* ==================== rereview N2: InstaBox and DEVD_APPROVAL_ALLOW during an active share ==================== */

const IBX_IP = "100.101.102.103";
const IBX = "ibx-p-vm";

test("N2: an InstaBox machine (tailnet IP registered via addInstaboxIp) still passes during an active share", async () => {
  clearInstaboxIps();
  addInstaboxIp(IBX_IP);
  try {
    const { call, deps } = setup({ ip: IBX_IP });
    addSession(deps.db, IBX, "instabox");
    // Hooks, SSH keys, prod-db catalog and git proxy of an InstaBox session — as before C1.
    expect(await denied(call("/api/agent-event", { json: { sessionId: IBX, event: "stop" } }))).toBe(false);
    expect(await denied(call("/api/op/ssh-keys", { headers: { "x-devbox-session": IBX } }))).toBe(false);
    expect(await denied(call("/api/prod-db/catalog", { headers: { "x-devbox-session": IBX } }))).toBe(false);
    expect(await denied(call("/git/gitea/org/repo.git/info/refs?service=git-upload-pack"))).toBe(false);
    // Approval gates still do NOT let the InstaBox address through (isApprovalAllowed excludes it).
    expect((await call("/api/ssh-approvals")).status).toBe(403);
  } finally { clearInstaboxIps(); }
});

test("N2: the same tailnet address, when it is NOT an InstaBox, is loopback/tailnet and passes as before", async () => {
  clearInstaboxIps();
  expect((await setup({ ip: IBX_IP }).call("/api/config")).status).toBe(200);
});

test("N2: a source from DEVD_APPROVAL_ALLOW (outside the container map) passes during an active share", async () => {
  const { call } = setup({ ip: "203.0.113.7", allowExtra: ["203.0.113.0/24"] });
  expect((await call("/api/config")).status).toBe(200);
  expect(await denied(call("/api/agent-event", { json: { sessionId: T, event: "stop" } }))).toBe(false);
});

test("N2: DEVD_APPROVAL_ALLOW does not override a container the map knows as restricted", async () => {
  const { call } = setup({ ip: IP_S, allowExtra: ["172.16.0.0/12"] });
  expect(await denied(call("/api/config"))).toBe(true);
});

test("N2: an address outside DEVD_APPROVAL_ALLOW and outside the map stays UNKNOWN_CALLER", async () => {
  const { call } = setup({ ip: "172.20.0.9", allowExtra: ["203.0.113.0/24"] });
  expect(await denied(call("/api/config"))).toBe(true);
});

test("C1: a just-started container (not yet in the map) passes after a fresh inspect", async () => {
  let n = 0;
  const identity = new ContainerIdentity({
    snapshot: async () => (n++ === 0 ? new Map([[IP_S, S]]) : new Map([[IP_S, S], [IP_T, T]])),
    minIntervalMs: 0,
  });
  const { call } = setup({ ip: IP_T, identity });
  expect((await call("/api/config")).status).toBe(200);
  expect(n).toBe(2);
});

/* ==================== final review C4: taint survives revocation ==================== */

test("C4: revoking the share does NOT give the container full access back (taint), a rebuild (new docker id) does", async () => {
  let cid = "cid-old";
  const identity = new ContainerIdentity({
    snapshot: async () => ({ ips: new Map([[IP_S, S], [IP_T, T]]), containerIds: new Map([[S, cid], [T, "cid-t"]]) }),
    minIntervalMs: 0,
  });
  const { call, src, deps } = setup({ shared: false, identity });
  deps.shareLockdown = { containerId: async () => cid, stopDind: async () => {} };
  src.ip = "127.0.0.1";
  const created = await call(`/api/sessions/${S}/shares`, { json: { minutes: 30 } });
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await call(`/api/shares/${id}`, { method: "DELETE" })).status).toBe(204);
  src.ip = IP_S;
  expect(await denied(call("/api/config"))).toBe(true); // still restricted after revocation
  // Rebuild: the session container has a new docker id → the taint no longer applies to it.
  cid = "cid-new"; identity.markChanged();
  await identity.identify(IP_S); // new inspect → SharedSessions recomputes the taint right away
  expect((await call("/api/config")).status).toBe(200);
});

test("C4: the taint is in the DB — a new instance (devd restart) keeps it; unknown docker id = fail-closed", async () => {
  const deps = fakeDeps();
  addSession(deps.db, S);
  markTainted(deps.db, S, "cid-1");
  const noMap = new SharedSessions(deps.db);
  expect(noMap.current().has(S)).toBe(true); // container id unknown → restricted
  const same = new ContainerIdentity({ snapshot: async () => ({ ips: new Map(), containerIds: new Map([[S, "cid-1"]]) }) });
  await same.identify("x");
  expect(new SharedSessions(deps.db, Date.now, same).current().has(S)).toBe(true);
  const rebuilt = new ContainerIdentity({ snapshot: async () => ({ ips: new Map(), containerIds: new Map([[S, "cid-2"]]) }) });
  await rebuilt.identify("x");
  expect(new SharedSessions(deps.db, Date.now, rebuilt).current().has(S)).toBe(false);
});

test("creating a share via the API restricts the container right away (without waiting for the cache)", async () => {
  const { call, src } = setup({ shared: false });
  expect((await call("/api/config")).status).toBe(200);
  src.ip = "127.0.0.1"; // the admin API is behind approvalGate — the owner creates it, not the container
  expect((await call(`/api/sessions/${S}/shares`, { json: { minutes: 30 } })).status).toBe(201);
  src.ip = IP_S;
  expect(await denied(call("/api/config"))).toBe(true);
});

/* ==================== review round 1: fail-closed, git placeholder, docker events ==================== */

test("active share + unknown source address (remoteAddr undefined) → 403; without a share it passes", async () => {
  expect(await denied(setup({ ip: undefined }).call("/api/config"))).toBe(true);
  expect((await setup({ ip: undefined, shared: false }).call("/api/config")).status).toBe(200);
});

test("active share + docker inspect has never succeeded yet → container address 403, loopback passes", async () => {
  const broken = () => new ContainerIdentity({ snapshot: async () => { throw new Error("docker down"); } });
  expect(await denied(setup({ ip: "172.20.0.9", identity: broken() }).call("/api/config"))).toBe(true);
  expect((await setup({ ip: "127.0.0.1", identity: broken() }).call("/api/config")).status).toBe(200);
  expect((await setup({ ip: "172.20.0.9", identity: broken(), shared: false }).call("/api/config")).status).toBe(200);
});

test("ContainerIdentity: a forced refresh has a default spacing of 10 s", async () => {
  let calls = 0, now = 0;
  const id = new ContainerIdentity({ snapshot: async () => { calls++; return new Map(); }, now: () => now });
  await id.identify(IP_S);
  now += 9_000; await id.identify(IP_S, { fresh: true });
  expect(calls).toBe(1);
  now += 2_000; await id.identify(IP_S, { fresh: true });
  expect(calls).toBe(2);
});

test("git proxy: a foreign session's placeholder from the container of shared S → 403; its own and no-auth pass the guard", async () => {
  const { call, deps } = setup();
  deps.db.query("INSERT INTO git_placeholders (placeholder, session_id, instance, created_at) VALUES (?,?,?,?)").run("devbox-T-x", T, "gitea", 0);
  deps.db.query("INSERT INTO git_placeholders (placeholder, session_id, instance, created_at) VALUES (?,?,?,?)").run("devbox-S-x", S, "gitea", 0);
  const basic = (p: string) => ({ authorization: "Basic " + btoa(`devbox:${p}`) });
  expect(await denied(call("/git/gitea/o/r.git/info/refs", { headers: basic("devbox-T-x") }))).toBe(true);
  expect(await denied(call("/git/gitea/o/r.git/info/refs", { headers: basic("devbox-S-x") }))).toBe(false);
  expect(await denied(call("/git/gitea/o/r.git/info/refs"))).toBe(false); // git's 401 challenge
});

test("watchDockerEvents: the map is marked stale right after spawn, after every event and after the stream dies", async () => {
  let changes = 0, spawns = 0;
  const procs: { push: (s: string) => void; end: () => void }[] = [];
  const stop = watchDockerEvents(() => { changes++; }, () => {
    spawns++;
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    let exit!: () => void;
    const exited = new Promise<void>((r) => { exit = r; });
    procs.push({ push: (s) => ctl.enqueue(new TextEncoder().encode(s)), end: () => { ctl.close(); exit(); } });
    return { stdout, exited, kill: () => {} };
  }, 1);
  expect(spawns).toBe(1);
  expect(changes).toBe(1); // right after spawn
  procs[0]!.push("container start\n");
  await Bun.sleep(5);
  expect(changes).toBe(2);
  procs[0]!.end();
  await Bun.sleep(20);
  expect(spawns).toBe(2); // respawn
  expect(changes).toBeGreaterThanOrEqual(4); // stream died + new spawn
  stop();
});
