import { expect, test } from "bun:test";
import { createProposal, getProposal, setStatus } from "../src/prodWrites";
import { createApp } from "../src/api";
import { fakeDeps, fakeVault } from "./helpers/apiHarness";
import { setRestartProjects } from "../src/operations";
import { waitFor } from "./helpers/waitFor";

setRestartProjects(["shop"]);
const POLL_MS = 20;

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function propose(app: ReturnType<typeof createApp>) {
  const r = await app.request("/api/operations", post({ op: "restart-app", params: { project: "shop" } }));
  return (await r.json()) as { id: number };
}

test("a proposal is stored and NOT executed on its own", async () => {
  let ran = 0;
  const app = createApp(fakeDeps({ execOperation: async () => { ran++; return "ok"; } }));
  const r = await app.request("/api/operations", post({ op: "restart-app", params: { project: "shop" } }));
  expect(r.status).toBe(200);
  expect(ran).toBe(0);
});

test("an operation outside the catalog is rejected with 400", async () => {
  const app = createApp(fakeDeps({ execOperation: async () => "ok" }));
  expect((await app.request("/api/operations", post({ op: "rm-rf", params: {} }))).status).toBe(400);
});

test("approve executes and records the result", async () => {
  const app = createApp(fakeDeps({ execOperation: async (op, p) => `${op}:${p.project}` }));
  const { id } = await propose(app);
  const r = await app.request(`/api/operations/${id}/approve`, { method: "POST" });
  expect(r.status).toBe(200);
  const rows = (await (await app.request("/api/operations")).json()) as { status: string; result: string }[];
  expect(rows[0]!.status).toBe("executed");
  expect(rows[0]!.result).toBe("restart-app:shop");
});

test("with a locked vault approve returns 423 and runs nothing", async () => {
  let ran = 0;
  const deps = fakeDeps({ execOperation: async () => { ran++; return "ok"; }, vault: fakeVault({ locked: true }) });
  const app = createApp(deps);
  // a proposal can be submitted while locked — it does not touch credentials
  const { id } = await propose(app);
  const r = await app.request(`/api/operations/${id}/approve`, { method: "POST" });
  expect(r.status).toBe(423);
  expect(ran).toBe(0);
});

test("a double approve does not run the operation twice", async () => {
  let ran = 0;
  const app = createApp(fakeDeps({ execOperation: async () => { ran++; return "ok"; } }));
  const { id } = await propose(app);
  await app.request(`/api/operations/${id}/approve`, { method: "POST" });
  const second = await app.request(`/api/operations/${id}/approve`, { method: "POST" });
  expect(second.status).toBe(409);
  expect(ran).toBe(1);
});

test("reject does not run the operation", async () => {
  let ran = 0;
  const app = createApp(fakeDeps({ execOperation: async () => { ran++; return "ok"; } }));
  const { id } = await propose(app);
  await app.request(`/api/operations/${id}/reject`, { method: "POST" });
  expect((await app.request(`/api/operations/${id}/approve`, { method: "POST" })).status).toBe(409);
  expect(ran).toBe(0);
});

test("a failed operation is recorded as failed, not executed", async () => {
  const app = createApp(fakeDeps({ execOperation: async () => { throw new Error("coolify unavailable"); } }));
  const { id } = await propose(app);
  expect((await app.request(`/api/operations/${id}/approve`, { method: "POST" })).status).toBe(502);
  const rows = (await (await app.request("/api/operations")).json()) as { status: string; error: string }[];
  expect(rows[0]!.status).toBe("failed");
  expect(rows[0]!.error).not.toContain("coolify unavailable");
  expect(JSON.parse((rows[0] as unknown as { error_details: string }).error_details).code).toBe("operation_failed");
});


test("deploy executes without approval and duplicate requests do not repeat it", async () => {
  let ran = 0;
  const app = createApp(fakeDeps({ execOperation: async () => { ran++; return "queued"; } }));
  const body = post({ op: "deploy", params: { project: "shop", idempotencyKey: "deploy-once" } });
  const first = await (await app.request("/api/operations", body)).json() as any;
  expect(first.status).toBe("executed");
  expect(first.result).toBe("queued");
  const second = await (await app.request("/api/operations", body)).json() as any;
  expect(second.id).toBe(first.id);
  expect(ran).toBe(1);
  expect((await app.request(`/api/operations/${first.id}/approve`, { method: "POST" })).status).toBe(409);
});

