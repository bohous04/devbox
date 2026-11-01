import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createDbRequest, getDbRequest, listDbRequests, setDbRequestStatus, serverReady } from "../src/dbRequests";
import type { Catalog } from "../src/prodDb";

const catalog = {
  servers: { shop: { host: "1.2.3.4", port: 2222, user: "main", key: "prod-tunnel-shop" } },
  databases: [],
} as Catalog;

test("a request is stored as pending together with its description", () => {
  const db = openDb(":memory:");
  const id = createDbRequest(db, { session: "dev-shop-web", project: "shop", wanted: "eshop", why: "read orders" });
  const r = getDbRequest(db, id)!;
  expect(r.status).toBe("pending");
  expect(r.wanted).toBe("eshop");
  expect(r.why).toBe("read orders");
});

test("the same session does not create a second request for the same database", () => {
  const db = openDb(":memory:");
  const a = createDbRequest(db, { session: "s1", project: "p", wanted: "eshop", why: "x" });
  const b = createDbRequest(db, { session: "s1", project: "p", wanted: "eshop", why: "x" });
  expect(b).toBe(a);                              // the agent hits it repeatedly; the queue does not fill up
  expect(listDbRequests(db, {}).length).toBe(1);
});

test("a rejection stays stable across automatic retries", () => {
  const db = openDb(":memory:");
  const a = createDbRequest(db, { session: "s1", project: "p", wanted: "eshop", why: "x" });
  setDbRequestStatus(db, a, "rejected");
  const b = createDbRequest(db, { session: "s1", project: "p", wanted: "eshop", why: "x" });
  expect(b).toBe(a);
});

test("filter by status", () => {
  const db = openDb(":memory:");
  const a = createDbRequest(db, { session: "s1", project: "p", wanted: "a", why: "x" });
  createDbRequest(db, { session: "s1", project: "p", wanted: "b", why: "x" });
  setDbRequestStatus(db, a, "approved", { note: "hotovo" });
  expect(listDbRequests(db, { status: "pending" }).length).toBe(1);
  expect(getDbRequest(db, a)!.note).toBe("hotovo");
});

test("a server without a tunnel key in 1P is not ready", () => {
  expect(serverReady(catalog, "shop", ["SSH Key - MacBook"])).toEqual({ ready: false, missingKey: "prod-tunnel-shop" });
});

test("a server with a key is ready", () => {
  expect(serverReady(catalog, "shop", ["prod-tunnel-shop"])).toEqual({ ready: true });
});

test("an unknown server is reported as unknown, not as not ready", () => {
  const r = serverReady(catalog, "neexistuje", ["prod-tunnel-shop"]);
  expect(r.ready).toBe(false);
  if (!r.ready) expect(r.unknownServer).toBe(true);
});
