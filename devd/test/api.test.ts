import { expect, test } from "bun:test";
import { ContainerIdentity } from "../src/containerIdentity";
import { createShare } from "../src/shares";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { insertSession, insertMetrics, openDb, listSchedules, listNotifyLog, logEvent, getSession, setRepoAgent, type SessionRow } from "../src/db";
import { createApp } from "../src/api";
import { sh } from "./helpers/sh";
import { loadCatalog } from "../src/prodDb";
import { createDbTargets } from "../src/dbTargets";
import { CloneQueue } from "../src/clone";
import { SessionBusyError, SessionManager } from "../src/sessions";
import { AgentEventHub, type NotifyExtra } from "../src/agentEvents";
import { GiteaAuthError, GiteaError, GiteaUnknownInstanceError } from "../src/gitea";

import type { ApiDeps } from "../src/api";
import { terminalGuard } from "../src/terminal";
import { hasDocker } from "./helpers/docker";
import { recordWeeklyUsage } from "../src/weeklyUsage";

const PROD_CATALOG = join(import.meta.dir, "..", "..", "image", "prod-db", "catalog.json");

function app(github?: ApiDeps["github"], gitea?: ApiDeps["gitea"], listenerOverride?: ApiDeps["listener"], extra?: Partial<ApiDeps>) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-api-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const opened: string[] = [];
  const listener = listenerOverride ?? { open: async (p: string) => { opened.push(p); }, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} };
  const stats = () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } });
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const dashboardDir = mkdtempSync(join(tmpdir(), "devd-dashboard-"));
  writeFileSync(join(dashboardDir, "index.html"), "HELLO");
  const backup = { build: async () => "/tmp/x", restore: async () => {} };
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  const agentEvents = new AgentEventHub({
    db, notify: (title, message, extra) => { notified.push({ title, message, extra }); },
    quietMs: 0, coalesceMs: 0,
  });
  const a = createApp({ mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener, notify: () => {}, stats, cloneQueue, configRepo, dashboardDir, backup, github, gitea, agentEvents, scheduler: { fireNow: async () => true }, ...extra });
  return { a, db, root, opened, notified, agentEvents };
}

test("GET /api/prod-db/:name/url: entitled → RO url; foreign → 403; unknown → 404", async () => {
  const { a } = app(undefined, undefined, undefined, {
    prodCatalog: loadCatalog(PROD_CATALOG),
    prodDbAccess: { "shop-Ledger-App": { read: ["ledger_app"], write: ["ledger_app"] } },
    readProdSecret: () => "TESTPW",
    remoteAddr: () => "127.0.0.1",
    dbTargets: createDbTargets({ entries: () => loadCatalog(PROD_CATALOG).databases }),
    dbProxyHost: "127.0.0.1:15432",
  });
  const ok = await a.request("/api/prod-db/ledger_app/url", { headers: { "x-devbox-session": "dev-shop-Ledger-App" } });
  expect(ok.status).toBe(200);
  const proxyUrl = await ok.text();
  expect(proxyUrl).toContain("postgresql://devbox_ledger_app_");
  expect(proxyUrl).not.toContain("TESTPW");
  const forbidden = await a.request("/api/prod-db/ledger_app/url", { headers: { "x-devbox-session": "dev-blog-web" } });
  expect(forbidden.status).toBe(403);
  const missing = await a.request("/api/prod-db/nothing/url", { headers: { "x-devbox-session": "dev-shop-Ledger-App" } });
  expect(missing.status).toBe(404);
});

// Task 2 fix: a session id with an ordinal suffix (prep for Task 3, see `nextSessionId`)
// must not be naively sliced from the string — `"dev-" + slice` would turn `dev-shop-Ledger-App-2`
// into the key `shop-Ledger-App-2`, which is not in the entitlement catalog. The key is built
// from the session row's `project`/`repo` columns (`shop-Ledger-App`, unchanged), so a second
// concurrent session on the same repo gets the same prod DB access as the first.
test("GET/POST prod-db: a session id with an ordinal suffix gets its entitlement from the columns, not the string", async () => {
  const { a, db } = app(undefined, undefined, undefined, {
    prodCatalog: loadCatalog(PROD_CATALOG),
    prodDbAccess: { "shop-Ledger-App": { read: ["ledger_app"], write: ["ledger_app"] } },
    readProdSecret: () => "TESTPW",
    remoteAddr: () => "127.0.0.1",
    dbTargets: createDbTargets({ entries: () => loadCatalog(PROD_CATALOG).databases }),
    dbProxyHost: "127.0.0.1:15432",
  });
  insertSession(db, {
    id: "dev-shop-Ledger-App-2", folder: "acme", project: "shop", repo: "Ledger-App",
    container: "dev-shop-Ledger-App-2", port_base: 40200, status: "running", solo: 0,
    created_at: 0, last_active_at: 0, important: 0,
  });
  const ok = await a.request("/api/prod-db/ledger_app/url", { headers: { "x-devbox-session": "dev-shop-Ledger-App-2" } });
  expect(ok.status).toBe(200);
  const proxyUrl = await ok.text();
  expect(proxyUrl).toContain("postgresql://devbox_ledger_app_");
  expect(proxyUrl).not.toContain("TESTPW");
  const write = await a.request("/api/prod-db/ledger_app/write", { method: "POST", headers: { "content-type": "application/json", "x-devbox-session": "dev-shop-Ledger-App-2" },
    body: JSON.stringify({ sql: "select 1" }) });
  expect(write.status).toBe(200);
});

test("prod-db write: propose (entitlement) → approve (stub exec) → executed; reject", async () => {
  let execCalls = 0;
  const { a } = app(undefined, undefined, undefined, {
    prodCatalog: loadCatalog(PROD_CATALOG),
    prodDbAccess: { "shop-Ledger-App": { read: ["ledger_app"], write: ["ledger_app"] }, "mel-web": { read: ["ledger_app"] } },
    readProdSecret: () => "TESTPW",
    remoteAddr: () => "127.0.0.1",
    dbTargets: createDbTargets({ entries: () => loadCatalog(PROD_CATALOG).databases }),
    dbProxyHost: "127.0.0.1:15432",
    execProdWrite: async ({ preview }) => { execCalls++; return { rows: 2, note: preview ? "preview: 2 rows" : "2 rows written" }; },
  });
  const post = (session: string, sql: string) => a.request("/api/prod-db/ledger_app/write", {
    method: "POST", headers: { "x-devbox-session": session, "content-type": "application/json" }, body: JSON.stringify({ sql }),
  });
  const status = async (id: number) => ((await (await a.request(`/api/prod-db/writes/${id}`)).json()) as { status: string }).status;

  // A read-only project may prepare a blocked proposal; approval cannot execute
  // it until a separate access operation grants write capability.
  const blocked = await post("dev-blog-web", "update users set x=1");
  expect(blocked.status).toBe(202);
  const blockedBody = await blocked.json() as { id: number; status: string };
  expect(blockedBody.status).toBe("blocked");
  expect((await a.request(`/api/prod-db/writes/${blockedBody.id}/approve`, { method: "POST" })).status).toBe(409);
  expect(execCalls).toBe(0);

  // write project → pending proposal
  const proposed = await post("dev-shop-Ledger-App", "update users set x=1");
  expect(proposed.status).toBe(200);
  const { id } = (await proposed.json()) as { id: number };
  expect(await status(id)).toBe("pending");

  // approve → calls the executor (stub) → executed
  expect((await a.request(`/api/prod-db/writes/${id}/approve`, { method: "POST" })).status).toBe(200);
  expect(execCalls).toBe(1);
  expect(await status(id)).toBe("executed");

  // reject path
  const { id: id2 } = (await (await post("dev-shop-Ledger-App", "delete from users")).json()) as { id: number };
  await a.request(`/api/prod-db/writes/${id2}/reject`, { method: "POST" });
  expect(await status(id2)).toBe("rejected");
});

