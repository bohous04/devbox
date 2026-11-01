import { expect, test } from "bun:test";
import { mergeUsageSeries, usageChartPoints, usageResetMarkers, type UsagePoint, isChartedWindow, USAGE_COLORS } from "./usageView";
const p = (time: number, reset: number, pct: number): UsagePoint => ({window:"weekly",sampledAt:time,resetsAt:reset,percentUsed:pct});
test("quota graph separates reset periods and never fabricates zero", () => {
  const history = [p(100,200,90),p(300,500,3)];
  expect(usageChartPoints(history,"weekly").map(x=>x.percentUsed)).toEqual([90,null,3]);
  expect(usageResetMarkers(history,"weekly",0,400)).toEqual([200]);
});
test("quota graph retains missing-data gaps, orders points and deduplicates reset markers", () => {
  const history = [p(4000000,5000000,20),p(100,5000000,10),p(300,5000000,12)];
  expect(usageChartPoints(history,"weekly").map(x=>x.percentUsed)).toEqual([10,12,null,20]);
  expect(usageResetMarkers(history,"weekly",0,6000000)).toEqual([5000000]);
  expect(usageChartPoints(history,"other")).toEqual([]);
});


test("quota graph separates an early reset before the previously reported reset time", () => {
  expect(usageChartPoints([p(100, 1000, 90), p(200, 2000, 3)], "weekly").map((x) => x.percentUsed)).toEqual([90, null, 3]);
});

test("quota graph never carries a reading across an expired reset timestamp", () => {
  expect(usageChartPoints([p(100, 200, 90), p(300, 200, 90)], "weekly").map((x) => x.percentUsed)).toEqual([90, null, 90]);
});


test("known reset markers survive a range without observations and deduplicate history", () => {
  const known = [{ window: "weekly", resetsAt: 300 }, { window: "other", resetsAt: 400 }, { window: "weekly", resetsAt: 700 }];
  expect(usageResetMarkers([], "weekly", 200, 600, known)).toEqual([300]);
  expect(usageResetMarkers([p(250, 300, 90)], "weekly", 200, 600, known)).toEqual([300]);
});

test("merged chart rows share one timeline and hold each step until its next reading or gap", () => {
  const rows = mergeUsageSeries([
    { key: "a", points: [{ sampledAt: 100, percentUsed: 10 }, { sampledAt: 300, percentUsed: 20 }] },
    { key: "b", points: [{ sampledAt: 200, percentUsed: 50 }, { sampledAt: 250, percentUsed: null }, { sampledAt: 400, percentUsed: 70 }] },
  ]);
  expect(rows).toEqual([
    { sampledAt: 100, values: { a: 10, b: null } },
    { sampledAt: 200, values: { a: 10, b: 50 } },
    { sampledAt: 250, values: { a: 10, b: null } },
    { sampledAt: 300, values: { a: 20, b: null } },
    { sampledAt: 400, values: { a: null, b: 70 } },
  ]);
});
test("tooltip timeline tolerates an account with no readings in the range", () => {
  expect(mergeUsageSeries([
    { key: "a", points: [{ sampledAt: 100, percentUsed: 10 }] },
    { key: "empty", points: [] },
  ])).toEqual([{ sampledAt: 100, values: { a: 10, empty: null } }]);
});

test("the chart skips five-hour windows, per-model windows and the Antigravity Claude/GPT group", () => {
  expect(isChartedWindow("agy", "Claude and GPT models", "weekly")).toBe(false);
  expect(isChartedWindow("agy", "Claude and GPT models", "five_hour")).toBe(false);
  expect(isChartedWindow("agy", "Gemini Models", "five_hour")).toBe(false);
  expect(isChartedWindow("agy", "Gemini Models", "weekly")).toBe(true);
  expect(isChartedWindow("claude", "Personal (Max 20x)", "weekly_scoped:Fable")).toBe(false);
  expect(isChartedWindow("claude", "Personal (Max 20x)", "weekly_all")).toBe(true);
  expect(isChartedWindow("codex", "Main account", "primary")).toBe(true);
  expect(isChartedWindow("grok", "Grok Build", "weekly")).toBe(true);
});

test("the chart palette has no grey colors and colors do not repeat", () => {
  expect(new Set(USAGE_COLORS).size).toBe(USAGE_COLORS.length);
  for (const hex of USAGE_COLORS) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(90);
  }
});
