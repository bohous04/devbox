import { expect, test } from "bun:test";
import type { Machine, MachineSample, Monitor } from "./api";
import {
  sortResources,
  memTooltip,
  attentionItems, backupAge, backupStale, backupTone, certTone, chartDomain, disruptiveUpdates, fillLabel,
  kernelUpdates, groupMonitors, machineDot, rebootBanner, timeLabel, toChart, uptimeLabel,
} from "./hardwareView";

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: "devbox", label: "devbox", beszel: null, host: null, backup: null, upgrade: null, checkedAt: 0, errors: [], ...over,
});
const host = (over: Partial<NonNullable<Machine["host"]>> = {}) => ({
  hostname: "box", os: null, kernel: null, uptimeSec: 1, bootedAt: null, disk: null,
  rebootRequired: false, rebootPkgs: [], updates: [], logins: [], packages: [], ...over,
});
const monitor = (over: Partial<Monitor> = {}): Monitor => ({
  id: "1", name: "m", type: "http", url: null, hostname: null, tag: null,
  up: true, uptime1d: null, uptime30d: null, uptime365d: null, responseMs: null, certDaysLeft: null, ...over,
});

test("status dot: Beszel takes precedence over probe", () => {
  expect(machineDot(machine({ beszel: { id: "x", name: "n", status: "up", agentVersion: null, uptimeSec: null, cpu: 0, memPct: 0, diskPct: 0 } }))).toBe("ok");
  expect(machineDot(machine({ beszel: { id: "x", name: "n", status: "down", agentVersion: null, uptimeSec: null, cpu: 0, memPct: 0, diskPct: 0 }, host: host() }))).toBe("danger");
  expect(machineDot(machine({ host: host() }))).toBe("ok");
  expect(machineDot(machine())).toBe("off");
});

test("a running backup is not a problem", () => {
  expect(backupTone("running")).toBe("ok");
  expect(backupTone("ok")).toBe("ok");
  expect(backupTone("failed")).toBe("danger");
  expect(backupTone("unknown")).toBe("warn");
});

test("attentionItems: a clean machine has no reasons", () => {
  expect(attentionItems(machine())).toEqual([]);
  expect(attentionItems(machine({ host: host() }))).toEqual([]);
});

test("attentionItems: names every reason, stable order", () => {
  expect(attentionItems(machine({ host: host({ rebootRequired: true }) }))).toEqual(["reboot required"]);
  expect(attentionItems(machine({
    host: host({ rebootRequired: true, updates: [{ pkg: "a", from: "1", to: "2" }, { pkg: "b", from: "1", to: "2" }] }),
    backup: { state: "failed", startedAt: null, finishedAt: null, nextAt: null, message: null, repo: null, pull: [] },
    errors: ["probe: unavailable"],
  }))).toEqual(["reboot required", "2 updates", "backup failed", "1 error"]);
});

test("attentionItems: singular vs. plural", () => {
  expect(attentionItems(machine({ host: host({ updates: [{ pkg: "a", from: "1", to: "2" }] }) }))).toEqual(["1 update"]);
  expect(attentionItems(machine({ errors: ["x", "y"] }))).toEqual(["2 errors"]);
});

test("backup age is taken from completion, otherwise from the last archive", () => {
  const now = 1_000_000_000;
  const repo = { archives: [], lastArchiveAt: now - 5_000, originalBytes: 0, storedBytes: 0 };
  expect(backupAge(machine({ backup: { state: "ok", startedAt: null, finishedAt: now - 1_000, nextAt: null, message: null, repo, pull: [] } }), now)).toBe(1_000);
  expect(backupAge(machine({ backup: { state: "ok", startedAt: null, finishedAt: null, nextAt: null, message: null, repo, pull: [] } }), now)).toBe(5_000);
  expect(backupAge(machine(), now)).toBeNull();
});

test("a backup older than 26 h is stale, same as none", () => {
  const now = 2_000_000_000;
  const mk = (finishedAt: number | null) => machine({ backup: { state: "ok", startedAt: null, finishedAt, nextAt: null, message: null, repo: null, pull: [] } });
  expect(backupStale(mk(now - 3600_000), now)).toBe(false);
  expect(backupStale(mk(now - 27 * 3600_000), now)).toBe(true);
  expect(backupStale(mk(null), now)).toBe(true);
  expect(backupStale(machine(), now)).toBe(false);      // a machine without backups is not reported
});

