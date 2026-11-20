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

// ---------------------------------------------------------------- backgroundSnapshot

test("backgroundSnapshot: the first peek starts the build and answers at once with nothing yet (scanning), never waiting", async () => {
  const { backgroundSnapshot } = await import("../src/cache");
  let release!: (v: number) => void;
  const s = backgroundSnapshot(() => new Promise<number>((r) => { release = r; }), 60_000, () => 1000);
  expect(s.peek()).toEqual({ value: null, at: null, scanning: true, error: null });
  release(7);
  await s.idle();
  expect(s.peek()).toEqual({ value: 7, at: 1000, scanning: false, error: null });
});

test("backgroundSnapshot: a stale value is served with scanning=true while one rebuild runs; refresh() rebuilds even when fresh", async () => {
  const { backgroundSnapshot } = await import("../src/cache");
  let now = 0;
  let n = 0;
  const s = backgroundSnapshot(async () => ++n, 100, () => now);
  s.peek(); await s.idle();
  expect(s.peek()).toMatchObject({ value: 1, scanning: false });
  now = 500;
  expect(s.peek()).toMatchObject({ value: 1, scanning: true });
  expect(s.peek()).toMatchObject({ value: 1, scanning: true });       // single flight
  await s.idle();
  expect(n).toBe(2);
  s.refresh();
  expect(s.peek()).toMatchObject({ value: 2, scanning: true });
  await s.idle();
  expect(s.peek()).toMatchObject({ value: 3, at: 500, scanning: false });
});

test("backgroundSnapshot: refresh() during a build queues exactly one more (the running one may predate the change)", async () => {
  const { backgroundSnapshot } = await import("../src/cache");
  let n = 0;
  let release!: () => void;
  const s = backgroundSnapshot(() => new Promise<number>((r) => { const k = ++n; release = () => r(k); }), 60_000, () => 0);
  s.peek();
  s.refresh(); s.refresh();
  release(); await Bun.sleep(1);
  expect(s.peek()).toMatchObject({ value: 1, scanning: true });
  release(); await s.idle();
  expect(n).toBe(2);
  expect(s.peek()).toMatchObject({ value: 2, scanning: false });
});

test("backgroundSnapshot: a failed build keeps the last value and reports the error (not swallowed)", async () => {
  const { backgroundSnapshot } = await import("../src/cache");
  let fail = false;
  const s = backgroundSnapshot(async () => { if (fail) throw new Error("disk gone"); return 1; }, 60_000, () => 0);
  s.peek(); await s.idle();
  fail = true; s.refresh(); await s.idle();
  expect(s.peek()).toEqual({ value: 1, at: 0, scanning: false, error: "disk gone" });
  fail = false; s.refresh(); await s.idle();
  expect(s.peek().error).toBeNull();
});