test("terminalGuard: running ok, stopped/unknown 1008", () => {
  const running = { id: "x", folder: "f", project: "p", repo: "r", container: "c", port_base: 1, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as const;
  expect(terminalGuard(running)).toEqual({ ok: true });
  expect(terminalGuard({ ...running, status: "stopped" })).toEqual({ ok: false, code: 1008, reason: "session is not running" });
  expect(terminalGuard(null)).toEqual({ ok: false, code: 1008, reason: "unknown session" });
});

test("GET /api/events returns DESC + honours the session filter", async () => {
  const { a, db } = app();
  logEvent(db, "dev-shop-cms", "open");
  logEvent(db, "dev-shop-cms", "agent_done");
  logEvent(db, "dev-blog-web", "open");
  const all = await (await a.request("/api/events")).json() as { type: string; session_id: string | null }[];
  expect(all[0].type).toBe("open");
  expect(all[0].session_id).toBe("dev-blog-web"); // newest first
  const filtered = await (await a.request("/api/events?session=dev-shop-cms")).json() as unknown[];
  expect(filtered).toHaveLength(2);
});

test("schedules CRUD via the API + cron validation", async () => {
  const { a, db } = app();
  const bad = await a.request("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", cron: "nonsense", folder: "acme", project: "shop", repo: "cms", cloneUrl: "https://x/cms.git", prompt: "p" }) });
  expect(bad.status).toBe(400);
  const ok = await a.request("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "nightly", cron: "0 3 * * *", folder: "acme", project: "shop", repo: "cms", cloneUrl: "https://x/cms.git", prompt: "bump it" }) });
  expect(ok.status).toBe(201);
  const created = await ok.json() as { id: string; important: 0 | 1 };
  // A new schedule is QUIET. `important` = Pushover emergency (priority 2, alarm until acknowledged);
  // it used to be created with 1 even though the CRON UI had no toggle for it.
  expect(created.important).toBe(0);
  expect(listSchedules(db)).toHaveLength(1);

  // …but it can be enabled deliberately via the request body.
  const loud = await a.request("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "loud", cron: "0 4 * * *", folder: "acme", project: "shop", repo: "cms", cloneUrl: "https://x/cms.git", prompt: "p", important: 1 }) });
  const loudRow = await loud.json() as { id: string; important: 0 | 1 };
  expect(loudRow.important).toBe(1);
  expect((await a.request(`/api/schedules/${loudRow.id}`, { method: "DELETE" })).status).toBe(204);

  const list = await (await a.request("/api/schedules")).json() as unknown[];
  expect(list).toHaveLength(1);
  const run = await a.request(`/api/schedules/${created.id}/run`, { method: "POST" });
  expect(run.status).toBe(202);
  const del = await a.request(`/api/schedules/${created.id}`, { method: "DELETE" });
  expect(del.status).toBe(204);
  expect(listSchedules(db)).toHaveLength(0);
});

test("github owners endpoint returns documented shape", async () => {
  const { a } = app({
    owners: () => [{ login: "alice", kind: "user" }, { login: "acme", kind: "org", avatarUrl: "https://a/o.png" }],
    repos: () => [],
  });
  const r = await a.request("/api/github/owners");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ owners: [{ login: "alice", kind: "user" }, { login: "acme", kind: "org", avatarUrl: "https://a/o.png" }] });
});

test("github owners endpoint maps gh failure to 502 with error body", async () => {
  const { a } = app({
    owners: () => { throw new Error("gh api user failed: gh auth login required"); },
    repos: () => [],
  });
  const r = await a.request("/api/github/owners");
  expect(r.status).toBe(502);
  expect(((await r.json()) as { error: string }).error).toContain("gh auth login");
});

test("github repos endpoint validates owner and returns repos", async () => {
  const repo = { name: "cms", nameWithOwner: "acme/cms", url: "https://github.com/acme/cms", visibility: "private", description: "", isPrivate: true, isArchived: false, updatedAt: "2026-07-01T10:00:00Z" };
  const { a } = app({ owners: () => [], repos: (o) => (o === "acme" ? [repo] : []) });
  const ok = await a.request("/api/github/repos?owner=acme");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ repos: [repo] });
  const bad = await a.request(`/api/github/repos?owner=${encodeURIComponent("x; rm -rf /")}`);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid owner" });
  const missing = await a.request("/api/github/repos");
  expect(missing.status).toBe(400);
});

test("GET /api/backup: a second backup while one is running → 409", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const backup = { build: async () => { await gate; return "/tmp/x"; }, restore: async () => {} };
  const { a } = app(undefined, undefined, undefined, { backup });
  // Promise.resolve(): a.request() is typed as `Response | Promise<Response>`
  // (Hono), even though an async handler always returns a Promise — without wrapping, `.catch` below
  // typecheck nepustil.
  const first = Promise.resolve(a.request("/api/backup"));
  await new Promise((r) => setTimeout(r, 10));
  const second = await a.request("/api/backup");
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "backup is already running", inProgress: "backup" });
  release();
  await first.catch(() => {});   // /tmp/x does not exist → 500 is fine, the 409 above is what matters
});

test("GET /api/backup: streams from a file (content-length, content, content-type, temp file deleted)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-backup-src-"));
  const p = join(dir, "backup.tgz");
  const bytes = Buffer.alloc(1_000_000, 0xab);   // 1 MB of known bytes — enough to tell reading into memory apart from streaming
  writeFileSync(p, bytes);
  const backup = { build: async () => p, restore: async () => {} };
  const { a } = app(undefined, undefined, undefined, { backup });
  const res = await a.request("/api/backup");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-length")).toBe(String(bytes.length));
  expect(res.headers.get("content-type")).toBe("application/gzip");
  const body = new Uint8Array(await res.arrayBuffer());
  expect(body).toEqual(new Uint8Array(bytes));
  expect(existsSync(p)).toBe(false);   // unlink-after-open: the source file must disappear even when the stream finished fine
});

test("POST /api/restore: a second restore/backup while a restore is running → 409, one flag for both", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const backup = { build: async () => "/tmp/x", restore: async () => { await gate; } };
  const { a } = app(undefined, undefined, undefined, { backup });
  const first = Promise.resolve(a.request("/api/restore", { method: "POST", body: new Uint8Array([1, 2, 3]) }));
  await new Promise((r) => setTimeout(r, 10));
  const secondRestore = await a.request("/api/restore", { method: "POST", body: new Uint8Array([1, 2, 3]) });
  expect(secondRestore.status).toBe(409);
  expect(await secondRestore.json()).toEqual({ error: "backup is already running", inProgress: "backup" });
  const backupDuring = await a.request("/api/backup");
  expect(backupDuring.status).toBe(409);
  release();
  await first;
});

test("POST /api/restore: a failed restore releases the single-flight flag", async () => {
  // A `restore` stub that rejects right inside the route's try/catch — a normal
  // body, no stream to race. (The test for a failed BODY READ — another branch
  // of the same property — is separate, below.)
  const backup = { build: async () => "/tmp/x", restore: async () => { throw new Error("boom"); } };
  const { a } = app(undefined, undefined, undefined, { backup });
  const broken = await a.request("/api/restore", { method: "POST", body: new Uint8Array([1, 2, 3]) });
  expect(broken.status).toBeGreaterThanOrEqual(400);
  const after = await a.request("/api/backup");
  expect(after.status).not.toBe(409);
});

