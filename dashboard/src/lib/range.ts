export type RangePresetId = "today" | "7d" | "30d" | "90d" | "month" | "custom";

export const PRESETS: { id: RangePresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** to is the exclusive end (tomorrow's midnight), from is the start's midnight. */
export function presetRange(id: Exclude<RangePresetId, "custom">, now: number): { from: number; to: number } {
  const to = startOfDay(now) + 86_400_000; // tomorrow's midnight
  if (id === "today") return { from: startOfDay(now), to };
  if (id === "month") { const d = new Date(now); return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to }; }
  const days = id === "7d" ? 7 : id === "30d" ? 30 : 90;
  return { from: to - days * 86_400_000, to };
}

/** Which preset matches the given range (for highlighting the active button). */
export function matchPreset(r: { from: number; to: number }, now: number): RangePresetId {
  for (const p of PRESETS) {
    if (p.id === "custom") continue;
    const c = presetRange(p.id, now);
    if (c.from === r.from && c.to === r.to) return p.id;
  }
  return "custom";
}

/** In-progress calendar selection → finished range, or `null` when the user
 *  has not picked a start yet. A single selected day is legitimate (one-day range).
 *  The end is the exclusive tomorrow's midnight, same as presetRange, so the last
 *  selected day is fully inside. */
export function rangeFromDraft(draft: { from?: Date; to?: Date } | undefined): { from: number; to: number } | null {
  if (!draft?.from) return null;
  const a = startOfDay(draft.from.getTime());
  const b = startOfDay((draft.to ?? draft.from).getTime());
  const [from, last] = a <= b ? [a, b] : [b, a];
  return { from, to: last + 86_400_000 };
}

/** Number of whole days in the range — decides whether drawing a daily series makes sense. */
export const rangeDays = (r: { from: number; to: number }): number => Math.round((r.to - r.from) / 86_400_000);
