// Hardware page logic without the DOM — same pattern as sessionsView / statsView.

import type { Machine, MachineSample, Monitor, SeriesRange } from "./api";

export const SERIES_RANGES: { key: SeriesRange; label: string }[] = [
  { key: "1h", label: "1 h" },
  { key: "6h", label: "6 h" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 d" },
];

/** Machine status dot: Beszel status takes precedence, otherwise judged by the probe. */
export function machineDot(m: Machine): "ok" | "danger" | "off" {
  if (m.beszel) return m.beszel.status === "up" ? "ok" : "danger";
  if (m.host) return "ok";
  return "off";
}

/** Backup status color. `running` is green — it is running right now, not a problem. */
export function backupTone(state: string | undefined): "ok" | "warn" | "danger" | undefined {
  if (state === "ok" || state === "running") return "ok";
  if (state === "failed") return "danger";
  if (state === "unknown") return "warn";
  return undefined;
}

/**
 * What the machine needs from a human, as labels for the card: pending packages,
 * reboot, broken backup, errors. An empty array means "no need to look".
 */
export function attentionItems(m: Machine): string[] {
  const items: string[] = [];
  const updates = m.host?.updates.length ?? 0;
  if (m.host?.rebootRequired) items.push("reboot required");
  if (updates > 0) items.push(`${updates} update${updates === 1 ? "" : "s"}`);
  if (m.backup && m.backup.state === "failed") items.push("backup failed");
  if (m.errors.length > 0) items.push(`${m.errors.length} error${m.errors.length === 1 ? "" : "s"}`);
  return items;
}

/** Age of the last backup in ms; null when none has ever finished. */
export function backupAge(m: Machine, now: number): number | null {
  const at = m.backup?.finishedAt ?? m.backup?.repo?.lastArchiveAt ?? null;
  return at === null ? null : Math.max(0, now - at);
}

/**
 * A backup older than a day is suspicious — all timers run daily. Returns `true`
 * even when nothing has ever run, because "I don't know" is worse here than "I know it didn't".
 */
export function backupStale(m: Machine, now: number): boolean {
  if (!m.backup) return false;
  const age = backupAge(m, now);
  return age === null || age > 26 * 3600_000;   // 26 h: daily timer + margin for drift
}

/**
 * Packages whose upgrade RESTARTS RUNNING CONTAINERS.
 *
 * Learned the hard way: "install 12 updates" on the devbox included docker-ce,
 * docker-ce-cli, containerd.io, docker-ce-rootless-extras and docker-compose-plugin.
 * The upgrade restarted the docker daemon, which took down all session containers and
 * with them the agents' work in progress. This is NOT harmless maintenance and the button must say so.
 */
const RUNTIME_PACKAGES = /^(docker|containerd|runc|podman)/;
/** A new kernel takes no effect without a reboot — on its own it takes nothing down. */
const KERNEL_PACKAGES = /^linux-(image|headers)/;

export function disruptiveUpdates(updates: { pkg: string }[]): string[] {
  return updates.filter((u) => RUNTIME_PACKAGES.test(u.pkg)).map((u) => u.pkg);
}

export function kernelUpdates(updates: { pkg: string }[]): string[] {
  return updates.filter((u) => KERNEL_PACKAGES.test(u.pkg)).map((u) => u.pkg);
}

export type MetricKey = "cpu" | "mem" | "disk" | "net";
export const METRICS: { key: MetricKey; label: string; unit: string }[] = [
  { key: "cpu", label: "CPU", unit: "%" },
  { key: "mem", label: "Memory", unit: "GB" },
  { key: "disk", label: "Disk", unit: "%" },
  { key: "net", label: "Network", unit: "kB/s" },
];

export interface ChartPoint { at: number; a: number; b?: number; aPct?: number; bPct?: number }

/**
 * Chart Y axis. Percentages have a FIXED domain 0–100, otherwise recharts stretches a flat
 * 16% curve across the full height and the chart looks like a solid block (verified live).
 * Network is unbounded; there the domain must be taken from the data.
 */
export function chartDomain(metric: MetricKey, samples: MachineSample[] = []): [number, number | "dataMax"] {
  if (metric === "net") return [0, "dataMax"];
  if (metric !== "mem") return [0, 100];
  // Memory is in GB: the axis ends at the RAM size so 57 GB of 62 does not look like a solid
  // block; swap (100 GB) stretches it only when there really is more of it than RAM.
  const top = Math.max(0, ...samples.map((s) => Math.max(s.memTotalGb, s.swapUsedGb ?? 0)));
  return top > 0 ? [0, top] : [0, "dataMax"];
}

/**
 * Takes a series of samples and extracts one metric for the chart. Network has two curves
 * (up/down), the others one — hence the optional `b`.
 */
export function toChart(samples: MachineSample[], metric: MetricKey): ChartPoint[] {
  return samples.map((s) => {
    switch (metric) {
      case "cpu": return { at: s.at, a: s.cpu };
      case "mem": return { at: s.at, a: s.memUsedGb, b: s.swapUsedGb ?? 0, aPct: s.memPct, bPct: s.swapPct };
      case "disk": return { at: s.at, a: s.diskPct };
      case "net": return { at: s.at, a: s.netDownKbs, b: s.netUpKbs };
    }
  });
}

/** Memory chart tooltip row: `a` is RAM, `b` swap; percentages when known. */
export function memTooltip(name: string, gb: number, point: { aPct?: number; bPct?: number }): string {
  const pct = name === "b" ? point.bPct : point.aPct;
  const label = name === "b" ? "Swap" : "RAM";
  return `${label} ${gb.toFixed(1)} GB${pct === undefined ? "" : ` (${Math.round(pct)} %)`}`;
}

/** X axis label by window width: short windows want hours, long ones days. */
export function timeLabel(at: number, range: SeriesRange): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (range === "7d") return `${d.getDate()}. ${hh}:00`;
  return `${hh}:${mm}`;
}

