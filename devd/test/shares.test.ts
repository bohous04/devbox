import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { DEFAULT_CONFIG } from "../src/config";
import { insertSession, listEvents, openDb, setSessionName, updateSession, type SessionRow } from "../src/db";
import { SessionManager } from "../src/sessions";
import {
  createShare, isShared, listActiveShares, onShareRevoked, resolveShare, revokeShare, revokeSessionShares,
  SHARE_MAX_MINUTES, SHARE_PRESETS,
} from "../src/shares";
import { markTainted, taintedContainerIds } from "../src/shareTaint";
import { fakeDeps } from "./helpers/apiHarness";
import { hasDocker as dockerAvailable, removeContainers, RUN_ID, testPortBase } from "./helpers/docker";
import { sh } from "./helpers/sh";

const T0 = 1_700_000_000_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function db(): Database { return openDb(":memory:"); }

const BASE: Omit<SessionRow, "id" | "repo" | "container" | "port_base" | "host"> = {
  folder: "f", project: "p", status: "running", solo: 0, created_at: T0, last_active_at: T0, important: 0,
};

/** Creates a running session (VPS, or InstaBox via `host`) and returns its id.
 *  `port_base` is UNIQUE — the counter gives each call its own port, so several
 *  sessions can be created in one test (see sessions.port_base UNIQUE in db.ts). */
let portCounter = 41000;
function running(d: Database, id = "dev-p-app", host: "vps" | "instabox" = "vps"): string {
  insertSession(d, { ...BASE, id, repo: "app", container: id, port_base: portCounter++, host });
  return id;
}

/* ==================== shares.ts: data layer ==================== */

test("createShare: the token is 43 base64url characters; only its hash is stored in the DB", () => {
  const d = db();
  running(d);
  const { id, token, expiresAt } = createShare(d, "dev-p-app", 30, T0);
  expect(token).toMatch(TOKEN_RE);
  expect(expiresAt).toBe(T0 + 30 * 60_000);
  const row = d.query("SELECT * FROM terminal_shares WHERE id=?").get(id) as Record<string, unknown>;
  expect(row.session_id).toBe("dev-p-app");
  expect(row.token_hash).not.toBe(token);
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  // The raw token is nowhere in the stored row, not even hidden in another column.
  expect(JSON.stringify(row).includes(token)).toBe(false);
});

test("resolveShare: valid until expires_at (inclusive), exactly at the moment of expiry and after it is null", () => {
  const d = db();
  running(d);
  const { token } = createShare(d, "dev-p-app", 30, T0);
  expect(resolveShare(d, token, T0)?.session_id).toBe("dev-p-app");
  expect(resolveShare(d, token, T0 + 30 * 60_000 - 1)).not.toBeNull();
  expect(resolveShare(d, token, T0 + 30 * 60_000)).toBeNull();
  expect(resolveShare(d, token, T0 + 30 * 60_000 + 1)).toBeNull();
});

test("resolveShare: unknown token, revoked or non-running session → null; valid again once running resumes", () => {
  const d = db();
  running(d);
  const { token } = createShare(d, "dev-p-app", 30, T0);
  expect(resolveShare(d, "a".repeat(43), T0)).toBeNull();
  updateSession(d, "dev-p-app", { status: "stopped" });
  expect(resolveShare(d, token, T0)).toBeNull();
  updateSession(d, "dev-p-app", { status: "running" });
  expect(resolveShare(d, token, T0)).not.toBeNull();
});

test("resolveShare: an InstaBox session is never valid, even with a valid unrevoked token", () => {
  const d = db();
  running(d, "dev-p-ibx", "instabox");
  const { token } = createShare(d, "dev-p-ibx", 30, T0);
  expect(resolveShare(d, token, T0)).toBeNull();
});

test("revokeShare invalidates the token, returns session_id, is idempotent and emits onShareRevoked", () => {
  const d = db();
  running(d);
  const { id, token } = createShare(d, "dev-p-app", 30, T0);
  const revoked: string[][] = [];
  const off = onShareRevoked((ids) => revoked.push(ids));
  try {
    expect(revokeShare(d, id, T0 + 1)).toBe("dev-p-app");
    expect(resolveShare(d, token, T0 + 1)).toBeNull();
    expect(revokeShare(d, id, T0 + 2)).toBeNull(); // already revoked — no second event
    expect(revoked).toEqual([[id]]);
  } finally { off(); }
});

