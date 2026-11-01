import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", "..", "image", "prod-db", "prod-db");
const PROXY_URL = "postgresql://devbox_ledger_app_fixture:placeholder@172.17.0.1:15432/ledger_app?sslmode=disable";
const SESSION = "isolated-prod-db-cli";
async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bash", SKILL, ...args], {
    env: { ...process.env, DEVD_SESSION_ID: SESSION, PROD_DB_CATALOG: "/does/not/exist/no-local-catalog.json", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
}
function binStub() {
  const dir = mkdtempSync(join(tmpdir(), "proddb-cli-test-"));
  for (const [name, body] of Object.entries({
    ssh: 'printf called > "$DEVD_TEST_SSH_MARK"; exit 98',
    psql: 'printf "%s\\n" "$@" > "$DEVD_TEST_PSQL_ARGS"',
    sleep: 'exit 0',
  })) { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); }
  return { dir, env: { PATH: `${dir}:${process.env.PATH}`, DEVD_TEST_SSH_MARK: join(dir, "ssh-called"), DEVD_TEST_PSQL_ARGS: join(dir, "psql-args") } };
}

test("prod-db list uses the live authenticated catalog and sees newly onboarded DBs without a session restart", async () => {
  const databases = [{ name: "ledger_app", server: "shop", engine: "postgres" }]; let requests = 0;
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    expect(req.headers.get("x-devbox-session")).toBe(SESSION); requests++;
    return new URL(req.url).pathname === "/api/prod-db/catalog" ? Response.json({ databases }) : new Response(null, { status: 404 });
  } });
  try {
    const env = { DEVD_URL: `http://127.0.0.1:${srv.port}` };
    const first = await run(["list"], env); expect(first.code).toBe(0); expect(first.stdout).toBe("ledger_app\tshop\tpostgres\n");
    databases.push({ name: "billing", server: "acme", engine: "postgres" });
    const second = await run(["list"], env); expect(second.code).toBe(0); expect(second.stdout).toContain("billing\tacme\tpostgres");
    expect(requests).toBe(2);
  } finally { srv.stop(true); }
});

test("prod-db url trims the DB name and returns the host proxy URL", async () => {
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    new URL(req.url).pathname === "/api/prod-db/ledger_app/url" ? new Response(PROXY_URL) : new Response(null, { status: 404 }) });
  try {
    const { code, stdout } = await run(["url", " ledger_app "], { DEVD_URL: `http://127.0.0.1:${srv.port}` });
    expect(code).toBe(0); expect(stdout).toBe(PROXY_URL);
  } finally { srv.stop(true); }
});

test("prod-db connect starts psql through the host proxy and never starts agent-side SSH", async () => {
  const stub = binStub();
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    new URL(req.url).pathname === "/api/prod-db/ledger_app/url" ? new Response(PROXY_URL) : new Response(null, { status: 404 }) });
  try {
    const { code } = await run(["connect", "ledger_app", "-tAc", "select 1"], { DEVD_URL: `http://127.0.0.1:${srv.port}`, ...stub.env });
    expect(code).toBe(0);
    expect(readFileSync(stub.env.DEVD_TEST_PSQL_ARGS, "utf8").trim().split("\n")).toEqual([PROXY_URL, "-tAc", "select 1"]);
    expect(existsSync(stub.env.DEVD_TEST_SSH_MARK)).toBe(false);
  } finally { srv.stop(true); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("unknown DB connect preserves structured request ID and actionable next step, without falling back to SSH", async () => {
  const stub = binStub();
  const failure = { code: "database_unknown", error: "Unknown database 'billing'; request #2 created.", requestId: 2, nextAction: "db-request status 2" };
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(failure, { status: 404 }) });
  try {
    const result = await run(["connect", "billing"], { DEVD_URL: `http://127.0.0.1:${srv.port}`, ...stub.env });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(JSON.parse(result.stderr)).toEqual(failure);
    expect(existsSync(stub.env.DEVD_TEST_SSH_MARK)).toBe(false); expect(existsSync(stub.env.DEVD_TEST_PSQL_ARGS)).toBe(false);
  } finally { srv.stop(true); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("connection failure is distinguishable from missing DB configuration", async () => {
  const result = await run(["connect", "billing"], { DEVD_URL: "http://127.0.0.1:1" });
  expect(result.code).toBe(1); expect(result.stderr).toContain('"code":"devd_unreachable"'); expect(result.stderr).not.toContain("database_unknown");
});

test("prod-db write emits its stable ID and waits for the actual execution result", async () => {
  const stub = binStub(); const requests: string[] = [];
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    const path = new URL(req.url).pathname; requests.push(`${req.method} ${path}`);
    if (path === "/api/prod-db/ledger_app/write" && req.method === "POST") {
      expect(await req.json()).toEqual({ sql: "update users set x=1", scope: "dml" });
      return Response.json({ id: 7, status: "pending", nextAction: "Approve exact SQL" }, { status: 202 });
    }
    if (path === "/api/prod-db/writes/7") return Response.json({ id: 7, status: "executed", result: "3 rows written" });
    return new Response(null, { status: 404 });
  } });
  try {
    const result = await run(["write", "ledger_app", "--sql", "update users set x=1"], { DEVD_URL: `http://127.0.0.1:${srv.port}`, ...stub.env });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ id: 7, status: "pending" });
    expect(result.stderr).toContain('"status":"executed"'); expect(result.stderr).toContain("3 rows written");
    expect(requests).toEqual(["POST /api/prod-db/ledger_app/write", "GET /api/prod-db/writes/7"]);
  } finally { srv.stop(true); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("prod-db write --no-wait returns blocked write/request IDs as JSON and forwards explicit migration scope and retry key", async () => {
  let requests = 0;
  const state = { id: 9, status: "blocked", code: "database_unknown", requestId: 2, nextAction: "Resolve request #2, then poll write #9" };
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    requests++;
    expect(req.method).toBe("POST"); expect(new URL(req.url).pathname).toBe("/api/prod-db/billing/write");
    expect(await req.json()).toEqual({ sql: "ALTER TABLE invoices ADD COLUMN note text", scope: "migration", idempotencyKey: "migration-0011" });
    return Response.json(state, { status: 202 });
  } });
  try {
    const result = await run(["write", "billing", "--sql", "ALTER TABLE invoices ADD COLUMN note text", "--scope", "migration", "--idempotency-key", "migration-0011", "--no-wait"], { DEVD_URL: `http://127.0.0.1:${srv.port}` });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(state); expect(requests).toBe(1);
  } finally { srv.stop(true); }
});

test("prod-db write rejection remains failure and write-status can resume by the same ID", async () => {
  const stub = binStub(); const rejected = { id: 12, status: "rejected", result: null };
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => req.method === "POST" ? Response.json({ id: 12, status: "pending" }) : Response.json(rejected) });
  try {
    const env = { DEVD_URL: `http://127.0.0.1:${srv.port}`, ...stub.env };
    const result = await run(["write", "ledger_app", "--sql", "delete from x"], env);
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).id).toBe(12); expect(result.stderr).toContain('"status":"rejected"');
    const status = await run(["write-status", "12"], env); expect(status.code).toBe(0); expect(JSON.parse(status.stdout)).toEqual(rejected);
    expect(existsSync(stub.env.DEVD_TEST_SSH_MARK)).toBe(false);
  } finally { srv.stop(true); rmSync(stub.dir, { recursive: true, force: true }); }
});
