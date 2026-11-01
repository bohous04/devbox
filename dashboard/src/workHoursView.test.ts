import { expect, test } from "bun:test";
import { cappedNote, formatHours, workForProject } from "./workHoursView";

test("formatHours: hours and minutes, not decimals", () => {
  expect(formatHours(1.5)).toBe("1h 30m");
  expect(formatHours(0.25)).toBe("15m");
  expect(formatHours(0)).toBe("0m");
});

test("formatHours: a whole hour without minutes does not show an extra '0m'", () => {
  expect(formatHours(2)).toBe("2h");
});

// Rounding is done on TOTAL minutes before splitting into h/m — a variant
// that truncated hours (Math.floor) and rounded minutes separately would return
// "1h 60m" here instead of carrying over into the next hour.
test("formatHours: rounding at the hour boundary carries over, not '…h 60m'", () => {
  expect(formatHours(0.999)).toBe("1h");
  expect(formatHours(1.999)).toBe("2h");
});

test("cappedNote reports only where the cap actually applied", () => {
  expect(cappedNote({ project: "p", hours: 2, cappedHours: 0 })).toBeNull();
  expect(cappedNote({ project: "p", hours: 2, cappedHours: 0.5 })).toContain("capped");
});

const WORK = {
  totalHours: 3,
  byProject: [
    { project: "alfa", hours: 2, cappedHours: 0.5 },
    { project: "beta", hours: 1, cappedHours: 0 },
  ],
  daily: [{ day: 0, hours: 3 }],
};

test("workForProject: without a filter returns work hours unchanged", () => {
  expect(workForProject(WORK, null)).toEqual({ totalHours: 3, byProject: WORK.byProject });
});

test("workForProject: with a filter only one project remains and the total is its own", () => {
  expect(workForProject(WORK, "alfa")).toEqual({
    totalHours: 2,
    byProject: [{ project: "alfa", hours: 2, cappedHours: 0.5 }],
  });
});

test("workForProject: a project with no worked hours → zero, not the overall total", () => {
  expect(workForProject(WORK, "gama")).toEqual({ totalHours: 0, byProject: [] });
});