test("revokeShare on an unknown id returns null and nothing is emitted", () => {
  const d = db();
  const revoked: string[][] = [];
  const off = onShareRevoked((ids) => revoked.push(ids));
  try {
    expect(revokeShare(d, "missing", T0)).toBeNull();
    expect(revoked).toEqual([]);
  } finally { off(); }
});

test("revokeSessionShares revokes all live shares of ONE session, returns their ids and does not touch a foreign session", () => {
  const d = db();
  running(d, "dev-p-app");
  running(d, "dev-p-other");
  const a = createShare(d, "dev-p-app", 30, T0);
  const b = createShare(d, "dev-p-app", 60, T0);
  const c = createShare(d, "dev-p-other", 30, T0);
  const revoked: string[][] = [];
  const off = onShareRevoked((ids) => revoked.push(ids));
  try {
    const ids = revokeSessionShares(d, "dev-p-app", T0 + 1);
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
    expect(resolveShare(d, a.token, T0 + 1)).toBeNull();
    expect(resolveShare(d, b.token, T0 + 1)).toBeNull();
    expect(resolveShare(d, c.token, T0 + 1)).not.toBeNull();
    expect(revoked).toHaveLength(1);
    expect([...revoked[0]!].sort()).toEqual([a.id, b.id].sort());
  } finally { off(); }
});

test("revokeSessionShares on a session without shares returns [] and does not emit", () => {
  const d = db();
  running(d);
  const revoked: string[][] = [];
  const off = onShareRevoked((ids) => revoked.push(ids));
  try {
    expect(revokeSessionShares(d, "dev-p-app", T0)).toEqual([]);
    expect(revoked).toEqual([]);
  } finally { off(); }
});

