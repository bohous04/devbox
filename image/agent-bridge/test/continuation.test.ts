import { expect, test } from "bun:test";
import { CONTINUATION_TEXT, mayContinue } from "../src/continuation";

const MIN = 60_000;

test("allows the 3rd within 5 min, refuses the 4th", () => {
  const now = 10 * MIN;
  expect(mayContinue([], now)).toBe(true);
  expect(mayContinue([now - 2 * MIN, now - MIN], now)).toBe(true);
  expect(mayContinue([now - 3 * MIN, now - 2 * MIN, now - MIN], now)).toBe(false);
});

test("an entry older than 5 min does not count", () => {
  const now = 10 * MIN;
  expect(mayContinue([now - 5 * MIN - 1, now - 2 * MIN, now - MIN], now)).toBe(true);
});

test("continuation text is the agreed wording", () => {
  expect(CONTINUATION_TEXT).toBe("Your previous turn was cut short by a restart. Check whether its last action took effect, then continue.");
});
