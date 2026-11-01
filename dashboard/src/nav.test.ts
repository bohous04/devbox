import { expect, test } from "bun:test";
import { LEGACY_ROUTES, NAV, activeLabel, primaryNav, secondaryNav } from "./nav";

test("the bottom bar has exactly 4 items, the fifth is More", () => {
  expect(primaryNav()).toHaveLength(4);
});

test("primary + secondary together make the whole menu, without overlap", () => {
  const all = [...primaryNav(), ...secondaryNav()].map((n) => n.to).sort();
  expect(all).toEqual(NAV.map((n) => n.to).sort());
});

test("paths are unique", () => {
  expect(new Set(NAV.map((n) => n.to)).size).toBe(NAV.length);
});

test("every old path points to an existing new one", () => {
  const known = new Set(NAV.map((n) => n.to));
  for (const [from, to] of Object.entries(LEGACY_ROUTES)) {
    expect(known.has(to)).toBe(true);
    expect(known.has(from)).toBe(false); // an old path must not also be a new one
  }
});

test("activeLabel recognizes the root and subpages", () => {
  expect(activeLabel("/")).toBe("Overview");
  expect(activeLabel("/sessions")).toBe("Sessions");
  expect(activeLabel("/sessions?open=abc")).toBe("Sessions");
  expect(activeLabel("/prod-writes")).toBe("Production writes");
  expect(activeLabel("/neznama")).toBe("Overview");
});

test("the root does not catch other paths (end route)", () => {
  // with a naive startsWith "/" would catch absolutely everything
  expect(activeLabel("/stats")).toBe("Statistics");
});

test("NAV: Unpushed (Work in progress) is the last item, outside the mobile bar, with its own path", () => {
  const item = NAV[NAV.length - 1];
  expect(item.to).toBe("/unpushed");
  expect(item.label).toBe("Unpushed");
  expect(item.primary).toBeUndefined();
  expect(activeLabel("/unpushed")).toBe("Unpushed");
});

test("NAV: AI subs comes right after Stats and is not in the mobile bar", () => {
  const idx = NAV.findIndex((n) => n.to === "/subscriptions");
  expect(idx).toBe(NAV.findIndex((n) => n.to === "/stats") + 1);
  // The bottom bar on mobile holds four items and they are taken; this one belongs
  // under "More", otherwise something more used would be pushed out of the bar.
  expect(NAV[idx].primary).toBeUndefined();
  expect(NAV.filter((n) => n.primary)).toHaveLength(4);
});