test("deploy waits for vault unlock without requiring manual approval", async () => {
  let ran = 0;
  const vault = fakeVault({ passphrase: "passphrase" });
  const app = createApp(fakeDeps({ vault, operationPollMs: POLL_MS, execOperation: async () => { ran++; return "ok"; } }));
  const row = await (await app.request("/api/operations", post({ op: "deploy", params: { project: "shop" } }))).json() as any;
  expect(row.status).toBe("approved");
  await Bun.sleep(POLL_MS * 5); // several ticks with the vault locked
  expect(ran).toBe(0);
  vault.unlock("passphrase");
  await waitFor(() => ran === 1);
  expect(ran).toBe(1);
  expect((await (await app.request(`/api/operations/${row.id}`)).json() as any).status).toBe("executed");
});

test("deploy preflight failure prevents execution", async () => {
  let ran = 0;
  const app = createApp(fakeDeps({ prepareDeployment: async () => { throw new Error("invalid target"); }, execOperation: async () => { ran++; return "ok"; } }));
  const response = await app.request("/api/operations", post({ op: "deploy", params: { project: "shop" } }));
  expect(response.status).toBe(409);
  expect(ran).toBe(0);
});


test("deploy waits for its exact SQL execution without approving SQL", async () => {
  let ran = 0;
  const deps = fakeDeps({ operationPollMs: POLL_MS, execOperation: async () => { ran++; return "ok"; } });
  const app = createApp(deps);
  const sqlId = createProposal(deps.db, { session: null, db: "fixture", sql: "ALTER TABLE fixture ADD COLUMN x int", scope: "migration" });
  const row = await (await app.request("/api/operations", post({ op: "deploy", params: { project: "shop", afterWrite: String(sqlId) } }))).json() as any;
  expect(row.status).toBe("approved");
  expect(getProposal(deps.db, sqlId)!.status).toBe("pending");
  expect(ran).toBe(0);
  setStatus(deps.db, sqlId, "approved");
  await Bun.sleep(POLL_MS * 5); // several ticks with the SQL only approved, not executed
  expect(ran).toBe(0);
  setStatus(deps.db, sqlId, "executed");
  await waitFor(() => ran === 1);
  expect(ran).toBe(1);
  expect((await (await app.request(`/api/operations/${row.id}`)).json() as any).status).toBe("executed");
});

for (const status of ["rejected", "failed"] as const) test(`deploy does not run after ${status} SQL`, async () => {
  let ran = 0;
  const deps = fakeDeps({ execOperation: async () => { ran++; return "ok"; } });
  const app = createApp(deps);
  const sqlId = createProposal(deps.db, { session: null, db: "fixture", sql: "UPDATE fixture SET x=1" });
  setStatus(deps.db, sqlId, status);
  const row = await (await app.request("/api/operations", post({ op: "deploy", params: { project: "shop", afterWrite: String(sqlId) } }))).json() as any;
  expect(row.status).toBe("failed");
  expect(ran).toBe(0);
});


test("concurrent deploy submissions execute the same prepared operation once", async () => {
  let ran = 0;
  const app = createApp(fakeDeps({
    prepareDeployment: async () => { await Bun.sleep(10); return { project: "shop", application: "app123", changes: [] }; },
    execOperation: async () => { ran++; await Bun.sleep(30); return "ok"; },
  }));
  const submit = async () => (await app.request("/api/operations", post({ op: "deploy", params: { project: "shop", idempotencyKey: "concurrent" } }))).json() as Promise<any>;
  const [a, b] = await Promise.all([submit(), submit()]);
  expect(a.id).toBe(b.id);
  expect(ran).toBe(1);
  expect((await (await app.request(`/api/operations/${a.id}`)).json() as any).status).toBe("executed");
});
