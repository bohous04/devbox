import { expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/api";
import { fakeDeps } from "./helpers/apiHarness";
import { createDbTargets, type DbTargets } from "../src/dbTargets";
import { loadCatalog } from "../src/prodDb";

const catalog = loadCatalog(join(import.meta.dir, "..", "..", "image", "prod-db", "catalog.json"));
const access = { "shop-Ledger-App": { read: ["ledger_app"] } };
const hdr = { headers: { "x-devbox-session": "dev-shop-Ledger-App" } };

function app(targets: DbTargets = createDbTargets({ entries: () => catalog.databases })) {
  return createApp(fakeDeps({
    prodCatalog: catalog, prodDbAccess: access,
    readProdSecret: () => "SKUTECNE_HESLO",
    dbTargets: targets, dbProxyHost: "172.17.0.1:15432",
  }));
}

test("the issued URL does not contain the real password", async () => {
  const r = await app().request("/api/prod-db/ledger_app/url", hdr);
  const url = await r.text();
  expect(r.status).toBe(200);
  expect(url).not.toContain("SKUTECNE_HESLO");
});

test("the URL points to the proxy, not to the database", async () => {
  const url = await (await app().request("/api/prod-db/ledger_app/url", hdr)).text();
  expect(url).toContain("172.17.0.1:15432");
});

test("the user in the URL is a placeholder that traces back to the session", async () => {
  const targets = createDbTargets({ entries: () => catalog.databases });
  const url = await (await app(targets).request("/api/prod-db/ledger_app/url", hdr)).text();
  const user = new URL(url).username;
  expect(user.startsWith("devbox_ledger_app_")).toBe(true);
  expect(targets.resolve(user)?.session).toBe("dev-shop-Ledger-App");
});

test("a foreign project gets neither a placeholder nor a 200", async () => {
  const r = await app().request("/api/prod-db/ledger_app/url", { headers: { "x-devbox-session": "dev-blog-web" } });
  expect(r.status).toBe(403);
});
