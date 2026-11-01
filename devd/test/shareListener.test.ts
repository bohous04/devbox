import { afterEach, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertSession, listEvents, openDb, setSessionName, type SessionRow } from "../src/db";
import { createShare, onShareRevoked, revokeShare } from "../src/shares";
import { createInvalidTokenLimiter, createShareApp, createShareFetch, limiterKey, startShareServer, tcpListening } from "../src/shareListener";
import type { PtyLike } from "../src/terminal";

const HOST = "share.example.com";
const ORIGIN = "https://share.example.com";

function fakePty() {
  const written: string[] = [];
  let killed = false;
  const pty: PtyLike = { onData: () => {}, onExit: () => {}, write: (d) => written.push(d), resize: () => {}, kill: () => { killed = true; } };
  return { pty, written, get killed() { return killed; } };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

function setup(opts: { listeningPorts?: (s: SessionRow) => Promise<number[]>; preview?: (req: Request) => Response; now?: () => number } = {}) {
  const db = openDb(":memory:");
  insertSession(db, { id: "dev-a", folder: "f", project: "p", repo: "app", container: "dev-a", port_base: 41000, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as SessionRow);
  setSessionName(db, "dev-a", "Moje session");
  const staticDir = mkdtempSync(join(tmpdir(), "devd-share-static-"));
  writeFileSync(join(staticDir, "share.html"), "<!doctype html><title>host</title>SHARE_PAGE");
  writeFileSync(join(staticDir, "index.html"), "ADMIN_DASHBOARD");
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "share-abc.js"), "console.log('share')");
  const ptys: ReturnType<typeof fakePty>[] = [];
  const spawnTargets: string[] = [];
  const shareApp = createShareApp({
    db, staticDir, onRevoked: onShareRevoked,
    spawnPty: (_c, _n, target) => { spawnTargets.push(target); const f = fakePty(); ptys.push(f); return f.pty; },
    listeningPorts: opts.listeningPorts, now: opts.now,
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createShareFetch({ shareApp, preview: opts.preview }), websocket });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { host: HOST, ...headers } });
  return { db, server, base, get, ptys, spawnTargets };
}

/** Raw HTTP request — `fetch` would normalise `..` in the path before it reached the server. */
function rawGet(port: number, path: string, host = HOST): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
  });
}

type WsResult = { opened: boolean; code: number; reason: string };
function openWs(port: number, path: string, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { host: HOST };
  if (origin) headers.origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers } as unknown as string[]);
  let opened = false;
  const openP = new Promise<boolean>((resolve) => {
    ws.onopen = () => { opened = true; resolve(true); };
    ws.onerror = () => resolve(false);
  });
  const closed = new Promise<WsResult>((resolve) => {
    ws.onclose = (e) => resolve({ opened, code: e.code, reason: e.reason });
  });
  return { ws, openP, closed };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("allowlist: admin API and anything outside /s/ and /assets/ → 404", async () => {
  const { get, server } = setup();
  for (const p of ["/api/vault", "/api/sessions", "/api/shares", "/", "/index.html", "/share.html", "/s/", "/assets/../index.html"]) {
    expect((await get(p)).status).toBe(404);
  }
  for (const p of ["/s/x/../api", "/s/x/../../api/vault", "/s/x/%2e%2e/api", "/s/x%2f..%2fapi", "/assets/..%2findex.html", "/assets/%2e%2e/index.html", "/s/x\\..\\api"]) {
    const res = await rawGet(server.port!, p);
    expect(res.split("\r\n")[0]).toContain("404");
    expect(res).not.toContain("ADMIN_DASHBOARD");
  }
});

test("a Host other than share → 404, the preview handler gets other hosts", async () => {
  const { get } = setup();
  expect((await get("/s/whatever", { host: "p3.example.com" })).status).toBe(404);
  expect((await get("/s/whatever", { host: "dev.example.com" })).status).toBe(404);

  const seen: string[] = [];
  const t = setup({ preview: (req) => { seen.push(req.headers.get("host") ?? ""); return new Response("preview", { status: 200 }); } });
  const r = await t.get("/", { host: "p3.example.com" });
  expect(r.status).toBe(200);
  expect(seen).toEqual(["p3.example.com"]);
});

