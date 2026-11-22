import { expect, test } from "bun:test";
import { OpenPhases } from "../src/sessions";

// Each step's start and end come from devd's own monotonic clock, at the moment devd enters the next step, not when a
// poller happens to look.
test("OpenPhases ends a step when the next one starts and keeps repeated reports in one step", () => {
  let clock = 1000;
  const p = new OpenPhases(() => clock);
  expect(p.snapshot()).toEqual([]);
  p.enter("fetch");
  clock = 2200;
  p.enter("worktree");
  clock = 2500;
  p.enter("worktree"); // git's percentages
  expect(p.snapshot()).toEqual([
    { step: "fetch", startedAt: 1000, endedAt: 2200 },
    { step: "worktree", startedAt: 2200 },
  ]);
  clock = 4000;
  p.enter("container");
  clock = 4100;
  p.enter("container"); // its sub-steps
  clock = 12_000;
  p.finish();
  expect(p.snapshot()).toEqual([
    { step: "fetch", startedAt: 1000, endedAt: 2200 },
    { step: "worktree", startedAt: 2200, endedAt: 4000 },
    { step: "container", startedAt: 4000, endedAt: 12_000 },
  ]);
  p.finish();
  expect(p.snapshot().at(-1)?.endedAt).toBe(12_000);
});

// Steps devd skipped have no entry; a snapshot is a copy, so a sent report never changes afterwards.
test("OpenPhases lists only the steps entered, and snapshots are copies", () => {
  let clock = 0;
  const p = new OpenPhases(() => clock);
  p.enter("pull");
  const before = p.snapshot();
  clock = 50;
  p.enter("container");
  expect(before).toEqual([{ step: "pull", startedAt: 0 }]);
  expect(p.snapshot().map((x) => x.step)).toEqual(["pull", "container"]);
});
