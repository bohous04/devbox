import { expect, test, beforeEach } from "bun:test";
import { costOf, hasPrice, resetPricingWarnings, warnUnpricedModel } from "../src/pricing";

beforeEach(() => resetPricingWarnings());

test("grok-4.6 standard rate", () => {
  expect(costOf("grok-4.6", "input", 1_000_000)).toBeCloseTo(2);
  expect(costOf("grok-4.6", "cacheRead", 1_000_000)).toBeCloseTo(0.5);
  expect(costOf("grok-4.6", "output", 1_000_000)).toBeCloseTo(6);
});

test("grok-4.6 long-context rate from 200k prompt tokens applies to the whole request", () => {
  expect(costOf("grok-4.6", "input", 1_000_000, 250_000)).toBeCloseTo(4);
  expect(costOf("grok-4.6", "output", 1_000_000, 250_000)).toBeCloseTo(12);
  expect(costOf("grok-4.6", "input", 1_000_000, 199_999)).toBeCloseTo(2);
});

test("gpt-5.6-sol current promotional rates and cache writes", () => {
  expect(costOf("gpt-5.6-sol", "input", 2_000_000)).toBeCloseTo(8);
  expect(costOf("gpt-5.6-sol", "cacheRead", 1_000_000)).toBeCloseTo(0.4);
  expect(costOf("gpt-5.6-sol", "cacheWrite", 1_000_000)).toBeCloseTo(5);
  expect(costOf("gpt-5.6-sol", "output", 1_000_000)).toBeCloseTo(20);
});

test("Astra rates and exact OpenAI long-context boundary", () => {
  for (const [kind, short, long] of [["input", 10, 20], ["cacheRead", 1, 2], ["cacheWrite", 12.5, 25], ["output", 50, 75]] as const) {
    expect(costOf("gpt-6-astra", kind, 1_000_000, 272_000)).toBeCloseTo(short);
    expect(costOf("gpt-6-astra", kind, 1_000_000, 272_001)).toBeCloseTo(long);
  }
  expect(costOf("gpt-5.6-sol", "output", 1_000_000, 272_001)).toBeCloseTo(30);
  expect(costOf("grok-4.6", "input", 1_000_000, 200_000)).toBeCloseTo(4);
});

test("GPT-6.x rates and long-context boundary", () => {
  for (const [model, rates] of [
    ["gpt-6.1-sol", [["input", 2, 4], ["cacheRead", 0.1, 0.2], ["cacheWrite", 2.5, 5], ["output", 10, 15]]],
    ["gpt-6-sol", [["input", 2, 4], ["cacheRead", 0.2, 0.4], ["cacheWrite", 2.5, 5], ["output", 10, 15]]],
    ["gpt-6-luna", [["input", 0.1, 0.2], ["cacheRead", 0.01, 0.02], ["cacheWrite", 0.125, 0.25], ["output", 0.5, 0.75]]],
  ] as const) {
    for (const [kind, short, long] of rates) {
      expect(costOf(model, kind, 1_000_000, 272_000)).toBeCloseTo(short);
      expect(costOf(model, kind, 1_000_000, 272_001)).toBeCloseTo(long);
    }
  }
  expect(hasPrice("gpt-6.1")).toBe(false); // no guessed aliases
});

test("other observed Codex models and documented aliases", () => {
  expect(costOf("gpt-5.6", "input", 1_000_000)).toBe(4);
  expect(costOf("gpt-5.6-terra", "output", 1_000_000)).toBe(12);
  expect(costOf("gpt-5.6-luna", "output", 1_000_000)).toBe(1.2);
  expect(costOf("gpt-5.5-2026-04-23", "output", 1_000_000)).toBe(30);
  expect(costOf("gpt-5.4-mini", "input", 1_000_000)).toBe(0.75);
  expect(costOf("gpt-5.4-mini-2026-03-17", "cacheRead", 1_000_000)).toBe(0.075);
  expect(costOf("gpt-5.3-codex", "output", 1_000_000)).toBe(14);
  // A historical stealth slug or a guessed alias must not become a free model.
  expect(costOf("stealth/ox-alpha", "input", 1_000_000)).toBeNull();
  expect(hasPrice("gpt-6-astra-made-up")).toBe(false);
  expect(costOf("constructor", "input", 1_000_000)).toBeNull();
});

test("unknown model → null + warn only once", () => {
  expect(costOf("who-knows-1", "input", 1000)).toBeNull();
  expect(hasPrice("who-knows-1")).toBe(false);
  const seen: string[] = [];
  const orig = console.warn; console.warn = (m: string) => { seen.push(m); };
  try { warnUnpricedModel("who-knows-1"); warnUnpricedModel("who-knows-1"); } finally { console.warn = orig; }
  expect(seen).toHaveLength(1);
});

test("Antigravity models: all reasoning levels, exact ids from `agy models`", () => {
  for (const l of ["low", "medium", "high"]) {
    expect(costOf(`claude-opus-5-5-${l}`, "input", 1_000_000)).toBe(4);
    expect(costOf(`claude-opus-5-5-${l}`, "cacheRead", 1_000_000)).toBeCloseTo(0.2);
    expect(costOf(`claude-opus-5-5-${l}`, "cacheWrite", 1_000_000)).toBe(5);
    expect(costOf(`claude-opus-5-5-${l}`, "output", 1_000_000)).toBe(20);
    expect(costOf(`claude-sonnet-5-5-${l}`, "cacheRead", 1_000_000)).toBeCloseTo(0.1);
    expect(costOf(`claude-sonnet-5-5-${l}`, "output", 1_000_000)).toBe(10);
    expect(hasPrice(`gemini-3.8-flash-${l}`)).toBe(true);
  }
  // Claude without the long-context surcharge: 900k prompt = the same rate.
  expect(costOf("claude-opus-5-5-high", "input", 1_000_000, 900_000)).toBe(4);
  expect(costOf("gpt-oss-120b-medium", "output", 1_000_000)).toBeCloseTo(0.36);
  expect(costOf("gpt-oss-120b-medium", "cacheRead", 1_000_000)).toBeCloseTo(0.09); // unknown cache price ≠ free
  expect(hasPrice("claude-opus-5-5")).toBe(false); // no guessed aliases
  expect(hasPrice("gemini-3.8-flash")).toBe(false);
});

test("Gemini 3.8 Flash: introductory price until the end of 2026, double from 1 Jan 2027 — by the token's time", () => {
  const before = Date.UTC(2026, 11, 31, 23, 59, 59), after = Date.UTC(2027, 0, 1);
  expect(costOf("gemini-3.8-flash-high", "input", 1_000_000, undefined, before)).toBeCloseTo(0.75);
  expect(costOf("gemini-3.8-flash-high", "cacheRead", 1_000_000, undefined, before)).toBeCloseTo(0.075);
  expect(costOf("gemini-3.8-flash-high", "output", 1_000_000, undefined, before)).toBeCloseTo(3.75);
  expect(costOf("gemini-3.8-flash-high", "input", 1_000_000, undefined, after)).toBeCloseTo(1.5);
  expect(costOf("gemini-3.8-flash-high", "cacheRead", 1_000_000, undefined, after)).toBeCloseTo(0.15);
  expect(costOf("gemini-3.8-flash-high", "output", 1_000_000, undefined, after)).toBeCloseTo(7.5);
  // Models without rateChange ignore the time.
  expect(costOf("grok-4.6", "input", 1_000_000, undefined, after)).toBeCloseTo(2);
});
