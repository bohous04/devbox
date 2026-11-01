import { expect, test } from "bun:test";
import { coolifyInstancesFromMcp, discoverDatabaseTargets, discoveryBlocksForTarget, listCoolifyServiceDatabases } from "../src/coolify";

const inst = coolifyInstancesFromMcp({ "infra-coolify": { env: { COOLIFY_BASE_URL: "https://panel.example", COOLIFY_ACCESS_TOKEN: "t" } } }).infra!;
// Shape of a real one-click umami service (GET /services/{uuid}), trimmed.
const umami = {
  uuid: "svcfixture00000000000001", name: "umami", status: "running:healthy", environment_id: 2,
  environment: { name: "production" }, server: { name: "Main VPS", ip: "host.docker.internal", uuid: "srv0" },
  databases: [{ uuid: "pgfixture000000000000001", name: "postgresql", image: "postgres:16-alpine", status: "running:healthy" }],
  docker_compose: [
    "services:",
    "  umami:",
    "    environment:",
    "      DATABASE_URL: 'postgres://$SERVICE_USER_POSTGRES:NEVER_RETURN@postgresql:5432/$POSTGRES_DB'",
    "    container_name: umami-svcfixture00000000000001",
    "  postgresql:",
    "    environment:",
    "      POSTGRES_USER: $SERVICE_USER_POSTGRES",
    "      POSTGRES_PASSWORD: NEVER_RETURN",
    "      POSTGRES_DB: umami",
    "    container_name: postgresql-svcfixture00000000000001",
    "volumes:",
  ].join("\n"),
};
const redisOnly = { uuid: "kuma0000", name: "uptime-kuma", databases: [{ uuid: "r1", name: "redis", image: "redis:7" }], docker_compose: "" };
const unrelated = {
  uuid: "tracker0", name: "tracker-postgres", database_type: "standalone-postgresql", status: "running:healthy",
  postgres_db: "tracker", environment_id: 7, environment: { name: "production" },
  destination: { server: { name: "Elsewhere", ip: "203.0.113.9", uuid: "srv9" } },
};
const catalog = { servers: { infra: { host: "198.51.100.1", port: 22, user: "root", key: "k" } }, databases: [] };
const fixture = (databases: unknown[] = [unrelated]) => async (req: Request) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/v1/databases") return Response.json(databases);
  if (path === "/api/v1/services") return Response.json([{ uuid: umami.uuid, name: umami.name }, { uuid: redisOnly.uuid, name: redisOnly.name }]);
  if (path === `/api/v1/services/${umami.uuid}`) return Response.json(umami);
  if (path === `/api/v1/services/${redisOnly.uuid}`) return Response.json(redisOnly);
  throw new Error(`Unexpected read ${path}`);
};

test("a database inside a Coolify service is found with its container and the DB name from compose", async () => {
  const rows = await listCoolifyServiceDatabases(inst, fixture());
  expect(rows).toEqual([{
    container: "postgresql-svcfixture00000000000001", uuid: "pgfixture000000000000001", name: "umami", engine: "postgres",
    status: "running:healthy", service: umami.uuid, db: "umami", environment: "production", environmentId: 2,
    server: "Main VPS", serverHost: "host.docker.internal", serverUuid: "srv0",
  }]);
  expect(JSON.stringify(rows)).not.toContain("NEVER_RETURN");
});

test("umami as a service is a verified target and an unrelated database does not block it", async () => {
  const result = await discoverDatabaseTargets({ catalog, instances: { infra: inst }, wanted: "umami" }, fixture());
  expect(result.candidates.find((c) => c.matched)).toMatchObject({ id: `infra:${umami.databases[0]!.uuid}`, server: "infra", verified: true, db: "umami" });
  const target = result.candidates.find((c) => c.matched)!;
  expect(discoveryBlocksForTarget(result.blocks, target)).toEqual([]);
});

test("an unavailable service list does not break discovery of standalone databases", async () => {
  const result = await discoverDatabaseTargets({ catalog, instances: { infra: inst }, wanted: "tracker" }, async (req) => {
    if (new URL(req.url).pathname === "/api/v1/services") return new Response("no", { status: 403 });
    return fixture()(req);
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.blocks.map((b) => b.code)).toEqual(["server_mapping"]);
});
