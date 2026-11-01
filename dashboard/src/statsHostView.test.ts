import { expect, test } from "bun:test";
import { hostLabel, hostOptions, previousFor, seriesFor, totalsFor, unknownLabel } from "./statsHostView";
import type { RangeStats } from "./api";

const data = {
  from: 0, to: 2, totals: { cost: 4, tokens: 100, hours: 1.5 },
  previous: { cost: 5, tokens: 0, hours: 0 },
  daily: [], projects: [], models: [],
  hosts: [
    { key: "devbox", cost: 3, tokens: 0, hours: 1 },
    { key: "mac", cost: 1, tokens: 100, hours: 0.5 },
  ],
  hostsPrevious: [{ key: "mac", cost: 5, tokens: 0, hours: 0 }],
  accounts: [],
  dailyByHost: [
    { host: "devbox", days: [{ day: 0, cost: 0, tokens: 0, hours: 0 }, { day: 1, cost: 3, tokens: 0, hours: 1 }] },
    { host: "mac", days: [{ day: 0, cost: 1, tokens: 100, hours: 0.5 }, { day: 1, cost: 0, tokens: 0, hours: 0 }] },
  ],
} as unknown as RangeStats;

test("hostOptions: alphabetical, so the switcher does not reorder between loads", () => {
  expect(hostOptions(data)).toEqual(["devbox", "mac"]);
});

test("totalsFor: all returns overall totals, otherwise just the given host", () => {
  expect(totalsFor(data, "all")).toEqual({ cost: 4, tokens: 100, hours: 1.5 });
  expect(totalsFor(data, "mac")).toEqual({ cost: 1, tokens: 100, hours: 0.5 });
});

test("totalsFor: an unknown host returns zeros, not undefined", () => {
  expect(totalsFor(data, "neexistuje")).toEqual({ cost: 0, tokens: 0, hours: 0 });
});

test("previousFor: a host with no record in the previous window gives zeros", () => {
  expect(previousFor(data, "mac").cost).toBe(5);
  expect(previousFor(data, "devbox")).toEqual({ cost: 0, tokens: 0, hours: 0 });
  expect(previousFor(data, "all").cost).toBe(5);
});

test("seriesFor: all returns a series per host, a specific host returns one", () => {
  expect(seriesFor(data, "all").length).toBe(2);
  const one = seriesFor(data, "mac");
  expect(one.length).toBe(1);
  expect(one[0][0].cost).toBe(1);
});

test("hostOptions: a missing hosts field returns an empty array via the ?? [] guard", () => {
  const noHosts = { ...data, hosts: undefined } as unknown as RangeStats;
  expect(hostOptions(noHosts)).toEqual([]);
});

test("totalsFor: missing hosts returns zeros", () => {
  const noHosts = { ...data, hosts: undefined } as unknown as RangeStats;
  expect(totalsFor(noHosts, "devbox")).toEqual({ cost: 0, tokens: 0, hours: 0 });
});

test("previousFor: missing hostsPrevious returns zeros", () => {
  const noPrevious = { ...data, hostsPrevious: undefined } as unknown as RangeStats;
  expect(previousFor(noPrevious, "mac")).toEqual({ cost: 0, tokens: 0, hours: 0 });
});

test("seriesFor: missing dailyByHost returns [[]] (not []), so the chart is not completely empty", () => {
  const noDaily = { ...data, dailyByHost: undefined } as unknown as RangeStats;
  // For an unknown host it returns [[]] — one empty chart, not no chart.
  // This is intentional: chart.map() in JSX would render nothing at all for [],
  // but for [[]] it renders one empty dataset.
  expect(seriesFor(noDaily, "unknown")).toEqual([[]]);
});

test("seriesFor: an unknown host always returns [[]], not []", () => {
  // Intentional: chart.map(series => <Line/>) must have something to map over,
  // otherwise nothing would render at all. [[]] = one empty dataset.
  expect(seriesFor(data, "unknownHost")).toEqual([[]]);
});

test("hostLabel: mac/devbox get a readable label", () => {
  expect(hostLabel("mac")).toBe("Mac");
  expect(hostLabel("devbox")).toBe("Devbox");
});

test("hostLabel: the SQL fallback for a missing host (—) is labeled Unknown, not a bare dash", () => {
  expect(hostLabel("—")).toBe("Unknown");
});

test("hostLabel: an unknown key is returned unchanged (future hosts have no hardcoded label)", () => {
  expect(hostLabel("nejaky-jiny-host")).toBe("nejaky-jiny-host");
});

test("unknownLabel: em dash (SQL fallback) is labeled Unknown", () => {
  expect(unknownLabel("—")).toBe("Unknown");
});

test("unknownLabel: any other key (project, account, host…) passes through unchanged", () => {
  expect(unknownLabel("my-project")).toBe("my-project");
  expect(unknownLabel("devbox")).toBe("devbox");
});
