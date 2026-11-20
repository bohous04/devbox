/** Cache for expensive read-only things that call out of the process (subprocess, HTTP,
 *  docker). It behaves as stale-while-revalidate: once a value exists,
 *  no request ever waits again — the old one is returned immediately and the refresh runs in the background.
 *
 *  Why exactly this: `/api/tree` (gh repo list + Gitea) took 1.42 s and
 *  `/api/cc-upkeep` (2× docker run + docker exec per session) 2.16 s, and both were
 *  called again on every page open. A plain TTL would only dilute the problem —
 *  a request that hits the expiry would wait the whole time. */
export function memoAsync<T>(fn: () => Promise<T>, ttlMs: number): { get: () => Promise<T>; invalidate: () => void } {
  let value: { v: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;

  const run = (): Promise<T> => {
    if (inFlight) return inFlight;   // single-flight: a concurrent call does not start a second gh/docker
    inFlight = fn()
      .then((v) => { value = { v, at: Date.now() }; return v; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    get: async () => {
      if (!value) return run();                       // we have nothing, we must wait
      if (Date.now() - value.at < ttlMs) return value.v;
      // Old but usable: we return it immediately and refresh in the background. A refresh error
      // is swallowed — the old value is still better than a broken page.
      run().catch(() => {});
      return value.v;
    },
    invalidate: () => { value = null; },
  };
}

/** Asynchronous sibling of memoAsync above — but WITHOUT stale-while-revalidate and without
 *  a silent background: a pure TTL cache with single-flight. The caller should learn about an outage
 *  IMMEDIATELY (e.g. sshKeyLister in index.ts, which verifies the title on POST
 *  /api/ssh-approvals — the approval flow must not pretend an unavailable 1Password is
 *  fine), not get a stale answer. Success is held for `ttlMs`; an error is never
 *  cached, so the next call retries right away. */
export function memoAsyncStrict<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let value: { v: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (value && Date.now() - value.at < ttlMs) return Promise.resolve(value.v);
    if (inFlight) return inFlight;
    inFlight = fn()
      .then((v) => { value = { v, at: Date.now() }; return v; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

export interface Snapshot<T> { value: T | null; at: number | null; scanning: boolean; error: string | null }

/** A value built only in the background: no caller ever waits for a build. `peek()` returns the
 *  last value (null before the first one finishes) with its time, starts a build when there is
 *  none yet or it is older than `ttlMs`, and says whether one is running. Unlike memoAsync a build
 *  error is kept and reported (the last value stays). `refresh()` forces a build; asked during a
 *  build it queues exactly one more, since the running one may predate the change. */
export function backgroundSnapshot<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = Date.now): {
  peek: () => Snapshot<T>; refresh: () => void; idle: () => Promise<void>;
} {
  let value: { v: T; at: number } | null = null;
  let error: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  const start = () => {
    running = fn()
      .then((v) => { value = { v, at: now() }; error = null; })
      .catch((e) => { error = e instanceof Error ? e.message : String(e); console.error("background build failed:", e); })
      .finally(() => { running = null; if (again) { again = false; start(); } });
  };
  return {
    peek: () => {
      if (!running && (!value || now() - value.at >= ttlMs)) start();
      return { value: value?.v ?? null, at: value?.at ?? null, scanning: running !== null, error };
    },
    refresh: () => { if (running) again = true; else start(); },
    idle: async () => { while (running) await running; },
  };
}
