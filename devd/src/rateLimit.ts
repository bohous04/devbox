// Sliding-window limiter for routes reachable from any container (the SSH gate
// in api.ts). A pure function over injected time — tested with a table, not by waiting.
//
// Why at all: devd listens on 0.0.0.0 and ufw allows 4300/tcp from all docker bridge networks,
// so EVERY container on the host can reach these routes — including those that have nothing
// to do with the devbox (Coolify applications, gh-runner, databases). Without a limit they
// could produce a flood of approval dialogs on the mac; the point of the attack is not to get through
// the gate by force, but to wear the human down until they click one of those dialogs through. The limit is therefore
// primarily protection against prompt fatigue, not against overloading the server.

export interface RateLimiter {
  /** Registers an attempt. `ok: false` → the caller should return 429 with `retryAfterSec`. */
  take(key: string): { ok: boolean; retryAfterSec: number };
}

/** `limit` passes per `key` within the last `windowMs`. The window is sliding (not fixed
 *  buckets), so the limit cannot be bypassed by timing attempts around a window boundary. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();
  // Cap on the number of keys: a key is a session id or a source address, both chosen by the caller,
  // so without cleanup the map would grow forever (one key per made-up session).
  // Cleanup is lazy — it runs once the map grows large, not on every call.
  const MAX_KEYS = 512;
  return {
    take(key) {
      const t = now();
      const cutoff = t - windowMs;
      if (hits.size > MAX_KEYS) {
        for (const [k, v] of hits) if (v.every((x) => x <= cutoff)) hits.delete(k);
      }
      const fresh = (hits.get(key) ?? []).filter((x) => x > cutoff);
      if (fresh.length >= limit) {
        // The oldest pass in the window determines when a slot frees up. `Math.ceil` and a minimum
        // of 1 s: 0 would invite the caller to retry immediately.
        const retryAfterSec = Math.max(1, Math.ceil((fresh[0]! + windowMs - t) / 1000));
        // A rejected attempt is DELIBERATELY not counted — otherwise dense enough spam would keep the window
        // full forever and the limit would behave like a permanent ban.
        hits.set(key, fresh);
        return { ok: false, retryAfterSec };
      }
      fresh.push(t);
      hits.set(key, fresh);
      return { ok: true, retryAfterSec: 0 };
    },
  };
}