test("invalid token → 404 page (HTML), info 404", async () => {
  const { get } = setup();
  const r = await get("/s/invalid-token");
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toContain("text/html");
  const body = await r.text();
  expect(body).not.toContain("SHARE_PAGE");
  expect(body).toContain("Share");
  expect((await get("/s/invalid-token/info")).status).toBe(404);
});

test("valid token → share.html without leaking the token into Referer; info JSON without the token", async () => {
  const { db, get } = setup({ listeningPorts: async () => [3000, 3003] });
  const now = Date.now();
  const { token, expiresAt } = createShare(db, "dev-a", 60, now);
  const page = await get(`/s/${token}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("SHARE_PAGE");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("cache-control")).toContain("no-store");

  const info = await get(`/s/${token}/info`);
  expect(info.status).toBe(200);
  const text = await info.text();
  expect(text).not.toContain(token);
  expect(JSON.parse(text)).toEqual({ name: "Moje session", expiresAt, ports: [3000, 3003] });
});

test("revoked / expired share → 404", async () => {
  const { db, get } = setup();
  const a = createShare(db, "dev-a", 60);
  revokeShare(db, a.id);
  expect((await get(`/s/${a.token}`)).status).toBe(404);
  const b = createShare(db, "dev-a", 1, Date.now() - 120_000);
  expect((await get(`/s/${b.token}/info`)).status).toBe(404);
});

test("static /assets/* from staticDir; non-existent → 404", async () => {
  const { get } = setup();
  const r = await get("/assets/share-abc.js");
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("console.log('share')");
  expect((await get("/assets/nope.js")).status).toBe(404);
});

test("rate limit: after 20 invalid tokens from one IP → 429, another IP passes", async () => {
  const { db, get } = setup();
  const { token } = createShare(db, "dev-a", 60);
  for (let i = 0; i < 20; i++) expect((await get(`/s/bad${i}`, { "cf-connecting-ip": "203.0.113.5" })).status).toBe(404);
  expect((await get(`/s/bad-x`, { "cf-connecting-ip": "203.0.113.5" })).status).toBe(429);
  expect((await get(`/s/${token}/info`, { "cf-connecting-ip": "203.0.113.5" })).status).toBe(429);
  expect((await get(`/s/${token}/info`, { "cf-connecting-ip": "198.51.100.7" })).status).toBe(200);
});

test("WS: valid token + correct Origin → bridge in control mode (input passes), tmux main, log opened", async () => {
  const { db, server, ptys, spawnTargets } = setup();
  const { id, token } = createShare(db, "dev-a", 60);
  const c = openWs(server.port!, `/s/${token}/ws`);
  expect(await c.openP).toBe(true);
  c.ws.send(JSON.stringify({ t: "i", d: "ls\r" }));
  await tick();
  expect(ptys.length).toBe(1);
  expect(ptys[0].written).toEqual(["ls\r"]);
  expect(spawnTargets).toEqual(["main"]);
  const opened = listEvents(db).filter((e) => e.type === "terminal_share_opened");
  expect(opened.length).toBe(1);
  expect(JSON.stringify(listEvents(db))).not.toContain(token);
  expect(JSON.stringify(opened[0])).toContain(id);
  c.ws.close();
  await c.closed;
  await tick();
  expect(ptys[0].killed).toBe(true);
});

test("WS with a foreign or missing Origin → closed, no pty is created", async () => {
  const { db, server, ptys } = setup();
  const { token } = createShare(db, "dev-a", 60);
  for (const origin of ["https://evil.example", "https://dev.example.com", null]) {
    const c = openWs(server.port!, `/s/${token}/ws`, origin);
    const r = await c.closed;
    expect(r.opened).toBe(false);
  }
  expect(ptys.length).toBe(0);
});

test("WS with an invalid token → closed, no pty is created", async () => {
  const { server, ptys } = setup();
  const c = openWs(server.port!, `/s/invalid/ws`);
  const r = await c.closed;
  expect(r.opened).toBe(false);
  expect(ptys.length).toBe(0);
});

test("WS: a third connection to the same share → 1013; works again after one is freed", async () => {
  const { db, server } = setup();
  const { token } = createShare(db, "dev-a", 60);
  const a = openWs(server.port!, `/s/${token}/ws`); expect(await a.openP).toBe(true);
  const b = openWs(server.port!, `/s/${token}/ws`); expect(await b.openP).toBe(true);
  const c = openWs(server.port!, `/s/${token}/ws`);
  const rc = await c.closed;
  expect(rc.code).toBe(1013);
  a.ws.close(); await a.closed; await tick();
  const d = openWs(server.port!, `/s/${token}/ws`); expect(await d.openP).toBe(true);
  await tick();
  expect(d.ws.readyState).toBe(WebSocket.OPEN);
  b.ws.close(); d.ws.close();
});

test("WS: revoking the share closes open connections with code 4001", async () => {
  const { db, server, ptys } = setup();
  const { id, token } = createShare(db, "dev-a", 60);
  const other = createShare(db, "dev-a", 60);
  const a = openWs(server.port!, `/s/${token}/ws`); expect(await a.openP).toBe(true);
  const o = openWs(server.port!, `/s/${other.token}/ws`); expect(await o.openP).toBe(true);
  revokeShare(db, id);
  const r = await a.closed;
  expect(r.code).toBe(4001);
  expect(r.reason).toBe("Share ended");
  await tick();
  expect(ptys[0].killed).toBe(true);
  expect(o.ws.readyState).toBe(WebSocket.OPEN); // another share stays
  o.ws.close();
});

test("WS: share expiry closes the connection with code 4001 and logs expired", async () => {
  // Controlled clock: at the moment of connecting exactly 200 ms remain until expiry, regardless of
  // machine load (real time could expire even before the upgrade).
  let clock = Date.now();
  const { db, server } = setup({ now: () => clock });
  const { token, expiresAt } = createShare(db, "dev-a", 1, clock);
  clock = expiresAt - 200;
  const a = openWs(server.port!, `/s/${token}/ws`); expect(await a.openP).toBe(true);
  const r = await a.closed;
  expect(r.code).toBe(4001);
  await tick();
  expect(listEvents(db).some((e) => e.type === "terminal_share_expired")).toBe(true);
});

test("tcpListening: listening port → true, closed → false", async () => {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    expect(await tcpListening("127.0.0.1", l.port)).toBe(true);
  } finally { l.stop(true); }
  expect(await tcpListening("127.0.0.1", l.port)).toBe(false);
});

/* ==================== final review I6/I7 ==================== */

test("I6: the limiter has a hard cap — with a full map the oldest clients are evicted", () => {
  let t = 0;
  const lim = createInvalidTokenLimiter(() => t, 100);
  for (let i = 0; i < 1000; i++) lim.hit(`10.0.${i >> 8}.${i & 255}`);
  expect(lim.size()).toBeLessThanOrEqual(100);
  // A fresh client still counts its attempts.
  for (let i = 0; i < 20; i++) lim.hit("9.9.9.9");
  expect(lim.blocked("9.9.9.9")).toBe(true);
  t += 61_000;
  expect(lim.blocked("9.9.9.9")).toBe(false);
});

test("I6: IPv6 clients are counted per /64 — rotating addresses within the prefix does not bypass the limiter", () => {
  const lim = createInvalidTokenLimiter(() => 0);
  for (let i = 0; i < 20; i++) lim.hit(`2001:db8:1:2::${i.toString(16)}`);
  expect(lim.blocked("2001:db8:1:2:ffff::1")).toBe(true);
  expect(lim.blocked("2001:db8:1:3::1")).toBe(false);
  expect(limiterKey("2001:0db8:0001:0002:0:0:0:1")).toBe("2001:db8:1:2::/64");
  expect(limiterKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
  expect(limiterKey("1.2.3.4")).toBe("1.2.3.4");
});

test("I7: an occupied share listener port does not crash devd — it is logged and returns null", () => {
  const logs: string[] = [];
  const r = startShareServer(() => { throw new Error("EADDRINUSE: port 4302"); }, (m) => logs.push(m));
  expect(r).toBeNull();
  expect(logs[0]).toContain("EADDRINUSE");
  expect(logs[0]).toContain("disabled");
  expect(startShareServer(() => 42)).toBe(42);
});
