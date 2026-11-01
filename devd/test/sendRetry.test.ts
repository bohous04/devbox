import { expect, test } from "bun:test";
import { BACKOFF_MS, httpError, permanentError, sendWithRetry } from "../src/sendRetry";

/** Scheduler with a manual crank: the test itself decides when the delay "elapses". */
function harness() {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  const schedule = (fn: () => void, ms: number) => { delays.push(ms); pending = fn; };
  const logs: string[] = [];
  const tick = async () => {
    const fn = pending;
    pending = null;
    if (!fn) throw new Error("no further attempt was scheduled");
    fn();
    await Promise.resolve(); // let the microtask chain inside sendWithRetry finish
  };
  return { delays, tick, logs, deps: { schedule, log: (m: string) => logs.push(m) } };
}

test("success on the first attempt schedules nothing", async () => {
  const h = harness();
  const r = await sendWithRetry("pushover", async () => {}, h.deps);
  expect(r).toEqual({ delivered: true, attempts: 1 });
  expect(h.delays).toEqual([]);
});

test("a network outage is retried and succeeds on the second try", async () => {
  const h = harness();
  let calls = 0;
  const p = sendWithRetry("pushover", async () => {
    calls += 1;
    if (calls === 1) throw new Error("fetch failed");
  }, h.deps);
  await Promise.resolve();
  expect(h.delays).toEqual([BACKOFF_MS[0]]);
  await h.tick();
  expect(await p).toEqual({ delivered: true, attempts: 2 });
});

test("a persistent outage exhausts the backoff and gives up, delays grow", async () => {
  const h = harness();
  const p = sendWithRetry("pushover", async () => { throw new Error("fetch failed"); }, h.deps);
  await Promise.resolve();
  for (let i = 0; i < BACKOFF_MS.length; i++) await h.tick();
  const r = await p;
  expect(r.delivered).toBe(false);
  expect(r.attempts).toBe(BACKOFF_MS.length + 1); // first attempt + one per delay
  expect(h.delays).toEqual(BACKOFF_MS);
  expect(h.logs.at(-1)).toContain("pushover");
});

// 4xx means "bad token / bad request". Retrying it is pointless and only
// delays delivery of the messages that can get through.
test("a 4xx error is not retried", async () => {
  const h = harness();
  let calls = 0;
  const r = await sendWithRetry("pushover", async () => {
    calls += 1;
    throw httpError(400, "application token is invalid");
  }, h.deps);
  expect(calls).toBe(1);
  expect(r).toEqual({ delivered: false, attempts: 1 });
  expect(h.delays).toEqual([]);
});

// Otherwise an unconfigured listener would keep coming back to the log for eight minutes on EVERY notification.
test("permanentError is not retried", async () => {
  const h = harness();
  let calls = 0;
  const r = await sendWithRetry("listener notify", async () => {
    calls += 1;
    throw permanentError("listener is not configured");
  }, h.deps);
  expect(calls).toBe(1);
  expect(r.delivered).toBe(false);
  expect(h.delays).toEqual([]);
});

test("5xx and 429 are retried — that is temporary", async () => {
  for (const status of [429, 500, 503]) {
    const h = harness();
    let calls = 0;
    const p = sendWithRetry("x", async () => {
      calls += 1;
      if (calls === 1) throw httpError(status, "later");
    }, h.deps);
    await Promise.resolve();
    await h.tick();
    expect((await p).delivered).toBe(true);
  }
});
