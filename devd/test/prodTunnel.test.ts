import { expect, test } from "bun:test";
import { withTunnel } from "../src/prodTunnel";
import type { ServerRef } from "../src/prodDb";

const server: ServerRef = { host: "1.2.3.4", port: 2222, user: "tunnel", key: "prod-tunnel-shop" };
const spawn = () => { let done!: (c: number) => void; return { kill() { done(0); }, exited: new Promise<number>((r) => { done = r; }) }; };

test("a port owned by a foreign process is refused before fn runs", async () => {
  let ran = false;
  await expect(withTunnel(server, "/tmp/k", 15501, async () => { ran = true; }, { portFree: async () => false, spawn }))
    .rejects.toThrow(/occupied/);
  expect(ran).toBe(false);
});

test("fn does not run when the tunnel never comes up", async () => {
  let ran = false;
  await expect(withTunnel(server, "/tmp/k", 15501, async () => { ran = true; }, { portFree: async () => true, spawn, probe: async () => false, attempts: 2, delayMs: 1 }))
    .rejects.toThrow(/did not come up/);
  expect(ran).toBe(false);
});

test("fn does not run when ssh exits before the tunnel is ready", async () => {
  let ran = false;
  const dead = () => ({ kill() {}, exited: Promise.resolve(255) });
  await expect(withTunnel(server, "/tmp/k", 15501, async () => { ran = true; }, { portFree: async () => true, spawn: dead, probe: async () => { await Bun.sleep(5); return false; }, attempts: 5, delayMs: 1 }))
    .rejects.toThrow(/exited/);
  expect(ran).toBe(false);
});

test("a ready tunnel runs fn and is killed afterwards", async () => {
  let killed = 0;
  const r = await withTunnel(server, "/tmp/k", 15501, async () => 42, {
    portFree: async () => true, probe: async () => true,
    spawn: () => { let done!: (c: number) => void; return { kill() { killed++; done(0); }, exited: new Promise<number>((res) => { done = res; }) }; },
  });
  expect(r).toBe(42);
  expect(killed).toBe(1);
});