test("POST /api/restore: a failed BODY READ (connection dropped mid-upload) never sets the flag", async () => {
  // The route reads the body BEFORE `backupRunning = true` (see the comment at the route) — without
  // this property an interrupted upload would leave the flag up forever and no
  // further backup/restore would ever run. The error is raised in `pull`, not in
  // `start` — `start` runs before Hono/Bun even starts reading the stream,
  // so the error could stay uncaught somewhere else in the pipeline entirely; `pull`
  // raises it only when the reader actually asks for data, which more faithfully
  // matches a connection dropped in the middle of an upload.
  const backup = { build: async () => "/tmp/x", restore: async () => {} };
  const { a } = app(undefined, undefined, undefined, { backup });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("boom")); },
  });
  const broken = await a.request("/api/restore", { method: "POST", body, duplex: "half" } as RequestInit);
  expect(broken.status).toBeGreaterThanOrEqual(400);
  const after = await a.request("/api/backup");
  expect(after.status).not.toBe(409);
});

test("health and empty sessions", async () => {
  const { a } = app();
  const h = await a.request("/api/health");
  expect(h.status).toBe(200);
  const health = (await h.json()) as { ok: boolean; commit: string | null };
  expect(health.ok).toBe(true);
  // devd reports the commit it runs from, so a deploy can be verified.
  expect(health.commit).toMatch(/^[0-9a-f]{40}$/);
  const s = await a.request("/api/sessions");
  expect(await s.json()).toEqual([]);
});

test("GET /api/sessions: claudeState = working while fresh metrics flow (even after an old prompt)", async () => {
  const { a, db } = app();
  const now = Date.now();
  // last_active_at 20 min ago (last prompt), but the agent is generating tokens right now → must not be "idle".
  insertSession(db, { id: "dev-shop-web", folder: "acme", project: "shop", repo: "web", container: "dev-shop-web",
    port_base: 3100, status: "running", solo: 0, created_at: now - 60 * 60_000, last_active_at: now - 20 * 60_000, important: 0 });
  insertMetrics(db, [{ ts: now, session_id: "dev-shop-web", name: "claude_code.token.usage", value: 5, attrs: "{}" }]);
  const rows = (await (await a.request("/api/sessions")).json()) as { id: string; claudeState: string }[];
  expect(rows[0].claudeState).toBe("working");
});

test("GET /api/sessions: claudeState = idle with no metrics and an old last_active_at", async () => {
  const { a, db } = app();
  const now = Date.now();
  insertSession(db, { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 3110, status: "running", solo: 0, created_at: now - 60 * 60_000, last_active_at: now - 20 * 60_000, important: 0 });
  const rows = (await (await a.request("/api/sessions")).json()) as { id: string; claudeState: string }[];
  expect(rows[0].claudeState).toBe("idle");
});

test("GET /api/sessions?tmux=1: adds tmux sessions; without the parameter nothing changes", async () => {
  const { a, db } = app(undefined, undefined, undefined, {
    tmuxProbe: async (containers: string[]) => Object.fromEntries(containers.map((c) => [c,
      [{ name: "main", label: "SHOP-58", agent: null, title: null, attached: 1 }]])),
  });
  insertSession(db, {
    id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  });

  const plain = await (await a.request("/api/sessions")).json() as Record<string, unknown>[];
  expect(plain[0].tmux).toBeUndefined();

  const withTmux = await (await a.request("/api/sessions?tmux=1")).json() as { tmux: { name: string; label: string | null; agent: string | null; title: string | null; attached: number }[] }[];
  expect(withTmux[0].tmux[0]).toEqual({ name: "main", label: "SHOP-58", agent: null, title: null, attached: 1 });
});

test("tree endpoint delegates to tree()", async () => {
  const { a } = app();
  const r = await a.request("/api/tree");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual([]);
});

test("GET /api/tree: repos carry the remembered agent (null otherwise)", async () => {
  // `app()` is the existing harness in this file; `extra` overrides the tree lister.
  // repo_prefs is filled only AFTER the app is created — the merge happens per request, not at startup.
  const { a, db } = app(undefined, undefined, undefined, {
    tree: async () => ([{
      folder: "acme", project: "shop",
      repos: [
        { name: "app", cloneUrl: "https://x/app.git", provider: "github" as const, cloned: true },
        { name: "web", cloneUrl: "https://x/web.git", provider: "github" as const, cloned: false },
      ],
    }]),
  });
  setRepoAgent(db, "acme", "shop", "app", "codex", 1);
  setRepoAgent(db, "acme", "shop", "claudeSolo", "codex", 2);

  const res = await a.request("/api/tree");
  const body = await res.json() as { soloAgent: string | null; repos: { name: string; agent: string | null }[] }[];
  expect(body[0].repos.find((r) => r.name === "app")!.agent).toBe("codex");
  expect(body[0].repos.find((r) => r.name === "web")!.agent).toBeNull();
  expect(body[0].soloAgent).toBe("codex");   // claudeSolo is remembered at the project level
});

test("unknown session end → 404 with error body", async () => {
  const { a } = app();
  const r = await a.request("/api/sessions/nope/end", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  expect(r.status).toBe(404);
  expect(((await r.json()) as { error: string }).error).toContain("nope");
});

// Regression: End waiting for the offsite backup (storage guard) hung past the client timeout.
test("a long End returns 202 and finishes in the background", async () => {
  process.env.DEVD_END_SYNC_WAIT_MS = "20";
  let finish!: () => void;
  const mgr = { end: () => new Promise<void>((r) => { finish = r; }), list: () => [] } as unknown as SessionManager;
  const { a } = app(undefined, undefined, undefined, { mgr });
  try {
    const r = await a.request("/api/sessions/dev-x/end", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ pending: true });
    finish();
  } finally { delete process.env.DEVD_END_SYNC_WAIT_MS; }
});

test("malformed JSON body on session create → 400 with error body", async () => {
  const { a } = app();
  const r = await a.request("/api/sessions", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid JSON body" });
});

test("solo create without project → 400 with error body", async () => {
  const { a } = app();
  const r = await a.request("/api/sessions", { method: "POST", body: JSON.stringify({ folder: "apps", solo: true }), headers: { "content-type": "application/json" } });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toContain("required");
});

test("path-traversal folder segment → 400 with error body", async () => {
  const { a } = app();
  const r = await a.request("/api/sessions", { method: "POST", body: JSON.stringify({ folder: "..", project: "shop", repo: "x" }), headers: { "content-type": "application/json" } });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid folder/project/repo" });
});

test("HTTP Gitea clone URL reaches Codex session creation", async () => {
  const calls: unknown[] = [];
  const mgr = { open: async (input: unknown) => { calls.push(input); return { created: true }; } } as unknown as SessionManager;
  const { a } = app(undefined, undefined, undefined, { mgr });
  const input = { folder: "games", project: "games", repo: "game_web", cloneUrl: "http://gitea.example:3000/Alice/game_web.git", agent: "codex" };
  const response = await a.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  expect(calls).toEqual([{ ...input, fresh: undefined }]);
});

test("HTTP Gitea clone URL can be scheduled", async () => {
  const { a } = app();
  const response = await a.request("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Gitea", cron: "0 3 * * *", folder: "games", project: "games", repo: "game_web", cloneUrl: "http://gitea.example:3000/Alice/game_web.git", prompt: "Review" }) });
  expect(response.status).toBe(201);
});

test("invalid cloneUrl scheme → 400 with error body", async () => {
  const { a } = app();
  const r = await a.request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ folder: "acme", project: "shop", repo: "cms", cloneUrl: "ext::sh -c evil" }),
    headers: { "content-type": "application/json" },
  });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid cloneUrl" });
});

test("POST /api/sessions: invalid agent → 400", async () => {
  const { a } = app();
  const res = await a.request("/api/sessions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder: "f", project: "p", repo: "r", agent: "gpt" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json() as { error: string }).error).toContain("agent");
});

test("api open translates /workspace path to host path", async () => {
  const { a, db, opened, root } = app();
  insertSession(db, { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 });
  const r = await a.request("/api/open", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "dev-shop-cms", path: "/workspace/docs/review.md" }) });
  expect(r.status).toBe(204);
  expect(opened).toEqual([`${root}/acme/shop/cms/docs/review.md`]);
});

