import { expect, test } from "bun:test";
import { hourLabel, msLabel, page, peakHour, projectOptions, quantileLabel, share, toRanked, totalCost } from "./statsView";
import { matchPreset, presetRange, rangeDays } from "./lib/range";

test("toRanked unifies projects and models into the same shape", () => {
  expect(toRanked([{ project: "shop", cost: 1, tokens: 10 }], "project")).toEqual([{ key: "shop", cost: 1, tokens: 10 }]);
  expect(toRanked([{ model: "opus", cost: 2, tokens: 20 }], "model")).toEqual([{ key: "opus", cost: 2, tokens: 20 }]);
  // a missing key must not pass as "undefined"
  expect(toRanked([{ repo: null, cost: 0, tokens: 0 }], "repo")[0].key).toBe("—");
});

test("share never returns NaN", () => {
  expect(share(1, 4)).toBe(25);
  expect(share(1, 0)).toBe(0);
  expect(share(0, 0)).toBe(0);
});

test("totalCost sums the ranking", () => {
  expect(totalCost([{ key: "a", cost: 1.5, tokens: 0 }, { key: "b", cost: 2.5, tokens: 0 }])).toBe(4);
  expect(totalCost([])).toBe(0);
});

test("page paginates and clamps an out-of-range index", () => {
  const rows = Array.from({ length: 60 }, (_, i) => i);
  expect(page(rows, 0, 25).items).toHaveLength(25);
  expect(page(rows, 0, 25).pages).toBe(3);
  expect(page(rows, 2, 25).items).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
  // after narrowing the filter the old page is out of range → must fall back to the last one
  expect(page(rows, 99, 25).page).toBe(2);
  expect(page([], 3, 25)).toEqual({ items: [], page: 0, pages: 1 });
});

test("hourLabel pads with zero", () => {
  expect(hourLabel(0)).toBe("00:00");
  expect(hourLabel(9)).toBe("09:00");
  expect(hourLabel(23)).toBe("23:00");
});

test("peakHour finds the busiest hour, an empty day returns null", () => {
  const h = (hour: number, hours: number) => ({ hour, hours, cost: 0 });
  expect(peakHour([h(9, 1), h(14, 3), h(20, 2)])).toBe(14);
  expect(peakHour([h(9, 0), h(14, 0)])).toBeNull();
  expect(peakHour([])).toBeNull();
});

test("msLabel reads humanly and does not show zero as 0 s", () => {
  expect(msLabel(0)).toBe("—");
  expect(msLabel(-5)).toBe("—");
  expect(msLabel(45_000)).toBe("45 s");
  expect(msLabel(4 * 60_000)).toBe("4 min");
  expect(msLabel(80 * 60_000)).toBe("1 h 20 min");
  expect(msLabel(120 * 60_000)).toBe("2 h");
});

test("quantileLabel without data returns a dash, not zero", () => {
  // prompt stats start on the deploy day — empty is the normal state
  expect(quantileLabel(undefined, String)).toBe("—");
  expect(quantileLabel({ count: 0, avg: 0, p50: 0, p90: 0 }, String)).toBe("—");
  expect(quantileLabel({ count: 3, avg: 5, p50: 4, p90: 9 }, (v) => `${v} zn.`)).toBe("4 zn.");
});

/* ------------------------------- rozsahy ------------------------------- */

test("preset Today is one day from today's midnight", () => {
  const now = new Date(2026, 6, 26, 15, 30).getTime();
  const r = presetRange("today", now);
  expect(rangeDays(r)).toBe(1);
  expect(new Date(r.from).getHours()).toBe(0);
  expect(r.to - r.from).toBe(86_400_000);
});

test("matchPreset recognizes its presets and marks any other range as custom", () => {
  const now = new Date(2026, 6, 26, 15, 30).getTime();
  expect(matchPreset(presetRange("today", now), now)).toBe("today");
  expect(matchPreset(presetRange("7d", now), now)).toBe("7d");
  expect(matchPreset(presetRange("month", now), now)).toBe("month");
  expect(matchPreset({ from: 1, to: 2 }, now)).toBe("custom");
});

test("rangeDays counts whole days", () => {
  const now = new Date(2026, 6, 26, 15, 30).getTime();
  expect(rangeDays(presetRange("7d", now))).toBe(7);
  expect(rangeDays(presetRange("30d", now))).toBe(30);
});

test("projectOptions: alphabetical, so the switcher does not jump with costs", () => {
  const opts = projectOptions([
    { project: "vpsbetter" },
    { project: "alfa" },
    { project: "portal" },
  ]);
  expect(opts).toEqual(["alfa", "portal", "vpsbetter"]);
});

// "—" is the SQL fallback for rows WITHOUT a project attribute. It cannot be filtered on
// (json_extract returns NULL, equality never matches), so it has no place as a switcher
// option — it would get selected and the page would show all zeros.
test("projectOptions: the no-project bucket (—) is not offered as a filter", () => {
  expect(projectOptions([{ project: "—" }, { project: "alfa" }]))
    .toEqual(["alfa"]);
});

// A filter can get "lost": a link with ?project=alfa opened on a range where alfa spent
// nothing would not have it in the options — the switcher would show empty and there would be
// no way back. The active project therefore always belongs in the options.
test("projectOptions: the active project is offered even without data in the range", () => {
  expect(projectOptions([{ project: "beta" }], "alfa")).toEqual(["alfa", "beta"]);
  expect(projectOptions([{ project: "alfa" }], "alfa")).toEqual(["alfa"]);
});
