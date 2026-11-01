import type { ServerRef } from "./prodDb";

/** Opens a forward-only SSH tunnel 127.0.0.1:hp -> (VPS) 127.0.0.1:hp, runs fn, then closes it.
 *  The key is forward-only (permitopen on that port), so it gives no shell or other target. */
export async function withTunnel<T>(s: ServerRef, keyPath: string, hp: number, fn: () => Promise<T>): Promise<T> {
  const p = Bun.spawn([
    "ssh", "-N",
    "-o", "IdentitiesOnly=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12",
    "-i", keyPath, "-L", `127.0.0.1:${hp}:127.0.0.1:${hp}`,
    "-p", String(s.port), `${s.user}@${s.host}`,
  ], { stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      try {
        const c = await Bun.connect({ hostname: "127.0.0.1", port: hp, socket: { data() {} } });
        c.end();
        break;
      } catch { await Bun.sleep(150); }
    }
    return await fn();
  } finally {
    p.kill();
    await p.exited;
  }
}
