import { expect, test } from "bun:test";
import { parseMeminfo, resourceBreakdown } from "../src/resources";

const GB = 1024 ** 3;
const session = (container: string, extra: Record<string, unknown> = {}) => ({
  id: container, container, project: "games", repo: "game_web", status: "running" as const, name: null, ...extra,
});

test("a session gets the RAM and CPU of its dind container", () => {
  const r = resourceBreakdown(
    [session("dev-a", { name: "Telefon" })],
    [
      { container: "dev-a", cpuPct: 150, memBytes: 6 * GB },
      { container: "dind-dev-a", cpuPct: 20, memBytes: 1 * GB },
    ],
    { totalBytes: 62 * GB, usedBytes: 10 * GB }, null,
  );
  expect(r.sessions).toEqual([{ id: "dev-a", label: "Telefon", project: "games", cpuPct: 170, memBytes: 7 * GB, dindMemBytes: 1 * GB }]);
});

test("without a nickname the label is the repo, stopped sessions are skipped", () => {
  const r = resourceBreakdown(
    [session("dev-a"), session("dev-b", { status: "stopped" })],
    [{ container: "dev-a", cpuPct: 1, memBytes: GB }],
    { totalBytes: 62 * GB, usedBytes: 2 * GB }, null,
  );
  expect(r.sessions.map((s) => s.label)).toEqual(["game_web"]);
  const slot = resourceBreakdown([session("dev-games-game_web-15")], [], { totalBytes: 0, usedBytes: 0 }, null);
  expect(slot.sessions[0].label).toBe("game_web-15");
  const solo = resourceBreakdown([session("dev-apps-claudeSolo-5", { repo: "claudeSolo-5" })], [], { totalBytes: 0, usedBytes: 0 }, null);
  expect(solo.sessions[0].label).toBe("claudeSolo-5");
});

test("foreign containers go into one row, the rest of host RAM into another", () => {
  const r = resourceBreakdown(
    [session("dev-a")],
    [
      { container: "dev-a", cpuPct: 50, memBytes: 4 * GB },
      { container: "coolify-proxy", cpuPct: 3, memBytes: 1 * GB },
      { container: "metro-postgres", cpuPct: 1, memBytes: 1 * GB },
    ],
    { totalBytes: 62 * GB, usedBytes: 20 * GB }, 10 * GB,
  );
  expect(r.otherContainers).toEqual({ count: 2, cpuPct: 4, memBytes: 2 * GB });
  expect(r.codexMemBytes).toBe(10 * GB);
  expect(r.hostOtherBytes).toBe(4 * GB); // 20 − 4 − 2 − 10
  expect(r.host).toEqual({ totalBytes: 62 * GB, usedBytes: 20 * GB });
});

test("the host remainder never goes below zero", () => {
  const r = resourceBreakdown([], [{ container: "x", cpuPct: 0, memBytes: 30 * GB }], { totalBytes: 62 * GB, usedBytes: 20 * GB }, null);
  expect(r.hostOtherBytes).toBe(0);
});

test("parseMeminfo computes used RAM as total − available", () => {
  const m = parseMeminfo("MemTotal:       65000000 kB\nMemFree:          600000 kB\nMemAvailable:    5000000 kB\n");
  expect(m).toEqual({ totalBytes: 65000000 * 1024, usedBytes: 60000000 * 1024 });
  expect(parseMeminfo("")).toEqual({ totalBytes: 0, usedBytes: 0 });
});
