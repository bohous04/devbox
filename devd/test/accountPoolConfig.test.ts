import { expect, test } from "bun:test";
import { ACCOUNT_POOL_DEFAULTS, DEFAULT_CONFIG, resolveAccountPool, validateConfig } from "../src/config";

test("resolveAccountPool: missing block → all defaults", () => {
  expect(resolveAccountPool(DEFAULT_CONFIG.settings)).toEqual(ACCOUNT_POOL_DEFAULTS);
  expect(ACCOUNT_POOL_DEFAULTS).toEqual({
    thresholdPct: 90, hysteresisPct: 10, cooldownMinutes: 5, activePollSec: 60, idlePollSec: 300,
    preferredAccountId: null, spilloverPct: 60,
    // An empty map and solo mode off: deploying the code on its own must not change
    // the behaviour of the live pool.
    projectAccounts: {}, soloAccountId: null,
  });
});

test("resolveAccountPool: a partial block overrides only its own fields", () => {
  const r = resolveAccountPool({ ...DEFAULT_CONFIG.settings, accountPool: { thresholdPct: 80 } });
  expect(r.thresholdPct).toBe(80);
  expect(r.hysteresisPct).toBe(10);
  expect(r.cooldownMinutes).toBe(5);
});

test("a config with accountPool passes validation (does not break old configs)", () => {
  const cfg = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, accountPool: { cooldownMinutes: 1 } } };
  expect(validateConfig(cfg).settings.accountPool!.cooldownMinutes).toBe(1);
  expect(validateConfig(DEFAULT_CONFIG).settings.accountPool).toBe(undefined);
});
