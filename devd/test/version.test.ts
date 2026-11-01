import { expect, test } from "bun:test";
import { VERSION } from "../src/version";

test("exposes a semver version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
