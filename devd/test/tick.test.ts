import { expect, test } from "bun:test";
import { guardedTick } from "../src/tick";

test("guardedTick: a running tick does not start a second time, after completion it does again", async () => {
  let running = 0, starts = 0;
  let release: () => void = () => {};
  const tick = guardedTick("test", async () => {
    starts++; running++;
    await new Promise<void>((r) => { release = r; });
    running--;
  });
  tick(); tick(); tick();          // the second and third are skipped
  expect(starts).toBe(1);
  release();
  await new Promise((r) => setTimeout(r, 0));
  tick();
  expect(starts).toBe(2);
  expect(running).toBe(1);
  release();
});

test("guardedTick: a tick error is logged and does not break the next one", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { errors.push(String(m)); };
  try {
    const tick = guardedTick("flaky", async () => { throw new Error("boom"); });
    tick();
    await new Promise((r) => setTimeout(r, 0));
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.filter((e) => e.includes("flaky")).length).toBe(2);
  } finally { console.error = orig; }
});

test("guardedTick: a synchronous throw in fn is logged and the next tick runs fn again", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { errors.push(String(m)); };
  try {
    let calls = 0;
    // Deliberately NOT an `async function` — the body throws synchronously, before a
    // promise exists, to verify that guardedTick catches this too and releases `running`.
    const tick = guardedTick("sync-throw", (): Promise<void> => { calls++; throw new Error("boom"); });
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(errors.filter((e) => e.includes("sync-throw")).length).toBe(1);
    tick(); // running must be false again — otherwise this tick would be silently skipped
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(errors.filter((e) => e.includes("sync-throw")).length).toBe(2);
  } finally { console.error = orig; }
});
