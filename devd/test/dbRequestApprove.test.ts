import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/api";
import { fakeDeps } from "./helpers/apiHarness";
import { insertSession } from "../src/db";
import { createDbTargets } from "../src/dbTargets";
import { loadCatalog, readAccessFile } from "../src/prodDb";
import { getDbRequest } from "../src/dbRequests";
import { getOperation } from "../src/operationStore";
import { createDbOnboarding, type Block, type OnboardingHost, type RequestView } from "../src/dbOnboarding";

const session = "dev-apps-invoice-creator";
const headers = { "content-type": "application/json", "x-devbox-session": session };
const post = (b: unknown = {}) => ({ method: "POST", body: JSON.stringify(b), headers });
export function onboardingHarness(host?: OnboardingHost, autoApprove = false) {
  const root = mkdtempSync(join(tmpdir(), "db-onboarding-test-")), path = join(root, "catalog.json");
  writeFileSync(path, JSON.stringify({ servers: { acme: { host: "192.0.2.1", port: 2222, user: "main", key: "prod-tunnel-acme" } }, databases: [] }));
  const catalog = loadCatalog(path), accessPath = join(root, "access.json");
  let blocks: Block[] = [], discoveryBlocks: Block[] = [], executed = 0, verified = 0;
  const candidate = { id: "acme:db123", instance: "acme", uuid: "db123", server: "acme", container: "db123", engine: "postgres" as const, name: "billing-db", db: "billing", environment: "production", matched: true, verified: true, status: "running" };
  let candidates = [candidate];
  const d = fakeDeps({ prodCatalog: catalog, prodCatalogPath: path, prodAccessPath: accessPath, prodDbAccess: {}, dbTargets: createDbTargets({ entries: () => catalog.databases }), dbProxyHost: "127.0.0.1:15432",
    discoverDbTargets: async () => ({ candidates, blocks: discoveryBlocks }),
    dbOnboardingHost: host ?? { preflight: async () => blocks, execute: async () => { executed++; }, verify: async () => { verified++; } },
  });
  d.dbOnboardingAutoApprove = autoApprove;
  const app = createApp(d);
  const create = async () => await (await app.request("/api/prod-db/requests", post({ wanted: " billing ", why: "Deploy reviewed migration" }))).json() as RequestView;
  const prepare = async (id: number, form = {}) => await (await app.request(`/api/prod-db/requests/${id}/prepare`, post(form))).json() as RequestView;
  const view = async (id: number) => await (await app.request(`/api/prod-db/requests/${id}`, { headers })).json() as RequestView;
  return { d, app, catalog, path, accessPath, create, prepare, view, counts: () => ({ executed, verified }), blocks: (b: Block[]) => { blocks = b; }, discoveryBlocks: (b: Block[]) => { discoveryBlocks = b; }, candidates: (c: typeof candidates) => { candidates = c; }, candidate };
}
async function until(fn: () => Promise<boolean>, ms = 1000) { const end = Date.now() + ms; do { if (await fn()) return; await Bun.sleep(5); } while (Date.now() < end); throw Error("state did not settle"); }

test("SQL cards expose access blockers and rejection without leaking the host plan or reopening decisions", async () => {
  const h = onboardingHarness();
  const block: Block = { code: "unsupported_engine", category: "configuration", message: "Unsupported database engine", action: "Install the engine adapter" };
  h.blocks([block]);
  const w = await (await h.app.request("/api/prod-db/billing/write",post({sql:"UPDATE items SET active=1"}))).json() as any;
  await h.prepare(w.requestId);
  const read = async () => await (await h.app.request(`/api/prod-db/writes/${w.id}`,{headers})).json() as any;
  const blocked = await read();
  expect(blocked.access.blocks).toEqual([block]); expect(blocked.access.engine).toBe("postgres");
  expect(blocked.access.plan).toBeUndefined(); expect(blocked.access.server).toBeUndefined();
  await h.app.request(`/api/prod-db/requests/${w.requestId}/reject`,post());
  const rejected = await read();
  expect(rejected.access.state).toBe("rejected"); expect(rejected.nextAction).toContain("rejected");
  expect(rejected.requestId).toBe(w.requestId); expect(h.counts().executed).toBe(0);
  expect((await h.app.request(`/api/prod-db/writes/${w.id}/reject`,post())).status).toBe(200);
  expect((await read()).code).toBeNull();
});

