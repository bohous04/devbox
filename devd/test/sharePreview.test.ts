import { afterEach, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { createShare, onShareRevoked, revokeShare } from "../src/shares";
import { createShareApp, createShareFetch } from "../src/shareListener";
import { createPreview, PREVIEW_COOKIE, previewPortForHost, rewriteAppSetCookie } from "../src/sharePreview";

const P3 = "p3.example.com";
const ORIGIN = `https://${P3}`;

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

interface UpstreamSeen { url: string; method: string; headers: Headers; body: string }

/** Fake application in the container: HTTP records what it received; /ws is an echo websocket. */
function fakeUpstream(handler?: (req: Request) => Response | Promise<Response>) {
  const seen: UpstreamSeen[] = [];
  const wsSeen: Headers[] = [];
  const sockets: { close(code?: number, reason?: string): void; readyState: number }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        wsSeen.push(req.headers);
        if (new URL(req.url).pathname === "/slow-ws") await tick(300); // slow dev server
        const proto = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        return srv.upgrade(req, proto ? { headers: { "sec-websocket-protocol": proto } } : undefined) ? undefined : new Response("no", { status: 400 });
      }
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
      return handler ? handler(req) : new Response("UPSTREAM_OK", { headers: { "x-app": "1" } });
    },
    websocket: {
      open(ws) { sockets.push(ws); },
      message(ws, m) { if (typeof m !== "string") ws.send(m); else if (m === "bye") ws.close(4321, "app closing"); else ws.send(`echo:${m}`); },
    },
  });
  servers.push(server);
  return { server, seen, wsSeen, sockets };
}

function setup(opts: { handler?: (req: Request) => Response | Promise<Response>; portsPerSession?: number; now?: () => number } = {}) {
  const up = fakeUpstream(opts.handler);
  const db = openDb(":memory:");
  // p3 → port_base+3 = the fake application's port; a second session sits right next to it.
  insertSession(db, { id: "dev-a", folder: "f", project: "p", repo: "app", container: "dev-a", port_base: up.server.port! - 3, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as SessionRow);
  const staticDir = mkdtempSync(join(tmpdir(), "devd-preview-static-"));
  writeFileSync(join(staticDir, "share.html"), "SHARE_PAGE");
  const shareApp = createShareApp({ db, staticDir, onRevoked: onShareRevoked, spawnPty: () => { throw new Error("no pty"); } });
  const preview = createPreview({ db, bindIp: "127.0.0.1", portsPerSession: opts.portsPerSession ?? 5, onRevoked: onShareRevoked, now: opts.now });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createShareFetch({ shareApp, preview }), websocket });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const req = (path: string, init: RequestInit & { host?: string } = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { host: init.host ?? P3, ...(init.headers as Record<string, string> | undefined) } });
  const share = createShare(db, "dev-a", 60);
  const cookie = `${PREVIEW_COOKIE}=${share.token}`;
  return { db, up, server, base, req, share, cookie };
}

function openWs(port: number, path: string, headers: Record<string, string>, protocols?: string[]) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, protocols } as unknown as string[]);
  const messages: string[] = [];
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => messages.push(typeof e.data === "string" ? e.data : `bin:${[...new Uint8Array(e.data as ArrayBuffer)].join(",")}`);
  const openP = new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => { ws.onclose = (e) => resolve({ code: e.code, reason: e.reason }); });
  return { ws, messages, openP, closed };
}

test("previewPortForHost: p0…p9 on the preview domain, nothing else", () => {
  expect(previewPortForHost("p3.example.com")).toBe(3);
  expect(previewPortForHost("P0.EXAMPLE.COM:443")).toBe(0);
  expect(previewPortForHost("p9.example.com")).toBe(9);
  for (const h of ["p10.example.com", "share.example.com", "p3.evil.com", "p3.example.com.evil.com", "x.p3.example.com", "p-1.example.com", "pa.example.com", ""]) {
    expect(previewPortForHost(h)).toBeNull();
  }
  expect(previewPortForHost("p4.example.org", "example.org")).toBe(4);
  expect(previewPortForHost("p4.example.com", "example.org")).toBeNull();
});

