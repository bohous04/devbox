import { expect, test } from "bun:test";
import { createTunnelPool, tunnelArgs } from "../src/tunnelPool";
import type { ServerRef } from "../src/prodDb";

const server: ServerRef = { host: "1.2.3.4", port: 2222, user: "tunnel", key: "prod-tunnel-shop" };

test("arguments build a forward-only tunnel without a shell", () => {
  const a = tunnelArgs(server, "/tmp/k", 15501);
  expect(a[0]).toBe("ssh");
  expect(a).toContain("-N");                                  // no command = no shell
  expect(a.join(" ")).toContain("-L 127.0.0.1:15501:127.0.0.1:15501");
  expect(a.join(" ")).toContain("tunnel@1.2.3.4");
  expect(a.join(" ")).toContain("-p 2222");
});

test("the tunnel is kept alive, not just opened", () => {
  const a = tunnelArgs(server, "/tmp/k", 15501).join(" ");
  expect(a).toContain("ServerAliveInterval");
  expect(a).toContain("ExitOnForwardFailure=yes");
});

function fakeDeps(over: Record<string, unknown> = {}) {
  const spawned: string[][] = [];
  return {
    spawned,
    deps: {
      keyPath: () => "/tmp/k",
      portFree: async () => true,
      spawn: (argv: string[]) => { spawned.push(argv); return { kill() {}, exited: new Promise<number>(() => {}) }; },
      probe: async () => true,
      ...over,
    },
  };
}

test("a second ensure call does not create another tunnel", async () => {
  const { spawned, deps } = fakeDeps();
  const pool = createTunnelPool(deps as never);
  await pool.ensure(server, 15501);
  await pool.ensure(server, 15501);
  expect(spawned.length).toBe(1);
});

test("a different port has its own tunnel", async () => {
  const { spawned, deps } = fakeDeps();
  const pool = createTunnelPool(deps as never);
  await pool.ensure(server, 15501);
  await pool.ensure(server, 15502);
  expect(spawned.length).toBe(2);
});

test("when the tunnel dies, the next ensure rebuilds it", async () => {
  let resolveExit: ((c: number) => void) | undefined;
  const { spawned, deps } = fakeDeps({
    spawn: (argv: string[]) => {
      spawned.push(argv);
      return { kill() {}, exited: new Promise<number>((r) => { resolveExit = r; }) };
    },
  });
  const pool = createTunnelPool(deps as never);
  await pool.ensure(server, 15501);
  resolveExit!(255);                       // ssh died
  await Bun.sleep(10);
  await pool.ensure(server, 15501);
  expect(spawned.length).toBe(2);
});

test("an unreachable port throws after the timeout instead of silently passing", async () => {
  const { deps } = fakeDeps({ probe: async () => false, attempts: 3, delayMs: 1 });
  const pool = createTunnelPool(deps as never);
  await expect(pool.ensure(server, 15501)).rejects.toThrow(/tunnel/i);
});

test("stopAll cleans up the tunnels", async () => {
  let killed = 0;
  const { deps } = fakeDeps({
    spawn: () => ({ kill() { killed++; }, exited: new Promise<number>(() => {}) }),
  });
  const pool = createTunnelPool(deps as never);
  await pool.ensure(server, 15501);
  await pool.ensure(server, 15502);
  pool.stopAll();
  expect(killed).toBe(2);
});


test("concurrent callers share one in-flight tunnel startup", async () => {
  const { spawned, deps } = fakeDeps({ keyPath: async () => { await Bun.sleep(5); return "/tmp/k"; } });
  const pool = createTunnelPool(deps as never);
  await Promise.all([pool.ensure(server, 15501), pool.ensure(server, 15501)]);
  expect(spawned).toHaveLength(1); expect(pool.owns(server, 15501)).toBe(true);
});
test("unrelated local listener is rejected before reading a key or spawning SSH", async () => {
  const { spawned, deps } = fakeDeps({ portFree: async () => false });
  const pool = createTunnelPool(deps as never);
  await expect(pool.ensure(server, 15501)).rejects.toThrow("occupied"); expect(spawned).toHaveLength(0);
});

test("changed server identity on the same port replaces only our previous tunnel", async () => {
  const killed: string[] = [];
  const spawned: string[][] = [];
  const pool = createTunnelPool({
    keyPath: () => "/tmp/k", portFree: async () => true, probe: async () => true,
    spawn: (argv: string[]) => { spawned.push(argv); const who = argv[argv.length - 1]; let done!: (c: number) => void;
      return { kill() { killed.push(who); done(0); }, exited: new Promise<number>((r) => { done = r; }) }; },
  } as never);
  const legacy: ServerRef = { ...server, user: "main" };
  await pool.ensure(legacy, 15500);
  await pool.ensure(server, 15500);
  expect(killed).toEqual(["main@1.2.3.4"]);
  expect(pool.owns(legacy, 15500)).toBe(false);
  expect(pool.owns(server, 15500)).toBe(true);
  expect(spawned).toHaveLength(2);
});
