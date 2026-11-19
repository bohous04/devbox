import { expect, test } from "bun:test";
import { add } from "./critic-probe";

test("add returns the sum of its arguments", () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-2, 3)).toBe(1);
  expect(add(0, 0)).toBe(0);
});
