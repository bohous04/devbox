import { expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/api";
import { fakeDeps } from "./helpers/apiHarness";
import { loadCatalog } from "../src/prodDb";
import { getDbRequest, listDbRequests, setDbRequestStatus } from "../src/dbRequests";

const catalog = loadCatalog(join(import.meta.dir, "..", "..", "image", "prod-db", "catalog.json"));
const access = { "shop-Ledger-App": { read: ["ledger_app"] } };
const hdr = { headers: { "x-devbox-session": "dev-shop-Ledger-App" } };
const deps = (over = {}) => fakeDeps({ prodCatalog: catalog, prodDbAccess: access, readProdSecret: () => "PW", ...over });

test("an unknown database creates a request instead of a bare 404", async () => {
  const d = deps();
  const r = await createApp(d).request("/api/prod-db/eshop/url", hdr);
  expect(r.status).toBe(404);
  const body = await r.text();
  expect(body).toContain("request #");                  // the agent learns what happened
  expect(listDbRequests(d.db, {}).length).toBe(1);
});

test("repeated hits do not fill the queue", async () => {
  const d = deps();
  const app = createApp(d);
  await app.request("/api/prod-db/eshop/url", hdr);
  await app.request("/api/prod-db/eshop/url", hdr);
  expect(listDbRequests(d.db, {}).length).toBe(1);
});

test("a known database does not create a request", async () => {
  const d = deps({ dbTargets: undefined });
  await createApp(d).request("/api/prod-db/ledger_app/url", hdr);
  expect(listDbRequests(d.db, {}).length).toBe(0);
});

test("an explicit request through the API carries a description", async () => {
  const d = deps();
  const r = await createApp(d).request("/api/prod-db/requests", {
    method: "POST", headers: { ...hdr.headers, "content-type": "application/json" },
    body: JSON.stringify({ wanted: "eshop", why: "read orders" }),
  });
  expect(r.status).toBe(200);
  expect(listDbRequests(d.db, {})[0]!.why).toBe("read orders");
  expect(listDbRequests(d.db, {})[0]!.requested_scope).toBe("read");
});

test("explicit migration access gets its own request after approved read access", async () => {
  const d = deps(), app = createApp(d), originalAccess = structuredClone(d.prodDbAccess);
  const request = (scope: string) => app.request("/api/prod-db/requests", {
    method: "POST", headers: { ...hdr.headers, "content-type": "application/json" },
    body: JSON.stringify({ wanted: "fixture_scope", why: "Prepare reviewed access only", scope }),
  });
  const read = await (await request("read")).json() as any;
  const plan = JSON.stringify({ requestedScope: "read", write: false, migrations: false, fingerprint: "original-read-plan" });
  setDbRequestStatus(d.db, read.id, "approved");
  d.db.query("INSERT INTO db_onboarding(request_id,state,plan,blocks,updated_at) VALUES(?,?,?,?,?)")
    .run(read.id, "ready", plan, "[]", Date.now());
  const response = await request("migration");
  expect(response.status).toBe(200);
  const migration = await response.json() as any;
  expect(migration.requested_scope).toBe("migration");
  expect(migration.id).not.toBe(read.id);
  expect(migration.status).toBe("pending");
  expect(migration.plan).toBeNull();
  expect(migration.operationId).toBeNull();
  expect(getDbRequest(d.db, read.id)?.requested_scope).toBe("read");
  expect(getDbRequest(d.db, read.id)?.status).toBe("approved");
  expect(d.db.query("SELECT state,plan FROM db_onboarding WHERE request_id=?").get(read.id)).toEqual({ state: "ready", plan });
  expect(d.prodDbAccess).toEqual(originalAccess);
  expect((await (await request("migration")).json() as any).id).toBe(migration.id);
});

test("unsupported explicit access scopes are rejected before creating a request", async () => {
  const d = deps(), app = createApp(d);
  for (const scope of ["admin", null, true, []]) {
    const response = await app.request("/api/prod-db/requests", {
      method: "POST", headers: { ...hdr.headers, "content-type": "application/json" },
      body: JSON.stringify({ wanted: "fixture_scope", why: "Prepare reviewed access only", scope }),
    });
    expect(response.status).toBe(400);
  }
  expect(listDbRequests(d.db)).toHaveLength(0);
});

test("a request without a description is rejected — approving blind makes no sense", async () => {
  const d = deps();
  const r = await createApp(d).request("/api/prod-db/requests", {
    method: "POST", headers: { ...hdr.headers, "content-type": "application/json" },
    body: JSON.stringify({ wanted: "eshop" }),
  });
  expect(r.status).toBe(400);
});

test("the request list is visible in the API", async () => {
  const d = deps();
  const app = createApp(d);
  await app.request("/api/prod-db/eshop/url", hdr);
  const rows = await (await app.request("/api/prod-db/requests")).json() as { wanted: string }[];
  expect(rows[0]!.wanted).toBe("eshop");
});
