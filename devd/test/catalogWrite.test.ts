import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addDatabase, loadCatalog, type Catalog } from "../src/prodDb";

function catalogFile(): string {
  const p = join(mkdtempSync(join(tmpdir(), "cat-")), "catalog.json");
  const c: Catalog = {
    servers: { shop: { host: "1.2.3.4", port: 2222, user: "main", key: "prod-tunnel-shop" } },
    databases: [],
  };
  writeFileSync(p, JSON.stringify(c, null, 2));
  return p;
}

const entry = { name: "eshop", server: "shop", engine: "postgres" as const, hostPort: 15502, db: "eshop", roUser: "eshop_ro", opItem: "prod-ro eshop" };

test("a new database is written and visible after reloading", () => {
  const p = catalogFile();
  addDatabase(p, entry);
  expect(loadCatalog(p).databases.map((d) => d.name)).toEqual(["eshop"]);
});

test("writing leaves the servers alone", () => {
  const p = catalogFile();
  addDatabase(p, entry);
  expect(Object.keys(loadCatalog(p).servers)).toEqual(["shop"]);
});

test("a duplicate name is rejected, not silently overwritten", () => {
  const p = catalogFile();
  addDatabase(p, entry);
  expect(() => addDatabase(p, entry)).toThrow(/eshop/);
});

test("a database on an unknown server is rejected", () => {
  const p = catalogFile();
  expect(() => addDatabase(p, { ...entry, server: "missing" })).toThrow(/missing/);
});

test("a taken port is rejected — the tunnel cannot tell two DBs on the same port apart", () => {
  const p = catalogFile();
  addDatabase(p, entry);
  expect(() => addDatabase(p, { ...entry, name: "other", db: "other" })).toThrow(/15502/);
});

test("the file stays readable JSON after a write", () => {
  const p = catalogFile();
  addDatabase(p, entry);
  expect(() => JSON.parse(readFileSync(p, "utf8"))).not.toThrow();
});
