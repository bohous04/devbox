import { expect, test } from "bun:test";
import { createOpRunner, OpRateLimited } from "../src/opRateLimit";
import type { RunOpts, RunResult } from "../src/proc";

const ok = (stdout = "[]"): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const limited = (): RunResult => ({ code: 1, stdout: "", stderr: "Too many requests. Your client has been rate-limited. Try again in  seconds", timedOut: false });

test("exhausted daily quota blocks SSH and DB commands until reset without another subprocess", async () => {
  let now = 1000;
  const calls: string[][] = [];
  const op = createOpRunner({ now: () => now, run: async (cmd, opts) => {
    calls.push(cmd);
    expect(opts.env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: "fixture-token" });
    expect(opts.unsetEnv).toEqual(["OP_CONNECT_HOST", "OP_CONNECT_TOKEN"]);
    if (cmd[1] === "service-account") return ok(JSON.stringify([
      { remaining: 1000, reset: 0 }, { remaining: 0, reset: 12581 },
    ]));
    return now === 1000 ? limited() : ok("recovered");
  } });
  const first = await op("fixture-token", ["item", "list"]).catch(e => e);
  expect(first).toBeInstanceOf(OpRateLimited);
  expect(first.retryAt).toBe(12582000);
  expect(first.resetKnown).toBe(true);
  for (const args of [["read", "op://private"], ["item", "list"], ["item", "create"]]) {
    await expect(op("fixture-token", args)).rejects.toBeInstanceOf(OpRateLimited);
  }
  expect(calls).toHaveLength(2);
  now = first.retryAt;
  expect((await op("fixture-token", ["item", "list"])).stdout).toBe("recovered");
  expect(calls).toHaveLength(3);
});

test("concurrent quota failures share one usage query and sanitize the exposed error", async () => {
  let diagnostics = 0;
  const op = createOpRunner({ run: async cmd => {
    if (cmd[1] === "service-account") { diagnostics++; await Bun.sleep(5); return ok('[{"remaining":0,"reset":300}]'); }
    return { ...limited(), stderr: "SECRET rate-limited op://private" };
  } });
  const errors = await Promise.all(Array.from({ length: 5 }, () => op("secret-token", ["item", "list"]).catch(e => e)));
  expect(diagnostics).toBe(1);
  expect(errors.every(e => e instanceof OpRateLimited && e.resetKnown)).toBe(true);
  expect(JSON.stringify(errors)).not.toMatch(/SECRET|secret-token|op:\/\//);
});

test("malformed or failed quota diagnostics use a short cooldown, never an automatic command retry", async () => {
  for (const diagnostic of [ok("invalid"), ok("{}"), ok('[{"remaining":0,"reset":"120"}]'), { ...limited(), timedOut: true }]) {
    let now = 100, calls = 0;
    const op = createOpRunner({ now: () => now, run: async cmd => {
      calls++; return cmd[1] === "service-account" ? diagnostic : limited();
    } });
    const error = await op("token", ["item", "create"]).catch(e => e);
    expect(error.resetKnown).toBe(false); expect(error.retryAt).toBe(60100);
    await expect(op("token", ["item", "list"])).rejects.toBeInstanceOf(OpRateLimited);
    expect(calls).toBe(2);
    now = 60100;
    await expect(op("token", ["item", "list"])).rejects.toBeInstanceOf(OpRateLimited);
    expect(calls).toBe(4);
  }
});

test("cooldown is scoped to the credential and ordinary failures keep their original result", async () => {
  const seen: RunOpts[] = [];
  const op = createOpRunner({ run: async (cmd, opts) => {
    seen.push(opts);
    if (cmd[1] === "service-account") return ok('[{"remaining":0,"reset":60}]');
    if (opts.env?.OP_SERVICE_ACCOUNT_TOKEN === "limited") return limited();
    return { ...ok(), code: 1, stderr: "item not found" };
  } });
  await expect(op("limited", ["item", "list"])).rejects.toBeInstanceOf(OpRateLimited);
  expect((await op("other", ["read", "ref"], { stdin: "private-input", timeoutMs: 55 })).stderr).toBe("item not found");
  expect(seen.at(-1)?.stdin).toBe("private-input");
  expect(seen.at(-1)?.timeoutMs).toBe(55);
});