test("GET /s/<token>: valid token → __Host- cookie until expiry and 302 to /, the application gets nothing", async () => {
  const { req, share, up } = setup();
  const r = await req(`/s/${share.token}`);
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/");
  const sc = r.headers.get("set-cookie") ?? "";
  const m = sc.match(/^__Host-devbox-share=([^;]+); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=(\d+)$/);
  expect(m).not.toBeNull();
  expect(m![1]).toBe(share.token);
  expect(Number(m![2])).toBeGreaterThan(3590);
  expect(Number(m![2])).toBeLessThanOrEqual(3600);
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(up.seen).toHaveLength(0);
});

test("GET /s/<invalid>: 410, after 20 attempts 429 (rate limit by CF-Connecting-IP)", async () => {
  const { req, up } = setup();
  const r = await req("/s/invalid-token");
  expect(r.status).toBe(410);
  expect(r.headers.get("set-cookie")).toBeNull();
  for (let i = 0; i < 20; i++) await req("/s/x" + i, { headers: { "cf-connecting-ip": "1.2.3.4" } });
  expect((await req("/s/x99", { headers: { "cf-connecting-ip": "1.2.3.4" } })).status).toBe(429);
  expect((await req("/s/x99", { headers: { "cf-connecting-ip": "5.6.7.8" } })).status).toBe(410);
  expect(up.seen).toHaveLength(0);
});

test("with cookie: proxy to port_base+N with Host localhost:300N, without the share cookie, X-Forwarded-Proto https", async () => {
  const { req, cookie, up } = setup();
  // The application does not get another host's domain-wide cookie (a, b); it does get its own host-only __Host-pv-* (I2).
  const r = await req("/app/page?q=1", { headers: { cookie: `a=1; ${cookie}; __Host-pv-sid=42; b=2; __Host-pv-theme=dark`, "x-forwarded-proto": "http" } });
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("UPSTREAM_OK");
  expect(r.headers.get("x-app")).toBe("1");
  expect(up.seen).toHaveLength(1);
  const s = up.seen[0];
  expect(new URL(s.url).pathname + new URL(s.url).search).toBe("/app/page?q=1");
  expect(s.headers.get("host")).toBe("localhost:3003");
  expect(s.headers.get("cookie")).toBe("sid=42; theme=dark");
  expect(s.headers.get("x-forwarded-proto")).toBe("https");
  expect(s.headers.get("x-forwarded-host")).toBe(P3);
});

test("with only the share cookie: the application gets no Cookie header at all; the POST body passes", async () => {
  const { req, cookie, up } = setup();
  const r = await req("/api/x", { method: "POST", body: "request-body", headers: { cookie, "content-type": "text/plain" } });
  expect(r.status).toBe(200);
  expect(up.seen[0].method).toBe("POST");
  expect(up.seen[0].body).toBe("request-body");
  expect(up.seen[0].headers.get("cookie")).toBeNull();
});

test("without a cookie / with an invalid or revoked cookie → 410 \"Share expired\", the application gets nothing", async () => {
  const { req, cookie, up, db, share } = setup();
  const none = await req("/");
  expect(none.status).toBe(410);
  expect(await none.text()).toContain("Share expired");
  expect((await req("/", { headers: { cookie: `${PREVIEW_COOKIE}=bogus` } })).status).toBe(410);
  revokeShare(db, share.id);
  expect((await req("/", { headers: { cookie } })).status).toBe(410);
  expect(up.seen).toHaveLength(0);
});

test("port outside the session (p7 with 5 ports) or a foreign host → 404, never proxied", async () => {
  const { req, cookie, up } = setup({ portsPerSession: 5 });
  expect((await req("/", { host: "p7.example.com", headers: { cookie } })).status).toBe(404);
  expect((await req("/", { host: "p3.evil.com", headers: { cookie } })).status).toBe(404);
  expect((await req("/", { host: "p12.example.com", headers: { cookie } })).status).toBe(404);
  expect(up.seen).toHaveLength(0);
});