const samples: MachineSample[] = [{
  at: 1000, cpu: 12, memPct: 40, memUsedGb: 4, memTotalGb: 10, swapPct: 25, swapUsedGb: 2, swapTotalGb: 8,
  diskPct: 3.5, diskUsedGb: 68, diskTotalGb: 2000, diskReadMbs: 0.1, diskWriteMbs: 0.4,
  netUpKbs: 94.9, netDownKbs: 18.9, load1: 3, load5: 3.5, load15: 4,
}];

test("toChart extracts one metric, network two curves", () => {
  expect(toChart(samples, "cpu")).toEqual([{ at: 1000, a: 12 }]);
  expect(toChart(samples, "mem")).toEqual([{ at: 1000, a: 4, b: 2, aPct: 40, bPct: 25 }]);
  expect(toChart(samples, "disk")).toEqual([{ at: 1000, a: 3.5 }]);
  expect(toChart(samples, "net")).toEqual([{ at: 1000, a: 18.9, b: 94.9 }]);
});

test("an empty series does not crash", () => {
  expect(toChart([], "cpu")).toEqual([]);
});

test("axis label: short window hours and minutes, weekly also the day", () => {
  const at = new Date(2026, 6, 27, 9, 5).getTime();
  expect(timeLabel(at, "6h")).toBe("09:05");
  expect(timeLabel(at, "7d")).toBe("27. 09:00");
});

test("uptime to two decimal places, otherwise everything is 100 %", () => {
  expect(uptimeLabel(0.9996455660310484)).toBe("99.96 %");
  expect(uptimeLabel(1)).toBe("100.00 %");
  expect(uptimeLabel(null)).toBe("—");
});

test("monitors are grouped by tag and a group with an outage goes to the top", () => {
  const groups = groupMonitors([
    monitor({ id: "1", tag: "INFRA", up: true }),
    monitor({ id: "2", tag: "Acme", up: true }),
    monitor({ id: "3", tag: "Acme", up: false }),
    monitor({ id: "4", tag: null }),
  ]);
  expect(groups.map((g) => g.tag)).toEqual(["Acme", "INFRA", "other"]);
  expect(groups[0].monitors).toHaveLength(2);
});

test("percentage charts have a fixed 0-100 axis, network scales from data", () => {
  // Without a fixed axis recharts stretches a flat 16% curve over the full height and the chart
  // looks like a solid block. Verified live on the devbox CPU chart.
  expect(chartDomain("cpu")).toEqual([0, 100]);
  expect(chartDomain("disk")).toEqual([0, 100]);
  expect(chartDomain("net")).toEqual([0, "dataMax"]);
});

test("memory has a GB axis from zero to RAM size, swap above it stretches the axis", () => {
  // Fixed axis 0–RAM: 57 GB of 62 must look neither like a solid block nor like a flat line.
  expect(chartDomain("mem", samples)).toEqual([0, 10]);
  expect(chartDomain("mem", [{ ...samples[0], swapUsedGb: 30 }])).toEqual([0, 30]);
  expect(chartDomain("mem", [])).toEqual([0, "dataMax"]);
});

test("the memory tooltip label carries both GB and percent", () => {
  expect(memTooltip("a", 57.04, { aPct: 92.1 })).toBe("RAM 57.0 GB (92 %)");
  expect(memTooltip("b", 3.8, { bPct: 3.8 })).toBe("Swap 3.8 GB (4 %)");
  expect(memTooltip("b", 0, {})).toBe("Swap 0.0 GB");
});

test("usage below one percent is not rounded to zero", () => {
  // Storage Box: 2.08 GB of 1 TB = 0.19 %, and "0 %" looks like a broken value.
  expect(fillLabel(2_083_817_190, 1024 ** 4)).toBe("< 1 %");
  expect(fillLabel(0, 1024 ** 4)).toBe("0 %");
  expect(fillLabel(500, 1000)).toBe("50 %");
  expect(fillLabel(5, 0)).toBe("—");
});