test("unknown DB -> verified target -> prepared Operations plan -> approval -> verification -> live catalog and separate SQL approval", async () => {
  const h = onboardingHarness();
  const unknown = await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN cash_reserve_amount numeric", scope: "migration", idempotencyKey: "migration-0011" }));
  expect(unknown.status).toBe(202);
  const write = await unknown.json() as { id: number; requestId: number; status: string };
  expect(write.status).toBe("blocked");
  const request = await h.create(); expect(request.id).toBe(write.requestId);
  const prepared = await h.prepare(request.id, { server: " acme ", db: " billing ", write: true, migrations: true });
  expect(prepared.state).toBe("awaiting_approval"); expect(prepared.plan!.entry.server).toBe("acme");
  expect(prepared.plan!.input.sshAlias).toBe(""); expect(h.counts().executed).toBe(0);
  const duplicate = await h.prepare(request.id); expect(duplicate.operationId).toBe(prepared.operationId);
  expect(loadCatalog(h.path).databases).toHaveLength(0);
  expect((await h.app.request(`/api/operations/${prepared.operationId}/approve`, post())).status).toBe(202);
  await until(async () => (await h.view(request.id)).state === "ready");
  expect(h.counts()).toEqual({ executed: 1, verified: 1 });
  expect(h.catalog.databases).toHaveLength(1); expect(readAccessFile(h.accessPath)["apps-invoice-creator"]!.write).toEqual(["billing"]);
  const url = await h.app.request("/api/prod-db/billing/url", { headers });
  expect(url.status).toBe(200); expect(await url.text()).toContain("devbox_billing_");
  const pending = await (await h.app.request(`/api/prod-db/writes/${write.id}`, { headers })).json() as { status: string };
  expect(pending.status).toBe("pending");
  expect((await h.app.request(`/api/operations/${prepared.operationId}/approve`, post())).status).toBe(409);
  expect(h.counts().executed).toBe(1);
});

test("legacy command/confirmation cannot write the catalog or claim verified access", async () => {
  const h = onboardingHarness(), r = await h.create();
  for (const route of ["command", "confirm"]) expect((await h.app.request(`/api/prod-db/requests/${r.id}/${route}`, post({ server: "acme" }))).status).toBe(410);
  expect(loadCatalog(h.path).databases).toHaveLength(0); expect(getDbRequest(h.d.db, r.id)!.status).toBe("pending");
});

test("access and SQL readiness each notify once across retries and polling", async () => {
  const h = onboardingHarness(), notifications: string[] = [];
  h.d.notify = (title) => { notifications.push(title); };
  const propose = () => h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN amount numeric", scope: "migration", idempotencyKey: "notify-once" }));
  const w = await (await propose()).json() as { id: number; requestId: number };
  await propose();
  expect(notifications).toEqual(["Database access requested"]);
  const p = await h.prepare(w.requestId);
  await h.app.request(`/api/operations/${p.operationId}/approve`, post());
  await until(async () => (await h.view(w.requestId)).state === "ready");
  for (let i = 0; i < 3; i++) await h.app.request(`/api/prod-db/writes/${w.id}`, { headers });
  await propose();
  expect(notifications.filter(n => n === "Production SQL awaiting approval")).toHaveLength(1);
  expect(notifications.filter(n => n === "Database access requested")).toHaveLength(1);
});

