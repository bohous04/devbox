import { expect, test } from "bun:test";
import { clampExecTimeout, MAX_EXEC_TIMEOUT_MS } from "../src/instabox/client";

test("clampExecTimeout keeps the timeout within the InstaBox exec API range", () => {
  expect(MAX_EXEC_TIMEOUT_MS).toBe(600_000);
  expect(clampExecTimeout(undefined)).toBe(600_000);
  expect(clampExecTimeout(0)).toBe(600_000);
  expect(clampExecTimeout(-5)).toBe(600_000);
  expect(clampExecTimeout(Number.NaN)).toBe(600_000);
  expect(clampExecTimeout(90_000)).toBe(90_000);
  expect(clampExecTimeout(15 * 60_000)).toBe(600_000);
  expect(clampExecTimeout(1234.7)).toBe(1234);
});
