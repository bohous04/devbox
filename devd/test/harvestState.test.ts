import { expect, test } from "bun:test";
import { getHarvestState, openDb, setHarvestState } from "../src/db";

test("get/set: JSON roundtrip, upsert, izolace podle source", () => {
  const db = openDb(":memory:");
  expect(getHarvestState(db, "grok")).toBeNull();
  setHarvestState(db, "grok", { offset: 42 });
  setHarvestState(db, "codex", { sinceSec: 7 });
  expect(getHarvestState<{ offset: number }>(db, "grok")!.offset).toBe(42);
  setHarvestState(db, "grok", { offset: 99 });
  expect(getHarvestState<{ offset: number }>(db, "grok")!.offset).toBe(99);
  expect(getHarvestState<{ sinceSec: number }>(db, "codex")!.sinceSec).toBe(7);
});
