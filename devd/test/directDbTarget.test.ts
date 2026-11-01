import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { createDbRequest } from "../src/dbRequests";
import { createDbOnboarding, type OnboardingPlan } from "../src/dbOnboarding";
import { createDbOnboardingHost, type HostDeps } from "../src/dbOnboardingHost";
import { mariaRoleSql } from "../src/mariaDbOnboarding";
import { mysqlPasswordHash } from "../src/mysqlAuth";
import { keysForProject, type Catalog, type ServerRef } from "../src/prodDb";
import { createTunnelPool, startDirectRelay } from "../src/tunnelPool";

// Direct server: MariaDB reachable over TCP without SSH/Docker (e.g. a native game DB).
const direct: ServerRef = { kind: "direct", host: "192.0.2.80", port: 3306, user: "", key: "", adminOpItem: "prod-admin game", opVault: "vault" };

test("catalog: a direct server gives the session no SSH key", () => {
  const cat: Catalog = { servers: { game: direct, ssh: { host: "192.0.2.1", port: 22, user: "t", key: "prod-tunnel-ssh" } },
    databases: [{ name: "game_db", server: "game", engine: "mariadb", hostPort: 15600, db: "game_db", roUser: "game_db_ro", opItem: "x" },
      { name: "app", server: "ssh", engine: "postgres", hostPort: 15601, db: "app", roUser: "app_ro", opItem: "y" }] };
  expect(keysForProject(cat, { p: { read: ["game_db", "app"] } }, "p")).toEqual(["prod-tunnel-ssh"]);
});

test("tunnel pool: a direct server starts a local relay instead of ssh", async () => {
  const spawned: string[][] = [], relays: [number, string, number][] = [];
  let closed = 0;
  const pool = createTunnelPool({ keyPath: () => "/tmp/k", portFree: async () => true,
    spawn: (argv) => { spawned.push(argv); return { kill() {}, exited: new Promise<number>(() => {}) }; },
    directRelay: async (port, t) => { relays.push([port, t.host, t.port]); return { close: () => { closed++; } }; } });
  await pool.ensure(direct, 15600);
  await pool.ensure(direct, 15600);
  expect(spawned).toHaveLength(0);
  expect(relays).toEqual([[15600, "192.0.2.80", 3306]]);
  expect(pool.owns(direct, 15600)).toBe(true);
  pool.stopAll();
  expect(closed).toBe(1);
});

test("the relay forwards bytes upstream and listens only on loopback", async () => {
  const upstream = createServer((s) => s.on("data", (d: Buffer) => s.write(Buffer.concat([Buffer.from("echo:"), d]))));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const local = (probe.address() as { port: number }).port; await new Promise<void>((r) => probe.close(() => r()));
  const relay = await startDirectRelay(local, { host: "127.0.0.1", port: upstreamPort });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: "127.0.0.1", port: local }, () => c.write("ping"));
      c.on("data", (d) => { resolve(d.toString()); c.destroy(); }); c.on("error", reject);
    });
    expect(reply).toBe("echo:ping");
  } finally { relay.close(); upstream.close(); }
});

test("mariaRoleSql binds the account to the given host, not to '%'", () => {
  const p = { entry: { name: "g", server: "game", engine: "mariadb", hostPort: 15600, db: "game_db", roUser: "game_db_ro", opItem: "x" } } as OnboardingPlan;
  const sql = mariaRoleSql(p, "game_db_ro", "pw", "203.0.113.7");
  expect(sql).toContain("CREATE USER 'game_db_ro'@'203.0.113.7'");
  expect(sql).toContain("GRANT SELECT ON `game\\_db`.* TO 'game_db_ro'@'203.0.113.7'");
  expect(sql).not.toContain("@'%'");
  expect(() => mariaRoleSql(p, "game_db_ro", "pw", "x'; DROP")).toThrow("invalid account host");
});

function onboardingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "direct-onboarding-"));
  const catalogPath = join(dir, "catalog.json");
  const catalog: Catalog = { servers: { game: direct }, databases: [] };
  writeFileSync(catalogPath, JSON.stringify(catalog));
  let discovered = 0; const preflighted: OnboardingPlan[] = [];
  const db = openDb(join(dir, "devd.sqlite"));
  const on = createDbOnboarding({ db, catalog, catalogPath, access: {}, accessPath: join(dir, "access.json"), proxyReady: () => true, portFree: async () => true,
    host: { preflight: async (p) => { preflighted.push(p); return []; }, execute: async () => {}, verify: async () => {} },
    discover: async () => { discovered++; return { candidates: [], blocks: [{ code: "server_mapping", category: "configuration", message: "noise", action: "x" }] }; } });
  return { db, on, preflighted, get discovered() { return discovered; }, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("onboarding: a direct server skips discovery and prepares a migration without a container", async () => {
  const f = onboardingFixture();
  try {
    const id = createDbRequest(f.db, { session: "s", project: "games-game", wanted: "game_db", why: "migration", scope: "migration" });
    const v = await f.on.prepare(id, { server: "game" });
    expect(f.discovered).toBe(0);
    expect(v.blocks).toEqual([]);
    expect(v.state).toBe("awaiting_approval");
    const e = v.plan!.entry;
    expect(e).toMatchObject({ server: "game", engine: "mariadb", db: "game_db", roUser: "game_db_ro", rwUser: "game_db_rw", migrationUser: "game_db_migration" });
    expect(e.container).toBeUndefined();
    expect(e.tunnelUser).toBeUndefined();
    expect(v.plan!.trustedServer.kind).toBe("direct");
  } finally { f.cleanup(); }
});

test("onboarding: a direct server rejects postgres", async () => {
  const f = onboardingFixture();
  try {
    const id = createDbRequest(f.db, { session: "s", project: "p", wanted: "game_pg", why: "read" });
    const v = await f.on.prepare(id, { server: "game", engine: "postgres" });
    expect(v.state).toBe("blocked");
    expect(v.blocks.map((b) => b.code)).toEqual(["unsupported_engine"]);
    expect(f.preflighted).toHaveLength(0);
  } finally { f.cleanup(); }
});

function directPlan(): OnboardingPlan {
  const entry = { name: "game_db", server: "game", engine: "mariadb" as const, db: "game_db", hostPort: 15600, roUser: "game_db_ro", opItem: "prod-ro game_db", rwUser: "game_db_rw", rwOpItem: "prod-rw game_db" };
  return { requestId: 1, entry, input: { sshAlias: "", container: "", engine: "mariadb", db: "game_db", hostPort: 15600, roUser: entry.roUser, opItem: entry.opItem, opVault: "vault" },
    trustedServer: { ...direct }, server: { ...direct }, write: true, migrations: false, changes: [], fingerprint: "f" };
}

function hostHarness(over: Partial<HostDeps> = {}, accounts: { user: string; host: string; hash: string }[] = []) {
  const items = [{ id: "admin", title: "prod-admin game", category: "LOGIN", vault: { id: "vault", name: "vault" } }];
  const secrets = new Map<string, string>([["admin/username", "admin-user"], ["admin/password", "ADMIN-SECRET"]]);
  const queries: string[] = [], logins: string[] = []; let creates = 0;
  const deps: HostDeps = {
    token: () => "TOKEN", catalog: () => ({ servers: { game: direct }, databases: [] }), proxyReady: () => true, portFree: async () => true,
    canCreateItems: async () => true, egressHost: "203.0.113.7",
    run: async (cmd) => {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
      if (cmd[1] === "item" && cmd[2] === "list") return ok(JSON.stringify(items));
      if (cmd[1] === "read") { const [, , , id, field] = cmd[2]!.split("/"); return ok(secrets.get(`${id}/${field}`) ?? ""); }
      if (cmd[1] === "item" && cmd[2] === "create") {
        const id = `i${++creates}`; items.push({ id, title: cmd[cmd.indexOf("--title") + 1]!, category: "PASSWORD", vault: { id: "vault", name: "vault" } });
        secrets.set(`${id}/password`, `role-pw-${creates}`); return ok("{}");
      }
      throw new Error("unexpected " + cmd.join(" "));
    },
    connectMaria: async (o) => {
      logins.push(`${o.user}@${o.host}:${o.port}`);
      return { end: async () => {}, query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("SELECT SCHEMA_NAME")) return [[{ SCHEMA_NAME: "game_db" }]];
        if (sql.startsWith("SHOW GRANTS")) return [[{ g: "GRANT ALL PRIVILEGES ON *.* TO `admin-user`@`%` WITH GRANT OPTION" }]];
        if (sql.includes("FROM mysql.user")) return [accounts];
        return [{}];
      } } as never;
    },
    ...over,
  };
  return { host: createDbOnboardingHost(deps), queries, logins, secrets, items };
}

test("direct executor: without DEVD_EGRESS_IP it does nothing and returns a block", async () => {
  const f = hostHarness({ egressHost: undefined });
  const blocks = await f.host.preflight(directPlan());
  expect(blocks.map((b) => b.code)).toContain("direct_egress_unknown");
  expect(f.logins).toHaveLength(0);
});

test("direct executor: creates roles bound to the egress IP and never leaks the admin password", async () => {
  const f = hostHarness();
  expect(await f.host.preflight(directPlan())).toEqual([]);
  const steps: string[] = [];
  await f.host.execute(directPlan(), (s) => steps.push(s));
  expect(f.logins.every((l) => l === "admin-user@192.0.2.80:3306")).toBe(true);
  const roleSql = f.queries.filter((q) => q.startsWith("BEGIN NOT ATOMIC"));
  expect(roleSql).toHaveLength(2);
  expect(roleSql[0]).toContain("'game_db_ro'@'203.0.113.7'");
  expect(roleSql[1]).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON `game\\_db`.* TO 'game_db_rw'@'203.0.113.7'");
  expect(JSON.stringify(f.queries)).not.toContain("ADMIN-SECRET");
  expect(steps).toEqual(["1password_items", "database_roles", "database_roles_ready"]);
});

test("direct executor: a foreign account with the same name blocks", async () => {
  const f = hostHarness({}, [{ user: "game_db_ro", host: "%", hash: "*FOREIGN" }]);
  const blocks = await f.host.preflight(directPlan());
  expect(blocks.map((b) => b.code)).toContain("role_conflict");
});

test("direct executor: its own account from an earlier attempt does not block a retry", async () => {
  const f = hostHarness({}, [{ user: "game_db_ro", host: "203.0.113.7", hash: mysqlPasswordHash("stored-pw") }]);
  f.items.push({ id: "ro", title: "prod-ro game_db", category: "PASSWORD", vault: { id: "vault", name: "vault" } });
  f.secrets.set("ro/password", "stored-pw");
  expect(await f.host.preflight(directPlan())).toEqual([]);
});

test("direct executor: an unreachable server = connection block without the exception text", async () => {
  const f = hostHarness({ connectMaria: async () => { throw Object.assign(new Error("connect ETIMEDOUT secret-detail"), { code: "ETIMEDOUT" }); } });
  const blocks = await f.host.preflight(directPlan());
  expect(blocks.map((b) => [b.code, b.category])).toContainEqual(["direct_unreachable", "connection"]);
  expect(JSON.stringify(blocks)).not.toContain("secret-detail");
});
