import { expect, test } from "bun:test";
import { runDoctor } from "../src/doctor";
import type { ApiClient } from "../src/api";

const okApi = { health: async () => ({ ok: true, version: "0.1.0" }) } as unknown as ApiClient;
const downApi = { health: async () => { throw new Error("nope"); } } as unknown as ApiClient;

test("local mode checks devd and docker", async () => {
  const calls: string[][] = [];
  const checks = await runDoctor({ devdUrl: "u" }, okApi, (...cmd) => { calls.push(cmd); return { code: 0 }; });
  expect(checks.every((c) => c.ok)).toBe(true);
  expect(calls.some((c) => c[0] === "docker")).toBe(true);
});

test("backup path is checked separately — a dead primary IP doesn't necessarily mean a dead server", async () => {
  const checks = await runDoctor(
    { devdUrl: "u", sshHost: "vps", sshHostAlt: "vps-ts" }, okApi,
    (...cmd) => ({ code: cmd.includes("vps-ts") ? 0 : 1 }),
  );
  expect(checks.find((c) => c.name === "ssh vps")!.ok).toBe(false);
  expect(checks.find((c) => c.name.includes("vps-ts"))!.ok).toBe(true);
});

test("remote mode checks ssh + tailscale; devd down yields hint", async () => {
  const checks = await runDoctor({ devdUrl: "u", sshHost: "vps" }, downApi, () => ({ code: 1 }));
  const devd = checks.find((c) => c.name.includes("devd"))!;
  expect(devd.ok).toBe(false);
  expect(checks.some((c) => c.name.includes("ssh") && !c.ok)).toBe(true);
  expect(checks.some((c) => c.name.includes("tailscale"))).toBe(true);
});