/** Uptime 0–1 → "99.97 %". Two decimal places, otherwise every row is "100 %". */
export function uptimeLabel(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(2)} %`;
}

/** Monitors grouped by their Kuma tag; untagged ones fall into "other". */
export function groupMonitors(monitors: Monitor[]): { tag: string; monitors: Monitor[] }[] {
  const by = new Map<string, Monitor[]>();
  for (const m of monitors) {
    const key = m.tag ?? "other";
    const list = by.get(key);
    if (list) list.push(m); else by.set(key, [m]);
  }
  // A group with an outage goes to the top, otherwise alphabetical — so the order does not change on poll.
  return [...by.entries()]
    .map(([tag, ms]) => ({ tag, monitors: ms }))
    .sort((a, b) =>
      Number(a.monitors.every((m) => m.up)) - Number(b.monitors.every((m) => m.up))
      || a.tag.localeCompare(b.tag));
}

/**
 * Fill percentage for labels. The Storage Box is 0.19 % full and `Math.round` turns that
 * into "0 %", which looks like a broken value — below one percent it is said in words.
 */
export function fillLabel(part: number, total: number): string {
  if (total <= 0) return "—";
  const pct = (part / total) * 100;
  if (pct > 0 && pct < 1) return "< 1 %";
  return `${Math.round(pct)} %`;
}

/** A certificate under 14 days is a warning, under 0 an error. */
export function certTone(days: number | null): "warn" | "danger" | undefined {
  if (days === null) return undefined;
  if (days <= 0) return "danger";
  return days <= 14 ? "warn" : undefined;
}

/* ------------------------------- reboot banner ------------------------------- */

// Cap after which the banner fades even without proof the machine came back — if the reboot
// failed (or the probe never confirmed it), it must not hang here forever.
export const REBOOT_BANNER_MAX_MS = 10 * 60_000;

/** Banner text after clicking Reboot, or null (do not show). Otherwise Reboot is an
 *  action with no feedback at all: HTTP returns 202 and the machine just disappears a bit later —
 *  on the devbox together with this dashboard. The banner disappears by itself once the probe
 *  reports an uptime SHORTER than the time since the click (the machine provably came back up);
 *  an unknown uptime (the machine is offline right now) keeps the banner. */
export function rebootBanner(rebootedAt: number | null, uptimeSec: number | null | undefined, now: number): string | null {
  if (rebootedAt === null) return null;
  const elapsed = now - rebootedAt;
  if (elapsed > REBOOT_BANNER_MAX_MS) return null;
  if (uptimeSec != null && uptimeSec * 1000 < elapsed) return null;
  const min = Math.max(1, Math.round(elapsed / 60_000));
  return `Rebooting — initiated ${min} min ago. The machine goes down and comes back on its own; this page may briefly fail to refresh in the meantime.`;
}

export type ResourceSort = "mem" | "cpu";

/** Sessions from the biggest consumer down; ties by name, so rows do not jump. */
export function sortResources<T extends { label: string; memBytes: number; cpuPct: number }>(rows: T[], key: ResourceSort): T[] {
  const v = (r: T) => (key === "mem" ? r.memBytes : r.cpuPct);
  return [...rows].sort((a, b) => v(b) - v(a) || a.label.localeCompare(b.label));
}
