import { expect, test } from "bun:test";
import { preserveForEnd } from "../src/storageGuard";
import type { RunOpts, RunResult } from "../src/proc";

const ok = (o: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...o });

test("without an installed guard nothing runs", async () => {
  const calls: string[][] = [];
  await preserveForEnd("dev-x", async (c) => { calls.push(c); return ok(); }, () => false);
  expect(calls).toEqual([]);
});

// Regression: the docker wrapper waited for the backup only 40 s and End timed out at 60 s — the backup
// now runs up front with its own cap in hours.
test("the backup runs up front with a long cap, not within the 60 s lifecycle", async () => {
  const calls: { cmd: string[]; opts: RunOpts }[] = [];
  await preserveForEnd("dev-x", async (cmd, opts) => { calls.push({ cmd, opts }); return ok(); }, () => true);
  expect(calls[1].cmd).toEqual(["/usr/local/bin/devbox-storage", "prepare-end", "dev-x"]);
  expect(calls[1].opts.timeoutMs).toBeGreaterThanOrEqual(3_600_000);
});

test("a missing container backs up nothing (nothing to delete)", async () => {
  const calls: string[][] = [];
  await preserveForEnd("dev-x", async (c) => { calls.push(c); return ok({ code: 1, stderr: "Error: No such object: dev-x" }); }, () => true);
  expect(calls).toHaveLength(1);
});

test("a failed backup stops End (nothing gets deleted)", async () => {
  const exec = async (c: string[]) => c[1] === "prepare-end" ? ok({ code: 1, stderr: "devbox-storage: Source changed during backup; deletion denied" }) : ok();
  await expect(preserveForEnd("dev-x", exec, () => true)).rejects.toThrow("Source changed");
});
