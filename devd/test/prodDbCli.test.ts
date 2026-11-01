import { expect, test } from "bun:test";
import { run } from "../src/proc";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const IMAGE = join(import.meta.dir, "..", "..", "image");

test("access CLI forwards explicit scope and rejects ignored prepare flags before HTTP", async () => {
  const bodies: any[] = []; let requests = 0, ignoreScope = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests++;
    expect(new URL(req.url).pathname).toBe("/api/prod-db/requests");
    expect(req.headers.get("x-devbox-session")).toBe("scope-fixture");
    const body = await req.json(); bodies.push(body);
    return Response.json({ id: 7, state: "pending", requested_scope: ignoreScope ? "read" : (body as any).scope });
  } });
  const cli = (...args: string[]) => run(["bash", join(IMAGE, "db-request"), ...args], {
    env: { DEVD_URL: `http://127.0.0.1:${server.port}`, DEVD_SESSION_ID: "scope-fixture" }, timeoutMs: 5000,
  });
  try {
    expect((await cli(" fixture_scope ", "--why", "Prepare access", "--scope", "migration")).code).toBe(0);
    expect(bodies[0]).toEqual({ wanted: "fixture_scope", why: "Prepare access", scope: "migration" });
    expect((await cli("fixture_scope", "--why", "Prepare access")).code).toBe(0);
    expect(bodies[1].scope).toBe("read");
    expect((await cli("fixture_scope", "--why", "Prepare access", "--scope", "admin")).code).toBe(2);
    expect((await cli("prepare", "7", "--scope", "migration")).code).toBe(2);
    expect(requests).toBe(2);
    ignoreScope = true;
    const stale = await cli("fixture_scope", "--why", "Prepare access", "--scope", "migration");
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).id).toBe(7);
    expect(stale.stderr).toContain("did not accept the requested access scope");
  } finally { server.stop(true); }
});

for (const vendor of ["MariaDB", "MySQL"]) test(`MariaDB proxy CLI supports the ${vendor} client without passwords in argv`, async () => {
  const root = mkdtempSync(join(tmpdir(), "prod-db-mysql-stub-"));
  // Use the preferred name for both vendor stubs, to be independent of installed clients.
  writeFileSync(join(root, "mariadb"), `#!/bin/sh\nif [ "$1" = --version ]; then echo '${vendor} fixture'; exit; fi\nprintf '%s\\n' "$@"\ntest "$MYSQL_PWD" = ephemeral-test-password\n`, { mode: 0o755 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("mysql://devbox_fixture:ephemeral-test-password@127.0.0.1:15433/fixture") });
  try {
    const r = await run(["bash",join(IMAGE, "prod-db", "prod-db"),"connect","fixture","-e","SELECT 1"], { env: { DEVD_URL: `http://127.0.0.1:${server.port}`, PATH: `${root}:${process.env.PATH}` }, timeoutMs: 5000 });
    expect(r.code).toBe(0); expect(r.stdout).toContain(vendor === "MariaDB" ? "--skip-ssl" : "--ssl-mode=DISABLED");
    expect(r.stdout).toContain("--port=15433"); expect(r.stdout).toContain("SELECT 1"); expect(r.stdout).not.toContain("ephemeral-test-password");
  } finally { server.stop(true); rmSync(root,{recursive:true,force:true}); }
});

test("CLI preserves structured blocked reasons/IDs, trims input and reloads catalog without session restart", async () => {
  const urls: string[] = []; let catalogued = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    expect(req.headers.get("x-devbox-session")).toBe("dev-fixture");
    const path = new URL(req.url).pathname; urls.push(path);
    if (path === "/api/prod-db/catalog") return Response.json({ databases: catalogued ? [{ name: "fixture", server: "isolated", engine: "postgres" }] : [] });
    if (path === "/api/prod-db/fixture/url") return catalogued ? new Response("postgresql://devbox_fixture:placeholder@127.0.0.1:15432/fixture") : Response.json({ error: "Unknown database", code: "database_unknown", requestId: 12, nextAction: "db-request status 12" }, { status: 404 });
    if (path === "/api/prod-db/fixture/write") return Response.json({ id: 23, status: "blocked", requestId: 12, nextAction: "db-request prepare 12" }, { status: 202 });
    if (path === "/api/prod-db/requests/12") return Response.json({ id: 12, state: "blocked", blocks: [{ code: "op_manual_items", message: "Create dedicated key" }], nextAction: "1Password" });
    return Response.json({ error: "1Password permission denied", code: "op_read_denied" }, { status: 403 });
  } });
  const env = { DEVD_URL: `http://127.0.0.1:${server.port}`, DEVD_SESSION_ID: "dev-fixture", PROD_DB_CATALOG: "/nonexistent-stale-catalog" };
  const cli = (args: string[]) => run(["bash", join(IMAGE, "prod-db", "prod-db"), ...args], { env, timeoutMs: 5000 });
  try {
    const missing = await cli(["connect", " fixture "]); expect(missing.code).toBe(1); expect(missing.stderr).toContain('"requestId":12'); expect(missing.stderr).toContain("db-request status");
    const write = await cli(["write", " fixture ", "--sql", "CREATE TABLE harmless(id int)", "--scope", "migration", "--no-wait"]);
    expect(write.code).toBe(0); expect(JSON.parse(write.stdout).status).toBe("blocked");
    expect((await cli(["list"])).stdout).toBe(""); catalogued = true;
    expect((await cli(["list"])).stdout).toContain("fixture\tisolated\tpostgres");
    const root = mkdtempSync(join(tmpdir(), "prod-db-psql-stub-"));
    writeFileSync(join(root, "psql"), "#!/bin/sh\nprintf '%s\\n' \"$1\"\n", { mode: 0o755 });
    const connect = await run(["bash", join(IMAGE, "prod-db", "prod-db"), "connect", " fixture "], { env: { ...env, PATH: `${root}:${process.env.PATH}` }, timeoutMs: 5000 });
    expect(connect.code).toBe(0); expect(connect.stdout).toContain("devbox_fixture:placeholder");
    const status = await run(["bash", join(IMAGE, "db-request"), "status", "12"], { env, timeoutMs: 5000 }); expect(JSON.parse(status.stdout).id).toBe(12);
    const denied = await run(["bash", join(IMAGE, "db-request"), "fixture", "--why", "read"], { env, timeoutMs: 5000 }); expect(denied.code).toBe(1); expect(denied.stderr).toContain("op_read_denied");
    expect(urls).not.toContain("/api/prod-db/ fixture /url");
  } finally { server.stop(true); }
});
