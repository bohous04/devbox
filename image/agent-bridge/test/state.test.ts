import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, StateCorruptError, type BridgeState } from "../src/state";

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
  target: { harness: "codex", account: "a1", model: "m", env: { CODEX_HOME: "/h" }, droppedEnvKeys: [] },
  pendingHandoff: { preamble: "earlier" },
  instructionsPending: true,
  trimSeq: 7,
  ackCandidate: { seq: 9, at: 1234 },
  awaitingTarget: false,
};

test("saveState then loadState round-trips and leaves no temp file", () => {
  const p = join(dir, "state.json");
  saveState(p, state);
  expect(loadState(p)).toEqual(state);
  expect(existsSync(`${p}.tmp`)).toBe(false);
});

test("loadState returns null when missing", () => {
  expect(loadState(join(dir, "nope.json"))).toBeNull();
});

test("corrupt JSON, an empty file and a wrong shape are StateCorruptError with the reason", () => {
  const p = join(dir, "state.json");
  writeFileSync(p, "{not json");
  expect(() => loadState(p)).toThrow(StateCorruptError);
  writeFileSync(p, "");
  expect(() => loadState(p)).toThrow("empty");
  writeFileSync(p, "[]");
  expect(() => loadState(p)).toThrow("not an object");
  writeFileSync(p, JSON.stringify({ ...state, queue: {} }));
  expect(() => loadState(p)).toThrow("queue");
  writeFileSync(p, JSON.stringify({ ...state, harness: 3 }));
  expect(() => loadState(p)).toThrow("harness");
  writeFileSync(p, JSON.stringify({ ...state, queue: [{ runId: "r", text: "t" }] }));
  expect(() => loadState(p)).toThrow("queue[0].attachments");
  writeFileSync(p, JSON.stringify({ ...state, target: { ...state.target, droppedEnvKeys: undefined } }));
  expect(() => loadState(p)).toThrow("target.droppedEnvKeys");
  writeFileSync(p, JSON.stringify({ ...state, trimSeq: -1 }));
  expect(() => loadState(p)).toThrow("trimSeq");
});

test("a state file from before switching loads with no target and no pending handoff", () => {
  const p = join(dir, "state.json");
  const { target: _t, pendingHandoff: _h, instructionsPending: _i, trimSeq: _a, ackCandidate: _c, awaitingTarget: _w, ...old } = state;
  writeFileSync(p, JSON.stringify(old));
  expect(loadState(p)).toEqual({ ...old, target: null, pendingHandoff: null, instructionsPending: false, trimSeq: 0, ackCandidate: null, awaitingTarget: false });
});

test("state files written by bridge 1.2 and 1.4 load unchanged, with nothing acknowledged and no awaited target", () => {
  for (const v of ["1.2", "1.4"]) {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "state", `state-${v}.json`), "utf8"));
    const p = join(dir, `state-${v}.json`);
    writeFileSync(p, JSON.stringify(raw));
    expect(loadState(p)).toEqual({ instructionsPending: false, ...raw, trimSeq: 0, ackCandidate: null, awaitingTarget: false });
  }
});
