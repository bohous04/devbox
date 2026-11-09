import type { ServerRef } from "./prodDb";
import { createTunnelPool, type TunnelPoolDeps } from "./tunnelPool";

/** Opens a forward-only SSH tunnel 127.0.0.1:hp -> (VPS) 127.0.0.1:hp, runs fn, then closes it.
 *  The key is forward-only (permitopen on that port), so it gives no shell or other target.
 *
 *  Built on a one-shot tunnel pool so it shares its startup checks: a port already owned by a
 *  foreign process is refused (never send DB credentials to it), and fn() does not run unless
 *  the tunnel actually came up — ssh exiting early or the port staying silent throws instead. */
export async function withTunnel<T>(
  s: ServerRef, keyPath: string, hp: number, fn: () => Promise<T>,
  deps: Omit<TunnelPoolDeps, "keyPath"> = {},
): Promise<T> {
  const pool = createTunnelPool({ ...deps, keyPath: () => keyPath });
  try {
    await pool.ensure(s, hp);
    return await fn();
  } finally {
    await pool.stopAll();
  }
}
