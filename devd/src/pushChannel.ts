// APNs phone channel — implements the SAME interface as Pushover (`Pushover`
// from pushover.ts: {enabled, send(title, message, opts)}), so that at the construction
// site (index.ts) it can simply be swapped based on `settings.phoneChannel`. The Pushover code
// stays untouched — it is just not called while the channel is "apns" (it will be deleted only
// after verified operation, see the internal design notes).
import type { Database } from "bun:sqlite";
import { deletePushDevice, insertPushAlert, listOpenPushAlerts, listPushDevices, touchPushAlert } from "./db";
import { sendApns, type ApnsConfig, type ApnsNotification } from "./apns";
import type { Pushover, PushOpts } from "./pushover";

// Same shape as the (unexported) RunFn in apns.ts — curl via an injected `run`,
// so it can be simulated without a network (the `run` pattern of codexAuth/harvesters in index.ts).
export type RunFn = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface PushChannelDeps { db: Database; run: RunFn; now: () => number }

/** Emergency (opts.priority === 2, see EMERGENCY in pushover.ts) and blocked
 *  (`opts.blocked`, from NotifyExtra.blocked — prod write approval, SSH key,
 *  locked vault) are recognized from the STRUCTURE. Agent hooks, however, do not set `blocked`
 *  and their blocked states (agentEvents.ts: `blockedText` → "…is waiting for permission"/
 *  "…is waiting for input") are still recognized only from the TEXT — the phrase "is waiting for" remains as a
 *  fallback signal (and for backward compatibility with calls without the flag). Everything
 *  else falls into "done" (an informational category, not fatal — the app shows it
 *  as a regular notification without any special action).
 */
function categoryFor(title: string, message: string, opts?: PushOpts): ApnsNotification["category"] {
  if (opts?.priority === 2) return "emergency";
  if (opts?.blocked === true) return "blocked";
  return `${title} ${message}`.toLowerCase().includes("is waiting for") ? "blocked" : "done";
}

/** `notify()` builds the deep link as `<dashboardUrl>/sessions?terminal=<id>` (see
 *  index.ts) — this extracts the sessionId from it for the APNs payload and terminal:true, so the
 *  app knows to open the terminal directly, not just the session detail. */
function sessionFromUrl(url?: string): { sessionId?: string; terminal?: boolean } {
  if (!url) return {};
  try {
    const terminal = new URL(url).searchParams.get("terminal");
    return terminal ? { sessionId: terminal, terminal: true } : {};
  } catch {
    return {};
  }
}

/** Sends one notification to all registered devices; a dead token (APNs 410)
 *  is deleted from `push_devices` right away. Sequential (not Promise.all) — there are usually only
 *  a few devices and a sequential run is easier to trace in tests and in the error log. */
async function pushToAllDevices(d: PushChannelDeps, cfg: ApnsConfig, n: ApnsNotification): Promise<void> {
  for (const device of listPushDevices(d.db)) {
    const result = await sendApns({ run: d.run, now: d.now }, cfg, device.token, n);
    if (result === "gone") deletePushDevice(d.db, device.token);
  }
}

export function createApnsChannel(d: PushChannelDeps, cfg: ApnsConfig | null): Pushover {
  const enabled = !!cfg?.keyPath && !!cfg?.keyId && !!cfg?.teamId && !!cfg?.bundleId;

  return {
    enabled,
    send(title, message, opts) {
      if (!enabled) return false;
      const category = categoryFor(title, message, opts);
      const { sessionId, terminal } = sessionFromUrl(opts?.url);
      const target = opts?.target, targetId = opts?.targetId;

      // Fire-and-forget: `send` must return a boolean immediately (same contract as
      // Pushover), the actual work runs in the background via `void`.
      if (category === "emergency") {
        const alertId = crypto.randomUUID();
        insertPushAlert(d.db, { alert_id: alertId, title, message, session_id: sessionId ?? null });
        void pushToAllDevices(d, cfg!, { title, message, category, sessionId, alertId, terminal, target, targetId, timeSensitive: true })
          .then(() => touchPushAlert(d.db, alertId, d.now()))
          .catch((e) => console.error("apns: emergency push failed:", (e as Error).message));
      } else {
        void pushToAllDevices(d, cfg!, { title, message, category, sessionId, terminal, target, targetId })
          .catch((e) => console.error("apns: push failed:", (e as Error).message));
      }
      return true;
    },
  };
}

/** Called by index.ts on the tick (30 s): unacknowledged emergency alerts (up to 10 min old —
 *  `listOpenPushAlerts` already does that filtering) older than 30 s since the last send are
 *  pushed again to all devices and `last_sent_at` is advanced. After 10 min the alert drops out of
 *  `listOpenPushAlerts` on its own (the last push happened by then, no further
 *  ones) — exactly the behavior from the spec "last unacked push and done". */
export async function tickPushAlerts(d: PushChannelDeps, cfg: ApnsConfig | null): Promise<void> {
  if (!cfg) return;
  const now = d.now();
  const due = listOpenPushAlerts(d.db, now).filter((a) => a.last_sent_at <= now - 30_000);
  for (const a of due) {
    await pushToAllDevices(d, cfg, {
      title: a.title, message: a.message, category: "emergency",
      sessionId: a.session_id ?? undefined, alertId: a.alert_id, timeSensitive: true,
    });
    touchPushAlert(d.db, a.alert_id, now);
  }
}
