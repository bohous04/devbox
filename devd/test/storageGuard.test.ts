import { expect, test } from "bun:test";
import { preserveForEnd } from "../src/storageGuard";
import type { RunOpts, RunResult } from "../src/proc";

const ok = (o: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...o });
const ID = "abcdef1234567890ffff";
const UNIT = "devbox-storage-end-abcdef123456";
const noSleep = async () => {};

/** A host where the container exists and the unit is in `states` on successive reads (then inactive). */
function host(o: { states?: string[]; run?: (cmd: string[]) => RunResult; journal?: string } = {}) {
  const calls: { cmd: string[]; opts: RunOpts }[] = [];
  const states = [...(o.states ?? [])];
  const exec = async (cmd: string[], opts: RunOpts) => {
    calls.push({ cmd, opts });
    if (cmd[1] === "inspect") return ok({ stdout: `${ID}\n` });
    if (cmd[0] === "systemctl") return ok({ stdout: `${states.shift() ?? "inactive"}\n` });
    if (cmd[0] === "journalctl") return ok({ stdout: o.journal ?? "" });
    return o.run?.(cmd) ?? ok();
  };
  return { calls, exec, runs: () => calls.filter((c) => c.cmd[0] === "systemd-run") };
}

test("without an installed guard nothing runs", async () => {
  const calls: string[][] = [];
  await preserveForEnd("dev-x", async (c) => { calls.push(c); return ok(); }, () => false, noSleep);
  expect(calls).toEqual([]);
});

// Regression: the docker wrapper waited for the backup only 40 s and End timed out at 60 s — the backup
// now runs up front with its own cap in hours. Since 2026-11-23 it runs as its own systemd unit (the one the docker
// wrapper uses), outside devd's cgroup: a devd restart (a deploy) killed backups mid-run with devd.
test("the backup runs in its own transient unit with a long cap, not in devd's cgroup", async () => {
  const h = host();
  await preserveForEnd("dev-x", h.exec, () => true, noSleep);
  const [run] = h.runs();
  expect(run.cmd).toEqual(["systemd-run", "--quiet", "--wait", "--collect", "--unit", UNIT, "--property=Type=oneshot",
    "--property=Nice=15", "--property=TimeoutStartSec=4h", "/usr/local/bin/devbox-storage", "prepare-end", "dev-x"]);
  expect(run.opts.timeoutMs).toBeGreaterThanOrEqual(3_600_000);
});

test("a backup an earlier devd left running is waited for, then prepare-end runs again (quick once it verified)", async () => {
  const h = host({ states: ["activating", "activating", "deactivating"] });
  await preserveForEnd("dev-x", h.exec, () => true, noSleep);
  const order = h.calls.map((c) => c.cmd[0] === "systemctl" ? "state" : c.cmd[0] === "systemd-run" ? "run" : "inspect");
  expect(order).toEqual(["inspect", "state", "state", "state", "state", "run"]);
});

test("a unit the docker wrapper started at the same moment is waited for and run once more", async () => {
  let n = 0;
  const h = host({ run: () => (++n === 1 ? ok({ code: 1, stderr: `Failed to start transient service unit: Unit ${UNIT}.service already exists.` }) : ok()) });
  await preserveForEnd("dev-x", h.exec, () => true, noSleep);
  expect(h.runs()).toHaveLength(2);
});

test("a missing container backs up nothing (nothing to delete)", async () => {
  const calls: string[][] = [];
  await preserveForEnd("dev-x", async (c) => { calls.push(c); return ok({ code: 1, stderr: "Error: No such object: dev-x" }); }, () => true, noSleep);
  expect(calls).toHaveLength(1);
});

test("a failed backup stops End with the guard's own last words from the unit's journal", async () => {
  const h = host({ run: () => ok({ code: 1 }), journal: "starting\ndevbox-storage: Source changed during backup; deletion denied\n" });
  await expect(preserveForEnd("dev-x", h.exec, () => true, noSleep))
    .rejects.toThrow(`backup before ending failed (journalctl -u ${UNIT}): devbox-storage: Source changed during backup; deletion denied`);
});

// Review of #145 (M5): a failed unit kept without --collect holds the name while nothing runs.
test("a unit name that stays taken while nothing runs is named in the error, not blamed on the backup", async () => {
  const h = host({ run: () => ok({ code: 1, stderr: `Failed to start transient service unit: Unit ${UNIT}.service already exists.` }) });
  await expect(preserveForEnd("dev-x", h.exec, () => true, noSleep))
    .rejects.toThrow(`backup before ending: ${UNIT} is held by a leftover unit; clear it with systemctl reset-failed ${UNIT}`);
  expect(h.runs()).toHaveLength(4);
});
