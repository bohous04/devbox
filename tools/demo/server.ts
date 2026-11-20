#!/usr/bin/env bun
// Demo devd — serves invented data for the devd API so the dashboard, the `dev` CLI
// and the iOS app can be screenshotted/recorded without a real server.
//
//   bun run tools/demo/server.ts [--port 4399] [--host 0.0.0.0] [--dashboard dashboard/dist]
//
// See tools/demo/README.md. Never point this at, or proxy to, a real devd.

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { OpenProgress } from "../../devd/src/sessions";
import { VERSION } from "../../devd/src/version";
import type { AgentName } from "../../devd/src/db";
import * as D from "./data";
import { terminalReplay, type Replay } from "./terminal";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(flag("port", process.env.DEMO_PORT ?? "4399"));
const HOST = flag("host", "127.0.0.1");
const DIST = resolve(flag("dashboard", join(import.meta.dir, "../../dashboard/dist")));

/* ----------------------------------------------------------- open flow */

// POST /api/sessions takes ~7 s and GET /api/open-progress walks through the same
// steps devd reports (fetch → worktree → pull → container), so the CLI spinner and
// the dashboard's "New session" dialog have something to show.
const OPEN_MS = 7000;
const opening = new Map<string, number>(); // folder/project/repo → started at
const key = (f: string, p: string, r: string) => `${f}/${p}/${r}`;

function progressAt(elapsed: number): OpenProgress {
  // The repo already has sessions, so this is the path a real open takes: fetch, check out a
  // fresh worktree (git reports a percentage), pull, then the container substeps.
  if (elapsed < 700) return { step: "fetch" };
  if (elapsed < 4600) {
    const percent = Math.min(100, Math.round(((elapsed - 700) / 3900) * 100));
    return { step: "worktree", git: { phase: "Updating files", percent } };
  }
  if (elapsed < 5300) return { step: "pull" };
  if (elapsed < 5800) return { step: "container", detail: "setting file ownership" };
  if (elapsed < 6500) return { step: "container", detail: "waiting for the docker sidecar" };
  return { step: "container", detail: "starting the container" };
}

/* ------------------------------------------------------------- helpers */

const json = (v: unknown, status = 200) => Response.json(v, { status });
const num = (u: URL, k: string, d: number) => { const v = Number(u.searchParams.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };

async function body(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) as Record<string, unknown>; } catch { return {}; }
}

function staticFile(path: string): Response | null {
  if (!existsSync(DIST)) return null;
  const p = normalize(join(DIST, path === "/" ? "index.html" : path));
  if (!p.startsWith(DIST)) return null;
  if (existsSync(p) && statSync(p).isFile()) return new Response(Bun.file(p));
  return new Response(Bun.file(join(DIST, "index.html")));
}