test("a docker upgrade is recognized as disruptive", () => {
  // Learned the hard way: "install 12 updates" included docker-ce and friends,
  // the upgrade restarted the docker daemon and killed the agents' work in progress.
  const updates = [
    { pkg: "cloudflared", from: "1", to: "2" },
    { pkg: "docker-ce", from: "1", to: "2" },
    { pkg: "docker-ce-cli", from: "1", to: "2" },
    { pkg: "containerd.io", from: "1", to: "2" },
    { pkg: "docker-compose-plugin", from: "1", to: "2" },
    { pkg: "python3.13", from: "1", to: "2" },
  ];
  expect(disruptiveUpdates(updates)).toEqual(["docker-ce", "docker-ce-cli", "containerd.io", "docker-compose-plugin"]);
});

test("packages that do not take down containers are not considered disruptive", () => {
  // Assigned to a variable (not an inline literal) — `disruptiveUpdates` takes only
  // `{ pkg: string }[]`, but the fixture deliberately carries the full real package shape
  // (pkg/from/to), like the test above. An inline literal would hit the
  // excess-property check, a stored variable does not (same structure, just reached
  // differently by the type).
  const harmless = [{ pkg: "tailscale", from: "1", to: "2" }, { pkg: "libpython3.13-stdlib", from: "1", to: "2" }];
  expect(disruptiveUpdates(harmless)).toEqual([]);
  expect(disruptiveUpdates([])).toEqual([]);
  // But "docker" must match only at the start of the name, not anywhere.
  const prefixOnly = [{ pkg: "libdocker-helper", from: "1", to: "2" }];
  expect(disruptiveUpdates(prefixOnly)).toEqual([]);
});

test("the kernel is recognized separately — it takes nothing down by itself, just wants a reboot", () => {
  const updates = [{ pkg: "linux-image-amd64", from: "1", to: "2" }, { pkg: "docker-ce", from: "1", to: "2" }];
  expect(kernelUpdates(updates)).toEqual(["linux-image-amd64"]);
  expect(disruptiveUpdates(updates)).toEqual(["docker-ce"]);
});

test("certificate expiry within 14 days warns, after expiry it is an error", () => {
  expect(certTone(84)).toBeUndefined();
  expect(certTone(10)).toBe("warn");
  expect(certTone(0)).toBe("danger");
  expect(certTone(null)).toBeUndefined();
});

// Reboot is the only action on the page that used to give NO feedback —
// the machine just vanished after a while (and for the devbox, this dashboard with it). The banner
// shows from the click, disappears on its own once the probe reports an uptime shorter than the
// time since the click (the machine is back), and fades out after 10 minutes regardless.
test("rebootBanner: shows after the click, disappears when the machine returns or after 10 minutes", () => {
  const t0 = 1_800_000_000_000;
  expect(rebootBanner(null, 12345, t0)).toBeNull();
  // right after the click: the banner is there even though the uptime is still old (probe from before the restart)
  expect(rebootBanner(t0, 99_999, t0 + 30_000)).toContain("Rebooting");
  // the machine is back: uptime (2 min) is shorter than the time since the click (5 min)
  expect(rebootBanner(t0, 120, t0 + 5 * 60_000)).toBeNull();
  // uptime unknown (the machine is offline right now) → the banner stays
  expect(rebootBanner(t0, null, t0 + 5 * 60_000)).toContain("Rebooting");
  // after 10 minutes it fades out even without proof of return
  expect(rebootBanner(t0, null, t0 + 11 * 60_000)).toBeNull();
});

test("sessions sort by RAM or CPU, ties by name", () => {
  const rows = [
    { label: "b", memBytes: 5, cpuPct: 10 },
    { label: "a", memBytes: 5, cpuPct: 90 },
    { label: "c", memBytes: 9, cpuPct: 1 },
  ];
  expect(sortResources(rows, "mem").map((r) => r.label)).toEqual(["c", "a", "b"]);
  expect(sortResources(rows, "cpu").map((r) => r.label)).toEqual(["a", "b", "c"]);
  expect(rows[0].label).toBe("b"); // input unchanged
});
