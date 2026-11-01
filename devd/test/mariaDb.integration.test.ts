import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createApp } from "../src/api";
import { fakeDeps } from "./helpers/apiHarness";
import type { Catalog } from "../src/prodDb";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createConnection } from "mysql2/promise";
import { mariaRoleSql, verifyMariaRole, mariaRoleScript, mariaInspectionCommand } from "../src/mariaDbOnboarding";
import { startMysqlProxy } from "../src/mysqlProxy";
import { createDbTargets } from "../src/dbTargets";
import { executeWrite } from "../src/prodWrites";
import type { OnboardingPlan } from "../src/dbOnboarding";

const port = Number(process.env.DEVD_TEST_MARIA_PORT ?? 0);
const integration = port ? test : test.skip;
integration("isolated MariaDB roles, proxy, prepared queries, scoped writes, retries and denial", async () => {
  if (port < 49152 || port > 65535) throw Error("Use an isolated localhost high port");
  const name = "devd_maria_" + crypto.randomUUID().replaceAll("-", "").slice(0,8);
  const password = "Synthetic-Integration-927abz";
  const admin = await createConnection({ host: "127.0.0.1", port, user: "root", password, multipleStatements: true });
  const entry = { name, server: "fixture", container: "devd-mariadb-fixture-20260918", engine: "mariadb" as const, hostPort: port, db: name,
    roUser: name + "_ro", opItem: "ro", rwUser: name + "_rw", rwOpItem: "rw", migrationUser: name + "_ddl", migrationOpItem: "ddl" };
  const p = { entry, input: { container: entry.container } } as OnboardingPlan;
  const scratch = mkdtempSync(join(tmpdir(), "devd-maria-shell-"));
  const targets = createDbTargets({ entries: () => [entry] });
  let locked = false, reads = 0;
  const proxy = await startMysqlProxy({ port: 0, hostname: "127.0.0.1", targets, vault: { isLocked: () => locked },
    readSecret: () => { reads++; return password; }, ensureTunnel: async () => {} });
  const login = (creds: { user: string; password: string }) => createConnection({ host: "127.0.0.1", port: proxy.port, database: name, ...creds, connectTimeout: 3000, multipleStatements: true });
  try {
    await admin.query(`CREATE DATABASE \`${name}\`; CREATE TABLE \`${name}\`.items(id INT PRIMARY KEY, label TEXT); INSERT INTO \`${name}\`.items VALUES(1,'fixture'); CREATE DATABASE \`${name.replaceAll('_','x')}\`; CREATE TABLE \`${name.replaceAll('_','x')}\`.private_data(id INT)`);
    // Run the real host account scripts against only this isolated Docker DB.
    const shell = async (script: string) => {
      const process = Bun.spawn(["bash"], { stdin: new Blob([script.replaceAll("/var/lib/devd-db-roles", scratch + "/roles").replaceAll("/run/lock/devd-db-onboarding.lock", scratch + "/lock")]), stdout: "pipe", stderr: "pipe" });
      const [code, output] = await Promise.all([process.exited, new Response(process.stdout).text()]);
      expect(code).toBe(0); return output;
    };
    const provision = mariaRoleScript(p,Object.fromEntries([entry.roUser,entry.rwUser,entry.migrationUser].map(role => [role,password])));
    await shell(provision); await shell(provision);
    const inspection = await shell(mariaInspectionCommand(p));
    expect(JSON.parse(inspection.trim().slice("DATABASE=".length)).roles.every((r: any) => r.managed)).toBe(true);
    for (const role of [entry.roUser, entry.rwUser, entry.migrationUser]) {
      await admin.query(mariaRoleSql(p, role, password));
      await admin.query(mariaRoleSql(p, role, password)); // same account/password retries
      await verifyMariaRole(p, role, password, port);
      await expect(admin.query(mariaRoleSql(p,role,"different-password"))).rejects.toMatchObject({ sqlState: "45000" });
    }
    const creds = targets.issue("fixture", name);
    const c = await login(creds);
    try {
      const [rows] = await c.query<any[]>("SELECT CURRENT_USER() AS account, label FROM items");
      expect(rows[0]?.account).toBe(entry.roUser + "@%"); expect(rows[0]?.label).toBe("fixture");
      const [prepared] = await c.execute<any[]>("SELECT label FROM items WHERE id=?", [1]);
      expect(prepared[0]?.label).toBe("fixture");
      const [multi] = await c.query<any[]>("SELECT 1 AS a; SELECT 2 AS b"); expect(multi).toHaveLength(2);
      await expect(c.query("INSERT INTO items VALUES(2,'denied')")).rejects.toMatchObject({ errno: 1142 });
      await expect(c.query("CREATE TABLE forbidden(id INT)")).rejects.toMatchObject({ errno: 1142 });
      await expect(c.query(`SELECT * FROM \`${name.replaceAll('_','x')}\`.private_data`)).rejects.toMatchObject({ errno: 1142 });
    } finally { await c.end(); }
    const cli = Bun.spawn(["docker", "run", "--rm", "--network", "host", "-e", "MYSQL_PWD=" + creds.password, "mariadb:11.4", "mariadb", "--skip-ssl", "-h127.0.0.1", "-P" + proxy.port, "-u" + creds.user, name, "-N", "-e", "SELECT label FROM items WHERE id=1"], { stdout: "pipe", stderr: "pipe" });
    expect(await cli.exited).toBe(0); expect((await new Response(cli.stdout).text()).trim()).toBe("fixture");
    const before = reads;
    await expect(login({ ...creds, password: "wrong" })).rejects.toBeDefined(); expect(reads).toBe(before);
    locked = true; await expect(login(creds)).rejects.toBeDefined(); locked = false;
    targets.revoke("fixture"); await expect(login(creds)).rejects.toBeDefined();
    const server = { host: "unused", port: 22, user: "unused", key: "unused" };
    const opts = { ensureTunnel: async () => {} };
    expect((await executeWrite(entry,server,"",password,"INSERT INTO items VALUES(2,'approved')",opts)).rows).toBe(1);
    await expect(executeWrite(entry,server,"",password,"CREATE TABLE denied_ddl(id INT)",opts)).rejects.toThrow("database_write_failed");
    await executeWrite(entry,server,"",password,"CREATE TABLE approved_ddl(id INT)",{...opts,scope:"migration"});
    await expect(executeWrite(entry,server,"",password,"INSERT INTO items VALUES(3,'preview')",{...opts,preview:true})).rejects.toThrow("static_only");
    const [count] = await admin.query<any[]>(`SELECT COUNT(*) AS n FROM \`${name}\`.items`); expect(count[0]?.n).toBe(2);
    // Extra role/global privileges must not pass verification.
    await admin.query(`GRANT PROCESS ON *.* TO '${entry.roUser}'@'%'`);
    await expect(verifyMariaRole(p,entry.roUser,password,port)).rejects.toThrow("unexpected role privileges");
  } finally {
    proxy.stop();
    rmSync(scratch, { recursive: true, force: true });
    for (const user of [entry.roUser,entry.rwUser,entry.migrationUser]) await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\`; DROP DATABASE IF EXISTS \`${name.replaceAll('_','x')}\``);
    await admin.end();
  }
}, 30000);