// Review fix round 1 (Important #1): emitShareRevoked is called IN THE MIDDLE of
// SessionManager.end()/recreate() (see sessions.ts revokeShares) — a crashed
// listener must not interrupt revoking the rows nor bring down the rest of the session teardown.
// It is tested directly on `revokeShare`/`revokeSessionShares` (those are exactly the
// functions `end()`/`recreate()` call), not through the whole Docker lifecycle —
// "the end-equivalent run carries on" means exactly this: the call does not throw.
test("revokeShare: a crashed listener does not prevent the revocation nor delivery to the other listeners", () => {
  const d = db();
  running(d);
  const { id } = createShare(d, "dev-p-app", 30, T0);
  const received: string[][] = [];
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  const offBad = onShareRevoked(() => { throw new Error("boom"); });
  const offGood = onShareRevoked((ids) => received.push(ids));
  try {
    let threw = false;
    let sessionId: string | null = null;
    try { sessionId = revokeShare(d, id, T0 + 1); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(sessionId).toBe("dev-p-app"); // the revocation itself completed, even though one listener crashed
    expect(received).toEqual([[id]]); // the second listener got the event anyway
    expect(errors.some((e) => e.includes("boom"))).toBe(true); // but the error was neither swallowed nor lost without a trace
  } finally { offBad(); offGood(); console.error = origError; }
});

test("revokeSessionShares: a crashed listener does not prevent revoking all of the session's shares (the end-equivalent run carries on)", () => {
  const d = db();
  running(d);
  const { id } = createShare(d, "dev-p-app", 30, T0);
  const received: string[][] = [];
  const origError = console.error;
  console.error = () => {};
  const offBad = onShareRevoked(() => { throw new Error("boom"); });
  const offGood = onShareRevoked((ids) => received.push(ids));
  try {
    let threw = false;
    let ids: string[] = [];
    try { ids = revokeSessionShares(d, "dev-p-app", T0 + 1); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(ids).toEqual([id]);
    expect(received).toEqual([[id]]);
    expect(isShared(d, "dev-p-app", T0 + 1)).toBe(false); // the revocation in the DB went through completely
  } finally { offBad(); offGood(); console.error = origError; }
});

test("listActiveShares: only unrevoked and unexpired, with the session name; disappear after revoke and after expiry", () => {
  const d = db();
  running(d);
  setSessionName(d, "dev-p-app", "Nice session");
  const a = createShare(d, "dev-p-app", 30, T0);
  const b = createShare(d, "dev-p-app", 10, T0);
  expect(listActiveShares(d, T0).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  expect(listActiveShares(d, T0).find((r) => r.id === a.id)?.name).toBe("Nice session");
  revokeShare(d, a.id, T0);
  expect(listActiveShares(d, T0).map((r) => r.id)).toEqual([b.id]);
  expect(listActiveShares(d, T0 + 10 * 60_000)).toEqual([]); // b has just expired
});

test("isShared: true while at least one live share of the session exists", () => {
  const d = db();
  running(d);
  expect(isShared(d, "dev-p-app", T0)).toBe(false);
  const { id } = createShare(d, "dev-p-app", 30, T0);
  expect(isShared(d, "dev-p-app", T0)).toBe(true);
  revokeShare(d, id, T0);
  expect(isShared(d, "dev-p-app", T0)).toBe(false);
});

test("SHARE_PRESETS and SHARE_MAX_MINUTES match the spec", () => {
  expect(SHARE_PRESETS).toEqual([30, 60, 240, 480, 1440]);
  expect(SHARE_MAX_MINUTES).toBe(1440);
});

/* ==================== admin API (createApp, :4300) ==================== */

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function harness(over: Partial<Parameters<typeof fakeDeps>[0]> = {}) {
  const deps = fakeDeps({ dind: true, ...over });
  return { app: createApp(deps), db: deps.db, deps };
}

test("POST /api/sessions/:id/shares: valid request → 201, the url carries the token, the log has no token", async () => {
  const { app, db: d } = harness();
  running(d);
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 60 }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; url: string; expiresAt: number };
  expect(body.url).toMatch(/^https:\/\/share\.example\.com\/s\/[A-Za-z0-9_-]{43}$/);
  const token = body.url.slice(body.url.lastIndexOf("/") + 1);
  expect(resolveShare(d, token)).not.toBeNull();
  const [ev] = listEvents(d, { session: "dev-p-app", type: "terminal_share_created" });
  expect(ev).toBeDefined();
  expect(ev!.data).not.toContain(token);
  expect(JSON.parse(ev!.data ?? "{}")).toEqual({ id: body.id, minutes: 60 });
});

test("POST /api/sessions/:id/shares: minutes 0 or 1441 → 400, nothing is created", async () => {
  const { app, db: d } = harness();
  running(d);
  for (const minutes of [0, 1441, -1, 1.5, "60"]) {
    const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes }));
    expect(res.status).toBe(400);
  }
  expect(listActiveShares(d)).toEqual([]);
});

test("POST /api/sessions/:id/shares: unknown session → 404", async () => {
  const { app } = harness();
  const res = await app.request("/api/sessions/dev-missing/shares", post({ minutes: 30 }));
  expect(res.status).toBe(404);
});

test("POST /api/sessions/:id/shares: InstaBox session → 409", async () => {
  const { app, db: d } = harness();
  running(d, "dev-p-ibx", "instabox");
  const res = await app.request("/api/sessions/dev-p-ibx/shares", post({ minutes: 30 }));
  expect(res.status).toBe(409);
  expect(listActiveShares(d)).toEqual([]);
});

test("POST /api/sessions/:id/shares: stopped (not running) session → 409", async () => {
  const { app, db: d } = harness();
  running(d);
  updateSession(d, "dev-p-app", { status: "stopped" });
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(409);
});

test("POST /api/sessions/:id/shares: without dind (host docker.sock in the session) → 409, nothing is created", async () => {
  const { app, db: d } = harness({ dind: false });
  running(d);
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("DEVD_DIND");
  expect(listActiveShares(d)).toEqual([]);
});

