import { expect, test } from "bun:test";
import { createAutoSave } from "./autoSave";

test("serializes writes and retains the newest edit during an in-flight save", async () => {
  const writes: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saver = createAutoSave(async (value: number) => {
    writes.push(value);
    if (value === 1) await gate;
  }, () => {});
  saver.enqueue(1); saver.enqueue(2); saver.enqueue(3);
  expect(writes).toEqual([1]);
  release(); await saver.flush();
  expect(writes).toEqual([1, 3]);
});

test("failure preserves the newest pending edit and blocks dependent actions until retry", async () => {
  const writes: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const errors: unknown[] = [];
  let fail = true;
  const saver = createAutoSave(async (value: number) => {
    writes.push(value);
    if (fail) { await gate; throw new Error("offline"); }
  }, error => errors.push(error));
  saver.enqueue(1); saver.enqueue(2); release();
  await expect(saver.flush()).rejects.toThrow("offline");
  expect(errors).toHaveLength(1);
  fail = false; saver.retry(); await saver.flush();
  expect(writes).toEqual([1, 2]);
});

test("a failed edit without subsequent changes is retried", async () => {
  let attempts = 0;
  const saver = createAutoSave(async (_value: string) => { if (++attempts === 1) throw new Error("offline"); }, () => {});
  saver.enqueue("folder"); await expect(saver.flush()).rejects.toThrow("offline");
  saver.retry(); await saver.flush(); expect(attempts).toBe(2);
});
