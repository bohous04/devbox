import { expect, test } from "bun:test";
import { nextTheme } from "./theme";

test("the theme cycle always returns to system", () => {
  expect(nextTheme("system")).toBe("light");
  expect(nextTheme("light")).toBe("dark");
  expect(nextTheme("dark")).toBe("system");
});

test("three clicks = back to the initial state", () => {
  expect(nextTheme(nextTheme(nextTheme("system")))).toBe("system");
});
