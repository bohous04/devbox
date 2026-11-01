import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { coolifyInstancesFromMcp, listCoolifyDatabases, discoverDatabaseTargets, discoveryBlocksForTarget } from "../src/coolify";

const mcp = {
  "shop-coolify": { command: "npx", args: ["@masonator/coolify-mcp"], env: { COOLIFY_BASE_URL: "https://coolify.shop.example", COOLIFY_ACCESS_TOKEN: "TOK" } },
  "acme-coolify": { command: "npx", args: [], env: {
    COOLIFY_BASE_URL: "https://coolify.acme.example", COOLIFY_ACCESS_TOKEN: "TOK2",
    COOLIFY_CF_ACCESS_CLIENT_ID: "CFID", COOLIFY_CF_ACCESS_CLIENT_SECRET: "CFSEC",
  } },
  "infra-plane": { command: "uvx", args: [], env: { PLANE_API_KEY: "x" } },
};

test("instances are derived from the MCP configuration, plane is ignored", () => {
  expect(Object.keys(coolifyInstancesFromMcp(mcp)).sort()).toEqual(["acme", "shop"]);
});

test("Cloudflare Access headers are carried over when present", () => {
  const i = coolifyInstancesFromMcp(mcp);
  expect(i.acme!.headers["CF-Access-Client-Id"]).toBe("CFID");
  expect(i.shop!.headers["CF-Access-Client-Id"]).toBeUndefined();
});

test("a server without a URL or token is skipped instead of producing a broken instance", () => {
  const bad = { "x-coolify": { env: { COOLIFY_BASE_URL: "https://x" } } };
  expect(Object.keys(coolifyInstancesFromMcp(bad))).toEqual([]);
});

test("databases are mapped to a container and an engine", async () => {
  const inst = coolifyInstancesFromMcp(mcp).shop!;
  const rows = await listCoolifyDatabases(inst, async () => new Response(JSON.stringify([
    { uuid: "db123", name: "ledger-postgres", type: "standalone-postgresql", status: "running:healthy" },
    { name: "cache", type: "standalone-redis", status: "running:healthy" },
  ])));
  expect(rows).toEqual([{ uuid: "db123", name: "ledger-postgres", container: "db123", engine: "postgres", status: "running:healthy" }]);
});

test("the token goes in a header, not in the URL", async () => {
  const inst = coolifyInstancesFromMcp(mcp).shop!;
  let seen: Request | null = null;
  await listCoolifyDatabases(inst, async (r) => { seen = r; return new Response("[]"); });
  expect(seen!.headers.get("authorization")).toBe("Bearer TOK");
  expect(seen!.url).not.toContain("TOK");
});

test("a Coolify error is propagated, not swallowed", async () => {
  const inst = coolifyInstancesFromMcp(mcp).shop!;
  await expect(listCoolifyDatabases(inst, async () => new Response("nope", { status: 401 })))
    .rejects.toThrow(/401/);
});


const inst = coolifyInstancesFromMcp(mcp).acme!;
const db = {
  uuid: "dbfixture000000000000001", name: "billing-db", database_type: "standalone-postgresql", status: "running:healthy",
  postgres_db: "billing", postgres_password: "NEVER_RETURN", environment_id: 9,
  environment: { name: "production" }, destination: { server: { name: "Main VPS", ip: "host.docker.internal", uuid: "server0" } },
};
const catalog = { servers: { acme: { host: "203.0.113.42", port: 22, user: "root", key: "prod-tunnel-acme" } }, databases: [] };
const options = { catalog, instances: { acme: inst }, wanted: " billing ", project: " apps-invoice-creator " };
const app = { uuid: "app123", name: "Billing", environment_id: 9, base_directory: "/apps/invoice-creator" };
const fixture = (databases = [db], applications = [app]) => async (req: Request) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/v1/databases") return Response.json(databases);
  if (path === "/api/v1/applications") return Response.json(applications);
  if (path === `/api/v1/databases/${db.uuid}`) return Response.json(db);
  throw new Error(`Unexpected read ${path}`);
};