test("/s/<something> with a valid cookie but without a valid token → belongs to the application (proxy)", async () => {
  const { req, cookie, up } = setup();
  const r = await req("/s/app-route", { headers: { cookie } });
  expect(r.status).toBe(200);
  expect(new URL(up.seen[0].url).pathname).toBe("/s/app-route");
});

test("Location from the application (localhost:300N) is rewritten to the public host; the redirect is not followed", async () => {
  const { req, cookie } = setup({ handler: () => new Response(null, { status: 302, headers: { location: "http://localhost:3003/login?x=1" } }) });
  const r = await req("/", { headers: { cookie } });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe(`https://${P3}/login?x=1`);
});

test("the response is streamed (the first chunk arrives before the application finishes) and revoking the share cuts the stream", async () => {
  let push!: (s: string) => void;
  const { req, cookie, db, share } = setup({
    handler: () => new Response(new ReadableStream({
      start(ctrl) {
        push = (s) => ctrl.enqueue(new TextEncoder().encode(s));
        push("data: 1\n\n"); // Bun sends the headers only with the first chunk
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const r = await req("/events", { headers: { cookie } });
  const reader = r.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
  push("data: 2\n\n"); // the application is still running — the second chunk must arrive separately
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 2\n\n");
  revokeShare(db, share.id);
  const ended = await Promise.race([reader.read().then((x) => (x.done ? "done" : "data"), () => "error"), tick(1000).then(() => "timeout")]);
  expect(["done", "error"]).toContain(ended);
});

test("WS proxy (HMR): subprotocol, messages in both directions, the application sees Host localhost:300N without the share cookie", async () => {
  const { server, cookie, up } = setup();
  const c = openWs(server.port!, "/hmr?token=abc", { host: P3, origin: ORIGIN, cookie: `${cookie}; k=foreign; __Host-pv-k=v` }, ["vite-hmr"]);
  expect(await c.openP).toBe(true);
  expect(c.ws.protocol).toBe("vite-hmr");
  c.ws.send("hello");
  c.ws.send(new Uint8Array([1, 2, 3]));
  await tick(100);
  expect(c.messages).toEqual(["echo:hello", "bin:1,2,3"]);
  const h = up.wsSeen[0];
  expect(h.get("host")).toBe("localhost:3003");
  expect(h.get("cookie")).toBe("k=v");
  expect(h.get("origin")).toBe("http://localhost:3003");
  c.ws.close();
});

test("WS: the application closes → the guest closes too; the guest closes → the application closes", async () => {
  const { server, cookie, up } = setup();
  const a = openWs(server.port!, "/ws", { host: P3, origin: ORIGIN, cookie });
  expect(await a.openP).toBe(true);
  a.ws.send("bye");
  expect((await a.closed).code).toBe(4321);

  const b = openWs(server.port!, "/ws", { host: P3, origin: ORIGIN, cookie });
  expect(await b.openP).toBe(true);
  await tick(50);
  b.ws.close();
  await tick(150);
  expect(up.sockets.at(-1)!.readyState).toBe(3); // CLOSED
});

test("WS: without a cookie or with a foreign Origin it is not upgraded and the application gets nothing", async () => {
  const { server, cookie, up } = setup();
  const noCookie = openWs(server.port!, "/ws", { host: P3, origin: ORIGIN });
  expect(await noCookie.openP).toBe(false);
  const badOrigin = openWs(server.port!, "/ws", { host: P3, origin: "https://evil.example", cookie });
  expect(await badOrigin.openP).toBe(false);
  expect(up.wsSeen).toHaveLength(0);
});

test("WS: revoking the share closes the proxied socket on both the guest and the application side", async () => {
  const { server, cookie, up, db, share } = setup();
  const c = openWs(server.port!, "/ws", { host: P3, origin: ORIGIN, cookie });
  expect(await c.openP).toBe(true);
  revokeShare(db, share.id);
  const res = await Promise.race([c.closed, tick(1000).then(() => null)]);
  expect(res?.code).toBe(4001);
  await tick(100);
  expect(up.sockets.at(-1)!.readyState).toBe(3);
});

test("WS: share expiry closes the proxied socket", async () => {
  const up0 = Date.now();
  const { server, db } = setup();
  // A share that expires in ~1 s (1 min, created 59 s "ago") — headroom for a slow open under load.
  const short = createShare(db, "dev-a", 1, up0 - 60_000 + 1000);
  const c = openWs(server.port!, "/ws", { host: P3, origin: ORIGIN, cookie: `${PREVIEW_COOKIE}=${short.token}` });
  expect(await c.openP).toBe(true);
  const res = await Promise.race([c.closed, tick(4000).then(() => null)]);
  expect(res?.code).toBe(4001);
}, 10_000);

test("WS: revoking the share while connecting to the application → the guest does not stay connected", async () => {
  const { server, cookie, db, share, up } = setup();
  const c = openWs(server.port!, "/slow-ws", { host: P3, origin: ORIGIN, cookie });
  await tick(100);
  revokeShare(db, share.id);
  const res = await Promise.race([c.closed, tick(2000).then(() => null)]);
  expect(res?.code).toBe(4001);
  await tick(100);
  expect(up.sockets.at(-1)!.readyState).toBe(3);
});

/* ==================== final review I1/I2 ==================== */

test("I1: a request with the Service-Worker header → 403, the application gets nothing; Service-Worker-Allowed is dropped", async () => {
  const { req, cookie, up } = setup({ handler: () => new Response("self.addEventListener('fetch',()=>{})", { headers: { "service-worker-allowed": "/", "content-type": "text/javascript" } }) });
  const r = await req("/sw.js", { headers: { cookie, "service-worker": "script" } });
  expect(r.status).toBe(403);
  expect(r.headers.get("clear-site-data")).toBe('"cache", "storage"');
  expect(up.seen).toHaveLength(0);
  const plain = await req("/sw.js", { headers: { cookie } });
  expect(plain.status).toBe(200);
  expect(plain.headers.get("service-worker-allowed")).toBeNull();
});

test("I1: the share-ended page and entry with a token both clear the origin's storage (Clear-Site-Data)", async () => {
  const { req, share } = setup();
  expect((await req("/")).headers.get("clear-site-data")).toBe('"cache", "storage"');
  const entry = await req(`/s/${share.token}`);
  expect(entry.status).toBe(302);
  expect(entry.headers.get("clear-site-data")).toBe('"cache", "storage"');
});

test("I1: an application response via pN is never cached — the upstream Cache-Control is rewritten to no-store", async () => {
  const { req, cookie } = setup({ handler: () => new Response("console.log(1)", { headers: {
    "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable",
    expires: "Thu, 31 Dec 2099 23:59:59 GMT", etag: "\"abc\"", "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
  } }) });
  const r = await req("/assets/x.js", { headers: { cookie } });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("expires")).toBeNull();
  expect(r.headers.get("etag")).toBeNull();
  expect(r.headers.get("last-modified")).toBeNull();
});

test("I2: application Set-Cookie → host-only __Host-pv-*, without Domain; the share cookie cannot be overwritten", async () => {
  const { req, cookie } = setup({ handler: () => {
    const h = new Headers();
    h.append("set-cookie", "sid=42; Domain=example.com; Path=/app; HttpOnly; SameSite=Lax");
    h.append("set-cookie", `${PREVIEW_COOKIE}=stolen; Path=/; Secure`);
    return new Response("ok", { headers: h });
  } });
  const r = await req("/", { headers: { cookie } });
  const set = r.headers.getSetCookie();
  expect(set).toEqual([
    "__Host-pv-sid=42; Path=/; Secure; HttpOnly; SameSite=Lax",
    `__Host-pv-${PREVIEW_COOKIE}=stolen; Path=/; Secure`,
  ]);
  for (const c of set) expect(c.toLowerCase()).not.toContain("domain=");
});

test("rewriteAppSetCookie: an unreadable header is dropped", () => {
  expect(rewriteAppSetCookie("=x")).toBeNull();
  expect(rewriteAppSetCookie("no-equals-sign")).toBeNull();
  expect(rewriteAppSetCookie("a=1; Secure; Partitioned; Max-Age=60")).toBe("__Host-pv-a=1; Path=/; Secure; Max-Age=60");
});
