import type { DbRequestReq } from "./dbPrompt";
import { mapPath, type Actions, type NotifySession } from "./actions";
import type { ListenerConfig } from "./config";
import type { SshApprovalReq } from "./sshPrompt";

// Allowed target for /open-url: only http(s) to a tailnet/private/loopback host
// (the devbox tailscale IP is in CGNAT 100.64.0.0/10). Blocks file:, javascript:
// and opening an arbitrary public URL if devd were compromised.
export function allowedPreviewUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname;
  if (h === "localhost") return u.href;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127) return u.href;                        // loopback
    if (a === 10) return u.href;                         // 10/8
    if (a === 192 && b === 168) return u.href;           // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return u.href;  // 172.16/12
    if (a === 100 && b >= 64 && b <= 127) return u.href; // tailscale CGNAT 100.64/10
    return null;
  }
  if (h.endsWith(".ts.net")) return u.href;              // MagicDNS
  return null;
}

// userInfo/session from devd: only safe segments are allowed (it goes into AppleScript
// and the launch config yaml in actions).
export function parseSession(v: unknown): NotifySession | undefined {
  const s = v as { id?: unknown; project?: unknown; repo?: unknown } | null;
  const ok = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9._-]+$/.test(x);
  return s && ok(s.id) && ok(s.project) && ok(s.repo) ? { id: s.id, project: s.project, repo: s.repo } : undefined;
}

// Bun.serve also passes the server object to the handler — the source address of the
// request can be read from it (requestIP). The type is narrowed to the one thing we need from it, so it can
// be faked in tests without a whole Bun server.
export interface RequestSource { requestIP?(req: Request): { address: string } | null }

