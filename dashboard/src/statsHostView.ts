import type { RangeStats } from "./api";

export type HostFilter = "all" | string;
type Totals = { cost: number; tokens: number; hours: number };
const ZERO: Totals = { cost: 0, tokens: 0, hours: 0 };

/** Hosts for the selector. Sorted alphabetically, not by cost — the order in the selector
 *  must not shuffle between loads, otherwise the selection jumps under the user's hand. */
export function hostOptions(data: RangeStats): string[] {
  return [...(data.hosts ?? []).map((h) => h.key)].sort();
}

function pick(rows: RangeStats["hosts"] | undefined, host: string): Totals {
  const r = (rows ?? []).find((x) => x.key === host);
  return r ? { cost: r.cost, tokens: r.tokens, hours: r.hours } : { ...ZERO };
}

export function totalsFor(data: RangeStats, host: HostFilter): Totals {
  return host === "all" ? data.totals : pick(data.hosts, host);
}

export function previousFor(data: RangeStats, host: HostFilter): Totals {
  return host === "all" ? data.previous : pick(data.hostsPrevious, host);
}

/** Series for the chart: in "all" one per host (split chart), otherwise one.
 *  An unknown host returns [[]] (not []): JSX chart.map(series => <Line/>) needs
 *  something to map over, otherwise the chart would not render at all. [[]] = one empty dataset. */
export function seriesFor(data: RangeStats, host: HostFilter): RangeStats["daily"][] {
  const all = data.dailyByHost ?? [];
  if (host === "all") return all.map((h) => h.days);
  const one = all.find((h) => h.host === host);
  return one ? [one.days] : [[]];
}

/** Label for any "missing attribute" bucket (host, project, account…).
 *  `—` is the SQL fallback (COALESCE) for rows without that attribute — we keep it
 *  as a real bucket and just rename it, so a bare dash character never shows
 *  anywhere. One place that knows about the em dash, so we do not duplicate it across components. */
export function unknownLabel(key: string): string {
  return key === "—" ? "Unknown" : key;
}

/** Readable host label for the UI. */
export function hostLabel(host: string): string {
  if (host === "mac") return "Mac";
  if (host === "devbox") return "Devbox";
  return unknownLabel(host);
}