test("api open rejects traversal, foreign paths and unknown sessions", async () => {
  const { a, db } = app();
  insertSession(db, { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40110, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 });
  const post = (body: unknown) => a.request("/api/open", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ sessionId: "dev-shop-cms", path: "/etc/passwd" })).status).toBe(400);
  expect((await post({ sessionId: "dev-shop-cms", path: "/workspace/../../../etc/passwd" })).status).toBe(400);
  expect((await post({ sessionId: "dev-shop-cms", path: "/workspace/./x" })).status).toBe(400);
  expect((await post({ sessionId: "nope", path: "/workspace/a" })).status).toBe(404);
});

test("api notify rejects non-string title", async () => {
  const { a } = app();
  const r = await a.request("/api/notify", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: 123, message: "hello" }) });
  expect(r.status).toBe(400);
});

test("stats live and totals endpoints respond", async () => {
  const { a } = app(); // app() must pass stats: () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } })
  expect((await a.request("/api/stats/live")).status).toBe(200);
  expect((await a.request("/api/stats/totals")).status).toBe(200);
});

test("get and put config validate and persist", async () => {
  const { a } = app(); // app() must pass a configRepo backed by DEFAULT_CONFIG + noop git
  expect((await a.request("/api/config")).status).toBe(200);
  const bad = await a.request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { version: 2 } }) });
  expect(bad.status).toBe(400);
});

test("restart unknown session → 404", async () => {
  const { a } = app(); // no session with this id exists
  expect((await a.request("/api/sessions/nope/restart", { method: "POST" })).status).toBe(404);
});

test("restart unknown session with a crafted id → 404 not 409", async () => {
  const { a } = app(); // a caller-crafted id must not spoof the error taxonomy via message text
  const r = await a.request(`/api/sessions/${encodeURIComponent("x is not stopped y")}/restart`, { method: "POST" });
  expect(r.status).toBe(404);
});

test("lifecycle routes: SessionBusyError → 409 with inProgress", async () => {
  const busy = async () => { throw new SessionBusyError("dev-shop-web", "recreate"); };
  const mgr = { stop: busy, end: busy, recreate: busy, restartSolo: busy, open: busy, list: () => [] } as unknown as SessionManager;
  const { a, db } = app(undefined, undefined, undefined, { mgr });
  insertSession(db, { id: "dev-shop-web", folder: "acme", project: "shop", repo: "web", container: "dev-shop-web",
    port_base: 3100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 });
  for (const path of ["/api/sessions/dev-shop-web/stop", "/api/sessions/dev-shop-web/end", "/api/sessions/dev-shop-web/recreate", "/api/sessions/dev-shop-web/restart"]) {
    const r = await a.request(path, { method: "POST" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ inProgress: "recreate" });
  }
  const open = await a.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder: "acme", project: "shop", repo: "web" }) });
  expect(open.status).toBe(409);
});

test("SPA fallback serves index for non-api routes when dashboard dir set", async () => {
  const { a } = app(); // app() passes dashboardDir pointing at a temp dir containing index.html "HELLO"
  const r = await a.request("/whatever");
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("HELLO");
});

test("typo'd /api and /v1 paths 404 as JSON instead of falling through to the SPA index", async () => {
  const { a } = app();
  const api = await a.request("/api/nonexistent");
  expect(api.status).toBe(404);
  expect(await api.json()).toEqual({ error: "not found" });
  const v1 = await a.request("/v1/nonexistent");
  expect(v1.status).toBe(404);
});

const aePost = (a: ReturnType<typeof app>["a"], body: unknown) =>
  a.request("/api/agent-event", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("agent-event: malformed body 400, unknown session 404", async () => {
  const { a } = app();
  expect((await aePost(a, { event: "stop" })).status).toBe(400);
  expect((await aePost(a, { sessionId: "dev-x-y", event: "cokoli" })).status).toBe(400);
  expect((await aePost(a, { sessionId: "dev-x-y", event: "stop" })).status).toBe(404);
});

test("agent-event: permission immediately, stop after sweep, with payloads", async () => {
  const { a, db, notified, agentEvents } = app();
  insertSession(db, {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40200, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });
  expect((await aePost(a, { sessionId: "dev-shop-cms", event: "permission_request" })).status).toBe(200);
  expect(notified[0]).toMatchObject({ title: "shop/cms", message: "Claude is waiting for permission" });
  expect(notified[0].extra?.sound).toBe(true);
  expect((await aePost(a, { sessionId: "dev-shop-cms", event: "user_prompt_submit" })).status).toBe(200);
  expect((await aePost(a, { sessionId: "dev-shop-cms", event: "stop" })).status).toBe(200);
  agentEvents.sweep(); // quietMs 0 → the window elapsed immediately
  expect(notified[1].title).toBe("shop/cms");
  expect(notified[1].extra?.session).toEqual({ id: "dev-shop-cms", project: "shop", repo: "cms", agent: "claude", name: null });
});

test("agent-event stop: malformed backgroundTasks (string, negative, infinite) is ignored, neither crashes nor believes busy", async () => {
  const { a, db } = app();
  insertSession(db, {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40200, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });
  // A string and a negative number pass through plain JSON.stringify unchanged. NaN itself
  // cannot be sent over the wire (JSON.stringify(NaN) is "null"), so the last case
  // uses 1e400 — JSON.parse legally overflows it to Infinity, i.e. a number that
  // Number.isFinite rejects just like NaN.
  const bodies = [
    JSON.stringify({ sessionId: "dev-shop-cms", event: "stop", backgroundTasks: "3" }),
    JSON.stringify({ sessionId: "dev-shop-cms", event: "stop", backgroundTasks: -1 }),
    '{"sessionId":"dev-shop-cms","event":"stop","backgroundTasks":1e400}',
  ];
  for (const body of bodies) {
    const res = await a.request("/api/agent-event", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
  }
  const rows = listNotifyLog(db, { session: "dev-shop-cms" }).filter((r) => r.event === "stop");
  expect(rows).toHaveLength(3);
  // Without a valid value only the counter decides (0 subagents) → armed, never deferred
  // because of a fabricated "busy" value.
  expect(rows.every((r) => r.decision === "armed")).toBe(true);
  expect(rows.every((r) => r.reason !== "busy-background-tasks")).toBe(true);
  expect(rows.every((r) => !(r.detail ?? "").includes("backgroundTasks"))).toBe(true);
});

const giteaRow = {
  name: "rp", fullName: "bob/rp", owner: "bob", description: "",
  isPrivate: true, isArchived: false, updatedAt: "2026-07-01T10:00:00Z",
  cloneUrl: "http://g/bob/rp.git",
};

test("gitea instances endpoint returns hasToken without the token itself", async () => {
  const { a } = app(undefined, {
    instances: () => [{ name: "Portal", url: "http://g", hasToken: true }],
    repos: async () => [], setToken: async () => ({ login: "x" }),
  });
  const r = await a.request("/api/gitea/instances");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ instances: [{ name: "Portal", url: "http://g", hasToken: true }] });
});

test("gitea repos endpoint maps errors to 404/502 and success to repos", async () => {
  const { a } = app(undefined, {
    instances: () => [],
    repos: async (i) => {
      if (i === "typo") throw new GiteaUnknownInstanceError("Unknown Gitea instance: typo");
      if (i === "down") throw new GiteaError("Gitea down unreachable: timeout");
      return [giteaRow];
    },
    setToken: async () => ({ login: "x" }),
  });
  const ok = await a.request("/api/gitea/repos?instance=Portal");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ repos: [giteaRow] });
  expect((await a.request("/api/gitea/repos?instance=typo")).status).toBe(404);
  expect((await a.request("/api/gitea/repos?instance=down")).status).toBe(502);
});