// Tapping the notification in the app opens "Production writes" directly — and both messages
// need something from a person, so they go out as blocked regardless of the text.
test("access and SQL notifications both carry the prodWrites target and blocked", async () => {
  const h = onboardingHarness(), extras: Record<string, unknown>[] = [];
  h.d.notify = (title, _m, extra) => { extras.push({ title, ...extra }); };
  const w = await (await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN amount numeric", scope: "migration", idempotencyKey: "notify-target" }))).json() as { id: number; requestId: number };
  expect(extras).toEqual([{ title: "Database access requested", target: { kind: "prodWrites" }, blocked: true }]);
  const p = await h.prepare(w.requestId);
  await h.app.request(`/api/operations/${p.operationId}/approve`, post());
  await until(async () => (await h.view(w.requestId)).state === "ready");
  await h.app.request(`/api/prod-db/writes/${w.id}`, { headers });
  expect(extras.find((e) => e.title === "Production SQL awaiting approval"))
    .toEqual({ title: "Production SQL awaiting approval", target: { kind: "prodWrites", id: String(w.id) }, blocked: true });
});

test("project/server confusion, invalid identifiers, occupied ports and all host blockers are shown early", async () => {
  const h = onboardingHarness(), r = await h.create();
  const wrong = await h.prepare(r.id, { server: "apps-invoice-creator", hostPort: 80, roUser: "bad;sql" });
  expect(wrong.blocks.map(b => b.code)).toEqual(expect.arrayContaining(["unknown_server", "invalid_port", "invalid_identifier"]));
  h.blocks([{ code: "op_unavailable", category: "connection", message: "1Password unavailable", action: "Reconnect" }, { code: "ssh_failed", category: "connection", message: "SSH unavailable", action: "Check host" }]);
  const blocked = await h.prepare(r.id, { server: " acme ", db: " billing " });
  expect(blocked.state).toBe("blocked"); expect(blocked.blocks).toHaveLength(2); expect(blocked.operationId).toBeNull(); expect(h.counts().executed).toBe(0);
});

test("multiple matched databases require a short selection; a sole unverified candidate is never assumed", async () => {
  const h = onboardingHarness(), r = await h.create();
  h.candidates([h.candidate, { ...h.candidate, id: "other", container: "db456", environment: "staging" }]);
  expect((await h.prepare(r.id)).blocks.some(b => b.code === "target_selection")).toBe(true);
  expect((await h.prepare(r.id, { candidateId: h.candidate.id })).state).toBe("awaiting_approval");
});

test("failed preparation persists only selected target and global discovery blocks", async () => {
  const h = onboardingHarness(), r = await h.create();
  const global = { code: "vault_unavailable", category: "connection" as const, message: "Vault unavailable", action: "Unlock" };
  const own = { ...global, code: "coolify_permission", instance: "acme", candidateId: h.candidate.id };
  h.discoveryBlocks([global, own,
    { ...global, code: "server_mapping", instance: "infra", candidateId: "infra:other" },
    { ...global, code: "server_mapping", instance: "acme", candidateId: "acme:other" },
    { ...global, code: "target_choice", category: "decision" },
  ]);
  const result = await h.prepare(r.id, { candidateId: h.candidate.id, roUser: "invalid role" });
  expect(result.state).toBe("blocked");
  expect(result.blocks.map((b) => b.code)).toEqual(["vault_unavailable", "coolify_permission", "invalid_identifier"]);
  expect((await h.view(r.id)).blocks).toEqual(result.blocks);
  expect(result.operationId).toBeNull();
});

test("an unmatched request shows the selection, not other databases' mapping problems or empty-target noise", async () => {
  const h = onboardingHarness(), r = await h.create();
  h.candidates([{ ...h.candidate, matched: false }, { ...h.candidate, id: "infra:mine", matched: true, verified: false }]);
  const global = { code: "vault_unavailable", category: "connection" as const, message: "Vault unavailable", action: "Unlock" };
  h.discoveryBlocks([
    { ...global, code: "server_mapping", instance: "infra", candidateId: "infra:tracker" },
    { ...global, code: "server_mapping", instance: "infra", candidateId: "infra:mine" },
    global,
  ]);
  const result = await h.prepare(r.id);
  expect(result.blocks.map((b) => [b.code, b.candidateId])).toEqual([
    ["target_selection", undefined], ["server_mapping", "infra:mine"], ["vault_unavailable", undefined],
  ]);
});

test("manual key step resumes same plan and request; approval is still required", async () => {
  const h = onboardingHarness(), r = await h.create();
  h.blocks([{ code: "op_manual_items", category: "permission", message: "Create dedicated key", action: "1Password" }]);
  const blocked = await h.prepare(r.id); expect(blocked.state).toBe("blocked");
  h.blocks([]);
  const ready = await h.prepare(r.id); expect(ready.state).toBe("awaiting_approval"); expect(ready.plan!.fingerprint).toBe(blocked.plan!.fingerprint);
  expect(h.counts().executed).toBe(0);
});

test("rejection survives retry and prevents both execution and catalog writes", async () => {
  const h = onboardingHarness(), r = await h.create(), p = await h.prepare(r.id);
  expect((await h.app.request(`/api/operations/${p.operationId}/reject`, post())).status).toBe(204);
  expect((await h.create()).id).toBe(r.id); expect((await h.prepare(r.id)).state).toBe("rejected");
  expect((await h.app.request(`/api/operations/${p.operationId}/approve`, post())).status).toBe(409);
  expect(h.counts().executed).toBe(0);
});

test("simultaneous prepare/approve runs one setup; failed partial setup resumes same approved operation", async () => {
  let attempts = 0;
  const host: OnboardingHost = { preflight: async () => [], execute: async () => { await Bun.sleep(10); if (++attempts === 1) throw { block: { code: "ssh_failed", category: "connection", message: "SSH failed", action: "Retry" } }; }, verify: async () => {} };
  const h = onboardingHarness(host), r = await h.create();
  const [a, b] = await Promise.all([h.prepare(r.id), h.prepare(r.id)]); expect(a.operationId).toBe(b.operationId);
  const replies = await Promise.all([h.app.request(`/api/operations/${a.operationId}/approve`, post()), h.app.request(`/api/operations/${a.operationId}/approve`, post())]);
  expect(replies.map(r => r.status).sort()).toEqual([202, 409]);
  await until(async () => (await h.view(r.id)).state === "failed"); expect(loadCatalog(h.path).databases).toHaveLength(0);
  expect((await h.app.request(`/api/prod-db/requests/${r.id}/resume`, post())).status).toBe(202);
  await until(async () => (await h.view(r.id)).state === "ready"); expect(attempts).toBe(2);
  expect((await h.view(r.id)).operationId).toBe(a.operationId); expect(getOperation(h.d.db, a.operationId!)!.status).toBe("executed");
});

test("agents cannot approve setup, SQL or deployment from a container network", async () => {
  const h = onboardingHarness(), r = await h.create(), p = await h.prepare(r.id);
  h.d.remoteAddr = () => "172.18.0.2";
  for (const route of [`/api/operations/${p.operationId}/approve`, `/api/prod-db/writes/1/approve`, `/api/prod-db/requests/${r.id}/reject`]) expect((await h.app.request(route, post())).status).toBe(403);
  expect(h.counts().executed).toBe(0);
});

test("role verification failure never grants access or publishes the catalog", async () => {
  const h = onboardingHarness({ preflight: async () => [], execute: async () => {}, verify: async () => { throw { block: { code: "ro_verification_failed", category: "permission", message: "RO has CREATE", action: "Fix grants" } }; } });
  const r = await h.create(), p = await h.prepare(r.id);
  await h.app.request(`/api/operations/${p.operationId}/approve`, post());
  await until(async () => (await h.view(r.id)).state === "failed");
  expect(loadCatalog(h.path).databases).toHaveLength(0); expect(h.d.prodDbAccess).toEqual({});
});

test("existing verified read access can be extended by a separate migration-access operation", async () => {
  const h = onboardingHarness(), initial = await h.create(), readPlan = await h.prepare(initial.id);
  await h.app.request(`/api/operations/${readPlan.operationId}/approve`, post());
  await until(async () => (await h.view(initial.id)).state === "ready");
  expect(h.catalog.databases[0]!.rwUser).toBeUndefined();
  const write = await (await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN a int", scope: "migration" }))).json() as { requestId: number; status: string };
  expect(write.requestId).not.toBe(initial.id); expect(write.status).toBe("blocked");
  const upgrade = await h.prepare(write.requestId);
  expect(upgrade.state).toBe("awaiting_approval"); expect(upgrade.plan!.previousEntry?.name).toBe("billing");
  expect(upgrade.plan!.migrations).toBe(true);
  await h.app.request(`/api/operations/${upgrade.operationId}/approve`, post());
  await until(async () => (await h.view(write.requestId)).state === "ready");
  expect(h.catalog.databases).toHaveLength(1); expect(h.catalog.databases[0]!.migrationUser).toBe("billing_migration");
});

test("same physical database under another alias cannot create a second password identity", async () => {
  const h = onboardingHarness(), initial = await h.create(), p = await h.prepare(initial.id);
  await h.app.request(`/api/operations/${p.operationId}/approve`, post());
  await until(async () => (await h.view(initial.id)).state === "ready");
  const request = await (await h.app.request("/api/prod-db/requests", post({ wanted: "billing_copy", why: "alias" }))).json() as RequestView;
  const alias = await h.prepare(request.id, { candidateId: h.candidate.id });
  expect(alias.blocks.some(b => b.code === "target_already_catalogued")).toBe(true); expect(alias.operationId).toBeNull();
});

test("configured-but-failed proxy is a setup blocker and cannot issue unusable URLs", async () => {
  const h = onboardingHarness(); h.d.dbProxyReady = () => false;
  const r = await h.create(), p = await h.prepare(r.id);
  expect(p.blocks.some(b => b.code === "proxy_unavailable")).toBe(true); expect(p.operationId).toBeNull();
});

test("an access scope expansion (scope updated) carries the prodWrites target and blocked", async () => {
  const h = onboardingHarness(), extras: Record<string, unknown>[] = [];
  h.d.notify = (title, _m, extra) => { extras.push({ title, ...extra }); };
  await h.app.request("/api/prod-db/billing/url", { headers }); // read request
  await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN scope_up int", scope: "migration", idempotencyKey: "scope-up" }));
  expect(extras.find((e) => e.title === "Database access scope updated"))
    .toEqual({ title: "Database access scope updated", target: { kind: "prodWrites" }, blocked: true });
});

test("read-first unknown database request promotes to the later migration before preparation", async () => {
  const h = onboardingHarness();
  const unknown = await (await h.app.request("/api/prod-db/billing/url", { headers })).json() as { requestId: number };
  const write = await (await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN before_prepare int", scope: "migration", idempotencyKey: "read-first" }))).json() as { id: number; requestId: number; status: string };
  expect(write.requestId).toBe(unknown.requestId);
  expect((await h.view(write.requestId)).requested_scope).toBe("migration");
  await h.create(); // A subsequent read request cannot downgrade the pending SQL requirement.
  expect((await h.view(write.requestId)).requested_scope).toBe("migration");
  const plan = await h.prepare(write.requestId);
  expect(plan.plan!.write).toBe(true); expect(plan.plan!.migrations).toBe(true);
  expect(h.d.db.query("SELECT COUNT(*) AS n FROM db_requests").get()).toEqual({ n: 1 });
});

test("scope promotion rebuilds a saved blocked read plan before creating its approval", async () => {
  const h = onboardingHarness(), r = await h.create();
  h.blocks([{ code: "op_manual_items", category: "configuration", message: "Vault setup needed", action: "Resolve" }]);
  const read = await h.prepare(r.id); expect(read.plan!.write).toBe(false); expect(read.operationId).toBeNull();
  await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN after_block int", scope: "migration" }));
  h.blocks([]);
  const migration = await h.prepare(r.id);
  expect(migration.plan!.migrations).toBe(true); expect(migration.plan!.fingerprint).not.toBe(read.plan!.fingerprint);
  expect(migration.state).toBe("awaiting_approval"); expect(h.counts().executed).toBe(0);
});

test("immutable read plan remains unchanged and polling the same blocked SQL creates one migration followup after read access is ready", async () => {
  const h = onboardingHarness(), r = await h.create(), read = await h.prepare(r.id);
  const write = await (await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN after_ready int", scope: "migration", idempotencyKey: "immutable-read" }))).json() as { id: number; requestId: number };
  expect(write.requestId).toBe(r.id);
  const unchanged = await h.prepare(r.id);
  expect(unchanged.plan!.fingerprint).toBe(read.plan!.fingerprint); expect(unchanged.plan!.migrations).toBe(false);
  expect(unchanged.requested_scope).toBe("read");
  await h.app.request(`/api/operations/${read.operationId}/approve`, post());
  await until(async () => (await h.view(r.id)).state === "ready");
  const polls = await Promise.all(Array.from({ length: 3 }, async () => await (await h.app.request(`/api/prod-db/writes/${write.id}`, { headers })).json() as { id: number; requestId: number; status: string }));
  const followup = polls[0]!;
  expect(followup.id).toBe(write.id); expect(followup.status).toBe("blocked"); expect(followup.requestId).not.toBe(r.id);
  expect(polls.every((poll) => poll.requestId === followup.requestId)).toBe(true);
  expect(h.d.db.query("SELECT COUNT(*) AS n FROM db_requests").get()).toEqual({ n: 2 });
  expect(h.d.db.query("SELECT COUNT(*) AS n FROM prod_writes").get()).toEqual({ n: 1 });
  const upgrade = await h.prepare(followup.requestId); expect(upgrade.plan!.migrations).toBe(true);
  expect(upgrade.operationId).not.toBe(read.operationId);
  await h.app.request(`/api/operations/${upgrade.operationId}/approve`, post());
  await until(async () => (await h.view(followup.requestId)).state === "ready");
  const pending = await (await h.app.request(`/api/prod-db/writes/${write.id}`, { headers })).json() as { id: number; status: string };
  expect(pending).toMatchObject({ id: write.id, status: "pending" });
});

test("scope change during async preflight cannot publish a stale read approval or duplicate concurrent preparation", async () => {
  let entered = false, release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const h = onboardingHarness({ preflight: async () => { if (!entered) { entered = true; await barrier; } return []; }, execute: async () => {}, verify: async () => {} });
  const r = await h.create();
  const first = h.prepare(r.id);
  await until(async () => entered);
  await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN concurrent_scope int", scope: "migration" }));
  const second = h.prepare(r.id);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.plan!.migrations).toBe(true); expect(a.operationId).toBe(b.operationId);
  expect(h.d.db.query("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1 });
  expect(a.plan!.fingerprint).toBe(b.plan!.fingerprint);
});

test("a rejected read request remains terminal when a blocked migration is polled", async () => {
  const h = onboardingHarness(), r = await h.create();
  await h.app.request(`/api/prod-db/requests/${r.id}/reject`, post());
  const w = await (await h.app.request("/api/prod-db/billing/write", post({ sql: "ALTER TABLE invoices ADD COLUMN denied_scope int", scope: "migration" }))).json() as { id: number; requestId: number };
  for (let n = 0; n < 3; n++) await h.app.request(`/api/prod-db/writes/${w.id}`, { headers });
  expect(w.requestId).toBe(r.id); expect((await h.view(r.id)).state).toBe("rejected");
  expect(h.d.db.query("SELECT COUNT(*) AS n FROM db_requests").get()).toEqual({ n: 1 });
});


test("automatic verified onboarding reaches ready without approving pending SQL", async () => {
  const h = onboardingHarness(undefined, true);
  const response = await h.app.request("/api/prod-db/billing/write", post({
    sql: "ALTER TABLE invoices ADD COLUMN example text", scope: "migration", idempotencyKey: "auto-setup-regression",
  }));
  const write = await response.json() as { id: number; requestId: number };
  await h.prepare(write.requestId, { server: "acme", db: "billing", write: true, migrations: true });
  await until(async () => (await h.view(write.requestId)).state === "ready");
  expect(h.counts()).toEqual({ executed: 1, verified: 1 });
  const proposal = await (await h.app.request(`/api/prod-db/writes/${write.id}`, { headers })).json() as { status: string };
  expect(proposal.status).toBe("pending");
});

// Final review I4: a database request from a shared/tainted session carries a label
// in the notification and in the Mac dialog (a terminal guest could have sent it).
test("I4: a database request from a shared session is labelled in the notification and the dialog", async () => {
  const notes: string[] = [];
  const dialogs: { shared?: boolean }[] = [];
  const h0 = onboardingHarness();
  const deps = { ...h0.d, dind: true, notify: (t: string) => { notes.push(t); },
    listener: { ...h0.d.listener, dbRequest: async (row: { shared?: boolean }) => { dialogs.push(row); } } };
  insertSession(deps.db, { id: session, folder: "apps", project: "apps", repo: "invoice-creator", container: session, port_base: 45100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 });
  const app = createApp(deps);
  expect((await app.request(`/api/sessions/${session}/shares`, post({ minutes: 30 }))).status).toBe(201);
  await app.request("/api/prod-db/requests", post({ wanted: "billing", why: "read" }));
  expect(notes).toEqual(["Database access requested (from a shared session)"]);
  expect(dialogs[0]?.shared).toBe(true);
});
