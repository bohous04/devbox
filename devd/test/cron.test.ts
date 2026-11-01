import { expect, test } from "bun:test";
import { cronMatch, validCron } from "../src/cron";

const at = (y: number, mo: number, day: number, h: number, mi: number) => new Date(y, mo - 1, day, h, mi, 0);

test("asterisks = every minute", () => { expect(cronMatch("* * * * *", at(2026, 7, 9, 3, 0))).toBe(true); });
test("specific time 3:00", () => {
  expect(cronMatch("0 3 * * *", at(2026, 7, 9, 3, 0))).toBe(true);
  expect(cronMatch("0 3 * * *", at(2026, 7, 9, 3, 1))).toBe(false);
  expect(cronMatch("0 3 * * *", at(2026, 7, 9, 4, 0))).toBe(false);
});
test("day of week (Monday = 1)", () => {
  // 2026-07-13 is a Monday
  expect(cronMatch("0 9 * * 1", at(2026, 7, 13, 9, 0))).toBe(true);
  expect(cronMatch("0 9 * * 1", at(2026, 7, 14, 9, 0))).toBe(false);
});
test("step and range and list", () => {
  expect(cronMatch("*/15 * * * *", at(2026, 7, 9, 3, 30))).toBe(true);
  expect(cronMatch("*/15 * * * *", at(2026, 7, 9, 3, 31))).toBe(false);
  expect(cronMatch("0 9-17 * * *", at(2026, 7, 9, 12, 0))).toBe(true);
  expect(cronMatch("0 9-17 * * *", at(2026, 7, 9, 18, 0))).toBe(false);
  expect(cronMatch("0 0 1,15 * *", at(2026, 7, 15, 0, 0))).toBe(true);
});
test("both DOM and DOW restricted → union (standard cron)", () => {
  // 2026-07-13 is a Monday, not the 1st → passes via DOW
  expect(cronMatch("0 0 1 * 1", at(2026, 7, 13, 0, 0))).toBe(true);
});
test("invalid expression → false / validCron false", () => {
  expect(cronMatch("60 * * * *", at(2026, 7, 9, 3, 0))).toBe(false);
  expect(cronMatch("* * *", at(2026, 7, 9, 3, 0))).toBe(false);
  expect(validCron("0 3 * * *")).toBe(true);
  expect(validCron("nonsense")).toBe(false);
  expect(validCron("70 3 * * *")).toBe(false);
});
