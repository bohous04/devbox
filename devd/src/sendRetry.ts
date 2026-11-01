// Retrying outbound notifications.
//
// Why this exists: on 21 Aug 2026 the VPS lost its OUTBOUND path for ten minutes (Netcup —
// UDP, ICMP and TCP out, see notify_log/tailscaled). Inbound traffic kept flowing,
// so sessions ran and agents worked — but every notification sent in that
// window ended up as `.catch(console.error)` and the user never learned about "finished work"
// or "waiting for permission". One dropped push is worse than a push
// delivered a minute later.
//
// The delays cover ~8 minutes. Deliberately not a longer window: a "waiting for
// permission" notification after ten minutes only confuses, and neither Pushover nor the listener is a message
// queue. Whoever needs certainty across a longer outage has an external monitor for that
// (Kuma heartbeat), not a notification.
export const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

interface HttpError extends Error { status: number }

/** Error from an HTTP response that `sendWithRetry` can classify as temporary/permanent. */
export function httpError(status: number, body: string): HttpError {
  const e = new Error(`HTTP ${status}: ${body.slice(0, 200)}`) as HttpError;
  e.status = status;
  return e;
}

/** Error that retrying will not fix — missing configuration, invalid token. */
export function permanentError(message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = 400;
  return e;
}

// No status = network error (DNS, timeout, dropped connection) → always temporary, exactly
// the case that happened during the outage. With a status we retry only what can resolve
// on its own: 429 (rate limit) and 5xx. 4xx is a bad token or a bad request —
// retrying will not fix it and it would only delay the messages queued behind it.
function retryable(err: unknown): boolean {
  const status = (err as HttpError)?.status;
  if (typeof status !== "number") return true;
  return status === 429 || status >= 500;
}

export interface RetryDeps {
  backoffMs?: number[];
  schedule?: (fn: () => void, ms: number) => void;
  log?: (msg: string) => void;
}

export interface SendResult { delivered: boolean; attempts: number }

/**
 * Calls `send()` and, on a temporary error, retries it according to `backoffMs`.
 *
 * NEVER throws or returns a rejected promise — the callers are fire-and-forget
 * paths (notify fan-out), where a rejection would end up as an unhandled rejection and crash
 * the process. The result is the return value, not an exception.
 */
export async function sendWithRetry(label: string, send: () => Promise<void>, d: RetryDeps = {}): Promise<SendResult> {
  const backoff = d.backoffMs ?? BACKOFF_MS;
  const schedule = d.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const log = d.log ?? ((m) => console.error(m));

  for (let attempt = 1; ; attempt++) {
    try {
      await send();
      if (attempt > 1) log(`${label}: delivered on attempt ${attempt}`);
      return { delivered: true, attempts: attempt };
    } catch (e) {
      const msg = (e as Error).message;
      if (!retryable(e)) {
        log(`${label} failed permanently, not retrying: ${msg}`);
        return { delivered: false, attempts: attempt };
      }
      const delay = backoff[attempt - 1];
      if (delay === undefined) {
        log(`${label}: giving up after ${attempt} attempts, the message is lost (${msg})`);
        return { delivered: false, attempts: attempt };
      }
      await new Promise<void>((resolve) => schedule(resolve, delay));
    }
  }
}
