import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, type BridgeState } from "../src/state";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state: BridgeState = {
  harness: "claude",
  nativeThreadId: "t1",
  account: null,
  model: "m",
  activeRunId: "r1",
  queue: [{ runId: "r2", text: "hi", attachments: ["a.png"] }],
  continuations: [1, 2],
  usageBaseline: { usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }, costUsd: 0.5 },
  target: { harness: "codex", account: "a1", model: "m", env: { CODEX_HOME: "/h" } },
  pendingHandoff: { preamble: "earlier" },
};

test("saveState then loadState round-trips", () => {
  const p = join(dir, "state.json");
  saveState(p, state);
  expect(loadState(p)).toEqual(state);
});

test("loadState returns null when missing", () => {
  expect(loadState(join(dir, "nope.json"))).toBeNull();
});

test("corrupt state throws", () => {
  const p = join(dir, "state.json");
  writeFileSync(p, "{not json");
  expect(() => loadState(p)).toThrow();
});

test("a state file from before switching loads with no target and no pending handoff", () => {
  const p = join(dir, "state.json");
  const { target: _t, pendingHandoff: _h, ...old } = state;
  writeFileSync(p, JSON.stringify(old));
  expect(loadState(p)).toEqual({ ...old, target: null, pendingHandoff: null });
});