test("real Coolify database_type shape is not silently discarded and secrets are projected out", async () => {
  const rows = await listCoolifyDatabases(inst, fixture());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ uuid: db.uuid, container: db.uuid, name: "billing-db", engine: "postgres", db: "billing", environment: "production" });
  expect(JSON.stringify(rows)).not.toContain("NEVER_RETURN");
});

test("malformed JSON and wrong response shapes are useful errors, never empty success", async () => {
  for (const body of ["<html>login</html>", JSON.stringify({ message: "unexpected" })]) {
    await expect(listCoolifyDatabases(inst, async () => new Response(body))).rejects.toThrow(/JSON|format/);
  }
});

test("data envelope and supported SQL engines", async () => {
  const rows = await listCoolifyDatabases(inst, async () => Response.json({ data: [
    { uuid: "db1", name: "orders", database_type: "standalone-mysql", mysql_database: "orders" },
    { uuid: "db2", name: "cms", database_type: "standalone-mariadb", mariadb_database: "cms" },
  ] }));
  expect(rows.map((r) => [r.container, r.engine, r.db])).toEqual([["db1", "mysql", "orders"], ["db2", "mariadb", "cms"]]);
});

test("UUID missing never falls back to human container name", async () => {
  await expect(listCoolifyDatabases(inst, async () => Response.json([{ name: "billing-db", database_type: "standalone-postgresql" }]))).rejects.toThrow(/UUID/);
});

test("unique matched production target maps real known server and app; trims request", async () => {
  const result = await discoverDatabaseTargets(options, fixture());
  expect(result.blocks).toEqual([]);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ id: `acme:${db.uuid}`, server: "acme", instance: "acme", matched: true, verified: true, application: "app123", applicationName: "Billing", db: "billing", environment: "production" });
  expect(result.candidates[0]!.server).not.toBe("apps-invoice-creator");
});

test("lightweight summaries are enriched by UUID before marking verified", async () => {
  const result = await discoverDatabaseTargets(options, fixture([{ uuid: db.uuid, name: db.name, database_type: db.database_type, status: db.status } as typeof db]));
  expect(result.candidates[0]).toMatchObject({ verified: true, db: "billing", environment: "production" });
});

test("multiple matching environments require explicit choice", async () => {
  const staging = { ...db, uuid: "staging123", environment: { name: "staging" } };
  const result = await discoverDatabaseTargets(options, fixture([db, staging]));
  expect(result.candidates.filter((c) => c.matched)).toHaveLength(2);
  expect(result.blocks).toContainEqual(expect.objectContaining({ code: "target_choice", category: "decision" }));
});

test("instance label does not map an unrelated remote server", async () => {
  const remote = { ...db, destination: { server: { name: "Other", ip: "203.0.113.99", uuid: "other" } } };
  const result = await discoverDatabaseTargets(options, fixture([remote]));
  expect(result.candidates[0]).toMatchObject({ server: "", verified: false });
  expect(result.blocks[0]!.code).toBe("server_mapping");
});

test("project alias is never used to invent a missing server", async () => {
  const result = await discoverDatabaseTargets({ ...options, catalog: { ...catalog, servers: {} } }, fixture());
  expect(result.candidates[0]).toMatchObject({ server: "", verified: false });
});

test("unrelated sole database remains an explicit choice", async () => {
  const result = await discoverDatabaseTargets({ ...options, wanted: "something-else", project: "different-project" }, fixture([db], []));
  expect(result.candidates[0]!.matched).toBe(false);
});

test("discovery reports connection, permission and missing config separately with no upstream secrets", async () => {
  const missing = await discoverDatabaseTargets({ ...options, instances: {} });
  expect(missing.blocks[0]).toMatchObject({ category: "configuration", code: "coolify_missing" });
  const permission = await discoverDatabaseTargets(options, async () => new Response("NEVER_RETURN", { status: 403 }));
  expect(permission.blocks[0]).toMatchObject({ category: "permission", code: "coolify_permission" });
  expect(JSON.stringify(permission)).not.toContain("NEVER_RETURN");
  const connection = await discoverDatabaseTargets(options, async () => { throw new Error("secret-token network failure"); });
  expect(connection.blocks[0]).toMatchObject({ category: "connection", code: "coolify_connection" });
  expect(JSON.stringify(connection)).not.toContain("secret-token");
});

