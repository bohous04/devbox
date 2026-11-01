import { expect, test } from "bun:test";
import { memoAsync, memoAsyncStrict } from "../src/cache";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("the first call waits, the second comes from cache without another run", async () => {
  let runs = 0;
  const m = memoAsync(async () => { runs++; return runs; }, 10_000);
  expect(await m.get()).toBe(1);
  expect(await m.get()).toBe(1);
  expect(runs).toBe(1);
});

test("concurrent calls share one run (single-flight)", async () => {
  let runs = 0;
  const m = memoAsync(async () => { runs++; await tick(); return runs; }, 10_000);
  const [a, b, c] = await Promise.all([m.get(), m.get(), m.get()]);
  expect([a, b, c]).toEqual([1, 1, 1]);
  expect(runs).toBe(1);
});

test("after the TTL expires it returns the old value immediately and refreshes in the background", async () => {
  let runs = 0;
  const m = memoAsync(async () => { runs++; return runs; }, 1);
  expect(await m.get()).toBe(1);
  await new Promise((r) => setTimeout(r, 5));
  expect(await m.get()).toBe(1);   // old value, no waiting
  await tick(); await tick();
  expect(await m.get()).toBe(2);   // background refresh finished
});

test("invalidate forces a fresh run", async () => {
  let runs = 0;
  const m = memoAsync(async () => { runs++; return runs; }, 10_000);
  await m.get();
  m.invalidate();
  expect(await m.get()).toBe(2);
});

test("an error is not cached — the next call tries again", async () => {
  let runs = 0;
  const m = memoAsync(async () => { runs++; if (runs === 1) throw new Error("boom"); return runs; }, 10_000);
  await expect(m.get()).rejects.toThrow("boom");
  expect(await m.get()).toBe(2);
});

test("a failed background refresh must not crash the process or drop the old value", async () => {
  let runs = 0;
  const m = memoAsync(async () => { runs++; if (runs > 1) throw new Error("later boom"); return runs; }, 1);
  expect(await m.get()).toBe(1);
  await new Promise((r) => setTimeout(r, 5));
  expect(await m.get()).toBe(1);
  await tick(); await tick();
  expect(await m.get()).toBe(1);   // still the old value, no unhandled rejection
});

// memoAsyncStrict — the async sibling of memoAsync, but WITHOUT stale-while-revalidate:
// a plain TTL cache with single-flight for subprocesses that now run via `run()`
// (op.ts) and whose failure the caller must learn about immediately — see sshKeyLister in index.ts.

test("memoAsyncStrict: TTL, single-flight, errors not cached, no background", async () => {
  let calls = 0; let fail = true;
  const get = memoAsyncStrict(async () => { calls++; if (fail) throw new Error("op mimo"); return calls; }, 1_000);
  await expect(get()).rejects.toThrow("op mimo");
  fail = false;
  const [a, b] = await Promise.all([get(), get()]);   // single-flight: one call
  expect(a).toBe(2); expect(b).toBe(2); expect(calls).toBe(2);
  expect(await get()).toBe(2);                         // TTL: from cache
});

test("memoAsyncStrict: after the TTL expires the underlying function is called again", async () => {
  let calls = 0;
  const get = memoAsyncStrict(async () => { calls++; return calls; }, 1);
  expect(await get()).toBe(1);
  await new Promise((r) => setTimeout(r, 5));
  expect(await get()).toBe(2);
});
