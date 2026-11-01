// Share listener (127.0.0.1:4302): the public entry for the GUEST of a shared terminal via a
// Cloudflare tunnel without Access (DEVD_SHARE_HOST, p0…p9.<DEVD_PREVIEW_DOMAIN>). A separate Hono
// application — it shares nothing with `app` from api.ts, so the admin API has no way to leak in here.
//
// No gate trusting loopback: cloudflared connects from localhost, so the source
// IP says nothing here. The only authority is the token in the path (resolveShare). `CF-Connecting-IP`
// serves only as the rate-limit key for invalid tokens.
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { join } from "node:path";
import { getSession, logEvent, type SessionRow } from "./db";
import { resolveShare, type ShareRow } from "./shares";
import { createBridge, type Bridge, type SpawnPty } from "./terminal";

/** Placeholder; the real host comes from DEVD_SHARE_HOST. */
export const SHARE_HOST = "share.example.com";
export const shareHostFromEnv = (env: Record<string, string | undefined> = process.env) => env.DEVD_SHARE_HOST || SHARE_HOST;
/** Limit of guest WS connections per share — separate from the owner's limit (4) in api.ts. */
export const MAX_GUEST_TERMINALS = 2;
export const CLOSE_ENDED = 4001;
export const CLOSE_ENDED_REASON = "Share ended";
const INVALID_TOKEN_LIMIT = 20;
const INVALID_TOKEN_WINDOW_MS = 60_000;

/** Exact allowlist of share-host paths (GET/HEAD only). The token is base64url (createShare
 *  produces 43 characters); assets are flat Vite files `assets/<name>-<hash>.<ext>` —
 *  the first character is alphanumeric, so `.`/`..` as a name does not pass. */
const TOKEN_ROUTE = /^\/s\/[A-Za-z0-9_-]{1,128}(\/(info|ws))?$/;
const ASSET_ROUTE = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isShareRoute(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  if (/%(2e|2f|5c)/i.test(pathname) || pathname.includes("\\")) return false;
  return TOKEN_ROUTE.test(pathname) || ASSET_ROUTE.test(pathname);
}

/** Same protection as vmFetch: `..` in the RAW path (Hono routes by req.url, the URL
 *  normalizes it) is rejected outright, so there are never two different readings of the same path. */
