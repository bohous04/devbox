import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { createDbRequest } from "../src/dbRequests";
import { BLOCKED_RECHECK_INTERVAL_MS, createDbOnboarding, type Block, type OnboardingDeps } from "../src/dbOnboarding";
import { getOperation } from "../src/operationStore";
import type { Catalog } from "../src/prodDb";

const T0 = 1_750_000_000_000;
const connection: Block = { code: "op_unavailable", category: "connection", message: "Synthetic outage", action: "Retry" };
const config: Block = { code: "op_connect_missing", category: "configuration", message: "Synthetic missing configuration", action: "Configure" };

function fixture() {
  let now = T0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const dir = mkdtempSync(join(tmpdir(), "onboarding-retry-"));
  const dbPath = join(dir, "devd.sqlite"), catalogPath = join(dir, "catalog.json");
  const catalog: Catalog = { servers: { test: { host: "192.0.2.42", port: 22, user: "main", key: "synthetic-tunnel" } }, databases: [] };
  writeFileSync(catalogPath, JSON.stringify(catalog));
  let blocks: Block[] = [connection], preflights = 0, executions = 0;
  const deps: OnboardingDeps = {
    db: openDb(dbPath), catalog, catalogPath, access: {}, accessPath: join(dir, "access.json"),
    proxyReady: () => true, portFree: async () => true,
    host: {
      preflight: async () => { preflights++; return blocks; },
      execute: async () => { executions++; }, verify: async () => {},
    },
    discover: async (row) => ({ blocks: [], candidates: [{ id: row.wanted, name: row.wanted, db: row.wanted,
      server: "test", container: `${row.wanted}123`, engine: "postgres", environment: "synthetic", verified: true, matched: true }] }),
  };
  const f = {
    deps, on: createDbOnboarding(deps),
    get preflights() { return preflights; }, get executions() { return executions; },
    setTime(value: number) { now = value; }, setBlocks(value: Block[]) { blocks = value; },
    request: (wanted = "alpha") => createDbRequest(deps.db, { session: "test", project: "fixture", wanted, why: "synthetic retry regression" }),
    restart() { deps.db.close(); deps.db = openDb(dbPath); f.on = createDbOnboarding(deps); },
    cleanup() { deps.db.close(); clock.mockRestore(); rmSync(dir, { recursive: true, force: true }); },
  };
  return f;
}

test("automatic connection rechecks run once per 15 minutes and cooldown survives DB reopen", async () => {
  const f = fixture();
  try {
    const id = f.request();
    expect((await f.on.prepare(id)).state).toBe("blocked");
    expect(f.preflights).toBe(1);
    for (let elapsed = 15_000; elapsed < BLOCKED_RECHECK_INTERVAL_MS; elapsed += 15_000) {
      f.setTime(T0 + elapsed); await f.on.tick();
    }
    expect(f.preflights).toBe(1);
    f.setTime(T0 + BLOCKED_RECHECK_INTERVAL_MS); await f.on.tick();
    expect(f.preflights).toBe(2);
    f.setTime(T0 + BLOCKED_RECHECK_INTERVAL_MS + 15_000); f.restart();
    await f.on.tick(); expect(f.preflights).toBe(2);
    f.setTime(T0 + 2 * BLOCKED_RECHECK_INTERVAL_MS - 1); await f.on.tick();
    expect(f.preflights).toBe(2);
    f.setTime(T0 + 2 * BLOCKED_RECHECK_INTERVAL_MS); await f.on.tick();
    expect(f.preflights).toBe(3);
    expect(f.executions).toBe(0);
    expect(f.on.view(id)!.operationId).toBeNull();
  } finally { f.cleanup(); }
});

test("configuration, permission, decision, unsupported engine and mixed blocks require manual recheck", async () => {
  for (const blocks of [
    [config], [{ ...config, category: "permission" as const }], [{ ...config, category: "decision" as const }],
    [{ ...connection, code: "unsupported_engine" }], [connection, config],
  ]) {
    const f = fixture();
    try {
      f.setBlocks(blocks);
      const id = f.request(); await f.on.prepare(id);
      for (const elapsed of [BLOCKED_RECHECK_INTERVAL_MS, 86_400_000, 7 * 86_400_000]) {
        f.setTime(T0 + elapsed); await f.on.tick();
      }
      f.restart(); await f.on.tick();
      expect(f.preflights).toBe(1);
      expect(f.on.view(id)!.state).toBe("blocked");
      expect(f.on.view(id)!.operationId).toBeNull();
    } finally { f.cleanup(); }
  }
});

test("manual prepare immediately rechecks corrected configuration without granting approval", async () => {
  const f = fixture();
  try {
    f.setBlocks([config]); const id = f.request(); await f.on.prepare(id);
    f.setTime(T0 + 1000); f.setBlocks([]);
    const prepared = await f.on.prepare(id);
    expect(f.preflights).toBe(2);
    expect(prepared.state).toBe("awaiting_approval");
    expect(getOperation(f.deps.db, prepared.operationId!)!.status).toBe("pending");
    expect(f.executions).toBe(0);
    await expect(f.on.resume(id)).rejects.toThrow("Operation has not been approved");
  } finally { f.cleanup(); }
});

