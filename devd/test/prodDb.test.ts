import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCatalog, dbEntry, roUrl, entitledDbs, keysForProject, prodKeyMounts,
  addGrant, grantAccess, mergeAccess, readAccessFile, reloadCatalog, type Access,
} from "../src/prodDb";

const CAT = join(import.meta.dir, "..", "..", "image", "prod-db", "catalog.json");

test("loadCatalog + dbEntry: finds the DB and joins it with its server", () => {
  const cat = loadCatalog(CAT);
  const e = dbEntry(cat, "ledger_app");
  expect(e?.server).toBe("shop");
  expect(e?.hostPort).toBe(15501);
  expect(cat.servers[e!.server].host).toBe("192.0.2.11");
  expect(dbEntry(cat, "neexistuje")).toBeUndefined();
});

test("roUrl: postgres vs mysql, password filled in, sslmode disable", () => {
  const cat = loadCatalog(CAT);
  const pg = dbEntry(cat, "ledger_app")!;
  expect(roUrl(pg, "S3cr3t")).toBe("postgresql://ledger_ro:S3cr3t@127.0.0.1:15501/ledger_app?sslmode=disable");
  const my = { name: "x", server: "infra", engine: "mysql" as const, hostPort: 15511, db: "x", roUser: "x_ro", opItem: "o" };
  expect(roUrl(my, "p")).toBe("mysql://x_ro:p@127.0.0.1:15511/x");
});

test("entitledDbs: read/write separately, project without an entry → empty", () => {
  const acc = { "shop-Ledger-App": { read: ["ledger_app"], write: ["ledger_app"] } };
  expect(entitledDbs(acc, "shop-Ledger-App", "read")).toEqual(["ledger_app"]);
  expect(entitledDbs(acc, "shop-Ledger-App", "write")).toEqual(["ledger_app"]);
  expect(entitledDbs({ p: { read: ["x"] } }, "p", "write")).toEqual([]);
  expect(entitledDbs({}, "other", "read")).toEqual([]);
});

test("keysForProject: unique server keys of entitled DBs (read ∪ write)", () => {
  const cat = loadCatalog(CAT);
  expect(keysForProject(cat, { "shop-Ledger-App": { read: ["ledger_app"] } }, "shop-Ledger-App")).toEqual(["prod-tunnel-shop"]);
  expect(keysForProject(cat, { p: { write: ["ledger_app"] } }, "p")).toEqual(["prod-tunnel-shop"]);
  expect(keysForProject(cat, {}, "x")).toEqual([]);
});

test("prodKeyMounts: a bind mount for each entitled key, otherwise empty", async () => {
  const cat = loadCatalog(CAT);
  const mounts = await prodKeyMounts(cat, { "shop-Ledger-App": { read: ["ledger_app"] } }, "shop-Ledger-App", (k) => `/tmp/keys/${k}`);
  expect(mounts).toEqual(["/tmp/keys/prod-tunnel-shop:/home/dev/.ssh/prod-tunnel-shop:ro"]);
  expect(await prodKeyMounts(cat, {}, "x", (k) => k)).toEqual([]);
});

test("mergeAccess: entitlements from the repo and the host are merged, nothing is overwritten", () => {
  const repo = { p: { read: ["a"], write: ["a"] } };
  const host = { p: { read: ["b"] }, q: { read: ["c"] } };
  expect(mergeAccess(repo, host)).toEqual({ p: { read: ["a", "b"], write: ["a"] }, q: { read: ["c"] } });
  expect(repo.p.read).toEqual(["a"]);                        // inputs stay untouched
});

test("addGrant: adds an entitlement once, the second call changes nothing", () => {
  const acc: Record<string, Access> = {};
  expect(addGrant(acc, "p", "eshop", "read")).toBe(true);
  expect(addGrant(acc, "p", "eshop", "read")).toBe(false);
  expect(addGrant(acc, "p", "eshop", "write")).toBe(true);
  expect(acc).toEqual({ p: { read: ["eshop"], write: ["eshop"] } });
});

test("grantAccess: writes the entitlement to disk; a missing file is not an error", () => {
  const path = join(mkdtempSync(join(tmpdir(), "acc-")), "access.json");
  expect(readAccessFile(path)).toEqual({});
  grantAccess(path, "p", "eshop", false);
  expect(readAccessFile(path)).toEqual({ p: { read: ["eshop"] } });
  grantAccess(path, "p", "eshop", true);                     // the second call only adds write
  expect(readAccessFile(path)).toEqual({ p: { read: ["eshop"], write: ["eshop"] } });
});

test("reloadCatalog: the in-memory catalog takes over the file contents, the reference stays", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cat-")), "catalog.json");
  const cat = loadCatalog(CAT);
  const extra = { ...cat.databases[0]!, name: "dalsi", hostPort: 15599 };
  writeFileSync(path, JSON.stringify({ servers: cat.servers, databases: [...cat.databases, extra] }));
  reloadCatalog(cat, path);
  expect(dbEntry(cat, "dalsi")?.hostPort).toBe(15599);
});
