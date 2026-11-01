// Public preview of a shared session: `p0…p9.<domain>` → dev server in the container (port 3000+N),
// published on `DEVD_BIND_IP:port_base+N`. Runs inside the share listener (createShareFetch
// sends every Host here except the share host), so the same applies: no gate trusting
// loopback, the only authority is the share token.
//
// The token arrives once in the path (`GET /s/<token>` from the link on the shared page), is stored in a
// `__Host-` cookie per pN host and is then verified on EVERY request (resolveShare). The cookie is never
// passed to the application in the container and the token is never logged.
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { BunWebSocketData } from "hono/bun";
import type { WSContext, WSEvents } from "hono/ws";
import { getSession } from "./db";
import { CLOSE_ENDED, CLOSE_ENDED_REASON, createInvalidTokenLimiter, createShareConnRegistry, type GuestConn } from "./shareListener";
import { resolveShare, type ShareRow } from "./shares";

/** Placeholder; the real domain comes from DEVD_PREVIEW_DOMAIN (pN.<domain> → session port N). */
export const DEFAULT_PREVIEW_DOMAIN = "example.com";
export const PREVIEW_COOKIE = "__Host-devbox-share";
/** The container port of preview pN is 3000+N — the same base as `/api/preview` and docker.ts. */
const CONTAINER_PORT_BASE = 3000;
const MAX_PREVIEW_PORTS = 10;
const UPSTREAM_WS_TIMEOUT_MS = 10_000;
const TOKEN_PATH = /^\/s\/([A-Za-z0-9_-]{1,128})$/;

/** "p3.example.com" → 3. Only one digit and exactly the preview domain (no port, regardless
 *  of letter case); anything else → null. */
export function previewPortForHost(host: string, domain = DEFAULT_PREVIEW_DOMAIN): number | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${domain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const m = /^p([0-9])$/.exec(h.slice(0, -suffix.length));
  return m ? Number(m[1]) : null;
}

export interface PreviewDeps {
  db: Database;
  /** Tailnet IP on which docker publishes session ports (DEVD_BIND_IP). Without it there is nowhere to proxy to. */
  bindIp?: string;
  portsPerSession: number;
  domain?: string;
  now?: () => number;
  /** Subscription to explicit share revocation (onShareRevoked from shares.ts). */
  onRevoked: (cb: (ids: string[]) => void) => void;
}

const NO_STORE = { "cache-control": "no-store" } as const;

/** The p0…p9 hosts are SHARED by all shares (final review I1): a service worker registered
 *  by guest A's application would intercept guest B's navigation to `/s/<tokenB>` and
 *  read their token. So at the end of a share and on entry with a new token, the origin's storage
 *  (service workers, cache, localStorage, IndexedDB) and the HTTP cache are cleared — cookies
 *  not, the share cookie set in the same response must survive. `"cache"` (rereview I1):
 *  a script that guest A's application had cached would otherwise run in guest B's preview. */
const CLEAR_STORAGE = { "clear-site-data": "\"cache\", \"storage\"" } as const;

/** Application cookies are stored on pN ONLY host-only and under the `__Host-` prefix (final
 *  review I2): the browser accepts such a cookie only without Domain, with Path=/ and Secure, so
 *  no other host `*.<DEVD_PREVIEW_DOMAIN>` could have set it. Only cookies with this prefix go back
 *  to the application (with the prefix stripped) — domain-wide cookies of other hosts never reach the
 *  guest's application. The cost: cookies set by the application's JavaScript (without the prefix) do not reach the
 *  application server. */
const APP_COOKIE_PREFIX = "__Host-pv-";

/** `Set-Cookie` from the application → host-only `__Host-pv-<name>`: drops both Domain and Path, enforces
 *  Path=/ and Secure; keeps the other attributes (Max-Age, Expires, HttpOnly, SameSite).
 *  Unreadable header → null (drop). */