test("automatic and immediate manual resume retain the approved operation and fingerprint", async () => {
  const f = fixture();
  try {
    f.setBlocks([]); const id = f.request(), prepared = await f.on.prepare(id);
    const operationId = prepared.operationId!, fingerprint = prepared.plan!.fingerprint;
    f.setBlocks([connection]); f.on.approve(operationId); await f.on.settled(id);
    const approved = getOperation(f.deps.db, operationId)!;
    expect(f.on.view(id)!.state).toBe("blocked");
    expect(f.preflights).toBe(2);
    f.setTime(T0 + 15_000); await f.on.tick(); expect(f.preflights).toBe(2);
    f.setTime(T0 + BLOCKED_RECHECK_INTERVAL_MS); await f.on.tick();
    expect(f.preflights).toBe(3);
    expect(getOperation(f.deps.db, operationId)).toMatchObject({ status: "approved", params: approved.params, decided_at: approved.decided_at });
    expect(f.on.view(id)!.operationId).toBe(operationId);
    expect(f.on.view(id)!.plan!.fingerprint).toBe(fingerprint);
    // Permission/configuration corrections also permit immediate operator retry.
    f.setBlocks([config]); await f.on.resume(id);
    expect(f.preflights).toBe(4);
    f.setTime(T0 + 2 * BLOCKED_RECHECK_INTERVAL_MS); await f.on.tick(); expect(f.preflights).toBe(4);
    f.setBlocks([]); await f.on.resume(id);
    expect(f.executions).toBe(1);
    expect(f.on.view(id)!.state).toBe("ready");
    expect(f.on.view(id)!.operationId).toBe(operationId);
    expect(f.on.view(id)!.plan!.fingerprint).toBe(fingerprint);
    expect(f.deps.db.query("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1 });
  } finally { f.cleanup(); }
});

test("retry cooldown is persisted before I/O even if checks throw without saving a block", async () => {
  const f = fixture();
  try {
    const id = f.request(); await f.on.prepare(id);
    let portChecks = 0;
    f.deps.portFree = async () => { portChecks++; throw Error("Synthetic interrupted check"); };
    f.setTime(T0 + BLOCKED_RECHECK_INTERVAL_MS);
    await expect(f.on.tick()).rejects.toThrow("Synthetic interrupted check");
    expect(portChecks).toBe(1);
    f.setTime(T0 + BLOCKED_RECHECK_INTERVAL_MS + 15_000); f.restart(); await f.on.tick();
    expect(portChecks).toBe(1);
    expect(f.on.view(id)!.state).toBe("blocked");
    expect(f.executions).toBe(0);
  } finally { f.cleanup(); }
});

test("overlapping ticks cannot perform duplicate preflight or submit duplicate approvals", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const id = f.request(); await f.on.prepare(id);
    let retries = 0;
    f.deps.host!.preflight = async () => { retries++; entered.resolve(); await release.promise; return []; };
    f.setTime(T0 + BLOCKED_RECHECK_INTERVAL_MS);
    const first = f.on.tick(); await entered.promise;
    await f.on.tick(); expect(retries).toBe(1);
    release.resolve(); await first;
    expect(f.on.view(id)!.state).toBe("awaiting_approval");
    expect(f.deps.db.query("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1 });
    expect(f.executions).toBe(0);
  } finally { release.resolve(); f.cleanup(); }
});

test("verified onboarding can auto-approve without bypassing the operation record", async () => {
  const f = fixture();
  try {
    f.deps.autoApprove = true;
    f.setBlocks([]);
    const id = f.request("automatic");
    const started = await f.on.prepare(id);
    expect(started.state).toBe("executing");
    expect(started.operationId).not.toBeNull();
    await f.on.settled(id);
    expect(f.on.view(id)!.state).toBe("ready");
    expect(getOperation(f.deps.db, started.operationId!)).toMatchObject({ status: "executed" });
    expect(f.executions).toBe(1);
    expect(f.deps.db.query("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1 });
  } finally { f.cleanup(); }
});

test("a catalogued database is granted to another project automatically without Coolify rediscovery", async () => {
  const f = fixture();
  try {
    f.deps.autoApprove = true;
    f.setBlocks([]);
    const entry = { name: "shared_chat", server: "test", container: "chat123", engine: "postgres" as const, db: "chat", hostPort: 15502,
      roUser: "chat_ro", opItem: "prod-ro shared_chat", rwUser: "chat_rw", rwOpItem: "prod-rw shared_chat",
      migrationUser: "chat_migration", migrationOpItem: "prod-migration shared_chat", tunnelUser: "devbox-db-tunnel", tunnelKey: "synthetic-tunnel" };
    f.deps.catalog!.databases.push(entry);
    writeFileSync(f.deps.catalogPath!, JSON.stringify(f.deps.catalog));
    let discoveries = 0;
    f.deps.discover = async () => { discoveries++; return { blocks: [], candidates: [] }; };
    f.on = createDbOnboarding(f.deps);
    const id = createDbRequest(f.deps.db, { session: "test", project: "other-project", wanted: "shared_chat", why: "migration", scope: "migration" });
    const started = await f.on.prepare(id);
    expect(started.blocks).toEqual([]);
    await f.on.settled(id);
    const done = f.on.view(id)!;
    expect(done.state).toBe("ready");
    expect(done.plan!.entry).toMatchObject({ container: "chat123", db: "chat", migrationUser: "chat_migration" });
    expect(discoveries).toBe(0);
    expect(f.deps.access!["other-project"]).toEqual({ read: ["shared_chat"], write: ["shared_chat"] });
  } finally { f.cleanup(); }
});
