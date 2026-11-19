import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatAttention, chatBusy, tmuxAttention, WORKING_GRACE_MS, type LinkState } from "../src/attention";
import { ThreadStore } from "../src/threadStore";
import type { AgentLiveSnapshot } from "../src/agentEvents";
import type { BackgroundWork, BridgeEvent } from "../../shared/thread";

// Events are stamped ts = 1000 * seq, so `now` below is easy to place relative to a run's end.
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function thread(events: BridgeEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), "attention-"));
  const s = ThreadStore.open(dir, "dev-a-b-1");
  cleanups.push(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  events.forEach((event, i) => s.apply({ seq: i + 1, ts: 1000 * (i + 1), event }));
  return s;
}
const connected: LinkState = { status: "connected", since: 500 };
const LATER = 60_000; // far past the grace window of every run below
const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });
const wakeup: BackgroundWork = { id: "w1", kind: "wakeup", label: "check CI", holding: true };
const devServer: BackgroundWork = { id: "c1", kind: "command", label: "npm run dev", holding: false };

test("completed run with holding work is working, not needs-you", () => {
  const s = thread([started("r1"), { type: "background.changed", work: [wakeup, devServer] }, completed("r1")]);
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "working", reason: "background", since: 3000 });
});

test("completed and unseen is needs-you; after markSeen it is idle", () => {
  const s = thread([started("r1"), { type: "background.changed", work: [devServer] }, completed("r1")]);
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "needs_you", reason: "completed", since: 3000 });
  s.markSeen(s.lastSeq());
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "idle", reason: null, since: 3000 });
});

test("open request is needs-you even with holding work", () => {
  const s = thread([
    started("r1"), { type: "background.changed", work: [wakeup] },
    { type: "request.opened", runId: "r1", requestId: "q1", kind: "question", prompt: "Which DB?" },
  ]);
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "needs_you", reason: "request", since: 3000 });
});

test("disconnected is needs-you", () => {
  const s = thread([started("r1")]);
  expect(chatAttention(s.snapshot(), { status: "disconnected", since: 7000 }, LATER))
    .toEqual({ section: "needs_you", reason: "disconnected", since: 7000 });
});

test("without a link (session not running) a lost connection is not needs-you", () => {
  const s = thread([started("r1"), completed("r1")]);
  s.markSeen(s.lastSeq());
  expect(chatAttention(s.snapshot(), null, LATER)).toEqual({ section: "idle", reason: null, since: 2000 });
});

test("a run that ended 1 s ago is still working", () => {
  const s = thread([started("r1"), completed("r1")]);
  s.markSeen(s.lastSeq());
  expect(chatAttention(s.snapshot(), connected, 2000 + 1000)).toEqual({ section: "working", reason: "running", since: 2000 });
  expect(chatAttention(s.snapshot(), connected, 2000 + WORKING_GRACE_MS).section).toBe("idle");
});

test("running and queued runs are working", () => {
  expect(chatAttention(thread([started("r1")]).snapshot(), connected, LATER))
    .toEqual({ section: "working", reason: "running", since: 1000 });
  expect(chatAttention(thread([{ type: "run.queued", runId: "r1", text: "hi", attachments: [] }]).snapshot(), connected, LATER))
    .toEqual({ section: "working", reason: "queued", since: 1000 });
});

test("a failed last run is needs-you until it was seen, then idle", () => {
  const s = thread([started("r1"), { type: "run.failed", runId: "r1", error: "boom" }]);
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "needs_you", reason: "failed", since: 2000 });
  s.markSeen(s.lastSeq());
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "idle", reason: null, since: 2000 });
});

test("a rate-limited run is needs-you with that reason; a later run that ends clears it", () => {
  const s = thread([started("r1"), { type: "run.failed", runId: "r1", error: "rate-limited: usage limit", reason: "rate-limited" }]);
  expect(s.snapshot().runs[0]).toMatchObject({ status: "failed", failureReason: "rate-limited" });
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "needs_you", reason: "rate-limited", since: 2000 });
  s.apply({ seq: 3, ts: 3000, event: started("r2") });
  s.apply({ seq: 4, ts: 4000, event: { type: "run.failed", runId: "r2", error: "boom" } });
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "needs_you", reason: "failed", since: 4000 });
});

