import { isDirect, type ServerRef } from "./prodDb";
import { connect, createServer, type Socket } from "node:net";

// Long-running forward-only SSH tunnels for dbProxy.
//
// `withTunnel` in prodTunnel.ts opens a tunnel for the duration of ONE operation — that is enough for prod
// writes, but not for the proxy, which holds client connections. This pool builds the tunnel once
// and leaves it standing; when ssh drops (network outage, peer restart), the next `ensure`
// builds it again.
//
// The key is forward-only (permitopen to that one port), so it gives neither a shell nor another target.

export interface Spawned { kill(): void; exited: Promise<number> }

/** Direct server (no SSH): a local TCP relay 127.0.0.1:<hostPort> → host:port. The rest of devd
 *  (proxy, approved writes) thus keeps talking to 127.0.0.1:<hostPort> just as through a tunnel.
 *  The relay listens only on loopback; DB authentication is done later by the proxy/executor. */
export function startDirectRelay(hostPort: number, target: { host: string; port: number }): Promise<{ close(): void }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host: target.host, port: target.port });
    for (const s of [client, upstream]) { sockets.add(s); s.setKeepAlive(true, 30_000); s.on("close", () => sockets.delete(s)); }
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.once("connect", () => upstream.setTimeout(0));
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
  const close = () => { server.close(); for (const s of sockets) s.destroy(); };
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(hostPort, "127.0.0.1", () => resolve({ close })); });
}

export interface TunnelPoolDeps {
  /** Materializes the key from 1P on the host and returns the path. May be async — reading from 1P has been
   *  asynchronous since PR #75+. */
  keyPath: (key: string) => string | Promise<string>;
  spawn?: (argv: string[]) => Spawned;
  /** Returns true when the port on 127.0.0.1 accepts connections. */
  probe?: (port: number) => Promise<boolean>;
  attempts?: number;
  delayMs?: number;
  portFree?: (port: number) => Promise<boolean>;
  directRelay?: (hostPort: number, target: { host: string; port: number }) => Promise<{ close(): void }>;
}

export function tunnelArgs(s: ServerRef, keyPath: string, hostPort: number): string[] {
  return [
    "ssh", "-N",
    "-o", "IdentitiesOnly=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=12",
    // Without keepalive the tunnel hangs as if alive after a silent outage and connections into it vanish
    // into a black hole; this way ssh exits on its own within 90 s and the pool builds it again.
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-i", keyPath,
    "-L", `127.0.0.1:${hostPort}:127.0.0.1:${hostPort}`,
    "-p", String(s.port), `${s.user}@${s.host}`,
  ];
}

const defaultProbe = async (port: number): Promise<boolean> => {
  try {
    const c = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    c.end();
    return true;
  } catch { return false; }
};

export interface TunnelPool {
  ensure(server: ServerRef, hostPort: number): Promise<void>;
  stopAll(): void;
  status(): { id: string; alive: boolean }[];
  owns(server: ServerRef, port: number): boolean;
}

export function createTunnelPool(d: TunnelPoolDeps): TunnelPool {
  const spawn = d.spawn ?? ((argv: string[]) => Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }));
  const probe = d.probe ?? defaultProbe;
  const attempts = d.attempts ?? 40;
  const delayMs = d.delayMs ?? 150;
  const portFree = d.portFree ?? ((port: number) => new Promise<boolean>((resolve) => {
    const server = createServer(); server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  }));

  const directRelay = d.directRelay ?? startDirectRelay;
  const live = new Map<string, { proc: Spawned; alive: boolean; port: number }>();
  const idFor = (s: ServerRef, hp: number) => isDirect(s) ? `direct:${s.host}:${s.port}#${hp}` : `${s.user}@${s.host}:${s.port}#${hp}`;
  const pending = new Map<string, Promise<void>>();
  const ready = new Set<string>();
  // Change of a catalog entry (e.g. legacy `main` → dedicated tunnelUser) keeps the
  // local port but changes the id. Only OUR previous tunnel on that port is retired;
  // a foreign listener still fails the portFree check below.
  const retireOthers = async (id: string, hostPort: number) => {
    for (const [other, e] of [...live.entries()]) {
      if (other === id || e.port !== hostPort) continue;
      e.alive = false; e.proc.kill();
      await Promise.race([e.proc.exited, Bun.sleep(3_000)]);
      live.delete(other); ready.delete(other);
    }
  };

  return {
    ensure(server, hostPort) {
      const id = idFor(server, hostPort);
      const existing = live.get(id);
      if (existing?.alive && ready.has(id)) return Promise.resolve();
      if (pending.has(id)) return pending.get(id)!;
      const task = (async () => {
      await retireOthers(id, hostPort);
      // Never send DB credentials to an unrelated process that already owns the port.
      if (!await portFree(hostPort)) throw new Error(`tunnel: local port ${hostPort} is occupied by another process`);
      if (isDirect(server)) {
        const relay = await directRelay(hostPort, { host: server.host, port: server.port });
        let resolveExit!: (code: number) => void;
        const proc: Spawned = { kill: () => { relay.close(); resolveExit(0); }, exited: new Promise<number>((r) => { resolveExit = r; }) };
        const entry = { proc, alive: true, port: hostPort };
        live.set(id, entry); ready.add(id);
        void proc.exited.then(() => { entry.alive = false; ready.delete(id); });
        return;
      }

      const proc = spawn(tunnelArgs(server, await d.keyPath(server.key), hostPort));
      const entry = { proc, alive: true, port: hostPort };
      live.set(id, entry);
      // An ssh crash marks the tunnel as dead, so the next ensure builds it again.
      void proc.exited.then(() => { entry.alive = false; ready.delete(id); });

      for (let i = 0; i < attempts; i++) {
        if (!entry.alive) throw new Error(`tunnel to ${id} exited before becoming ready`);
        if (await probe(hostPort)) {
          // Let a failed ExitOnForwardFailure process settle before accepting readiness.
          await Bun.sleep(Math.min(delayMs, 25));
          if (!entry.alive) throw new Error(`tunnel to ${id} exited during startup`);
          ready.add(id); return;
        }
        await Bun.sleep(delayMs);
      }
      entry.alive = false;
      proc.kill();
      throw new Error(`tunnel to ${id} did not come up — port ${hostPort} is not responding`);
      })();
      pending.set(id, task);
      void task.finally(() => { if (pending.get(id) === task) pending.delete(id); }).catch(() => {});
      return task;
    },

    stopAll() {
      for (const e of live.values()) { e.alive = false; e.proc.kill(); }
      live.clear();
      ready.clear();
    },

    status: () => [...live.entries()].map(([id, e]) => ({ id, alive: e.alive })),
    owns: (server, port) => !!live.get(idFor(server, port))?.alive && ready.has(idFor(server, port)),
  };
}