test("gitea token endpoint saves via setToken and maps rejection to 400", async () => {
  const saved: [string, string][] = [];
  const { a } = app(undefined, {
    instances: () => [], repos: async () => [],
    setToken: async (i, t) => {
      if (t === "wrong") throw new GiteaAuthError("Gitea rejected the token");
      saved.push([i, t]);
      return { login: "alice" };
    },
  });
  const ok = await a.request("/api/gitea/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instance: "Portal", token: "new" }),
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, login: "alice" });
  expect(saved).toEqual([["Portal", "new"]]);

  const bad = await a.request("/api/gitea/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instance: "Portal", token: "wrong" }),
  });
  expect(bad.status).toBe(400);

  const missing = await a.request("/api/gitea/token", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  expect(missing.status).toBe(400);
});

test("gitea endpoints without the dep answer 503", async () => {
  const { a } = app();
  expect((await a.request("/api/gitea/instances")).status).toBe(503);
  expect((await a.request("/api/gitea/repos?instance=x")).status).toBe(503);
  expect((await a.request("/api/gitea/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
});

test("clipboard endpoint proxies the listener and audits image/text", async () => {
  const kinds: string[] = [];
  const { a, db } = app(undefined, undefined, {
    open: async () => {}, notify: () => {},
    clipboard: async (kind: string) => {
      kinds.push(kind);
      if (kind === "image") return { status: 200, contentType: "image/png", body: new Uint8Array([1, 2]) };
      if (kind === "targets") return { status: 200, contentType: "text/plain; charset=utf-8", body: new TextEncoder().encode("image/png\n") };
      return { status: 204, contentType: null, body: new Uint8Array() };
    },
    openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  });
  const img = await a.request("/api/clipboard/image?session=abc123");
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await img.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  expect((await a.request("/api/clipboard/targets")).status).toBe(200);
  expect((await a.request("/api/clipboard/text")).status).toBe(204);
  expect(kinds).toEqual(["image", "targets", "text"]);
  const events = db.query("SELECT type, session_id, data FROM events WHERE type = 'clipboard_access'").all() as { type: string; session_id: string | null; data: string }[];
  expect(events.map((e) => JSON.parse(e.data).kind)).toEqual(["image"]); // neither targets nor a 204 text are logged
  expect(events[0]).toMatchObject({ session_id: "abc123" });
});

// Codex and Grok Build do not read the clipboard via xclip (arboard talks to X11/Wayland directly
// and there is no display in the container) — instead of bytes the image is handed over as a file
// in the shared /inbox and only the path goes into the prompt (tmux C-v binding, devbox-ctrlv).
test("clipboard image?target=shared saves the PNG into the shared _inbox and returns an /inbox path", async () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const { a, db, root } = app(undefined, undefined, {
    open: async () => {}, notify: () => {},
    clipboard: async (kind: string) =>
      kind === "image"
        ? { status: 200, contentType: "image/png", body: png }
        : { status: 204, contentType: null, body: new Uint8Array() },
    openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  });
  const r = await a.request("/api/clipboard/image?target=shared&session=abc123");
  expect(r.status).toBe(200);
  const path = await r.text();
  expect(path).toMatch(/^\/inbox\/img-\d{8}-\d{6}\.png$/);
  const name = path.split("/").pop()!;
  expect(readFileSync(join(root, "_inbox", name))).toEqual(Buffer.from(png));
  const events = db.query("SELECT session_id, data FROM events WHERE type = 'clipboard_access'").all() as { session_id: string | null; data: string }[];
  expect(events).toHaveLength(1);
  expect(events[0].session_id).toBe("abc123");
  expect(JSON.parse(events[0].data)).toMatchObject({ kind: "image", target: "shared", name });
  // two pastes in the same second must not overwrite the file — uniquePath adds a suffix
  const r2 = await a.request("/api/clipboard/image?target=shared");
  expect(r2.status).toBe(200);
  expect(await r2.text()).not.toBe(path);
});

// An unavailable clipboard used to end in a 502 with a JSON error the shim dropped (exit 1) — paste
// silently did nothing. Now it is a 503 with a bare sentence the shim inserts into the prompt.
test("clipboard endpoint: unknown kind 400, unavailable listener 503 with a message to paste", async () => {
  const { a } = app(undefined, undefined, {
    open: async () => {}, notify: () => {},
    clipboard: async () => { throw new Error("listener returned 500"); },
    openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  });
  expect((await a.request("/api/clipboard/gif")).status).toBe(400);
  const r = await a.request("/api/clipboard/image");
  expect(r.status).toBe(503);
  expect(r.headers.get("content-type")).toContain("text/plain");
  expect(await r.text()).toContain("Mac is not responding");
  // targets MUST stay 200 and offer text/plain — otherwise cc gives up before
  // it even asks for the message.
  const t = await a.request("/api/clipboard/targets");
  expect(t.status).toBe(200);
  expect(await t.text()).toBe("text/plain\n");
});

test("clipboard endpoint: listener answers with an error status → also a message, not silence", async () => {
  const { a } = app(undefined, undefined, {
    open: async () => {}, notify: () => {},
    clipboard: async () => ({ status: 500, contentType: null, body: new Uint8Array() }),
    openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  });
  const r = await a.request("/api/clipboard/image");
  expect(r.status).toBe(503);
  expect(await r.text()).toContain("500");
});

test("clipboard endpoint: a locked vault has its own message and the listener is not even called", async () => {
  let called = 0;
  const vault = { isLocked: () => true, unlock: () => {}, lock: () => {}, secrets: () => ({}), update: () => {} } as unknown as ApiDeps["vault"];
  const { a } = app(undefined, undefined, {
    open: async () => {}, notify: () => {},
    clipboard: async () => { called++; return { status: 204, contentType: null, body: new Uint8Array() }; },
    openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  }, { vault });
  const img = await a.request("/api/clipboard/image");
  expect(img.status).toBe(503);
  expect(await img.text()).toContain("Vault is locked");
  // a file paste (⌘⇧V) must also say why, not fall into the void
  expect(await (await a.request("/api/clipboard/file?session=abc")).text()).toContain("Vault is locked");
  const t = await a.request("/api/clipboard/targets");
  expect(t.status).toBe(200);
  expect(await t.text()).toBe("text/plain\n");
  expect(called).toBe(0);
});

test("clipboard/file: saves into the session workspace, returns the container path + logs", async () => {
  const listener: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {}, openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
    clipboard: async (kind: string) =>
      kind === "file"
        ? { status: 200, contentType: "application/octet-stream", filename: "faktura.pdf", body: new Uint8Array([1, 2, 3]) }
        : { status: 204, contentType: null, body: new Uint8Array() },
  };
  const { a, db, root } = app(undefined, undefined, listener);
  // workspace: root/folder/repo (folder==project)
  mkdirSync(join(root, "shop", "cms"), { recursive: true });
  insertSession(db, { id: "dev-shop-cms", folder: "shop", project: "shop", repo: "cms", container: "c", port_base: 4400, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 });

  const r = await a.request("/api/clipboard/file?session=dev-shop-cms");
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("/workspace/.inbox/faktura.pdf");
  expect(existsSync(join(root, "shop", "cms", ".inbox", "faktura.pdf"))).toBe(true);
  const ev = db.query("SELECT type, data FROM events WHERE type='file_inbox'").all() as { type: string; data: string }[];
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].data)).toMatchObject({ name: "faktura.pdf", size: 3 });
});

test("clipboard/file?target=shared: saves into <root>/_inbox, returns an /inbox path, WITHOUT a session", async () => {
  const listener: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {}, openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
    clipboard: async (kind: string) =>
      kind === "file"
        ? { status: 200, contentType: "application/octet-stream", filename: "sdileny.pdf", body: new Uint8Array([9, 9]) }
        : { status: 204, contentType: null, body: new Uint8Array() },
  };
  const { a, db, root } = app(undefined, undefined, listener);
  const r = await a.request("/api/clipboard/file?target=shared"); // no ?session=
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("/inbox/sdileny.pdf");
  expect(existsSync(join(root, "_inbox", "sdileny.pdf"))).toBe(true);
  const ev = db.query("SELECT data FROM events WHERE type='file_inbox'").all() as { data: string }[];
  expect(JSON.parse(ev[0].data)).toMatchObject({ name: "sdileny.pdf", size: 2, shared: true });
});

