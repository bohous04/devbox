// Pushover phone push. Fire-and-forget; a no-op (returns false) when unconfigured,
// so the whole notification path stays inert until secrets.pushover is filled in.
//
// "Fire-and-forget" does not mean "a single attempt", though: sending is handled by `sendWithRetry`,
// so a short outage of the outbound network delays the notification, it does not drop it (see sendRetry.ts).
import type { NotifyTargetKind } from "./agentEvents";
import { httpError, sendWithRetry } from "./sendRetry";

// `target`/`targetId`/`blocked` are read only by the APNs channel (pushChannel.ts); Pushover
// ignores them — its target is provided by the `url` to the dashboard page (pushOptsFor in notify.ts).
export interface PushOpts {
  priority?: number; retry?: number; expire?: number; sound?: string; url?: string; url_title?: string;
  target?: NotifyTargetKind; targetId?: string; blocked?: boolean;
}
export interface Pushover { readonly enabled: boolean; send(title: string, message: string, opts?: PushOpts): boolean }

// "important" session → a loud, persistent alert: priority 2 (emergency) repeats the
// push every `retry` s until you acknowledge it, up to `expire` s; `persistent` is a
// long-lasting sound (alarm). Retry min. 30 s, expire max. 10800 s (Pushover limits).
export const EMERGENCY: PushOpts = { priority: 2, retry: 60, expire: 3600, sound: "persistent" };

export function createPushover(token?: string, user?: string, timeoutMs = 4000): Pushover {
  const enabled = !!token && !!user;
  return {
    enabled,
    send(title, message, opts) {
      if (!enabled) return false;
      const params: Record<string, string> = { token: token!, user: user!, title, message };
      if (opts?.priority !== undefined) params.priority = String(opts.priority);
      // Emergency MUST have retry + expire, otherwise Pushover rejects the request.
      if (opts?.priority === 2) {
        params.retry = String(opts.retry ?? 60);
        params.expire = String(opts.expire ?? 3600);
      }
      if (opts?.sound) params.sound = opts.sound;
      if (opts?.url) params.url = opts.url;
      if (opts?.url_title) params.url_title = opts.url_title;
      // Time of the EVENT, not of delivery. A push delayed by a few minutes due to a network outage
      // otherwise looks on the phone as if the agent got stuck just now — and that is worse than silence.
      params.timestamp = String(Math.floor(Date.now() / 1000));
      void sendWithRetry("pushover", async () => {
        const r = await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) throw httpError(r.status, await r.text().catch(() => ""));
      });
      return true;
    },
  };
}
