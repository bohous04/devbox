import type { UsagePoint } from "../../shared/usage";
export type { UsagePoint } from "../../shared/usage";
export interface UsageChartPoint { sampledAt: number; percentUsed: number | null }
// Preserve gaps and reset boundaries. Never draw a diagonal from the prior
// week's quota into a new quota period, or across an extended sampling outage.
export function usageChartPoints(history: UsagePoint[], window: string): UsageChartPoint[] {
  const points = history.filter((p) => p.window === window).sort((a, b) => a.sampledAt - b.sampledAt);
  const result: UsageChartPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]; const before = points[i - 1];
    if (before && (p.sampledAt - before.sampledAt > 30 * 60_000 || ((before.resetsAt !== null && p.resetsAt !== null && before.resetsAt !== p.resetsAt) || (before.resetsAt !== null && before.sampledAt < before.resetsAt && before.resetsAt <= p.sampledAt)))) {
      result.push({ sampledAt: Math.max(before.sampledAt + 1, p.sampledAt - 1), percentUsed: null });
    }
    result.push({ sampledAt: p.sampledAt, percentUsed: p.percentUsed });
  }
  return result;
}
export function usageResetMarkers(history: UsagePoint[], window: string, from: number, to: number, known: { window: string; resetsAt: number }[] = []): number[] {
  return [...new Set([...history, ...known].filter((p) => p.window === window && p.resetsAt !== null && p.resetsAt >= from && p.resetsAt < to).map((p) => p.resetsAt!))].sort((a, b) => a - b);
}
export interface UsageChartRow { sampledAt: number; values: Record<string, number | null> }
// One shared timeline for all series, so the tooltip reports every line at the
// hovered time instead of pairing unrelated points that share an array index.
// A step value holds until that series' next reading or gap; after its last
// reading the series has no value.
export function mergeUsageSeries(series: { key: string; points: UsageChartPoint[] }[]): UsageChartRow[] {
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.sampledAt)))].sort((a, b) => a - b);
  const cursors = series.map(() => -1);
  return times.map((sampledAt) => {
    const values: Record<string, number | null> = {};
    series.forEach((s, i) => {
      while (cursors[i] + 1 < s.points.length && s.points[cursors[i] + 1].sampledAt <= sampledAt) cursors[i]++;
      const at = cursors[i];
      values[s.key] = at < 0 || (at === s.points.length - 1 && s.points[at].sampledAt < sampledAt) ? null : s.points[at].percentUsed;
    });
    return { sampledAt, values };
  });
}

/** Colors of the limits chart series — a saturated, mutually distinct palette without grey. A grey series
 *  blended into the grid and axes and looked "turned off". */
export const USAGE_COLORS = ["#2563eb", "#10b981", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];

/** Which window belongs in the weekly limits chart. Five-hour windows do not belong here (the chart
 *  is weekly; Antigravity sends them too and their resets every 5 h flooded the chart
 *  with dashed lines), Claude per-model windows (`weekly_scoped:<model>`, today Fable)
 *  duplicate the aggregate `weekly_all`, and the Antigravity group "Claude and GPT models"
 *  is not used. */
export function isChartedWindow(provider: string, accountLabel: string, window: string): boolean {
  if (window === "five_hour" || window.startsWith("weekly_scoped:")) return false;
  if (provider === "agy" && /claude and gpt/i.test(accountLabel)) return false;
  return true;
}