test("clipboard/file: unknown session → 400, empty → 204, over the cap → 413", async () => {
  const filey = (status: number, extra: object = {}): ApiDeps["listener"] => ({
    open: async () => {}, notify: () => {}, openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
    clipboard: async () => ({ status, contentType: null, body: new Uint8Array(), ...extra }),
  });
  // unknown session (no row in the db) — 204/413 propagate even before the session lookup
  expect((await app(undefined, undefined, filey(200, { filename: "x", body: new Uint8Array([1]) })).a.request("/api/clipboard/file?session=nope")).status).toBe(400);
  expect((await app(undefined, undefined, filey(204)).a.request("/api/clipboard/file?session=nope")).status).toBe(204);
  expect((await app(undefined, undefined, filey(413)).a.request("/api/clipboard/file?session=nope")).status).toBe(413);
});

test("POST /api/preview: range, URL, path, 404/403/400/502", async () => {
  const urls: string[] = [];
  const listener: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {},
    clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }),
    openUrl: async (u) => { urls.push(u); }, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  };
  const { a, db } = app(undefined, undefined, listener, { previewHost: "100.64.0.10" });
  insertSession(db, { id: "dev-a-web", folder: "a", project: "a", repo: "web", container: "dev-a-web", port_base: 40100, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  const post = (p: unknown) => a.request("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });

  const ok = await post({ sessionId: "dev-a-web", containerPort: 3000 });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ url: "http://100.64.0.10:40100" });
  expect(urls).toEqual(["http://100.64.0.10:40100"]);

  await post({ sessionId: "dev-a-web", containerPort: 3001, path: "/admin" });
  expect(urls.at(-1)).toBe("http://100.64.0.10:40101/admin");

  expect((await post({ sessionId: "dev-a-web", containerPort: 3010 })).status).toBe(403);   // mimo rozsah (3000–3009)
  expect((await post({ sessionId: "nope", containerPort: 3000 })).status).toBe(404);         // unknown session
  expect((await post({ sessionId: "dev-a-web", containerPort: 3000, path: "/../x" })).status).toBe(400); // traversal
  expect((await post({ sessionId: "dev-a-web", containerPort: 999 })).status).toBe(403);     // mimo rozsah
});

test("POST /api/preview: shared session → publicPreview + port, no token and no Tailscale URL", async () => {
  const urls: string[] = [];
  const listener: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {},
    clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }),
    openUrl: async (u) => { urls.push(u); }, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  };
  // Called by a shared session's container (the shared-container guard recognizes it by IP).
  const { a, db } = app(undefined, undefined, listener, {
    previewHost: "100.64.0.10", remoteAddr: () => "172.17.0.9",
    containerIdentity: new ContainerIdentity({ snapshot: async () => new Map([["172.17.0.9", "dev-a-web"]]) }),
  });
  insertSession(db, { id: "dev-a-web", folder: "a", project: "a", repo: "web", container: "dev-a-web", port_base: 40100, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  const { token } = createShare(db, "dev-a-web", 60);
  const r = await a.request("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "dev-a-web", containerPort: 3002 }) });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(JSON.parse(text)).toEqual({ publicPreview: true, port: 3002 });
  expect(text).not.toContain(token);
  expect(text).not.toContain("100.64.0.10");
  // Final review I3: the preview content is controlled by the guest — it does not open by itself on the owner's mac.
  expect(urls).toEqual([]);
});

test("POST /api/preview: listener crashes → 502 with url", async () => {
  const bad: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {},
    clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }),
    openUrl: async () => { throw new Error("listener down"); }, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  };
  const { a, db } = app(undefined, undefined, bad, { previewHost: "100.64.0.10" });
  insertSession(db, { id: "dev-a-web", folder: "a", project: "a", repo: "web", container: "dev-a-web", port_base: 40100, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  const r = await a.request("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "dev-a-web", containerPort: 3000 }) });
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ url: "http://100.64.0.10:40100" });
});

const runRow = (over: Partial<SessionRow> = {}): SessionRow => ({ id: "dev-x", folder: "f", project: "p", repo: "r", container: "ctr", port_base: 0, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, ...over });

test("tmux label: 400 invalid name, 404 unknown, otherwise set via tmuxExec", async () => {
  const calls: string[] = [];
  const { a, db } = app(undefined, undefined, undefined, { tmuxExec: async (_c, cmd) => { calls.push(cmd); return { code: 0, stdout: "" }; } });
  insertSession(db, runRow());
  const hdr = { "content-type": "application/json" };
  expect((await a.request("/api/sessions/dev-x/tmux/foo/label", { method: "POST", headers: hdr, body: "{}" })).status).toBe(400);
  expect((await a.request("/api/sessions/nope/tmux/main/label", { method: "POST", headers: hdr, body: "{}" })).status).toBe(404);
  const r = await a.request("/api/sessions/dev-x/tmux/main-2/label", { method: "POST", headers: hdr, body: JSON.stringify({ name: "SHOP-58" }) });
  expect(r.status).toBe(204);
  expect(calls.at(-1)).toContain("@devd_label 'SHOP-58'");
});

test("tmux kill: non-last → ended:false + kill command", async () => {
  const calls: string[] = [];
  const probe = "main\t\t\tfixing\t1\nmain-2\t\t\treview\t0";
  const { a, db } = app(undefined, undefined, undefined, {
    tmuxExec: async (_c, cmd) => { calls.push(cmd); return { code: 0, stdout: cmd.includes("list-sessions") ? probe : "" }; },
  });
  insertSession(db, runRow());
  const r = await a.request("/api/sessions/dev-x/tmux/main-2/kill", { method: "POST" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ended: false });
  expect(calls.some((c) => c.includes("kill-session -t main-2"))).toBe(true);
});

test.skipIf(!hasDocker)("tmux kill: last → ended:true + session deleted", async () => {
  const { a, db } = app(undefined, undefined, undefined, { tmuxExec: async () => ({ code: 0, stdout: "" }) });
  insertSession(db, runRow());
  const r = await a.request("/api/sessions/dev-x/tmux/main/kill", { method: "POST" });
  expect(await r.json()).toEqual({ ended: true });
  expect(getSession(db, "dev-x")).toBeNull();
});

// I2 (final review PR 1): the last pane closed while a recreate runs on the session
// → end() hits the same lock (SessionBusyError) as the other
// five lifecycle routes. Previously no try/catch = a bare 500 (Hono has no app.onError).
test("tmux kill: last pane + end() busy with recreate → 409, not 500", async () => {
  const mgr = { end: async () => { throw new SessionBusyError("dev-x", "recreate"); } } as unknown as SessionManager;
  const { a, db } = app(undefined, undefined, undefined, {
    mgr,
    tmuxExec: async () => ({ code: 0, stdout: "" }), // empty probe → remaining.length === 0 → end() is called
  });
  insertSession(db, runRow());
  const r = await a.request("/api/sessions/dev-x/tmux/main/kill", { method: "POST" });
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({ inProgress: "recreate" });
});

/* ------------------- prompt statistics (spec 2026-07-26) ------------------- */

const promptSession = (db: Parameters<typeof insertSession>[0], id = "dev-shop-cms") =>
  insertSession(db, {
    id, folder: "acme", project: "shop", repo: "cms", container: id,
    port_base: 40777, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });

test("agent-event: a prompt stores its length, but the prompt TEXT is never written anywhere", async () => {
  const { a, db } = app();
  promptSession(db);
  const secret = "please delete the production database of customer Novak";
  expect((await aePost(a, { sessionId: "dev-shop-cms", event: "user_prompt_submit", prompt: secret })).status).toBe(200);

  const rows = db.query("SELECT name, value, attrs, session_id FROM metrics").all() as
    { name: string; value: number; attrs: string; session_id: string }[];
  const chars = rows.find((r) => r.name === "devbox.prompt.chars");
  expect(chars?.value).toBe(secret.length);
  expect(chars?.session_id).toBe("dev-shop-cms");
  expect(JSON.parse(chars!.attrs)).toEqual({ project: "shop", repo: "cms" });

  // The prompt content must not be anywhere in metrics or events.
  const dump = JSON.stringify([
    ...rows,
    ...db.query("SELECT type, data FROM events").all(),
  ]);
  expect(dump).not.toContain("Novak");
  expect(dump).not.toContain(secret);
});

test("agent-event: wait_ms is written only once the previous stop is known", async () => {
  const { a, db } = app();
  promptSession(db);
  const waitRows = () => db.query("SELECT value FROM metrics WHERE name='devbox.prompt.wait_ms'").all() as { value: number }[];

  // the first prompt after devd starts has nothing to subtract from → no row
  await aePost(a, { sessionId: "dev-shop-cms", event: "user_prompt_submit", prompt: "hello" });
  expect(waitRows()).toHaveLength(0);

  // after a stop the reference exists
  await aePost(a, { sessionId: "dev-shop-cms", event: "stop" });
  await aePost(a, { sessionId: "dev-shop-cms", event: "user_prompt_submit", prompt: "continue" });
  const w = waitRows();
  expect(w).toHaveLength(1);
  expect(w[0].value).toBeGreaterThanOrEqual(0);
});

test("agent-event: an empty prompt creates no metric", async () => {
  const { a, db } = app();
  promptSession(db);
  await aePost(a, { sessionId: "dev-shop-cms", event: "user_prompt_submit", prompt: "" });
  expect(db.query("SELECT COUNT(*) n FROM metrics").get()).toMatchObject({ n: 0 });
});

test("GET /api/stats/sessions returns cost and tokens per session", async () => {
  const { a, db } = app();
  promptSession(db);
  insertMetrics(db, [
    { ts: Date.now(), session_id: "dev-shop-cms", name: "claude_code.cost.usage", value: 2.5, attrs: "{}" },
    { ts: Date.now(), session_id: "dev-shop-cms", name: "claude_code.token.usage", value: 1234, attrs: "{}" },
  ]);
  const r = await a.request("/api/stats/sessions");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual([{ id: "dev-shop-cms", cost: 2.5, tokens: 1234 }]);
});

test("GET /api/events: a bare array without offset, a paginated envelope with offset", async () => {
  const { a, db } = app();
  for (let i = 0; i < 7; i++) logEvent(db, "dev-shop-cms", i % 2 ? "agent_done" : "cc_upgraded");

  const plain = await (await a.request("/api/events")).json();
  expect(Array.isArray(plain)).toBe(true);

  const paged = await (await a.request("/api/events?offset=0&limit=3")).json() as
    { items: unknown[]; total: number; types: string[] };
  expect(paged.items).toHaveLength(3);
  expect(paged.total).toBe(7);
  expect(paged.types.sort()).toEqual(["agent_done", "cc_upgraded"]);

  const filtered = await (await a.request("/api/events?offset=0&types=cc_upgraded")).json() as { total: number };
  expect(filtered.total).toBe(4);
});

test("PUT /api/config drops the tree cache", async () => {
  let invalidated = 0;
  const { a } = app(undefined, undefined, undefined, { onConfigWritten: () => { invalidated++; } });
  const r = await a.request("/api/config", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: DEFAULT_CONFIG }),
  });
  expect(r.status).toBe(200);
  expect(invalidated).toBe(1);
});

test("an invalid config leaves the cache alone — invalidating would mean discarding a valid tree", async () => {
  let invalidated = 0;
  const { a } = app(undefined, undefined, undefined, { onConfigWritten: () => { invalidated++; } });
  const r = await a.request("/api/config", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { folders: "this is not an object" } }),
  });
  expect(r.status).toBe(400);
  expect(invalidated).toBe(0);
});

// ── OpenRouter ────────────────────────────────────────────────────────────────
// A human enters the key in the dashboard, so it MUST arrive here over HTTP. It must not be able
// to get back out the same way: GET is the only thing the dashboard calls after a reload, and
// returning it once would be enough for a paid credential to sit in a response that
// the browser (and its devtools and cache) quietly keeps.
function openrouterDeps() {
  let stored: string | null = null;
  return {
    stored: () => stored,
    dep: { hasKey: () => stored !== null, setKey: (k: string) => { stored = k.trim() || null; } },
  };
}

test("GET /api/openrouter: a fresh devd has neither a key nor a model", async () => {
  const { dep } = openrouterDeps();
  const { a } = app(undefined, undefined, undefined, { openrouter: dep });
  const r = await a.request("/api/openrouter");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ hasKey: false, model: null });
});

test("PUT /api/openrouter/key stores the key, GET only says YES/NO about it", async () => {
  const { dep, stored } = openrouterDeps();
  const { a } = app(undefined, undefined, undefined, { openrouter: dep });
  const put = await a.request("/api/openrouter/key", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "sk-or-v1-secret" }),
  });
  expect(put.status).toBe(204);
  expect(stored()).toBe("sk-or-v1-secret");

  const body = await (await a.request("/api/openrouter")).text();
  expect(JSON.parse(body).hasKey).toBe(true);
  expect(body).not.toContain("sk-or-v1-secret");
});

// An empty value means "disconnect OpenRouter", not an error — otherwise the key could only be replaced,
// never removed, and removing it would require SSH.
test("PUT /api/openrouter/key with an empty value disconnects the key", async () => {
  const { dep, stored } = openrouterDeps();
  const { a } = app(undefined, undefined, undefined, { openrouter: dep });
  await a.request("/api/openrouter/key", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "sk-or-v1-secret" }),
  });
  const r = await a.request("/api/openrouter/key", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "" }),
  });
  expect(r.status).toBe(204);
  expect(stored()).toBeNull();
});

// The model is the whole point of the card: stealth models on OpenRouter appear and disappear within
// weeks, so switching must not mean SSH to the VPS and editing the config by hand.
test("PUT /api/openrouter/model writes proxyModels.openrouter into the config", async () => {
  let written: unknown = null;
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async (c) => { written = c; } };
  const { dep } = openrouterDeps();
  const { a } = app(undefined, undefined, undefined, { openrouter: dep, configRepo });
  const r = await a.request("/api/openrouter/model", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stealth/ox-alpha" }),
  });
  expect(r.status).toBe(204);
  expect((written as typeof DEFAULT_CONFIG).settings.proxyModels?.openrouter).toBe("stealth/ox-alpha");
});

// ── Proxy profile context windows ────────────────────────────────────────────
test("GET /api/proxy-context returns rows with override, effective and source", async () => {
  const cfg = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, proxyContext: { gpt: 400_000 }, proxyModels: { openrouter: "stealth/ox-alpha" } } };
  const configRepo: ConfigRepo = { read: () => cfg, write: async () => {} };
  const { a } = app(undefined, undefined, undefined, { configRepo, orCtxLookup: async () => 1048576 });
  const r = await a.request("/api/proxy-context");
  expect(r.status).toBe(200);
  const { profiles } = await r.json() as { profiles: { key: string; override: number | null; effective: number | null; source: string }[] };
  expect(profiles.find((p) => p.key === "gpt")).toMatchObject({ override: 400_000, effective: 400_000, source: "manual" });
  expect(profiles.find((p) => p.key === "grok")).toMatchObject({ override: null, source: "default" });
  expect(profiles.find((p) => p.key === "openrouter")).toMatchObject({ override: null, effective: 1048576, source: "catalog" });
});