integration("MariaDB API prepares access but only explicit SQL approval executes the saved proposal", async () => {
  if (port < 49152 || port > 65535) throw Error("isolated port required");
  const name = "devd_api_" + crypto.randomUUID().replaceAll("-", "").slice(0,8), password = "Synthetic-Integration-927abz";
  const admin = await createConnection({ host: "127.0.0.1", port, user: "root", password, multipleStatements: true });
  const root = mkdtempSync(join(tmpdir(),"devd-maria-api-")), path = join(root,"catalog.json");
  const catalog: Catalog = { servers: { fixture: { host: "192.0.2.1", port: 22, user: "main", key: "prod-tunnel-fixture" } }, databases: [] };
  writeFileSync(path,JSON.stringify(catalog));
  let executions = 0;
  const targets = createDbTargets({ entries: () => catalog.databases });
  const proxy = await startMysqlProxy({ hostname: "127.0.0.1", port: 0, targets, vault: { isLocked: () => false }, readSecret: () => password, ensureTunnel: async target => { target.entry.hostPort = port; } });
  const d = fakeDeps({ prodCatalog: catalog, prodCatalogPath: path, prodAccessPath: join(root,"access.json"), prodDbAccess: {}, dbTargets: targets,
    mysqlProxyHost: `127.0.0.1:${proxy.port}`, mysqlProxyReady: () => true, dbProxyReady: () => false,
    discoverDbTargets: async () => ({ candidates: [{ id: "fixture:isolated", instance: "fixture", server: "fixture", container: "isolated", uuid: "isolated", engine: "mariadb", name, db: name, environment: "test", matched: true, verified: true, status: "running" }], blocks: [] }),
    dbOnboardingHost: { preflight: async () => [], execute: async p => {
      for (const role of [p.entry.roUser,p.entry.rwUser!]) await admin.query(mariaRoleSql(p,role,password));
    }, verify: async p => { for (const role of [p.entry.roUser,p.entry.rwUser!]) await verifyMariaRole(p,role,password,port); } },
    execProdWrite: async ({ entry, server, sql, scope }) => { executions++; return executeWrite({...entry,hostPort:port},server,"",password,sql,{scope,ensureTunnel:async()=>{}}); },
  });
  const app = createApp(d), headers = { "content-type": "application/json", "x-devbox-session": "dev-test-maria" };
  const post = (body = {}) => ({ method: "POST", headers, body: JSON.stringify(body) });
  const get = async (route: string) => await (await app.request(route,{headers})).json() as any;
  try {
    await admin.query(`CREATE DATABASE \`${name}\`; CREATE TABLE \`${name}\`.items(id INT PRIMARY KEY)`);
    const write = await (await app.request(`/api/prod-db/${name}/write`,post({sql:"INSERT INTO items VALUES(1)"}))).json() as any;
    expect(write.status).toBe("blocked");
    await app.request(`/api/prod-db/requests/${write.requestId}/prepare`,post());
    for (let n=0;n<100;n++) { const r=await get(`/api/prod-db/requests/${write.requestId}`); if(r.state==="ready") break; if(r.state==="failed") throw Error(JSON.stringify(r.blocks)); await Bun.sleep(10); }
    expect((await get(`/api/prod-db/requests/${write.requestId}`)).state).toBe("ready");
    expect(executions).toBe(0);
    const url = await (await app.request(`/api/prod-db/${name}/url`,{headers})).text();
    expect(url).toStartWith("mysql://"); expect(url).not.toContain(password);
    const c = await createConnection(url); await c.query("SELECT 1"); await c.end();
    expect((await get(`/api/prod-db/writes/${write.id}`)).status).toBe("pending");
    await get(`/api/prod-db/writes/${write.id}/preview`); expect(executions).toBe(0);
    expect((await app.request(`/api/prod-db/writes/${write.id}/approve`,post())).status).toBe(200);
    expect(executions).toBe(1);
    expect((await app.request(`/api/prod-db/writes/${write.id}/approve`,post())).status).toBe(409);
    expect(executions).toBe(1);
    const [rows] = await admin.query<any[]>(`SELECT COUNT(*) AS n FROM \`${name}\`.items`); expect(rows[0].n).toBe(1);
    d.mysqlProxyReady = () => false;
    expect((await app.request(`/api/prod-db/${name}/url`,{headers})).status).toBe(503);
  } finally {
    proxy.stop();
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\`; DROP USER IF EXISTS '${name}_ro'@'%','${name}_rw'@'%'`);
    await admin.end(); rmSync(root,{recursive:true,force:true});
  }
},30000);