export function rewriteAppSetCookie(header: string): string | null {
  const [pair, ...attrs] = header.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name || /[\s=;,]/.test(name)) return null;
  const value = pair.slice(eq + 1).trim();
  const keep = attrs.map((a) => a.trim()).filter((a) => {
    const key = a.split("=")[0]!.trim().toLowerCase();
    return a && !["domain", "path", "secure", "partitioned"].includes(key);
  });
  return [`${APP_COOKIE_PREFIX}${name}=${value}`, "Path=/", "Secure", ...keep].join("; ");
}

function expiredPage(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Share expired</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;text-align:center">`
    + `<h1>Share expired</h1><p>The preview is no longer available — the share expired or was revoked. Ask for a new link.</p></body></html>`,
    { status: 410, headers: { ...NO_STORE, ...CLEAR_STORAGE, "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" } },
  );
}

const notFound = () => new Response("not found", { status: 404, headers: NO_STORE });

/** Value of cookie `name`, or null. */
function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Cookie header for the application: ONLY cookies the application itself set on this pN
 *  host (`__Host-pv-*`, prefix stripped). The application sees neither the share cookie nor domain-wide cookies of other
 *  hosts (`.<DEVD_PREVIEW_DOMAIN>`). null when nothing is left. */
function appCookies(header: string | null): string | null {
  const rest = (header ?? "").split(";").map((p) => p.trim())
    .filter((p) => p.startsWith(APP_COOKIE_PREFIX) && p.indexOf("=") > APP_COOKIE_PREFIX.length)
    .map((p) => p.slice(APP_COOKIE_PREFIX.length));
  return rest.length ? rest.join("; ") : null;
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

function dropHopByHop(h: Headers): void {
  for (const name of (h.get("connection") ?? "").split(",")) if (name.trim()) h.delete(name.trim());
  for (const name of HOP_BY_HOP) h.delete(name);
}

/** Headers towards the application: Host as if it were `localhost:300N` (dev servers like Vite
 *  reject other hosts), without the share cookie, with our own X-Forwarded-* (incoming ones are dropped). */
function upstreamHeaders(req: Request, containerPort: number, publicHost: string): Headers {
  const h = new Headers(req.headers);
  dropHopByHop(h);
  for (const name of [...h.keys()]) if (name.startsWith("x-forwarded-")) h.delete(name);
  const cookie = appCookies(req.headers.get("cookie"));
  if (cookie) h.set("cookie", cookie); else h.delete("cookie");
  h.set("host", `localhost:${containerPort}`);
  h.set("x-forwarded-proto", "https");
  h.set("x-forwarded-host", publicHost);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) h.set("x-forwarded-for", ip);
  return h;
}

/** Response body proxied onward in chunks (nothing is buffered); `done` is called once,
 *  whether the body completes, fails, or the client discards it. An abort via our `signal` (share revoked/expired,
 *  client gone) just ends the stream — Bun would print `ctrl.error` as an unhandled error. */
function trackedBody(src: ReadableStream<Uint8Array>, signal: AbortSignal, done: () => void): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done: end, value } = await reader.read();
        if (end) { done(); ctrl.close(); } else ctrl.enqueue(value);
      } catch (e) { done(); if (signal.aborted) ctrl.close(); else ctrl.error(e); }
    },
    cancel(reason) { done(); return reader.cancel(reason); },
  });
}

/** A close code the server may send (1005/1006/1015 are only "reported", not sent). */
function sendableCloseCode(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1000;
}

// The share listener serves the hono `websocket` handler — upgrade data must have its shape.
type BunServer = Server<BunWebSocketData>;
type PreviewFetch = (req: Request, server: BunServer) => Promise<Response>;

/** Preview handler for the share listener (`createShareFetch({ preview })`). It keeps the open
 *  proxied connections per share and closes them when the share is revoked or expires. */
