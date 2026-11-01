import { expect, test } from "bun:test";
import { presetRange, rangeFromDraft } from "./range";

const at = (y: number, m: number, d: number) => new Date(y, m, d, 15, 30).getTime(); // 15:30 local time

test("7d: from is midnight 6 days ago, to is tomorrow's midnight", () => {
  const now = at(2026, 6, 23); // 23.7.2026
  const { from, to } = presetRange("7d", now);
  expect(new Date(from).getHours()).toBe(0);
  expect(new Date(to).getHours()).toBe(0);
  expect(Math.round((to - from) / 86_400_000)).toBe(7);
});

test("month: from is the 1st of the month, range covers the whole month so far", () => {
  const now = at(2026, 6, 23);
  const { from } = presetRange("month", now);
  expect(new Date(from).getDate()).toBe(1);
  expect(new Date(from).getMonth()).toBe(6);
});

/* --------------------------- calendar selection --------------------------- */
// The core of the bug this fixes: the calendar received `selected` as a FINISHED range
// and its `onSelect` was applied immediately, so ONE click (on 7/29) moved only
// one end and the picker closed with the range "7/29 – 8/20" that nobody wanted.
// Now selection goes into a draft and the range is applied only with the Apply button — react-day-picker
// returns {from,to} (both equal) ALREADY on the first click, so the shape of the response
// cannot tell whether the user is done.

test("rangeFromDraft: nothing to apply without a start", () => {
  expect(rangeFromDraft(undefined)).toBeNull();
  expect(rangeFromDraft({})).toBeNull();
});

test("rangeFromDraft: a start alone = a one-day range", () => {
  const r = rangeFromDraft({ from: new Date(2026, 7, 14, 9, 0) })!;
  expect(new Date(r.from).getHours()).toBe(0);
  expect(new Date(r.from).getDate()).toBe(14);
  expect(Math.round((r.to - r.from) / 86_400_000)).toBe(1);
});

test("rangeFromDraft: both ends give midnight–midnight with an exclusive end", () => {
  const r = rangeFromDraft({ from: new Date(2026, 7, 14, 9, 0), to: new Date(2026, 7, 16, 22, 0) })!;
  expect(new Date(r.from).getHours()).toBe(0);
  expect(new Date(r.from).getDate()).toBe(14);
  expect(new Date(r.to).getDate()).toBe(17);   // the end is tomorrow's midnight, i.e. exclusive
  expect(Math.round((r.to - r.from) / 86_400_000)).toBe(3);
});

test("rangeFromDraft: the same day twice = a one-day range, not empty", () => {
  const d = new Date(2026, 7, 14, 12, 0);
  const r = rangeFromDraft({ from: d, to: d })!;
  expect(Math.round((r.to - r.from) / 86_400_000)).toBe(1);
});

test("rangeFromDraft: reversed click order is normalized", () => {
  const r = rangeFromDraft({ from: new Date(2026, 7, 16), to: new Date(2026, 7, 14) })!;
  expect(new Date(r.from).getDate()).toBe(14);
  expect(new Date(r.to).getDate()).toBe(17);
});