test("GET /api/shares returns only active shares; DELETE /api/shares/:id revokes them and logs PER SESSION", async () => {
  const { app, db: d } = harness();
  running(d);
  const created = await (await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }))).json() as { id: string };
  const listed = await (await app.request("/api/shares")).json() as { id: string }[];
  expect(listed.map((r) => r.id)).toEqual([created.id]);

  const del = await app.request(`/api/shares/${created.id}`, { method: "DELETE" });
  expect(del.status).toBe(204);
  // Review fix round 1 (#4): the log must carry session_id, not an anonymous null row —
  // the `session` filter here returns nothing if it were logged with null.
  const [ev] = listEvents(d, { session: "dev-p-app", type: "terminal_share_revoked" });
  expect(ev).toBeDefined();
  expect(JSON.parse(ev!.data ?? "{}")).toEqual({ id: created.id });

  const afterDelete = await (await app.request("/api/shares")).json() as unknown[];
  expect(afterDelete).toEqual([]);

  // A second revoke and an unknown id → 404.
  expect((await app.request(`/api/shares/${created.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await app.request("/api/shares/missing", { method: "DELETE" })).status).toBe(404);
});

test("approvalGate: share admin routes from a container address are 403, from loopback they pass", async () => {
  const DOCKER_BRIDGE_ADDR = "172.17.0.2";
  const { app: blocked, db: d } = harness({ remoteAddr: () => DOCKER_BRIDGE_ADDR });
  running(d);
  expect((await blocked.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }))).status).toBe(403);
  expect((await blocked.request("/api/shares")).status).toBe(403);
  expect((await blocked.request("/api/shares/x", { method: "DELETE" })).status).toBe(403);

  const { app: allowed } = harness({ remoteAddr: () => "127.0.0.1", db: d });
  expect((await allowed.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }))).status).toBe(201);
});

/* ==================== final review C2/C4: restriction before the link ==================== */

test("C2: the dind sidecar is stopped and the container tainted BEFORE the link is created", async () => {
  const order: string[] = [];
  const { app, db: d } = harness({
    shareLockdown: {
      containerId: async (c) => { order.push(`id:${c}`); return "cid-app"; },
      stopDind: async (sid) => {
        order.push(`stop:${sid}`);
        expect(listActiveShares(d)).toEqual([]);
        // The taint is already recorded (rereview N4) — a concurrent ensureDind does not start the sidecar again.
        expect(taintedContainerIds(d, sid)).toEqual(["cid-app"]);
      },
      syncFirewall: async () => { order.push("fw"); expect(listActiveShares(d)).toEqual([]); },
    },
  });
  running(d);
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(201);
  expect(order).toEqual(["id:dev-p-app", "stop:dev-p-app", "fw"]);
  expect(taintedContainerIds(d, "dev-p-app")).toEqual(["cid-app"]);
});

test("C2: dind cannot be stopped → 502 with a clear error, no share; the taint stays (fail-closed, N4)", async () => {
  const { app, db: d } = harness({
    shareLockdown: { containerId: async () => "cid-app", stopDind: async () => { throw new Error("daemon not responding"); } },
  });
  running(d);
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(502);
  const { error } = await res.json() as { error: string };
  expect(error).toContain("dind");
  expect(error).toContain("daemon not responding");
  expect(listActiveShares(d)).toEqual([]);
  expect(taintedContainerIds(d, "dev-p-app")).toEqual(["cid-app"]);
});

test("N4: creating a share holds the session lock — a concurrent open/recreate gets busy and vice versa", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inStop = new Promise<void>((r) => { entered = r; });
  const { app, db: d, deps } = harness({
    shareLockdown: { containerId: async () => "cid-app", stopDind: async () => { entered(); await gate; } },
  });
  running(d);
  const pending = app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  await inStop;
  // During taint+stop+insert nothing that could start dind may run on the same session.
  await expect(deps.mgr.withLock(["dev-p-app"], "recreate", async () => "x")).rejects.toThrow();
  release();
  expect((await pending).status).toBe(201);

  // Conversely: if another operation runs on the session, sharing responds 409 and does not touch docker.
  let touched = false;
  const { app: app2, db: d2, deps: deps2 } = harness({
    shareLockdown: { containerId: async () => { touched = true; return "cid-app"; }, stopDind: async () => {} },
  });
  running(d2);
  let unlock!: () => void;
  const held = deps2.mgr.withLock(["dev-p-app"], "recreate", () => new Promise<void>((r) => { unlock = r; }));
  const res = await app2.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { inProgress: string }).inProgress).toBe("recreate");
  expect(touched).toBe(false);
  expect(listActiveShares(d2)).toEqual([]);
  unlock(); await held;
});

test("C2: the session container does not exist → 409, nothing is created", async () => {
  const { app, db: d } = harness({ shareLockdown: { containerId: async () => null, stopDind: async () => {} } });
  running(d);
  expect((await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }))).status).toBe(409);
  expect(listActiveShares(d)).toEqual([]);
});

test("I5: the firewall cannot be set → 502, no link is created (the taint stays — fail-closed)", async () => {
  const { app, db: d } = harness({
    shareLockdown: { containerId: async () => "cid-app", stopDind: async () => {}, syncFirewall: async () => { throw new Error("iptables missing"); } },
  });
  running(d);
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("firewall");
  expect(listActiveShares(d)).toEqual([]);
  expect(taintedContainerIds(d, "dev-p-app")).toEqual(["cid-app"]);
});

test("C4: GET /api/sessions carries tainted — still true after the share is revoked", async () => {
  const { app, db: d } = harness();
  running(d); running(d, "dev-p-clean");
  const created = await (await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }))).json() as { id: string };
  await app.request(`/api/shares/${created.id}`, { method: "DELETE" });
  const rows = await (await app.request("/api/sessions")).json() as { id: string; tainted: boolean }[];
  expect(rows.find((r) => r.id === "dev-p-app")?.tainted).toBe(true);
  expect(rows.find((r) => r.id === "dev-p-clean")?.tainted).toBe(false);
});

test("I3: /api/preview of a tainted session does not open the preview on the Mac; /api/open → 403", async () => {
  const opened: string[] = [];
  const base = fakeDeps().listener;
  const { app, db: d } = harness({
    previewHost: "100.64.0.1",
    listener: { ...base, openUrl: async (u: string) => { opened.push(u); }, open: async (p: string) => { opened.push(p); } },
  });
  running(d);
  markTainted(d, "dev-p-app", "cid-x");
  const r = await app.request("/api/preview", post({ sessionId: "dev-p-app", containerPort: 3000 }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ publicPreview: false, port: 3000 });
  const o = await app.request("/api/open", post({ sessionId: "dev-p-app", path: "/workspace/x.command" }));
  expect(o.status).toBe(403);
  expect(opened).toEqual([]);
});

/* ==================== sessions.ts: invalidation on end/recreate/replace (needs docker) ====================
 * Review fix round 1 (Important #2): "a share ends when the container is recreated" means
 * EVERY replacement of an existing session's container, not just SessionManager.recreate().
 * end()/recreate()/stop() have been covered since Task 1 — this section adds open()'s
 * stale-container branch and restartSolo()'s stale branch (the same `private revokeShares`
 * is also called by the recovery `create` callbacks in recoverAfterRestart/resumeRemote, but those
 * cannot be meaningfully tested as a standalone Docker test without simulating a devd restart/the Remote route,
 * and they rely on the same, already verified helper). */

// Linux only: after a container stops, Docker Desktop on the Mac reports the bind source as
// /host_mnt/private/…, so the workspace check (correctly) rejects recreate; devd runs on Linux.
const hasDocker = process.platform === "linux" && dockerAvailable;
const PROJECT = `share-${RUN_ID}`;
afterEach(() => { if (hasDocker) removeContainers(`dev-${PROJECT}-`); });
const APP_ID = `dev-${PROJECT}-app`;
const PORT_BASE = testPortBase();

function dockerDeps() {
  const root = mkdtempSync(join(tmpdir(), "devd-shares-"));
  const bare = join(root, "origin.git");
  sh(root, "git", "init", "--bare", "-b", "main", bare);
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  sh(seed, "git", "init", "-b", "main"); sh(seed, "git", "config", "user.email", "t@t"); sh(seed, "git", "config", "user.name", "t");
  writeFileSync(join(seed, "f.txt"), "x\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "init");
  sh(seed, "git", "push", bare, "HEAD:main");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.settings.portRangeStart = PORT_BASE;
  // controlRoot outside the default /var/lib/devd/sessions — without root syncPromptFile fails there with EACCES.
  return { db: openDb(":memory:"), cfg, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"], bareUrl: bare, controlRoot: join(root, "ctl") };
}

test.skipIf(!hasDocker)("end() revokes all of the session's shares (onShareRevoked is called)", async () => {
  const d = dockerDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  try {
    const opened = await mgr.open(t);
    const { id: shareId, token } = createShare(d.db, APP_ID, 30);
    expect(isShared(d.db, APP_ID)).toBe(true);
    const revoked: string[][] = [];
    const off = onShareRevoked((ids) => revoked.push(ids));
    try {
      await mgr.end(opened.session.id);
      expect(revoked).toEqual([[shareId]]);
    } finally { off(); }
    expect(resolveShare(d.db, token)).toBeNull();
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 180_000);

test.skipIf(!hasDocker)("recreate() revokes shares — the new container carries different tmux sessions", async () => {
  const d = dockerDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  try {
    const opened = await mgr.open(t);
    createShare(d.db, APP_ID, 30);
    expect(isShared(d.db, APP_ID)).toBe(true);
    await mgr.recreate(opened.session.id);
    expect(isShared(d.db, APP_ID)).toBe(false);
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 180_000);

test.skipIf(!hasDocker)("stop() does NOT revoke shares — a share survives an agent stop/restart", async () => {
  const d = dockerDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  try {
    const opened = await mgr.open(t);
    createShare(d.db, APP_ID, 30);
    await mgr.stop(opened.session.id);
    expect(isShared(d.db, APP_ID)).toBe(true);
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 180_000);

// Same scenario as the "open logs agent-switch..." test in sessions.test.ts: the container
// disappears OUTSIDE devd (the host lost it), but the DB still claims running — open() on the same
// session then goes into the `state === "missing"` branch, which replaces the container.
test.skipIf(!hasDocker)("open(): reopening with a vanished container (state=missing) revokes the old share", async () => {
  const d = dockerDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  try {
    await mgr.open(t);
    createShare(d.db, APP_ID, 30);
    expect(isShared(d.db, APP_ID)).toBe(true);
    sh(process.cwd(), "docker", "rm", "-f", APP_ID); // the container disappears outside devd → state "missing"
    await mgr.open(t);
    expect(isShared(d.db, APP_ID)).toBe(false);
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 180_000);

// Sister scenario to the "restartSolo: a stopped proxy session picks up the key after the vault
// is unlocked" test in sessions.test.ts: a stopped solo session with a stale proxy env is
// REBUILT on restart (not just startContainer), which must revoke the old share.
test.skipIf(!hasDocker)("restartSolo(): rebuilding the container (stale proxy env) revokes shares", async () => {
  const d = dockerDeps();
  d.cfg.settings.proxyModels = { gpt: "gpt-5.6-sol" };
  let key: string | null = null; // vault locked at open time
  const mgr = new SessionManager({ ...d, cliproxyKey: () => key });
  try {
    const s = await mgr.openSolo("acme", PROJECT, "claude-gpt");
    await mgr.stop(s.session.id);
    createShare(d.db, s.session.id, 30);
    expect(isShared(d.db, s.session.id)).toBe(true);
    key = "k-after-unlock"; // vault unlocked → the proxy env in the stopped container is stale
    await mgr.restartSolo(s.session.id);
    expect(isShared(d.db, s.session.id)).toBe(false);
  } finally { for (const s of mgr.list()) await mgr.end(s.id, "delete"); }
}, 300_000);

test("I7: the share listener is not running (bind 4302 failed) → creating links 503, nothing is created", async () => {
  const { app, db: d } = harness({ shareAvailable: () => false });
  running(d);
  const res = await app.request("/api/sessions/dev-p-app/shares", post({ minutes: 30 }));
  expect(res.status).toBe(503);
  expect(listActiveShares(d)).toEqual([]);
});
