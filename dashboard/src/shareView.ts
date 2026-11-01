// Terminal sharing from the owner's point of view: validity presets and dialog warnings.
import { untilLabel } from "./share/guest";

/** Validity presets — must match SHARE_MAX_MINUTES (1440) in devd/src/shares.ts. */
export const SHARE_PRESETS: { label: string; minutes: number }[] = [
  { label: "30 min", minutes: 30 },
  { label: "1 h", minutes: 60 },
  { label: "4 h", minutes: 240 },
  { label: "8 h", minutes: 480 },
  { label: "24 h", minutes: 1440 },
];

export function presetMinutes(label: string): number | null {
  return SHARE_PRESETS.find((p) => p.label === label)?.minutes ?? null;
}

export const shareExpiryLabel = untilLabel;

/** Fixed warning text (the user's decision). */
export function shareWarning(expiresAt: number, now = Date.now()): string {
  return `Anyone with the link gets full terminal access to this session until ${shareExpiryLabel(expiresAt, now)} — they can see the code and may obtain your AI account logins (Claude, Codex). Share only with people you trust.`;
}

/** After sharing, the container stays restricted until it is rebuilt (devd/src/shareTaint.ts). */
export const TAINT_MESSAGE = "Sharing ended — the session stays restricted until you rebuild it";
export const TAINT_ACTION = "Rebuild session";

/** Tainted sessions WITHOUT a live share — those with an active link are shown in the share list. */
export function taintedWithoutShare<S extends { id: string; tainted?: boolean }>(
  sessions: S[], shares: { session_id: string; expires_at: number }[], now = Date.now(),
): S[] {
  const live = new Set(shares.filter((s) => s.expires_at > now).map((s) => s.session_id));
  return sessions.filter((s) => s.tainted === true && !live.has(s.id));
}
