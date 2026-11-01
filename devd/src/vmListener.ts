// A second devd listener just for InstaBox VMs (C1 final review). The VM is in the tailnet, so
// on the main port (4300) it would pass the allowlist of the approval gates (100.64.0.0/10) — it could
// approve a prod-db write, an operation or an SSH grant by itself. So on this port we let through only
// what the InstaBox session container actually calls; everything else is 404. The Tailscale ACL
// (tag:devbox-instabox → VPS:vmPort) is a second layer, this one does not depend on it.

/** Exact routes (method + path) the container in the VM calls:
 *  - `/api/health`: reachability check after `tailscale up` (instabox/sessions.ts),
 *  - `/api/agent-event`: agent hooks (image/vendor/devd-hooks/devd-hook.sh),
 *  - `/v1/metrics`: OTLP metrics (OTEL_EXPORTER_OTLP_ENDPOINT),
 *  - `/api/accounts/lease`: pool account selection at agent start (image/account-lease.sh). */
const EXACT: Record<string, readonly string[]> = {
  "/api/health": ["GET", "HEAD"],
  "/api/agent-event": ["POST"],
  "/v1/metrics": ["POST"],
  "/api/accounts/lease": ["GET"],
};

/** May the request go to the VM listener? The git proxy (`/git/<instance>/…`) passes entirely — clone and push
 *  from the VM go through it with a dummy. Encoded dots/slashes in the path are rejected, so that
 *  nobody tries to sneak out of `/git/` elsewhere via differing decoding. */
export function isVmRoute(method: string, pathname: string): boolean {
  if (/%(2e|2f|5c)/i.test(pathname) || pathname.includes("\\")) return false;
  if (pathname.startsWith("/git/")) return !pathname.split("/").some((seg) => seg === "..");
  return EXACT[pathname]?.includes(method.toUpperCase()) ?? false;
}

/** Wraps the main application's `app.fetch`: allowed routes go to the same application (the same Bun
 *  server in `env` → the same getConnInfo), others get 404 without touching the application. */
export function vmFetch<E>(fetch: (req: Request, env: E) => Response | Promise<Response>) {
  return (req: Request, env: E): Response | Promise<Response> => {
    const { pathname } = new URL(req.url);
    // Hono routes by the raw path from req.url, the URL normalizes it — `..` in the raw
    // path could yield two different readings, so it is rejected outright.
    if (/\/\.\.?(\/|\?|#|$)/.test(req.url.replace(/^[a-z]+:\/\/[^/]*/i, "")) || !isVmRoute(req.method, pathname)) return Response.json({ error: "not found" }, { status: 404 });
    return fetch(req, env);
  };
}
