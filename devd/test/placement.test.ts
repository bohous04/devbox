import { expect, test } from "bun:test";
import { suggestPlacement } from "../src/placement";
const s = { devdUrl: "x", vmPort: 4301, suggestRamPct: 80, suggestLoadPerCore: 1, desktopWidth: 1, desktopHeight: 1 };

test("suggestPlacement", () => {
  expect(suggestPlacement({ memUsedPct: 50, load1: 2, cores: 8 }, s)).toEqual({ suggest: "vps", reason: null });
  expect(suggestPlacement({ memUsedPct: 87.4, load1: 2, cores: 8 }, s)).toEqual({ suggest: "instabox", reason: "RAM 87 %" });
  expect(suggestPlacement({ memUsedPct: 40, load1: 9.5, cores: 8 }, s)).toEqual({ suggest: "instabox", reason: "load 9.5 on 8 cores" });
  expect(suggestPlacement({ memUsedPct: 80, load1: 8, cores: 8 }, s).suggest).toBe("vps"); // the boundary is not "above"
});
