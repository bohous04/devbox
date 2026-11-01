import { expect, test } from "bun:test";
import postgres from "postgres";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/api";
import { fakeDeps, fakeVault } from "./helpers/apiHarness";
import { createDbTargets } from "../src/dbTargets";
import { startDbProxy } from "../src/dbProxy";
import { createPgConnect } from "../src/pgConnect";
import { loadCatalog } from "../src/prodDb";
import { onboardingRoleSql, onboardingVerifySql, onboardingWriteVerifySql } from "../src/dbOnboardingScripts";
import { executeWrite } from "../src/prodWrites";
import { createOperationExec, prepareCoolifyDeployment } from "../src/operationExec";
import type { RequestView } from "../src/dbOnboarding";

// Explicit opt-in: only a synthetic localhost PostgreSQL cluster. This test never
// reads production URLs, catalogs, secrets or SSH config. 1Password/SSH/Coolify
// transports are simulated; SQL grants, login, migration and denial are real.
const port = Number(process.env.DEVD_TEST_PG_PORT ?? 0);
const integration = port ? test : test.skip;
integration("isolated PostgreSQL: unknown DB -> onboarding -> RO verification -> separate DDL approval -> exact-commit POST deploy continuation", async () => {
  if (port < 49152 || port > 65535) throw Error("Use an isolated PostgreSQL high port");
  const name = `devd_e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, owner = `${name}_owner`;
  const admin = postgres({ host: "/tmp", port, username: "fixture_admin", database: "postgres", max: 1, prepare: false, onnotice: () => {} });
  let dbAdmin: ReturnType<typeof postgres> | undefined;
  const password = "Synthetic-Integration-Only-927abz";
  const roles = [`${name}_ro`, `${name}_rw`, `${name}_migration`, owner];
  const root = mkdtempSync(join(tmpdir(), "devd-full-onboarding-")), path = join(root, "catalog.json");
  writeFileSync(path, JSON.stringify({ servers: { isolated: { host: "192.0.2.55", port: 2222, user: "main", key: "prod-tunnel-isolated" } }, databases: [] }));
  const catalog = loadCatalog(path);
  const candidate = { id: "isolated:pgtest", instance: "isolated", server: "isolated", container: "pgtest", uuid: "pgtest", engine: "postgres" as const, name: `${name}-db`, db: name, environment: "isolated", matched: true, verified: true, status: "running" };
  let setups = 0, validations = 0, sqlExecutions = 0, deploys = 0, pinned = "HEAD";
  const sha = "e0c38dcb85f37828e380ce6891a52568a9893ede"; // inert commit label in fake Coolify, never production
  const methods: string[] = [];
  const operationDeps = {
    coolify: () => undefined,
    coolifyInstances: () => ({ isolated: { name: "isolated", url: "http://isolated.invalid", token: "synthetic", headers: {} } }),
    fetch: async (req: Request) => {
      const url = new URL(req.url); methods.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/api/v1/applications/apptest") {
        if (req.method === "PATCH") pinned = (await req.json() as { git_commit_sha: string }).git_commit_sha;
        return Response.json({ uuid: "apptest", git_commit_sha: pinned });
      }
      if (url.pathname === "/api/v1/deploy" && req.method === "POST") { expect(await req.json()).toEqual({ uuid: "apptest" }); deploys++; return Response.json({ deployments: [{ resource_uuid: "apptest", deployment_uuid: "queuedtest" }] }); }
      if (url.pathname === "/api/v1/deployments/queuedtest") return Response.json({ commit: pinned });
      return new Response("Unexpected isolated request", { status: 400 });
    },
  };
  const targets = createDbTargets({ entries: () => catalog.databases });
  const pgConnect = createPgConnect();
  const proxy = await startDbProxy({ port: 0, hostname: "127.0.0.1", targets, vault: fakeVault({ locked: false }), readSecret: () => password,
    connect: (target, secret, onData, onEnd) => pgConnect({ ...target, entry: { ...target.entry, hostPort: port } }, secret, onData, onEnd),
  });
  const d = fakeDeps({ prodCatalog: catalog, prodCatalogPath: path, prodAccessPath: join(root, "access.json"), prodDbAccess: {},
    dbTargets: targets, dbProxyHost: `127.0.0.1:${proxy.port}`, dbProxyReady: () => true, discoverDbTargets: async () => ({ candidates: [candidate], blocks: [] }),
    dbOnboardingHost: {
      preflight: async () => [],
      execute: async (plan) => { setups++; await dbAdmin!.unsafe(onboardingRoleSql(plan, Object.fromEntries(roles.map(r => [r, password])))); },
      verify: async (plan) => {
        for (const [role, query] of [[plan.entry.roUser, onboardingVerifySql(plan)], [plan.entry.rwUser!, onboardingWriteVerifySql(plan, plan.entry.rwUser!, false)], [plan.entry.migrationUser!, onboardingWriteVerifySql(plan, plan.entry.migrationUser!, true)]]) {
          const sql = postgres({ host: "127.0.0.1", port, database: name, username: role, password, max: 1, prepare: false, onnotice: () => {} });
          try { expect((await sql.unsafe(query!))[0]!.verified).toBe(true); } finally { await sql.end(); }
        }
        validations++;
      },
    },
    execProdWrite: async ({ entry, server, sql, preview, scope }) => { sqlExecutions++; return executeWrite({ ...entry, hostPort: port }, server, "", password, sql, { preview, scope, ensureTunnel: async () => {} }); },
    prepareDeployment: (params) => prepareCoolifyDeployment(operationDeps, params), execOperation: createOperationExec(operationDeps),
  });
  const app = createApp(d), headers = { "content-type": "application/json", "x-devbox-session": "dev-test-deploy" };
  const post = (body: unknown = {}) => ({ method: "POST", headers, body: JSON.stringify(body) });
  const get = async (path: string) => await (await app.request(path, { headers })).json() as any;
  const waitFor = async (path: string, key: string, value: string) => { for (let n = 0; n < 250; n++) { const result = await get(path); if (result[key] === value) return result; if (result[key] === "failed") throw Error(JSON.stringify(result)); await Bun.sleep(20); } throw Error(`Timeout ${path}`); };
  try {
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN`);
    await admin.unsafe(`CREATE DATABASE ${name} OWNER ${owner}`);
    dbAdmin = postgres({ host: "/tmp", port, username: "fixture_admin", database: name, max: 1, prepare: false, onnotice: () => {} });
    await dbAdmin.unsafe(`SET ROLE ${owner}; CREATE TABLE invoices(id integer PRIMARY KEY); RESET ROLE`);
    const sql = "ALTER TABLE invoices ADD COLUMN cash_reserve_amount numeric NULL; CREATE TABLE cash_deposits(id integer PRIMARY KEY, amount numeric NOT NULL)";
    const writeRes = await app.request(`/api/prod-db/${name}/write`, post({ sql, scope: "migration", idempotencyKey: `${name}-0011` }));
    expect(writeRes.status).toBe(202); const write = await writeRes.json() as any; expect(write.status).toBe("blocked");
    const prepared = await (await app.request(`/api/prod-db/requests/${write.requestId}/prepare`, post())).json() as RequestView;
    expect(prepared.state).toBe("awaiting_approval"); expect(prepared.plan!.migrations).toBe(true);
    const deployment = await (await app.request("/api/operations", post({ op: "deploy", params: { instance: "isolated", application: "apptest", commit: sha, afterWrite: String(write.id) } }))).json() as any;
    expect(deployment.status).toBe("approved");
    expect(deploys).toBe(0);
    await app.request(`/api/operations/${prepared.operationId}/approve`, post());
    await waitFor(`/api/prod-db/requests/${write.requestId}`, "state", "ready");
    expect(setups).toBe(1); expect(validations).toBe(1); expect(sqlExecutions).toBe(0);
    const live = await app.request(`/api/prod-db/${name}/url`, { headers }); expect(live.status).toBe(200);
    const proxyUrl = await live.text(); expect(proxyUrl).not.toContain(password);
    const viaProxy = postgres(proxyUrl, { max: 1, prepare: false, connect_timeout: 3 });
    try {
      expect((await viaProxy.unsafe("SELECT current_user AS role"))[0]!.role).toBe(`${name}_ro`);
      // postgres.js Query is lazy: Bun expect.rejects does not start the Promise subclass.
      await expect(viaProxy.unsafe("INSERT INTO invoices(id) VALUES(91)").execute()).rejects.toMatchObject({ code: "25006" });
    } finally { await viaProxy.end({ timeout: 1 }); }
    await app.request(`/api/prod-db/writes/${write.id}/preview`, { headers }); expect(sqlExecutions).toBe(0);
    expect((await app.request(`/api/prod-db/writes/${write.id}/approve`, post())).status).toBe(200);
    expect((await dbAdmin.unsafe("SELECT column_name FROM information_schema.columns WHERE table_name='invoices' AND column_name='cash_reserve_amount'")).length).toBe(1);
    expect((await dbAdmin.unsafe("SELECT to_regclass('public.cash_deposits') IS NOT NULL AS created"))[0]!.created).toBe(true);
    await waitFor(`/api/operations/${deployment.id}`, "status", "executed"); expect(deploys).toBe(1); expect(methods).toContain("POST /api/v1/deploy"); expect(pinned).toBe(sha);
    const again = await (await app.request(`/api/prod-db/${name}/write`, post({ sql, scope: "migration", idempotencyKey: `${name}-0011` }))).json() as any;
    expect(again.id).toBe(write.id); expect(again.status).toBe("executed");
    expect((await app.request(`/api/prod-db/writes/${write.id}/approve`, post())).status).toBe(409); expect(sqlExecutions).toBe(1);
    const dml = await (await app.request(`/api/prod-db/${name}/write`, post({ sql: "ALTER TABLE invoices ADD COLUMN forbidden integer", scope: "dml" }))).json() as any;
    const denied = await app.request(`/api/prod-db/writes/${dml.id}/approve`, post()); expect(denied.status).toBe(502); expect(await denied.text()).toContain("write_permission_denied");
  } finally {
    proxy.stop();
    await dbAdmin?.end(); await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (const role of roles) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}, 20_000);
