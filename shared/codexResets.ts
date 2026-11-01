export interface ResetAnnouncement {
  id: string;
  reset_type: "regular" | "banked";
  announced_at: string;
  text: string;
  source: { type: "x_post" | "observed"; url?: string };
}
export interface CodexResetStatus {
  data: {
    latest_reset: ResetAnnouncement | null;
    scheduled_reset: (ResetAnnouncement & { status: "scheduled"; scheduled_for: string | null }) | null;
    active_watch: { level: "elevated" | "strong"; reset_chance_percent: number | null; forecast_window: string; observed_at: string; expires_at: string; text: string; source: ResetAnnouncement["source"] } | null;
  };
  meta: { generated_at: string };
}
export interface CodexResetSnapshot { status: CodexResetStatus | null; fetchedAt: number | null; stale: boolean }

const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
function source(v: any): boolean {
  return v && (v.type === "x_post" || v.type === "observed") && (v.url === undefined || typeof v.url === "string");
}
function announcement(v: any): boolean {
  return v && typeof v.id === "string" && ["regular", "banked"].includes(v.reset_type)
    && date(v.announced_at) && typeof v.text === "string" && source(v.source);
}
export function isCodexResetStatus(v: any): v is CodexResetStatus {
  if (!v?.data || !date(v.meta?.generated_at)) return false;
  const { latest_reset: latest, scheduled_reset: scheduled, active_watch: watch } = v.data;
  return (latest === null || announcement(latest))
    && (scheduled === null || (announcement(scheduled) && scheduled.status === "scheduled" && (scheduled.scheduled_for === null || date(scheduled.scheduled_for))))
    && (watch === null || (watch && ["elevated", "strong"].includes(watch.level)
      && (watch.reset_chance_percent === null || (Number.isInteger(watch.reset_chance_percent) && watch.reset_chance_percent >= 0 && watch.reset_chance_percent <= 100))
      && typeof watch.forecast_window === "string" && typeof watch.text === "string" && date(watch.observed_at) && date(watch.expires_at) && source(watch.source)));
}

export function safeSourceUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.href : undefined; } catch { return undefined; }
}