export function createListener(cfg: ListenerConfig, actions: Actions) {
  return {
    async fetch(req: Request, server?: RequestSource): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
      // Clipboard bridge for cc in containers: GET with a token (the only non-POST API).
      if (req.method === "GET" && url.pathname.startsWith("/clipboard/")) {
        if (req.headers.get("authorization") !== `Bearer ${cfg.token}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const kind = url.pathname.slice("/clipboard/".length);
        if (kind === "targets") {
          const t = actions.clipboardTargets();
          return t.length > 0
            ? new Response(t.join("\n") + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } })
            : new Response(null, { status: 204 });
        }
        if (kind === "image") {
          const img = actions.clipboardImage();
          return img ? new Response(img, { headers: { "content-type": "image/png" } }) : new Response(null, { status: 204 });
        }
        if (kind === "text") {
          const t = actions.clipboardText();
          return t ? new Response(t, { headers: { "content-type": "text/plain; charset=utf-8" } }) : new Response(null, { status: 204 });
        }
        if (kind === "file") {
          const f = actions.clipboardFile();
          if (f === null) return new Response(null, { status: 204 });
          if ("tooBig" in f) return new Response("file is too large (>25 MB)", { status: 413 });
          return new Response(f.bytes, {
            headers: {
              "content-type": "application/octet-stream",
              "x-devbox-filename": encodeURIComponent(f.name),
            },
          });
        }
        return new Response(null, { status: 404 });
      }
      if (req.method !== "POST") return new Response(null, { status: 405 });
      if (req.headers.get("authorization") !== `Bearer ${cfg.token}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (url.pathname === "/open") {
        if (!body || typeof body.path !== "string") return Response.json({ error: "missing path" }, { status: 400 });
        const mapped = mapPath(cfg.mappings, body.path);
        if (!mapped) return Response.json({ error: "path outside the allowed mappings" }, { status: 403 });
        return actions.open(mapped).code === 0
          ? new Response(null, { status: 204 })
          : Response.json({ error: "open failed" }, { status: 500 });
      }
      // Bridge for the proxy login OAuth callback (CLIProxyAPI on the devbox): open
      // 127.0.0.1:1455 for 15 minutes and forward to the devd relay. The relay host is taken
      // from the body (`relayHost`), otherwise from the SOURCE address of the request — the path
      // devd used to get here works on the tailnet in the other direction too. Wherever it comes from,
      // it must pass the same filter as /open-url: a compromised devd must not use the mac
      // as a relay to an arbitrary public host.
      if (url.pathname === "/proxy-bridge") {
        const relayPort = typeof body?.relayPort === "number" && Number.isInteger(body.relayPort)
          && (body.relayPort as number) > 0 && (body.relayPort as number) <= 65535 ? body.relayPort as number : 4300;
        const ttlSec = typeof body?.ttlSec === "number" && (body.ttlSec as number) > 0
          ? Math.min(body.ttlSec as number, 1800) : 900;
        const host = typeof body?.relayHost === "string" && body.relayHost
          ? body.relayHost as string
          : server?.requestIP?.(req)?.address ?? null;
        if (!host) return Response.json({ error: "missing relayHost and the source address is unknown" }, { status: 400 });
        // An IPv6 address needs square brackets in a URL.
        const hostForUrl = host.includes(":") ? `[${host}]` : host;
        const base = `http://${hostForUrl}:${relayPort}`;
        if (!allowedPreviewUrl(`${base}/`)) return Response.json({ error: "relay host not allowed" }, { status: 400 });
        return actions.startProxyBridge(base, ttlSec * 1000).ok
          ? new Response(null, { status: 204 })
          : Response.json({ error: "could not bind port 1455 (is codex login running on the Mac?)" }, { status: 409 });
      }
      if (url.pathname === "/open-url") {
        if (!body || typeof body.url !== "string") return Response.json({ error: "missing url" }, { status: 400 });
        const target = allowedPreviewUrl(body.url);
        if (!target) return Response.json({ error: "url not allowed" }, { status: 400 });
        return actions.openUrl(target).code === 0
          ? new Response(null, { status: 204 })
          : Response.json({ error: "open failed" }, { status: 500 });
      }
      if (url.pathname === "/notify") {
        if (!body || typeof body.title !== "string" || typeof body.message !== "string") {
          return Response.json({ error: "missing title or message" }, { status: 400 });
        }
        const opts = { sound: body.sound === true, session: parseSession(body.session) };
        return actions.notify(body.title, body.message, opts).code === 0
          ? new Response(null, { status: 204 })
          : Response.json({ error: "notification failed" }, { status: 500 });
      }
      // SSH key approval: a blocking dialog on the mac, the answer is returned to devd.
      // A notification goes out concurrently too (devd calls /notify separately) — in case the mac
      // is locked and the dialog is not visible.
      if (url.pathname === "/ssh-approval") {
        if (!body || typeof body.id !== "string" || typeof body.title !== "string" || typeof body.why !== "string") {
          return Response.json({ error: "missing id, title or why" }, { status: 400 });
        }
        const answer = await actions.askSshApproval(body as unknown as SshApprovalReq);
        return answer ? Response.json(answer) : new Response(null, { status: 204 });
      }
      // Notification click (forwarded by the notifier app): session → focus/attach, otherwise dashboard.
      // Always 204 — the click is best-effort, errors go only to the log.
      // Database request: the dialog offers deny or open dashboard.
      if (url.pathname === "/db-request") {
        if (!body || typeof body.wanted !== "string") {
          return Response.json({ error: "missing wanted" }, { status: 400 });
        }
        const answer = await actions.askDbRequest(body as unknown as DbRequestReq);
        return answer ? Response.json(answer) : new Response(null, { status: 204 });
      }
      if (url.pathname === "/clicked") {
        try {
          const session = parseSession(body);
          if (session) {
            if (!actions.focusWarp(session.repo)) actions.openWarpAttach(session.id);
          } else {
            actions.openDashboard();
          }
        } catch (e) { console.error("clicked handler failed:", (e as Error).message); }
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  };
}