test("a thread store created before failure reasons opens and records them", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "_threads"));
  const old = new Database(ThreadStore.path(dir, "dev-a-b-1"), { create: true });
  old.run(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, origin TEXT NOT NULL, status TEXT NOT NULL, harness TEXT,
    native_thread_id TEXT, model TEXT, queued_at INTEGER, started_at INTEGER, ended_at INTEGER, ended_seq INTEGER, usage TEXT, error TEXT,
    updated_seq INTEGER NOT NULL)`);
  old.close();
  const s = ThreadStore.open(dir, "dev-a-b-1");
  cleanups.push(() => s.close());
  s.apply({ seq: 1, ts: 1000, event: started("r1") });
  s.apply({ seq: 2, ts: 2000, event: { type: "run.failed", runId: "r1", error: "rate-limited: x", reason: "rate-limited" } });
  expect(s.snapshot().runs[0].failureReason).toBe("rate-limited");
});

test("a session that is not running is not working on runs or background work the store still holds", () => {
  const running = thread([started("r1"), { type: "background.changed", work: [wakeup] }]);
  expect(chatAttention(running.snapshot(), null, LATER)).toEqual({ section: "idle", reason: null, since: 1000 });
  const queued = thread([{ type: "run.queued", runId: "r1", text: "hi", attachments: [] }]);
  expect(chatAttention(queued.snapshot(), null, LATER)).toEqual({ section: "idle", reason: null, since: 1000 });
  const held = thread([started("r1"), { type: "background.changed", work: [wakeup] }, completed("r1")]);
  held.markSeen(held.lastSeq());
  expect(chatAttention(held.snapshot(), null, LATER)).toEqual({ section: "idle", reason: null, since: 3000 });
});

test("an interrupted run and an empty thread are idle", () => {
  const s = thread([started("r1"), { type: "run.interrupted", runId: "r1" }]);
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "idle", reason: null, since: 2000 });
  expect(chatAttention(thread([]).snapshot(), connected, LATER)).toEqual({ section: "idle", reason: null, since: 0 });
});

test("restart guard: busy while working or while a request is open", () => {
  const working = thread([started("r1")]).snapshot();
  expect(chatBusy(working, chatAttention(working, connected, LATER))).toBe(true);
  // An open request on a disconnected link is needs_you, not working, but a restart would still kill the question.
  const asking = thread([started("r1"), { type: "request.opened", runId: "r1", requestId: "q1", kind: "approval", prompt: "rm -rf?" }]).snapshot();
  expect(chatBusy(asking, chatAttention(asking, { status: "disconnected", since: 0 }, LATER))).toBe(true);
  const done = thread([started("r1"), completed("r1")]).snapshot();
  expect(chatBusy(done, chatAttention(done, connected, LATER))).toBe(false);
});

test("tmux attention follows the hub's live state", () => {
  const live = (status: AgentLiveSnapshot["status"]): AgentLiveSnapshot =>
    ({ status, body: "", reason: null, startedAt: 1, updatedAt: 9, statusSince: 5 });
  expect(tmuxAttention(live("waiting"))).toEqual({ section: "needs_you", reason: "request", since: 5 });
  expect(tmuxAttention(live("failed"))).toEqual({ section: "needs_you", reason: "failed", since: 5 });
  expect(tmuxAttention(live("done"))).toEqual({ section: "needs_you", reason: "completed", since: 5 });
  expect(tmuxAttention(live("working"))).toEqual({ section: "working", reason: "running", since: 5 });
  expect(tmuxAttention(live("stalled"))).toEqual({ section: "working", reason: "running", since: 5 });
  expect(tmuxAttention(live("unknown"))).toEqual({ section: "idle", reason: null, since: 5 });
  expect(tmuxAttention(null)).toEqual({ section: "idle", reason: null, since: 0 });
});

test("a bridge log behind the store is needs-you", () => {
  const s = thread([started("r1"), completed("r1")]);
  s.markSeen(2);
  expect(chatAttention(s.snapshot(), { ...connected, behindSince: 7000 }, LATER)).toEqual({ section: "needs_you", reason: "bridge-behind", since: 7000 });
});

test("the last run is the one that ended last, not the last one inserted", () => {
  // A runs, B is queued, the bridge restarts: A is interrupted, the continuation C runs first, then B.
  const s = thread([
    started("A"),
    { type: "run.queued", runId: "B", text: "next", attachments: [] },
    { type: "run.interrupted", runId: "A" },
    { type: "run.started", runId: "C", origin: "continuation", nativeThreadId: null, model: null },
    completed("C"),
    started("B"),
    completed("B"),
  ]);
  s.markSeen(5); // C's end was seen, B's was not
  expect(chatAttention(s.snapshot(), connected, LATER)).toEqual({ section: "needs_you", reason: "completed", since: 7000 });
});
