import type { Quantiles } from "./api";

export interface Ranked { key: string; cost: number; tokens: number }

/** Unifies the leaderboards (projects / models / repos) into one shape, so the table
 *  and click-through are one component instead of three nearly identical ones. */
export const toRanked = <T extends Record<string, unknown>>(rows: T[], field: keyof T): Ranked[] =>
  rows.map((r) => ({ key: String(r[field] ?? "—"), cost: Number(r.cost) || 0, tokens: Number(r.tokens) || 0 }));

/** Project options for the filter. Alphabetical, not by cost — the order in the picker
 *  must not shuffle between ranges (same reasoning as hostOptions). The "—" bucket
 *  (rows without a project attribute) is skipped: it cannot be filtered on, the server
 *  compares it for equality with NULL and would return all zeros. `active` is added even
 *  when it has no data in the range — otherwise for a link with ?project=… the selector would
 *  show empty and the filter could not be cleared. */
export function projectOptions(projects: { project: string }[], active?: string | null): string[] {
  const keys = projects.map((p) => p.project).filter((p) => p && p !== "—");
  if (active) keys.push(active);
  return [...new Set(keys)].sort();
}

/** Share of the total in percent; an empty total → 0 (not NaN). */
export function share(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, (part / total) * 100);
}

export const totalCost = (rows: Ranked[]): number => rows.reduce((a, r) => a + r.cost, 0);

/** One page of the list. A page out of range is clamped, so after a filter change the user
 *  does not stare at an empty page instead of data. */
export function page<T>(rows: T[], pageIndex: number, perPage = 25): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const p = Math.min(Math.max(pageIndex, 0), pages - 1);
  return { items: rows.slice(p * perPage, p * perPage + perPage), page: p, pages };
}

/** "09:00" for the hour-of-day axis. */
export const hourLabel = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/** Busiest hour of the day — for the caption under the chart. null when no work was done. */
export function peakHour(hourly: { hour: number; hours: number; cost: number }[]): number | null {
  let best: { hour: number; v: number } | null = null;
  for (const h of hourly) {
    const v = h.hours > 0 ? h.hours : 0;
    if (v > 0 && (best === null || v > best.v)) best = { hour: h.hour, v };
  }
  return best?.hour ?? null;
}

/** Duration in ms → short human label for tiles ("4 min", "1 h 20 min"). */
export function msLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

/** Label for a quantile that has no data yet — prompt statistics start on the
 *  day of the deploy, so empty is the normal state, not an error. */
export function quantileLabel(q: Quantiles | undefined, fmt: (v: number) => string): string {
  if (!q || q.count === 0) return "—";
  return fmt(q.p50);
}