/* ------------------------------------------------------------- routing */

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  const seg = p.split("/").filter(Boolean); // ["api", ...]

  if (m === "GET") {
    switch (p) {
      case "/api/health": return json({ ok: true, version: VERSION, commit: null });
      case "/api/vault": return json({ locked: false });
      case "/api/config": return json(D.config());
      case "/api/tree": return json(D.tree());
      case "/api/sessions": {
        const tmux = url.searchParams.get("tmux") === "1";
        return json(D.sessions.map((s) => D.sessionInfo(s, tmux)));
      }
      case "/api/open-progress": {
        const started = opening.get(key(url.searchParams.get("folder") ?? "", url.searchParams.get("project") ?? "", url.searchParams.get("repo") ?? ""));
        return json({ progress: started === undefined ? null : progressAt(Date.now() - started) });
      }
      case "/api/placement": return json({ suggest: "vps", reason: null });
      case "/api/instabox/status": return json({ enabled: false });
      case "/api/stats/live": return json({ sessions: D.sessions.map(D.sessionLive), disk: { usedBytes: D.disk().usedBytes, totalBytes: D.disk().totalBytes } });
      case "/api/stats/resources": return json(D.resources());
      case "/api/stats/totals": return json(D.totals());
      case "/api/stats/projects": {
        const t = D.statsRange(new Date().setHours(0, 0, 0, 0), Date.now(), null, null);
        return json(t.projects.map((x) => ({ project: x.project, costToday: x.cost, tokensToday: x.tokens })));
      }
      case "/api/stats/sessions": return json(D.sessions.map((s) => ({ id: s.id, cost: s.cost, tokens: s.tokens })));
      case "/api/stats/disk": return json(D.disk());
      case "/api/stats/range": return json(D.statsRange(num(url, "from", Date.now() - 86_400_000), num(url, "to", Date.now()), url.searchParams.get("project"), url.searchParams.get("repo")));
      case "/api/stats/work": return json(D.workHours(num(url, "from", Date.now() - 86_400_000), num(url, "to", Date.now())));
      case "/api/usage": return json(D.usage(num(url, "from", Date.now() - 7 * 86_400_000), num(url, "to", Date.now())));
      case "/api/codex-resets": return json({ status: null, fetchedAt: null, stale: false });
      case "/api/events": {
        const ev = D.events();
        const s = url.searchParams.get("session");
        const rows = s ? ev.filter((e) => e.session_id === s) : ev;
        return url.searchParams.has("offset") ? json({ items: rows, total: rows.length, types: [...new Set(ev.map((e) => e.type))] }) : json(rows);
      }
      case "/api/hardware": return json(D.hardware());
      case "/api/accounts": return json(D.accounts());
      case "/api/auth": {
        const ok = (detail: string) => ({ loggedIn: true, detail });
        return json({ claude: ok("2 accounts"), codex: ok("Pro"), proxyCodex: ok("signed in"), proxyXai: ok("signed in"), grok: ok("SuperGrok"), antigravity: ok("signed in"), proxyAntigravity: ok("signed in") });
      }
      case "/api/cc-upkeep": return json(D.ccUpkeep());
      case "/api/prod-db/write-count": return json({ count: D.prodWrites().filter((w) => w.status === "pending").length });
      case "/api/prod-db/writes": {
        const st = url.searchParams.get("status");
        return json(D.prodWrites().filter((w) => !st || w.status === st));
      }
      case "/api/ssh-approvals": return json(D.sshApprovals());
      case "/api/ssh-grants": return json(D.sshGrants());
      case "/api/ssh-gate": return json({ enabled: true });
      case "/api/op/ssh-keys": return json(D.sshKeys());
      case "/api/subscriptions/codex": return json({ codex: { state: "ok", planType: "pro", windows: [{ kind: "primary", usedPct: 18, windowMinutes: 300, resetsAt: Date.now() + 3 * 3_600_000 }, { kind: "secondary", usedPct: 37, windowMinutes: 10080, resetsAt: Date.now() + 4 * 86_400_000 }], credits: null, limitReached: null, fetchedAt: Date.now() - 120_000, error: null } });
      case "/api/subscriptions/grok": return json({ grok: { state: "ok", tier: "SuperGrok", usedPct: null, resetsAt: null, fetchedAt: Date.now() - 300_000, error: null } });
      case "/api/openrouter": return json({ hasKey: false, model: null });
      case "/api/unpushed": return json({ report: { at: Date.now(), total: 0, scanned: 7, folders: [] }, scanning: false, error: null });
      case "/api/local-env": return json({ profiles: [] });
    }
    if (seg[1] === "hardware" && seg[3] === "series") return json(D.hardwareSeries(seg[2], url.searchParams.get("range") ?? "24h"));
    if (seg[1] === "prod-db" && seg[2] === "writes" && seg[4] === "preview") return json({ rows: 3, note: "3 rows would change (plans: team tier)" });
    if (seg[1] === "prod-db" && seg[2] === "writes" && seg[3]) {
      const w = D.prodWrites().find((x) => String(x.id) === seg[3]);
      return w ? json(w) : json({ error: "not found" }, 404);
    }
    if (seg[1] === "hardware" || seg[1] === "subscriptions") return json({});
    // Unknown GET: an empty list is the safest "nothing here" for both list and object readers.
    return json([]);
  }

  if (m === "POST" && p === "/api/sessions") {
    const b = await body(req);
    const folder = String(b.folder ?? ""), project = String(b.project ?? ""), repo = String(b.repo ?? "");
    const agent = (b.agent as AgentName | undefined) ?? "claude";
    const existing = D.sessions.find((s) => s.project === project && s.repo === repo && s.status === "running");
    if (existing && !b.fresh) return json({ session: D.sessionInfo(existing, false), created: false, pull: { status: "up-to-date" } });
    const k = key(folder, project, repo);
    opening.set(k, Date.now());
    await Bun.sleep(OPEN_MS);
    opening.delete(k);
    const s = D.addSession(folder, project, repo, agent);
    return json({ session: D.sessionInfo(s, false), created: true, pull: { status: "up-to-date" } });
  }
  // Every other mutation succeeds without changing anything.
  return json({ ok: true });
}

/* --------------------------------------------------------------- server */

interface WsData { replay?: Replay }

const server = Bun.serve<WsData, never>({
  port: PORT,
  hostname: HOST,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (/^\/api\/sessions\/[^/]+\/terminal$/.test(url.pathname)) {
      if (srv.upgrade(req, { data: {} })) return undefined;
      return new Response("expected websocket", { status: 400 });
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return api(req, url);
    return staticFile(url.pathname) ?? new Response("Demo devd: build the dashboard first (bun run --cwd dashboard build) or pass --dashboard <dist>.", { status: 404 });
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) { ws.data.replay = terminalReplay((d) => ws.send(d)); },
    message(ws: ServerWebSocket<WsData>, msg) {
      try {
        const m = JSON.parse(String(msg)) as { t: string; cols?: number; rows?: number };
        if (m.t === "r" && m.cols && m.rows) ws.data.replay?.resize(m.cols, m.rows);
      } catch { /* ignore */ }
    },
    close(ws: ServerWebSocket<WsData>) { ws.data.replay?.stop(); },
  },
});

console.log(`demo devd listening on http://${server.hostname}:${server.port}${existsSync(DIST) ? ` (dashboard from ${DIST})` : " (no dashboard build found)"}`);
