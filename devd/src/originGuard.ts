// Protection of the API on :4300 against forged requests from the browser (CSRF). Container
// previews run on sibling hosts (p0…p9.<DEVD_PREVIEW_DOMAIN>) — an agent's page could
// otherwise send a POST to the dashboard from the owner's browser and the CF
// Access cookie would be attached. A browser is recognized by Origin / Sec-Fetch-Site;
// clients without them (containers, curl, iOS URLSession, Mac listener) pass through
// unchanged — another layer handles those.
import type { MiddlewareHandler } from "hono";

export const DEFAULT_DASHBOARD_ORIGINS = [
  "http://localhost:4300", // SSH tunnel to devd
  // The dashboard's Vite dev server (localhost:5173) DELIBERATELY not: a forwarded Vite of a shared
  // session on the same port would turn guest code into an allowed origin (final review I8).
  // When developing the dashboard: DEVD_DASHBOARD_ORIGINS=http://localhost:5173.
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const normalize = (o: string) => o.trim().replace(/\/+$/, "");

const originOf = (url: string | undefined): string[] => {
  try { return url ? [new URL(url).origin] : []; } catch { return []; }
};

/** Allowed dashboard origins: defaults + the public URL (`DEVD_DASHBOARD_URL`) + devd's tailnet
 *  address (`DEVD_BIND_IP`:`DEVD_PORT`) + `DEVD_DASHBOARD_ORIGINS` (comma-separated). */
export function dashboardOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.DEVD_DASHBOARD_ORIGINS ?? "").split(",").map(normalize).filter(Boolean);
  const tailnet = env.DEVD_BIND_IP ? [`http://${env.DEVD_BIND_IP}:${env.DEVD_PORT || "4300"}`] : [];
  return [...new Set([...DEFAULT_DASHBOARD_ORIGINS, ...originOf(env.DEVD_DASHBOARD_URL), ...tailnet, ...extra])];
}

const isUpgrade = (h: Headers) => (h.get("upgrade") ?? "").toLowerCase() === "websocket";
const isBrowser = (h: Headers) => h.has("origin") || h.has("sec-fetch-site");
const isMutation = (method: string) => !SAFE_METHODS.has(method.toUpperCase());
const isBrowserMutation = (req: { method: string; headers: Headers }) => isBrowser(req.headers) && isMutation(req.method);

export function originAllowed(
  req: { method: string; headers: Headers },
  allowedOrigins: string[],
): { ok: true } | { ok: false; reason: string } {
  const h = req.headers;
  if (!isBrowser(h)) return { ok: true };
  if (!isMutation(req.method) && !isUpgrade(h)) return { ok: true }; // reads without an Origin check — covered by CF Access
  const origin = h.get("origin");
  if (origin === null) {
    // Browsers send Origin on all non-GET requests and WS; if it is missing, we trust only same-origin.
    return h.get("sec-fetch-site") === "same-origin"
      ? { ok: true }
      : { ok: false, reason: `missing Origin (sec-fetch-site: ${h.get("sec-fetch-site")})` };
  }
  return allowedOrigins.includes(normalize(origin))
    ? { ok: true }
    : { ok: false, reason: `origin not allowed: ${origin}` };
}

// Content-Length takes precedence (real server: POST without a body = `content-length: 0`);
// without it, the presence of a stream decides (chunked, Request built in-process).
function hasBody(req: Request): boolean {
  const len = req.headers.get("content-length");
  if (len !== null) return Number(len) > 0;
  return req.headers.has("transfer-encoding") || req.body !== null;
}
const isJson = (h: Headers) => (h.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

/**
 * Middleware for `/api/*`: foreign Origin → 403; the body of a mutating browser request
 * must be `application/json` (otherwise 415 — "simple" text/plain or form requests
 * do not get through even from a same-site page). `bodyTypeExempt` = routes with another body type.
 */
export function originGuard(allowedOrigins: string[], bodyTypeExempt: (path: string) => boolean): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    const verdict = originAllowed(raw, allowedOrigins);
    if (!verdict.ok) return c.json({ error: "forbidden", reason: verdict.reason }, 403);
    const h = raw.headers;
    if (isBrowserMutation(raw) && hasBody(raw) && !isJson(h) && !bodyTypeExempt(c.req.path)) {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }
    await next();
  };
}

/**
 * For a GET that changes state (OAuth relay): from a browser only from our own site — an `<img>`
 * or link from a sibling preview (same-site) or a foreign page (cross-site) → 403.
 * Without Sec-Fetch-* / Origin (listener on the Mac, curl) unchanged.
 */
export function stateChangingGetAllowed(
  req: { method: string; headers: Headers },
  allowedOrigins: string[],
): { ok: true } | { ok: false; reason: string } {
  const h = req.headers;
  const site = h.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return { ok: false, reason: `sec-fetch-site: ${site}` };
  const origin = h.get("origin");
  if (origin !== null && !allowedOrigins.includes(normalize(origin))) return { ok: false, reason: `origin not allowed: ${origin}` };
  return { ok: true };
}

export function stateChangingGetGuard(allowedOrigins: string[]): MiddlewareHandler {
  return async (c, next) => {
    const verdict = stateChangingGetAllowed(c.req.raw, allowedOrigins);
    if (!verdict.ok) return c.json({ error: "forbidden", reason: verdict.reason }, 403);
    await next();
  };
}
