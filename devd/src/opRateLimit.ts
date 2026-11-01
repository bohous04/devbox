import { run, timeoutFor, type RunOpts, type RunResult } from "./proc";

/** Safe public error: never includes CLI output, item references or the token. */
export class OpRateLimited extends Error {
  constructor(readonly retryAt: number, readonly resetKnown: boolean) {
    const at = new Date(retryAt).toLocaleString("en-GB", { timeZone: process.env.DEVD_TZ || undefined, timeZoneName: "short" });
    super(resetKnown
      ? `1Password: request limit exhausted. Quota resets at: ${at}.`
      : "1Password is rejecting further requests due to the rate limit. Reset time is unknown; repeated queries are temporarily paused.");
    this.name = "OpRateLimited";
  }
  retryAfterSeconds(now = Date.now()): number { return Math.max(1, Math.ceil((this.retryAt - now) / 1000)); }
}

type Runner = (cmd: string[], opts: RunOpts) => Promise<RunResult>;
const limited = (r: RunResult) => r.code !== 0 && /too many requests|rate[- ]limited/i.test(r.stderr);

/** Shared host-side circuit breaker. A quota error queries usage once, then all
 * SSH and DB callers fail locally until reset. It never serves stale secrets or
 * retries a write. Each token has independent state; replacing it cannot reuse
 * another credential's result. Test instances inject their own process runner. */
export function createOpRunner(deps: { run?: Runner; now?: () => number } = {}) {
  const exec = deps.run ?? run, now = deps.now ?? Date.now;
  const blocked = new Map<string, OpRateLimited>();
  const checking = new Map<string, Promise<OpRateLimited>>();
  const execute = (token: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}) =>
    exec(["op", ...args], {
      env: { OP_SERVICE_ACCOUNT_TOKEN: token }, unsetEnv: ["OP_CONNECT_HOST", "OP_CONNECT_TOKEN"],
      stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? timeoutFor("NET_CLI"),
    });

  function quotaError(token: string): Promise<OpRateLimited> {
    const pending = checking.get(token); if (pending) return pending;
    const previous = blocked.get(token); if (previous && previous.retryAt > now()) return Promise.resolve(previous);
    const fallback = new OpRateLimited(now() + 60_000, false);
    blocked.set(token, fallback); // Stop callers while the diagnostic is in flight.
    const job = (async () => {
      try {
        const result = await execute(token, ["service-account", "ratelimit", "--format", "json"], { timeoutMs: 10_000 });
        if (result.code || result.timedOut) return fallback;
        const rows: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(rows)) return fallback;
        const resets = rows.filter(r => r && typeof r === "object" && r.remaining === 0 &&
          typeof r.reset === "number" && Number.isFinite(r.reset) && r.reset > 0 && r.reset <= 7 * 86400)
          .map(r => r.reset as number);
        if (!resets.length) return fallback;
        const error = new OpRateLimited(now() + Math.ceil(Math.max(...resets)) * 1000, true);
        blocked.set(token, error);
        return error;
      } catch { return fallback; }
    })();
    checking.set(token, job);
    void job.finally(() => checking.delete(token));
    return job;
  }

  return async (token: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> => {
    const pending = checking.get(token); if (pending) throw await pending;
    const error = blocked.get(token);
    if (error && error.retryAt > now()) throw error;
    if (error) blocked.delete(token);
    const result = await execute(token, args, opts);
    if (limited(result)) throw await quotaError(token);
    return result;
  };
}

export const runOp = createOpRunner();