test("PUT /api/proxy-context/:key writes an override, null deletes it", async () => {
  let written: unknown = null;
  const configRepo: ConfigRepo = {
    read: () => ({ ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, proxyContext: { grok: 2_000_000 } } }),
    write: async (c) => { written = c; },
  };
  const { a } = app(undefined, undefined, undefined, { configRepo });
  const put = (key: string, tokens: unknown) => a.request(`/api/proxy-context/${key}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokens }),
  });
  expect((await put("gpt", 400_000)).status).toBe(204);
  expect((written as typeof DEFAULT_CONFIG).settings.proxyContext).toEqual({ grok: 2_000_000, gpt: 400_000 });
  expect((await put("grok", null)).status).toBe(204);
  expect((written as typeof DEFAULT_CONFIG).settings.proxyContext).toEqual({});
});

test("PUT /api/proxy-context rejects nonsense: unknown profile, zero, negative, text", async () => {
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => { throw new Error("must not write here"); } };
  const { a } = app(undefined, undefined, undefined, { configRepo });
  const put = (key: string, body: string) => a.request(`/api/proxy-context/${key}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body,
  });
  expect((await put("nope", JSON.stringify({ tokens: 1 }))).status).toBe(400);
  expect((await put("gpt", JSON.stringify({ tokens: 0 }))).status).toBe(400);
  expect((await put("gpt", JSON.stringify({ tokens: -1 }))).status).toBe(400);
  expect((await put("gpt", JSON.stringify({ tokens: "1M" }))).status).toBe(400);
  expect((await put("gpt", "{}")).status).toBe(400);
});

// ── Running proxy profiles locally (dev local) ───────────────────────────────
test("GET /api/local-env returns ready env maps, cliproxy base from the Host header", async () => {
  const cfg = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, proxyModels: { gpt: "gpt-5.6-sol", openrouter: "stealth/ox-alpha" } } };
  const configRepo: ConfigRepo = { read: () => cfg, write: async () => {} };
  const { a } = app(undefined, undefined, undefined, {
    configRepo,
    upstreamKeys: (u) => (u === "openrouter" ? "or-key" : "cp-key"),
    orCtxLookup: async () => 1048576,
  });
  const r = await a.request("/api/local-env", { headers: { host: "100.1.2.3:4300" } });
  expect(r.status).toBe(200);
  const { profiles } = await r.json() as { profiles: { profile: string; ready: boolean; env?: Record<string, string> }[] };
  const gpt = profiles.find((p) => p.profile === "claude-gpt")!;
  expect(gpt.ready).toBe(true);
  expect(gpt.env!.ANTHROPIC_BASE_URL).toBe("http://100.1.2.3:4300/api/cliproxy");
  // Grok has no model in the config → it must not be offered.
  expect(profiles.find((p) => p.profile === "claude-grok")!.ready).toBe(false);
  expect(profiles.find((p) => p.profile === "claude-openrouter")!.env!.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
});

test("passthrough /api/cliproxy/* forwards method, path, body and status", async () => {
  const seen: { method?: string; path?: string; body?: string; auth?: string | null } = {};
  const upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.method = req.method;
      seen.path = new URL(req.url).pathname;
      seen.body = await req.text();
      seen.auth = req.headers.get("authorization");
      return new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const { a } = app(undefined, undefined, undefined, { cliproxyLocalUrl: `http://127.0.0.1:${upstream.port}` });
    const r = await a.request("/api/cliproxy/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cp-key" },
      body: JSON.stringify({ model: "gpt-5.6-sol" }),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: 1 });
    expect(seen).toMatchObject({ method: "POST", path: "/v1/messages", auth: "Bearer cp-key" });
    expect(seen.body).toContain("gpt-5.6-sol");
  } finally {
    upstream.stop(true);
  }
});

// Without the dependency wired up (older deployment) the endpoint must say it cannot — not pretend
// it stored the key. A silent success would look done in the dashboard and the profile would not run.
test("/api/openrouter without the dependency wired up reports 503, not a fake OK", async () => {
  const { a } = app();
  expect((await a.request("/api/openrouter")).status).toBe(503);
  const put = await a.request("/api/openrouter/key", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "sk-or-v1-x" }),
  });
  expect(put.status).toBe(503);
});

// idleTimeout fix: long routes (backup, restore, open, manual upkeep run) call
// `server.timeout(req, 0)` as the very first thing in the handler, so Bun's default
// idle timeout (now a 255s cap) does not close them midway. Hono carries the Bun server in `c.env`
// only under a real `Bun.serve` (see index.ts) — in tests via `app.request(path,
// init, env)` that is exactly what the third argument supplies, so a stub with a
// `timeout` spy is enough here instead of a real Bun server.
test("long routes (backup/restore/sessions open/cc-upkeep run) disable the Bun idle timeout per request", async () => {
  const calls: Array<[Request, number]> = [];
  const env = { timeout: (req: Request, seconds: number) => { calls.push([req, seconds]); } };

  // POST /api/sessions: SessionBusyError stub (same pattern as "lifecycle routes" above) —
  // the handler ends quickly on 409, but noIdleTimeout must run BEFORE that.
  const mgr = { open: async () => { throw new SessionBusyError("dev-x", "open"); }, list: () => [] } as unknown as SessionManager;
  const { a } = app(undefined, undefined, undefined, { mgr });

  calls.length = 0;
  const backupRes = await a.request("/api/backup", {}, env);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0][1]).toBe(0);
  expect(backupRes.status).toBeOneOf([200, 500]); // stub `build()` returns a nonexistent path → readFileSync fails with 500

  calls.length = 0;
  await a.request("/api/restore", { method: "POST", body: new Uint8Array([1, 2, 3]) }, env);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0][1]).toBe(0);

  calls.length = 0;
  const sessionsRes = await a.request("/api/sessions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder: "acme", project: "shop", repo: "web" }),
  }, env);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0][1]).toBe(0);
  expect(sessionsRes.status).toBe(409);

  calls.length = 0;
  const upkeepRes = await a.request("/api/cc-upkeep/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }, env);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0][1]).toBe(0);
  expect(upkeepRes.status).toBe(404); // ccUpkeep is not wired up in the test app() — but the spy ran BEFORE this 404
});

test("GET /api/health (short route) does not call noIdleTimeout", async () => {
  const calls: unknown[] = [];
  const { a } = app(undefined, undefined, undefined, {});
  const env = { timeout: (...args: unknown[]) => { calls.push(args); } };
  const r = await a.request("/api/health", {}, env);
  expect(r.status).toBe(200);
  expect(calls.length).toBe(0);
});

test("GET /api/open-progress returns the open() progress of the given repo", async () => {
  const asked: unknown[] = [];
  const mgr = { openProgressFor: (t: unknown) => { asked.push(t); return { step: "clone", clone: { phase: "Receiving objects", percent: 7 } }; } } as unknown as SessionManager;
  const { a } = app(undefined, undefined, undefined, { mgr });
  const r = await a.request("/api/open-progress?folder=games&project=games&repo=game_main");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ progress: { step: "clone", clone: { phase: "Receiving objects", percent: 7 } } });
  expect(asked).toEqual([{ folder: "games", project: "games", repo: "game_main" }]);
  expect((await a.request("/api/open-progress?folder=..&project=x&repo=y")).status).toBe(400);
});

test("GET /api/usage: the response is compressed (compress middleware sits before the route)", async () => {
  const { a, db } = app();
  const now = Date.now();
  // a few hundred samples so the response crosses the compression threshold (1 kB)
  for (let i = 0; i < 300; i++) recordWeeklyUsage(db, "codex", "default", "Main", "org-a", now - i * 60_000, [{ window: "weekly", percentUsed: i % 100, resetsAt: now + 86_400_000 }]);
  const r = await a.request(`/api/usage?from=${now - 86_400_000}&to=${now}`, { headers: { "Accept-Encoding": "gzip" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-encoding")).toBe("gzip");
});
