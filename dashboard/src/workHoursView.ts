// Pure logic for the "Work hours" section on Stats — modeled on ccUpkeepView.ts.
// BEWARE of confusing it with "Active time" (RangeStats.totals.hours, metric
// claude_code.active_time.total): this is wall-clock from the prompt to the end of
// the turn, see the comment at buildWorkHours in devd/src/aggregate.ts.

/** Hours and minutes instead of a decimal number — "1h 30m", not "1.5". Zero values
 *  show "0m" (not "0h"), so an empty range is not mistaken for a rounding error. */
export function formatHours(h: number): string {
  const totalMinutes = Math.round(h * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  if (hh === 0) return `${mm}m`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h ${mm}m`;
}

/** Work hours narrowed to the selected project. Filtering happens here, not on the server:
 *  `byProject` already contains the per-project breakdown, so a second endpoint parameter
 *  would add nothing. `daily` is not filtered — Stats does not draw it and the server does not send
 *  a per-day breakdown per project; whoever needs it has to add it there,
 *  not compute it from the totals. */
export function workForProject(
  w: { totalHours: number; byProject: { project: string; hours: number; cappedHours: number }[] },
  project: string | null,
): { totalHours: number; byProject: { project: string; hours: number; cappedHours: number }[] } {
  if (!project) return { totalHours: w.totalHours, byProject: w.byProject };
  const byProject = w.byProject.filter((p) => p.project === project);
  return { totalHours: byProject.reduce((s, p) => s + p.hours, 0), byProject };
}

/** Note about the 30 min/turn cap — only where the cap actually cut off some
 *  interval. Without the condition "capped by 0m" would appear for every project. */
export function cappedNote(p: { project: string; hours: number; cappedHours: number }): string | null {
  if (p.cappedHours <= 0) return null;
  return `${formatHours(p.cappedHours)} capped by the 30-min-per-turn limit — actual work took longer`;
}
