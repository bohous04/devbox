import { describe, expect, test } from "bun:test";
import { parseCompareArgs } from "./compare.ts";

describe("parseCompareArgs", () => {
  test("requires account and model", () => {
    expect(() => parseCompareArgs(["--model", "m"])).toThrow(/--account/);
    expect(() => parseCompareArgs(["--account", "a"])).toThrow(/--model/);
  });
  test("defaults runs to 5 and out to metering-report.json", () => {
    const a = parseCompareArgs(["--account", "a", "--model", "claude-opus-5-5"]);
    expect(a.runs).toBe(5);
    expect(a.out).toBe("metering-report.json");
  });
  test("rejects values that would break shell quoting", () => {
    expect(() => parseCompareArgs(["--account", "a", "--model", "m; rm -rf /"])).toThrow(/--model/);
  });
  test("rejects a bad run count and unknown flags", () => {
    expect(() => parseCompareArgs(["--account", "a", "--model", "m", "--runs", "0"])).toThrow(/--runs/);
    expect(() => parseCompareArgs(["--account", "a", "--model", "m", "--bogus", "1"])).toThrow(/unknown/);
  });
});
