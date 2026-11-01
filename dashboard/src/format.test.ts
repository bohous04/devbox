import { expect, test } from "bun:test";
import {
  agoLabel, bytes, compactNumber, czHours, czInt, czPercent,
  daysLeftLabel, durationLabel, pctOf, stateBadge, stateLabel,
} from "./format";

test("bytes humanizes", () => {
  expect(bytes(1_500_000_000)).toBe("1.5 GB");
  expect(bytes(2048)).toBe("2.0 kB");
});
test("stateBadge", () => {
  expect(stateBadge("working")).toBe("working");
  expect(stateBadge("waiting")).toBe("waiting");
  expect(stateBadge("idle")).toBe("idle");
});
test("daysLeftLabel", () => {
  expect(daysLeftLabel(7)).toBe("~7 days");
  expect(daysLeftLabel(null)).toBe("plenty of space");
});
test("stateLabel without emoji", () => {
  expect(stateLabel("working")).toBe("working");
  expect(stateLabel("waiting")).toBe("waiting");
  expect(stateLabel("idle")).toBe("idle");
});
test("pctOf clamps and handles zero total", () => {
  expect(pctOf(50, 200)).toBe(25);
  expect(pctOf(300, 200)).toBe(100);
  expect(pctOf(-5, 200)).toBe(0);
  expect(pctOf(10, 0)).toBe(0);
});
test("czPercent rounds", () => {
  expect(czPercent(41.6)).toBe("42 %");
  expect(czPercent(0)).toBe("0 %");
});
test("czInt groups thousands", () => {
  expect(czInt(1234567)).toBe("1,234,567");
  expect(czInt(999)).toBe("999");
  expect(czInt(-4200)).toBe("-4,200");
});
test("compactNumber", () => {
  expect(compactNumber(534)).toBe("534");
  expect(compactNumber(12_500)).toBe("12.5 k");
  expect(compactNumber(1_200_000)).toBe("1.2 M");
  expect(compactNumber(2_400_000_000)).toBe("2.4 B");
  expect(compactNumber(150_000)).toBe("150 k");
  expect(compactNumber(1000)).toBe("1 k");
});
test("durationLabel", () => {
  expect(durationLabel(45_000)).toBe("45 s");
  expect(durationLabel(12 * 60_000)).toBe("12 min");
  expect(durationLabel((2 * 60 + 14) * 60_000)).toBe("2 h 14 min");
  expect(durationLabel(3 * 3_600_000)).toBe("3 h");
  expect(durationLabel((26 * 60 + 10) * 60_000)).toBe("26 h");
  expect(durationLabel((3 * 24 + 4) * 3_600_000)).toBe("3 d 4 h");
  expect(durationLabel(-5)).toBe("0 s");
});
test("agoLabel", () => {
  expect(agoLabel(3_000)).toBe("3 s ago");
  expect(agoLabel(2 * 60_000)).toBe("2 min ago");
  expect(agoLabel(5 * 3_600_000)).toBe("5 h ago");
  expect(agoLabel(49 * 3_600_000)).toBe("2 d ago");
});
test("czHours", () => {
  expect(czHours(6.42)).toBe("6.4 h");
  expect(czHours(0)).toBe("0.0 h");
});
