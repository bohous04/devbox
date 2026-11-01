import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { createDbRequest } from "../src/dbRequests";
import { createDbOnboarding, type OnboardingHost, type OnboardingPlan } from "../src/dbOnboarding";
import type { Catalog } from "../src/prodDb";
import { getOperation, setOperationStatus } from "../src/operationStore";
function fixture(host: OnboardingHost, accessMissing = false) {
  const dir = mkdtempSync(join(tmpdir(), "devbox-recovery-")), db = openDb(":memory:");
  const catalog: Catalog = { servers: { test: { host: "192.0.2.42", port: 22, user: "main", key: "prod-tunnel-test" } }, databases: [] };
  const catalogPath = join(dir, "catalog.json"); writeFileSync(catalogPath, JSON.stringify(catalog));
  const deps = { db, catalog, catalogPath, accessPath: join(dir, accessMissing ? "missing/access.json" : "access.json"), access: {}, host,
    proxyReady: () => true, portFree: async () => true,
    discover: async (row: { wanted: string }) => ({ blocks: [], candidates: [{ id: row.wanted, server: "test", container: `${row.wanted}123`, engine: "postgres" as const, name: row.wanted, db: row.wanted, environment: "test", verified: true, matched: true }] }),
  };
  return { dir, db, deps, catalog, catalogPath, on: createDbOnboarding(deps),
    request: (wanted: string) => createDbRequest(db, { session: "fixture", project: "test", wanted, why: "isolated recovery" }),
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const host: OnboardingHost = { preflight: async () => [], execute: async () => {}, verify: async () => {} };

test("partial catalog persistence recovers after overlay failure without restart", async () => {
  const f = fixture(host, true);
  try {
    const id = f.request("alpha"), p = await f.on.prepare(id); f.on.approve(p.operationId!); await f.on.settled(id);
    expect(f.on.view(id)!.state).toBe("failed"); expect(JSON.parse(readFileSync(f.catalogPath, "utf8")).databases).toHaveLength(1);
    mkdirSync(join(f.dir, "missing")); await f.on.resume(id);
    expect(f.on.view(id)!.state).toBe("ready"); expect(f.catalog.databases).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("a retry claims existing approval before asynchronous preflight; reject cannot overtake it", async () => {
  let hold = false, release!: () => void, entered!: () => void, executions = 0;
  const gate = new Promise<void>(r => { release = r; }), barrier = new Promise<void>(r => { entered = r; });
  const f = fixture({ preflight: async () => { if (hold) { entered(); await gate; } return []; }, execute: async () => { if (++executions === 1) throw Error("partial"); }, verify: async () => {} });
  try {
    const id = f.request("alpha"), p = await f.on.prepare(id); f.on.approve(p.operationId!); await f.on.settled(id);
    hold = true; const resumed = f.on.resume(id); await barrier;
    expect(() => f.on.reject(id)).toThrow(); release(); await resumed;
    expect(f.on.view(id)!.state).toBe("ready"); expect(executions).toBe(2);
  } finally { release(); f.cleanup(); }
});

test("same-server setup retains all verified tunnel ports until catalog commit", async () => {
  let ports: number[] = [], release!: () => void, entered!: () => void, secondStarted = false;
  const gate = new Promise<void>(r => { release = r; }), barrier = new Promise<void>(r => { entered = r; });
  const f = fixture({
    preflight: async () => [],
    execute: async (p: OnboardingPlan) => { ports = [...f.catalog.databases.map(e => e.hostPort), p.entry.hostPort]; if (p.entry.name === "beta") secondStarted = true; },
    verify: async (p) => { if (p.entry.name === "alpha") { entered(); await gate; } if (!ports.includes(p.entry.hostPort)) throw Error("missing PermitOpen"); },
  });
  try {
    const a = f.request("alpha"), b = f.request("beta"), pa = await f.on.prepare(a), pb = await f.on.prepare(b);
    f.on.approve(pa.operationId!); await barrier; f.on.approve(pb.operationId!); await Bun.sleep(10);
    expect(secondStarted).toBe(false); release(); await Promise.all([f.on.settled(a), f.on.settled(b)]);
    expect(f.on.view(a)!.state).toBe("ready"); expect(f.on.view(b)!.state).toBe("ready"); expect(ports).toHaveLength(2);
  } finally { release(); f.cleanup(); }
});

test("restart continues an interrupted approved setup, never a merely pending or rejected one", async () => {
  let ran = 0; const f = fixture({ ...host, execute: async () => { ran++; } });
  try {
    const id = f.request("alpha"), p = await f.on.prepare(id);
    setOperationStatus(f.db, p.operationId!, "approved");
    f.db.query("UPDATE db_onboarding SET state='executing' WHERE request_id=?").run(id);
    const restored = createDbOnboarding(f.deps); expect(restored.view(id)!.state).toBe("blocked");
    await restored.tick(); expect(restored.view(id)!.state).toBe("ready"); expect(ran).toBe(1);
    expect(getOperation(f.db, p.operationId!)!.status).toBe("executed");
  } finally { f.cleanup(); }
});

test("verified onboarding can approve and execute itself while SQL approvals stay separate", async () => {
  let ran = 0;
  const f = fixture({ ...host, execute: async () => { ran++; } });
  try {
    const onboarding = createDbOnboarding({ ...f.deps, autoApprove: true });
    const id = f.request("alpha");
    const prepared = await onboarding.prepare(id);
    expect(prepared.state).toBe("executing");
    expect(prepared.operationId).not.toBeNull();

    await onboarding.settled(id);
    expect(onboarding.view(id)!.state).toBe("ready");
    expect(getOperation(f.db, prepared.operationId!)!.status).toBe("executed");
    expect(ran).toBe(1);
  } finally { f.cleanup(); }
});
