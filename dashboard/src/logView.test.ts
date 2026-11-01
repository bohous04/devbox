import { expect, test } from "bun:test";
import { LOG_GROUPS, pageCount, toggle, typesForGroups, ungroupedTypes } from "./logView";

const ALL = ["agent_done", "agent_blocked", "cc_upgraded", "prod_write_executed", "brand_new_type"];

test("groups have unique ids and no type is in two groups", () => {
  expect(new Set(LOG_GROUPS.map((g) => g.id)).size).toBe(LOG_GROUPS.length);
  const all = LOG_GROUPS.flatMap((g) => g.types);
  expect(new Set(all).size).toBe(all.length);
});

test("ungroupedTypes finds types that fall into no group", () => {
  expect(ungroupedTypes(ALL)).toEqual(["brand_new_type"]);
});

test("empty selection = no filter", () => {
  expect(typesForGroups([], ALL)).toEqual([]);
});

test("selecting a group expands only to types actually present in the data", () => {
  const t = typesForGroups(["agent"], ALL);
  expect(t.sort()).toEqual(["agent_blocked", "agent_done"]);
  // group types not present in the data (agent_stuck) are not added
  expect(t).not.toContain("agent_stuck");
});

test("several groups at once merge without duplicates", () => {
  const t = typesForGroups(["agent", "cc"], ALL);
  expect(t.sort()).toEqual(["agent_blocked", "agent_done", "cc_upgraded"]);
});

test("the other group covers types that are in no group", () => {
  expect(typesForGroups(["other"], ALL)).toEqual(["brand_new_type"]);
});

test("a group without a single existing type filters to NOTHING, not everything", () => {
  // otherwise checking an empty group would look like "clear filter"
  const t = typesForGroups(["schedule"], ALL);
  expect(t).not.toEqual([]);
  expect(t.some((x) => ALL.includes(x))).toBe(false);
});

test("toggle adds and removes", () => {
  expect(toggle([], "agent")).toEqual(["agent"]);
  expect(toggle(["agent"], "agent")).toEqual([]);
  expect(toggle(["agent"], "cc")).toEqual(["agent", "cc"]);
});

test("pageCount is always at least 1", () => {
  expect(pageCount(0, 50)).toBe(1);
  expect(pageCount(1, 50)).toBe(1);
  expect(pageCount(50, 50)).toBe(1);
  expect(pageCount(51, 50)).toBe(2);
  expect(pageCount(200, 50)).toBe(4);
});
