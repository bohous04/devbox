import { expect, test } from "bun:test";
import { insertWorkInterval, listWorkIntervals, openDb, type WorkIntervalInput } from "../src/db";

function iv(over: Partial<WorkIntervalInput> = {}): WorkIntervalInput {
  return {
    session_id: "dev-shop-cms", project: "shop", repo: "cms",
    started_at: 1_000, ended_at: 61_000, seconds: 60, capped: 0, ...over,
  };
}

test("writes and reads intervals in a range, ascending", () => {
  const db = openDb(":memory:");
  insertWorkInterval(db, iv({ started_at: 3_000, ended_at: 4_000, seconds: 1 }));
  insertWorkInterval(db, iv({ started_at: 1_000, ended_at: 2_000, seconds: 1 }));
  const rows = listWorkIntervals(db, 0, 10_000);
  expect(rows.map((r) => r.started_at)).toEqual([1_000, 3_000]);
  expect(rows[0].project).toBe("shop");
});

test("range filters by interval start", () => {
  const db = openDb(":memory:");
  insertWorkInterval(db, iv({ started_at: 500 }));
  insertWorkInterval(db, iv({ started_at: 5_000 }));
  expect(listWorkIntervals(db, 1_000, 10_000)).toHaveLength(1);
});

test("capped is stored and read", () => {
  const db = openDb(":memory:");
  insertWorkInterval(db, iv({ capped: 1, seconds: 1_800 }));
  expect(listWorkIntervals(db, 0, 10_000)[0].capped).toBe(1);
});

test("empty range returns nothing", () => {
  const db = openDb(":memory:");
  expect(listWorkIntervals(db, 0, 10)).toEqual([]);
});
