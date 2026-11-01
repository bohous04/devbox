import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, validateConfig } from "../src/config";
import { resolveCcUpkeep } from "../src/ccUpkeep";

test("default: enabled, window 3–5", () => {
  expect(resolveCcUpkeep(DEFAULT_CONFIG.settings)).toEqual({ enabled: true, windowStartHour: 3, windowEndHour: 5 });
});

test("partial settings are filled in with defaults", () => {
  expect(resolveCcUpkeep({ ...DEFAULT_CONFIG.settings, ccUpkeep: { windowStartHour: 1 } }))
    .toEqual({ enabled: true, windowStartHour: 1, windowEndHour: 5 });
  expect(resolveCcUpkeep({ ...DEFAULT_CONFIG.settings, ccUpkeep: { enabled: false } }).enabled).toBe(false);
});

test("config without ccUpkeep stays valid (backward compatibility)", () => {
  const { ccUpkeep, ...settings } = DEFAULT_CONFIG.settings;
  expect(() => validateConfig({ ...DEFAULT_CONFIG, settings })).not.toThrow();
});
