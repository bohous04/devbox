import { expect, test } from "bun:test";
import { createDbTargets } from "../src/dbTargets";
import type { DbEntry } from "../src/prodDb";

const entry = { name: "shop", server: "s1", engine: "postgres", hostPort: 15501, db: "shop", roUser: "shop_ro", opItem: "shop pw" } as DbEntry;
const targets = () => createDbTargets({ entries: () => [entry] });

test("a placeholder can be mapped back to its target and session", () => {
  const t = targets();
  const cred = t.issue("dev-a-b", "shop");
  expect(t.resolve(cred.user)).toMatchObject({ session: "dev-a-b" });
  expect(t.resolve(cred.user)!.entry.name).toBe("shop");
});

test("the placeholder user carries the database name so the log stays readable", () => {
  expect(targets().issue("dev-a-b", "shop").user.startsWith("devbox_shop_")).toBe(true);
});

test("the placeholder password is non-empty and different every time", () => {
  const t = targets();
  const a = t.issue("dev-a-b", "shop"), b = t.issue("dev-a-b", "shop");
  expect(a.password.length).toBeGreaterThan(16);
  expect(a.password).not.toBe(b.password);
});

test("revoking a session invalidates only its placeholders", () => {
  const t = targets();
  const mine = t.issue("dev-a-b", "shop");
  const other = t.issue("dev-c-d", "shop");
  t.revoke("dev-a-b");
  expect(t.resolve(mine.user)).toBeUndefined();
  expect(t.resolve(other.user)).toBeDefined();
});

test("an unknown database is not issued", () => {
  expect(() => targets().issue("dev-a-b", "neexistuje")).toThrow(/neexistuje/);
});

test("an unknown user maps to nothing", () => {
  expect(targets().resolve("postgres")).toBeUndefined();
});
