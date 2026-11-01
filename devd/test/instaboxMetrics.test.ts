import { expect, test } from "bun:test";
import { toSessionMetrics } from "../src/instabox/client";

test("toSessionMetrics maps cpuUsedPct/memUsed to cpuPct/integer memBytes", () => {
  expect(toSessionMetrics({ cpuUsedPct: 12.5, memUsed: 1000.6 })).toEqual({ cpuPct: 12.5, memBytes: 1001 });
});

test("toSessionMetrics without input returns zeros", () => {
  expect(toSessionMetrics({})).toEqual({ cpuPct: 0, memBytes: 0 });
});
