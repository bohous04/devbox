import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../devd/src/api";
import { CloneQueue } from "../../devd/src/clone";
import { DEFAULT_CONFIG } from "../../devd/src/config";
import { openDb } from "../../devd/src/db";
import { SessionManager } from "../../devd/src/sessions";
import type { TreeProject } from "../../devd/src/tree";
import { ApiClient } from "../src/api";
import { loadCatalog } from "../../devd/src/prodDb";
import { createProposal } from "../../devd/src/prodWrites";

const db = openDb(":memory:");
const root = mkdtempSync(join(tmpdir(), "cli-api-"));
const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], controlRoot: join(root, "ctl") });
const tree = async (): Promise<TreeProject[]> => [{ folder: "acme", project: "shop", repos: [{ name: "cms", cloneUrl: "https://x/cms.git", provider: "github", cloned: false }] }];
// Stubbed cloneBare/fetchRepo — keeps the round-trip test fast and offline (no real network).
const cloneQueue = new CloneQueue({ db, root, tree, cloneBare: async (_url, dest) => { mkdirSync(dest, { recursive: true }); }, fetchRepo: () => {} });
const app = createApp({
  mgr, db, cfg: DEFAULT_CONFIG, root, remoteAddr: () => "127.0.0.1",
  tree,
  listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} }, notify: () => {},
  stats: () => ({}),
  cloneQueue,
  configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
  backup: { build: async () => "/tmp/x", restore: async () => {} },
  prodCatalog: loadCatalog(join(import.meta.dir, "..", "..", "image", "prod-db", "catalog.json")),
  prodDbAccess: { x: { read: ["ledger_app"], write: ["ledger_app"] } },
  execProdWrite: async () => ({ rows: 1, note: "1 row written" }),
});
const server = Bun.serve({ port: 0, fetch: app.fetch });
const api = new ApiClient(`http://127.0.0.1:${server.port}`);
afterAll(() => server.stop(true));

test("health and tree round-trip", async () => {
  expect((await api.health()).ok).toBe(true);
  const tree = await api.tree();
  expect(tree[0].repos[0].name).toBe("cms");
});

test("prod writes: list → approve → executed; reject (CLI client round-trip)", async () => {
  const id = createProposal(db, { session: "dev-x", db: "ledger_app", sql: "update t set a=1" });
  expect((await api.prodWrites("pending")).some((w) => w.id === id)).toBe(true);
  expect((await api.prodWriteApprove(id)).note).toContain("row");
  expect((await api.prodWrites("pending")).some((w) => w.id === id)).toBe(false);
  expect((await api.prodWrite(id)).status).toBe("executed");

  const id2 = createProposal(db, { session: "dev-x", db: "ledger_app", sql: "delete from t" });
  await api.prodWriteReject(id2);
  expect((await api.prodWrite(id2)).status).toBe("rejected");
});

test("sessions empty; end unknown session throws server error message", async () => {
  expect(await api.sessions()).toEqual([]);
  await expect(api.end("nope")).rejects.toThrow(/nope/);
});

test("restart unknown session throws server error message (404 → RestartError)", async () => {
  await expect(api.restart("nope")).rejects.toThrow(/nope/);
});

test("clone endpoint returns jobId; job() polls it through to done", async () => {
  const { jobId } = await api.clone({ scope: "all" });
  expect(jobId).toBeTruthy();
  let job = await api.job(jobId);
  while (job.status === "running") job = await api.job(jobId);
  expect(job.status).toBe("done");
  expect(job.total).toBe(1);
  expect(job.done).toBe(1);
});

test("job() rejects for an unknown id with a 404 error message", async () => {
  await expect(api.job("nope")).rejects.toThrow(/unknown job/);
});

test("sessions({ tmux: true }) calls /api/sessions?tmux=1, no param plain /api/sessions", async () => {
  const seen: string[] = [];
  const srv = Bun.serve({ port: 0, fetch: (req) => {
    const u = new URL(req.url);
    seen.push(u.pathname + u.search);
    return Response.json([]);
  } });
  const client = new ApiClient(`http://127.0.0.1:${srv.port}`);
  await client.sessions();
  await client.sessions({ tmux: true });
  srv.stop(true);
  expect(seen).toEqual(["/api/sessions", "/api/sessions?tmux=1"]);
});

test("backup downloads real file bytes; restore posts bytes through to the deps callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-api-backup-"));
  const backupFile = join(dir, "backup.tgz");
  writeFileSync(backupFile, "hello-backup");
  let restoredPath: string | undefined;
  let restoredBytes: Buffer | undefined;
  const backupApp = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, remoteAddr: () => "127.0.0.1", tree,
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} }, notify: () => {},
    stats: () => ({}),
    cloneQueue,
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: {
      build: async () => backupFile,
      restore: async (p: string) => { restoredPath = p; restoredBytes = readFileSync(p); },
    },
  });
  const backupServer = Bun.serve({ port: 0, fetch: backupApp.fetch });
  const backupApi = new ApiClient(`http://127.0.0.1:${backupServer.port}`);
  try {
    const bytes = await backupApi.backup();
    expect(new TextDecoder().decode(bytes)).toBe("hello-backup");

    await backupApi.restore(new TextEncoder().encode("restored-content"));
    expect(restoredPath).toBeTruthy();
    expect(restoredBytes?.toString()).toBe("restored-content");
  } finally {
    backupServer.stop(true);
  }
});

test("backup surfaces a build() failure as a 500 error message", async () => {
  const failApp = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, remoteAddr: () => "127.0.0.1", tree,
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} }, notify: () => {},
    stats: () => ({}),
    cloneQueue,
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: {
      build: () => { throw new Error("backup failed: disk full"); },
      restore: async () => {},
    },
  });
  const failServer = Bun.serve({ port: 0, fetch: failApp.fetch });
  const failApi = new ApiClient(`http://127.0.0.1:${failServer.port}`);
  try {
    await expect(failApi.backup()).rejects.toThrow(/disk full/);
  } finally {
    failServer.stop(true);
  }
});

// Review (fix 2): placement() is only a hint in openAndAttach ("VPS is busy, consider
// --instabox") and the caller swallows it (.catch(() => null)) — but without a timeout a
// hung/slow devd would leave `dev <repo>` stuck on the hint before the session even gets
// opened. A server that never answers /api/placement simulates exactly this case;
// placement() must give up after about 2 s, not hang forever.
test("placement(): timeouts around 2s, so a hung devd never blocks the open flow on the hint", async () => {
  const hangServer = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const hangApi = new ApiClient(`http://127.0.0.1:${hangServer.port}`);
  const start = Date.now();
  try {
    await expect(hangApi.placement()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  } finally {
    hangServer.stop(true);
  }
});
