import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { insertSession, openDb } from "../src/db";
import { allocatePortBase, NoPortsError } from "../src/ports";

const s = DEFAULT_CONFIG.settings;
const fake = (id: string, port_base: number) => ({
  id, folder: "apps", project: "apps", repo: id, container: id, port_base,
  status: "running" as const, solo: 0 as const, created_at: 0, last_active_at: 0, important: 0 as const,
});

test("allocates lowest free block and reuses gaps", () => {
  const db = openDb(":memory:");
  expect(allocatePortBase(db, s)).toBe(40100);
  insertSession(db, fake("a", 40100));
  insertSession(db, fake("b", 40110));
  expect(allocatePortBase(db, s)).toBe(40120);
  db.query(`DELETE FROM sessions WHERE id='a'`).run();
  expect(allocatePortBase(db, s)).toBe(40100);
});

test("a new block must not overlap an existing one, even after shrinking portsPerSession", () => {
  const db = openDb(":memory:");
  // A session created under the old setting holds 40100-40109.
  insertSession(db, fake("a", 40100));
  // The new setting has blocks of five — a naive allocator offers 40105, which lies
  // INSIDE the range of session "a". Docker would not start that container.
  const base = allocatePortBase(db, { ...s, portsPerSession: 5, portRangeStart: 40100 });
  expect(base).toBeGreaterThanOrEqual(40110);
});

test("overlap is detected from the other side too (the new block starts earlier and reaches into the old one)", () => {
  const db = openDb(":memory:");
  insertSession(db, fake("a", 40105));
  const base = allocatePortBase(db, { ...s, portsPerSession: 10, portRangeStart: 40100 });
  expect(base).not.toBe(40100);   // 40100-40109 zasahuje do 40105
});

test("an exhausted range still reports NoPortsError, not a silent overlap", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 100; i++) insertSession(db, fake(`s${i}`, 40100 + i * 5));
  expect(() => allocatePortBase(db, { ...s, portsPerSession: 5, portRangeStart: 40100 }))
    .toThrow(NoPortsError);
});
