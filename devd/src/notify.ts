import type { NotifyExtra, NotifyTargetKind } from "./agentEvents";
import { EMERGENCY, type PushOpts } from "./pushover";

/** Target → dashboard page for Pushover (paths from dashboard/src/nav.ts). The vault
 *  is unlocked from the panel on Overview, hence "/". */
const TARGET_PATHS: Record<NotifyTargetKind, string> = {
  prodWrites: "/prod-writes",
  sshApprovals: "/ssh-approvals",
  schedules: "/cron",
  subscriptions: "/subscriptions",
  vault: "/",
};

/** Builds opts for the phone channel from `notify()` extra. important → EMERGENCY.
 *  A session-scoped push carries a deep link to that session's web terminal (tap the
 *  notification → terminal) and takes precedence; otherwise target → dashboard page.
 *  `target`/`targetId`/`blocked` are always passed on — APNs builds the payload from them,
 *  Pushover ignores them. */
export function pushOptsFor(extra: NotifyExtra | undefined, dashboardUrl: string): PushOpts {
  const opts: PushOpts = { ...(extra?.important ? EMERGENCY : {}) };
  if (!dashboardUrl) {
    // Without DEVD_DASHBOARD_URL there is nowhere to link — the notification goes without a link.
  } else if (extra?.session) {
    opts.url = `${dashboardUrl}/sessions?terminal=${encodeURIComponent(extra.session.id)}`;
    opts.url_title = "Open terminal";
  } else if (extra?.target) {
    opts.url = `${dashboardUrl}${TARGET_PATHS[extra.target.kind]}`;
    opts.url_title = "Open in dashboard";
  }
  if (extra?.target) {
    opts.target = extra.target.kind;
    if (extra.target.id !== undefined) opts.targetId = extra.target.id;
  }
  if (extra?.blocked) opts.blocked = true;
  return opts;
}

export function shouldWarnDisk(usedBytes: number, totalBytes: number, warnPercent: number, lastWarnTs: number, now: number): boolean {
  if (totalBytes <= 0) return false;
  const pct = (usedBytes / totalBytes) * 100;
  return pct >= warnPercent && now - lastWarnTs >= 6 * 3600_000;
}

function tb(bytes: number): string { return `${(bytes / 1e12).toFixed(1)} TB`; }

export function diskWarnMessage(usedBytes: number, totalBytes: number, daysLeft: number | null): string {
  const pct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  const eta = daysLeft === null ? "plenty of space left" : `full in ~${Math.round(daysLeft)} days`;
  return `Disk at ${pct}% (${tb(usedBytes)} / ${tb(totalBytes)}) — ${eta}`;
}