function rawPathSuspicious(url: string): boolean {
  const raw = url.replace(/^[a-z]+:\/\/[^/]*/i, "");
  return /\/\.\.?(\/|\?|#|$)/.test(raw) || /%(2e|2f|5c)/i.test(raw) || raw.includes("\\");
}

const notFoundJson = () => Response.json({ error: "not found" }, { status: 404 });

type Fetch<E> = (req: Request, env: E) => Response | Promise<Response>;

/** Share listener entry: decides by Host. `shareHost` → the share application (after checking
 *  the raw path and the allowlist), other hosts → `preview` (public preview p0…p9,
 *  sharePreview.ts); without it 404. */
export function createShareFetch<E>(d: { shareApp: { fetch: Fetch<E> }; preview?: Fetch<E>; shareHost?: string }): Fetch<E> {
  const shareHost = (d.shareHost ?? SHARE_HOST).toLowerCase();
  return (req, env) => {
    const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
    if (host !== shareHost) return d.preview ? d.preview(req, env) : notFoundJson();
    if (rawPathSuspicious(req.url) || !isShareRoute(req.method, new URL(req.url).pathname)) return notFoundJson();
    return d.shareApp.fetch(req, env);
  };
}

/** Hard cap on the number of clients in the limiter (final review I6) — the endpoint is public and
 *  an attacker rotating addresses would otherwise inflate the map without bound. */
export const INVALID_TOKEN_MAX_ENTRIES = 10_000;

/** Limiter key: IPv4 whole, IPv6 only the /64 prefix — one client typically has a whole /64,
 *  so otherwise every address in it would get its own 20 attempts. */
export function limiterKey(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (!a.includes(":")) return a;
  const [head = "", tail = ""] = a.split("::", 2);
  const h = head ? head.split(":") : [];
  const t = a.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Rate limit of invalid tokens per client (fixed window). Valid tokens are not counted;
 *  a blocked client gets 429 on all `/s/*` until the end of the window. At most
 *  `maxEntries` clients: a full map first sheds expired windows, then the oldest. */
export function createInvalidTokenLimiter(now: () => number, maxEntries = INVALID_TOKEN_MAX_ENTRIES) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const entry = (ip: string) => {
    const t = now();
    const key = limiterKey(ip);
    let e = hits.get(key);
    if (!e || e.resetAt <= t) {
      hits.delete(key); // a new window goes to the end of the order (Map keeps insertion order)
      if (hits.size >= maxEntries) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      while (hits.size >= maxEntries) hits.delete(hits.keys().next().value!);
      e = { count: 0, resetAt: t + INVALID_TOKEN_WINDOW_MS };
      hits.set(key, e);
    }
    return e;
  };
  return {
    blocked: (ip: string) => entry(ip).count >= INVALID_TOKEN_LIMIT,
    hit: (ip: string) => { entry(ip).count++; },
    size: () => hits.size,
  };
}

/** Starts the share listener (:4302). A taken port or another bind error MUST NOT bring down devd
 *  (final review I7) — it is logged and sharing is disabled (`null`; creating links then
 *  returns 503), the admin API on :4300 keeps running. */
export function startShareServer<T>(serve: () => T, log: (msg: string) => void = console.error): T | null {
  try { return serve(); }
  catch (e) {
    log(`share listener failed to start (${(e as Error).message}) — terminal sharing is disabled`);
    return null;
  }
}

const PAGE_HEADERS = { "cache-control": "no-store" } as const;

function endedPage(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Share ended</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;text-align:center">`
    + `<h1>Share ended</h1><p>This link is not valid — the share expired, was revoked, or does not exist.</p></body></html>`,
    { status: 404, headers: { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" } },
  );
}

export interface GuestConn { close(code: number, reason: string): void }

/** Open guest connections per share: closed by an explicit revoke (`onRevoked`) as well as expiry
 *  (one timer per share, not per connection → `onExpired` is called once). Shared by
 *  the guest terminal and the preview proxy (sharePreview.ts), each with its own instance. */
export function createShareConnRegistry(d: { now: () => number; onRevoked: (cb: (ids: string[]) => void) => void; onExpired?: (share: ShareRow) => void }) {
  const live = new Map<string, Set<GuestConn>>(); // share id → open connections
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const closeShare = (id: string) => {
    for (const conn of live.get(id) ?? []) conn.close(CLOSE_ENDED, CLOSE_ENDED_REASON);
  };
  d.onRevoked((ids) => { for (const id of ids) closeShare(id); });
  return {
    count: (id: string) => live.get(id)?.size ?? 0,
    add(share: ShareRow, conn: GuestConn) {
      let set = live.get(share.id);
      if (!set) {
        set = new Set();
        live.set(share.id, set);
        expiryTimers.set(share.id, setTimeout(() => {
          d.onExpired?.(share);
          closeShare(share.id);
        }, Math.max(0, share.expires_at - d.now())));
      }
      set.add(conn);
    },
    remove(id: string, conn: GuestConn) {
      const set = live.get(id);
      if (!set) return;
      set.delete(conn);
      if (set.size === 0) {
        live.delete(id);
        clearTimeout(expiryTimers.get(id));
        expiryTimers.delete(id);
      }
    },
  };
}

export interface ShareAppDeps {
  db: Database;
  spawnPty: SpawnPty;
  /** Root of the guest's static bundle (share.html + assets/) — in production dashboard/dist/share. */
  staticDir: string;
  now?: () => number;
  /** Subscription to explicit share revocation (onShareRevoked from shares.ts). */
  onRevoked: (cb: (ids: string[]) => void) => void;
  /** Container ports (3000+N) on which something listens in the session — for preview links. */
  listeningPorts?: (s: SessionRow) => Promise<number[]>;
  /** Exits tmux copy-mode of the grouped session (`{t:"b"}`) — same as for the owner. */
  exitCopyMode?: (container: string, tmuxName: string) => Promise<void>;
  shareHost?: string;
}

export function createShareApp(d: ShareAppDeps): Hono {
  const now = d.now ?? Date.now;
  const origin = `https://${d.shareHost ?? SHARE_HOST}`;
  const limiter = createInvalidTokenLimiter(now);
  // One timer per share (not per connection) → one `expired` entry in the log.
  const conns = createShareConnRegistry({
    now, onRevoked: d.onRevoked,
    onExpired: (share) => logEvent(d.db, share.session_id, "terminal_share_expired", { id: share.id }),
  });

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    // The token is in the page URL — it must not leave in the Referer to links (previews, anything from the terminal).
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
  });

  const clientKey = (c: { req: { header(n: string): string | undefined } }) => c.req.header("cf-connecting-ip") ?? "local";
  /** A valid share for the token from the path, or a Response (429 / 404). */
  const lookup = (c: { req: { header(n: string): string | undefined } }, token: string, notFound: () => Response): ShareRow | Response => {
    const ip = clientKey(c);
    if (limiter.blocked(ip)) return new Response("too many invalid attempts", { status: 429, headers: { "retry-after": "60" } });
    const share = resolveShare(d.db, token, now());
    if (!share) { limiter.hit(ip); return notFound(); }
    return share;
  };

  app.get("/s/:token", async (c) => {
    const share = lookup(c, c.req.param("token"), endedPage);
    if (share instanceof Response) return share;
    const page = Bun.file(join(d.staticDir, "share.html"));
    if (!(await page.exists())) return c.text("guest page is not built", 503);
    return new Response(page, { headers: { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" } });
  });

  app.get("/s/:token/info", async (c) => {
    const share = lookup(c, c.req.param("token"), notFoundJson);
    if (share instanceof Response) return share;
    const s = getSession(d.db, share.session_id);
    if (!s) return notFoundJson();
    let ports: number[] = [];
    if (d.listeningPorts) { try { ports = await d.listeningPorts(s); } catch { ports = []; } }
    c.header("cache-control", "no-store");
    return c.json({ name: s.name ?? s.repo, expiresAt: share.expires_at, ports });
  });

  // The guest's WS terminal. Origin and token are verified BEFORE the upgrade (a foreign page must not open the
  // terminal with the guest's browser — CSWSH); after the upgrade validity is verified again (revoke in between).
  app.get("/s/:token/ws", async (c, next) => {
    if (c.req.header("origin") !== origin) return c.text("forbidden", 403);
    const share = lookup(c, c.req.param("token"), notFoundJson);
    if (share instanceof Response) return share;
    return next();
  }, upgradeWebSocket((c) => {
    const token = c.req.param("token") ?? "";
    let bridge: Bridge | null = null;
    let conn: GuestConn | null = null;
    let shareId: string | null = null;
    return {
      onOpen(_evt, ws: WSContext) {
        const share = resolveShare(d.db, token, now());
        const s = share ? getSession(d.db, share.session_id) : null;
        if (!share || !s) { ws.close(CLOSE_ENDED, CLOSE_ENDED_REASON); return; }
        if (conns.count(share.id) >= MAX_GUEST_TERMINALS) { ws.close(1013, "too many terminals"); return; }
        conn = { close: (code, reason) => ws.close(code, reason) };
        shareId = share.id;
        conns.add(share, conn);
        logEvent(d.db, s.id, "terminal_share_opened", { id: share.id });
        bridge = createBridge({
          db: d.db, sessionId: s.id, container: s.container, target: "main", spawn: d.spawnPty, granted: true,
          cols: 80, rows: 24, sink: { send: (data) => ws.send(data), close: () => ws.close() },
          exitCopyMode: d.exitCopyMode ? (name) => d.exitCopyMode!(s.container, name) : undefined,
        });
      },
      onMessage(evt) { if (typeof evt.data === "string") bridge?.onClientMessage(evt.data); },
      onClose() {
        bridge?.dispose();
        if (shareId && conn) conns.remove(shareId, conn);
      },
    };
  }));

  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    if (!ASSET_ROUTE.test(`/assets/${file}`)) return notFoundJson();
    const f = Bun.file(join(d.staticDir, "assets", file));
    if (!(await f.exists())) return notFoundJson();
    return new Response(f, { headers: { "content-type": f.type, "cache-control": "public, max-age=31536000, immutable" } });
  });

  app.notFound(() => notFoundJson());
  return app;
}

/** Is something listening on host:port? A short TCP connect — exactly what the preview proxy will then see. */
export function tcpListening(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({
      hostname: host, port,
      socket: { open(sock) { sock.end(); finish(true); }, data() {}, error() { finish(false); }, connectError() { finish(false); } },
    }).catch(() => finish(false));
  });
}