export function createPreview(d: PreviewDeps): PreviewFetch {
  const now = d.now ?? Date.now;
  const domain = (d.domain ?? DEFAULT_PREVIEW_DOMAIN).toLowerCase();
  const limiter = createInvalidTokenLimiter(now);
  const conns = createShareConnRegistry({ now, onRevoked: d.onRevoked });
  const portCount = Math.min(d.portsPerSession, MAX_PREVIEW_PORTS);

  async function proxyHttp(req: Request, share: ShareRow, target: string, containerPort: number, publicHost: string): Promise<Response> {
    const ac = new AbortController();
    const conn: GuestConn = { close: () => ac.abort() };
    const release = () => conns.remove(share.id, conn);
    conns.add(share, conn);
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let res: Response;
    try {
      res = await fetch(target, {
        method: req.method, headers: upstreamHeaders(req, containerPort, publicHost), body: hasBody ? req.body : undefined,
        redirect: "manual", signal: ac.signal, decompress: false, duplex: "half",
      } as RequestInit);
    } catch {
      release();
      return new Response("preview is not running — nothing is listening on this port in the session", { status: 502, headers: NO_STORE });
    }
    const headers = new Headers(res.headers);
    dropHopByHop(headers);
    // Application cookies only host-only under __Host-pv- (I2); a service worker is never served from pN (I1).
    headers.delete("set-cookie");
    for (const c of res.headers.getSetCookie()) { const r = rewriteAppSetCookie(c); if (r) headers.append("set-cookie", r); }
    headers.delete("service-worker-allowed");
    // The upstream must not leave anything in the HTTP cache of the shared pN origin (rereview I1): guest A's
    // application `/assets/x.js` with a one-year max-age would otherwise also be served to guest B on the same pN.
    headers.set("cache-control", "no-store");
    headers.delete("expires");
    headers.delete("etag");
    headers.delete("last-modified");
    const loc = headers.get("location");
    if (loc) {
      const m = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?=\/|$)/i.exec(loc);
      if (m && (m[2] ?? ":80") === `:${containerPort}`) headers.set("location", `https://${publicHost}${loc.slice(m[0].length) || "/"}`);
    }
    if (!res.body) { release(); return new Response(null, { status: res.status, statusText: res.statusText, headers }); }
    return new Response(trackedBody(res.body, ac.signal, release), { status: res.status, statusText: res.statusText, headers });
  }

  /** Websocket (Vite HMR etc.): first the connection to the application — its chosen subprotocol is then
   *  returned to the client in the upgrade (without it the browser rejects a connection with a subprotocol). */
  async function proxyWs(req: Request, server: BunServer, share: ShareRow, token: string, target: string, containerPort: number, publicHost: string): Promise<Response> {
    // CSWSH: a websocket to the preview may only be opened by the preview page itself.
    if (req.headers.get("origin") !== `https://${publicHost}`) return new Response("forbidden", { status: 403, headers: NO_STORE });
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const h = upstreamHeaders(req, containerPort, publicHost);
    for (const name of [...h.keys()]) if (name.startsWith("sec-websocket-")) h.delete(name);
    h.set("origin", `http://localhost:${containerPort}`);
    const upstream = new WebSocket(target.replace(/^http/, "ws"), { headers: Object.fromEntries(h), protocols } as unknown as string[]);
    upstream.binaryType = "arraybuffer";
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), UPSTREAM_WS_TIMEOUT_MS);
      upstream.onopen = () => { clearTimeout(timer); resolve(true); };
      upstream.onerror = upstream.onclose = () => { clearTimeout(timer); resolve(false); };
    });
    if (!opened) { upstream.close(); return new Response("preview is not running", { status: 502, headers: NO_STORE }); }

    let client: WSContext | null = null;
    let upstreamClosed: { code: number; reason: string } | null = null;
    const pending: (string | ArrayBuffer)[] = [];
    const conn: GuestConn = { close: (code, reason) => { client?.close(code, reason); upstream.close(1000); } };
    upstream.onmessage = (e) => { if (client) client.send(e.data); else pending.push(e.data); };
    upstream.onerror = null;
    upstream.onclose = (e) => {
      upstreamClosed = { code: sendableCloseCode(e.code), reason: e.reason };
      client?.close(upstreamClosed.code, upstreamClosed.reason);
    };
    const events: WSEvents = {
      onOpen(_evt, ws) {
        client = ws;
        // Connecting to the application may have taken a while — a share revoke in the meantime would not be seen by the registry yet.
        if (!resolveShare(d.db, token, now())) { conn.close(CLOSE_ENDED, CLOSE_ENDED_REASON); return; }
        conns.add(share, conn);
        for (const m of pending.splice(0)) ws.send(m);
        if (upstreamClosed) ws.close(upstreamClosed.code, upstreamClosed.reason);
      },
      onMessage(evt) { if (upstream.readyState === WebSocket.OPEN) upstream.send(evt.data as string | ArrayBuffer); },
      onClose() {
        conns.remove(share.id, conn);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000);
      },
    };
    // Same `data` shape as upgradeWebSocket from hono/bun — events are handled by the shared `websocket` handler.
    const data = { events, url: new URL(req.url), protocol: upstream.protocol };
    const ok = server.upgrade(req, upstream.protocol ? { headers: { "sec-websocket-protocol": upstream.protocol }, data } : { data });
    if (!ok) { upstream.close(); return new Response("websocket upgrade failed", { status: 400, headers: NO_STORE }); }
    return new Response(null);
  }

  return async (req, server) => {
    const n = previewPortForHost(req.headers.get("host") ?? "", domain);
    if (n === null || n >= portCount || !d.bindIp) return notFound();
    // Service worker registration / update: the browser fetches the script with the header
    // `Service-Worker: script`. A service worker is NEVER served from preview hosts (I1).
    if (req.headers.has("service-worker")) return new Response("service workers are not allowed on the preview", { status: 403, headers: { ...NO_STORE, ...CLEAR_STORAGE } });
    const publicHost = `p${n}.${domain}`;
    const url = new URL(req.url);
    const cookieToken = readCookie(req.headers.get("cookie"), PREVIEW_COOKIE);
    const cookieShare = cookieToken ? resolveShare(d.db, cookieToken, now()) : null;

    // Entry from the link on the shared page: token from the path → cookie and out of the URL (so it does not stay
    // in history or in the Referer). With a valid cookie and a foreign `/s/…` path the request goes to the application.
    const m = TOKEN_PATH.exec(url.pathname);
    if (m && (req.method === "GET" || req.method === "HEAD")) {
      const ip = req.headers.get("cf-connecting-ip") ?? "local";
      if (limiter.blocked(ip)) return new Response("too many invalid attempts", { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });
      const share = resolveShare(d.db, m[1], now());
      if (share) {
        const maxAge = Math.max(0, Math.floor((share.expires_at - now()) / 1000));
        return new Response(null, {
          status: 302,
          headers: {
            ...NO_STORE, ...CLEAR_STORAGE, location: "/", "referrer-policy": "no-referrer",
            "set-cookie": `${PREVIEW_COOKIE}=${m[1]}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
          },
        });
      }
      if (!cookieShare) { limiter.hit(ip); return expiredPage(); }
    }

    if (!cookieShare) return expiredPage();
    const s = getSession(d.db, cookieShare.session_id);
    if (!s) return expiredPage();
    // The target is computed only from THIS share's session and N < portsPerSession — another session's port is unreachable.
    const containerPort = CONTAINER_PORT_BASE + n;
    const target = `http://${d.bindIp}:${s.port_base + n}${url.pathname}${url.search}`;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return proxyWs(req, server, cookieShare, cookieToken!, target, containerPort, publicHost);
    return proxyHttp(req, cookieShare, target, containerPort, publicHost);
  };
}