test("each instance failing remains visible alongside successful candidates", async () => {
  const result = await discoverDatabaseTargets({ ...options, instances: { acme: inst, shop: coolifyInstancesFromMcp(mcp).shop! } }, async (req) => {
    if (new URL(req.url).hostname === "coolify.shop.example") return new Response("down", { status: 503 });
    return fixture()(req);
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.blocks).toContainEqual(expect.objectContaining({ instance: "shop", code: "coolify_http" }));
});


test("sanitized live Billing response reproduces the incident and resolves with current parser", async () => {
  const live = JSON.parse(readFileSync(new URL("./fixtures/coolify-billing.redacted.json", import.meta.url), "utf8"));
  // The pre-fix filter only read type: this observed response has database_type.
  expect(live.type).toBeUndefined();
  expect(live.database_type).toBe("standalone-postgresql");
  const rows = await listCoolifyDatabases(inst, async () => Response.json([live]));
  expect(rows[0]).toMatchObject({ container: "dbfixture000000000000001", name: "billing-db", db: "billing", engine: "postgres" });
});

test("human server label cannot override a contradictory observed host", async () => {
  const remote = { ...db, destination: { server: { name: "acme", ip: "203.0.113.99", uuid: "other" } } };
  const result = await discoverDatabaseTargets(options, fixture([remote]));
  expect(result.candidates[0]).toMatchObject({ server: "", verified: false });
});

test("unrelated mapping errors retain their candidate identity and do not block the selected target", async () => {
  const unrelated = { ...db, uuid: "unrelated-db", name: "unrelated", postgres_db: "unrelated", environment_id: 10, destination: { server: { name: "Other", ip: "203.0.113.99", uuid: "other" } } };
  const result = await discoverDatabaseTargets(options, fixture([db, unrelated]));
  const selected = result.candidates.find((c) => c.uuid === db.uuid)!;
  expect(result.blocks).toContainEqual(expect.objectContaining({ code: "server_mapping", candidateId: "acme:unrelated-db", instance: "acme" }));
  expect(discoveryBlocksForTarget(result.blocks, selected)).toEqual([]);
  expect(discoveryBlocksForTarget(result.blocks, result.candidates.find((c) => c.uuid === unrelated.uuid))).toHaveLength(1);
  expect(discoveryBlocksForTarget(result.blocks)).toEqual(result.blocks);
});

test("selected instance failures and global blocks remain visible, other instance failures do not block it", async () => {
  const result = await discoverDatabaseTargets({ ...options, instances: { acme: inst, shop: coolifyInstancesFromMcp(mcp).shop! } }, async (req) => {
    if (new URL(req.url).hostname === "coolify.shop.example") return new Response("down", { status: 503 });
    return fixture()(req);
  });
  expect(result.blocks[0]).toMatchObject({ instance: "shop" });
  expect(discoveryBlocksForTarget(result.blocks, result.candidates[0])).toEqual([]);
  const common = { code: "vault_unavailable", category: "connection" as const, message: "Vault unavailable", action: "Unlock" };
  const own = { ...common, instance: "acme", candidateId: result.candidates[0]!.id };
  expect(discoveryBlocksForTarget([...result.blocks, common, own], result.candidates[0])).toEqual([common, own]);
});

test("an exact Coolify resource UUID matches its database even when the name differs", async () => {
  const result = await discoverDatabaseTargets({ ...options, wanted: db.uuid, project: undefined }, fixture([db]));
  expect(result.candidates[0]).toMatchObject({ uuid: db.uuid, matched: true, verified: true });
  const byName = await discoverDatabaseTargets({ ...options, wanted: "warehouse", project: undefined }, fixture([db]));
  expect(byName.candidates[0]!.matched).toBe(false);
});
