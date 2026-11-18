import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffBudget } from "../src/handoff";
import { planAfterResumeFailure, planTransition, resumeFailedNotice, STALE_MS } from "../src/transition";
import { ThreadStore } from "../src/threadStore";
import type { BridgeEvent, Capabilities } from "../../shared/thread";

const DAY = 24 * 3600 * 1000;
const T0 = 1_800_000_000_000;
const ALL: Capabilities = { resume: true, injectItems: false, liveModelSwitch: true, questions: true, images: true, backgroundVisibility: true };
const opts = (now: number) => ({ window: 200_000, reserve: 20_000, now });

function store() { return ThreadStore.open(mkdtempSync(join(tmpdir(), "transition-")), "dev-a-b-1"); }

/** Applies events with increasing seq; `at` sets the timestamp of the following events. */
function feeder(s: ThreadStore) {
  let seq = 0;
  let ts = T0;
  return {
    at(t: number) { ts = t; },
    push(event: BridgeEvent) { s.apply({ seq: ++seq, ts: ts++, event }); },
  };
}

function run(f: ReturnType<typeof feeder>, runId: string, thread: string, user: string, answer: string, usage = { input: 100, output: 10, cacheCreation: 0, cacheRead: 0 }) {
  f.push({ type: "run.queued", runId, text: user, attachments: [] });
  f.push({ type: "run.started", runId, origin: "user", nativeThreadId: thread, model: "m" });
  f.push({ type: "message.final", runId, itemId: `a-${runId}`, role: "assistant", text: answer });
  f.push({ type: "run.completed", runId, nativeThreadId: thread, usage, costUsd: null });
}

/** Claude thread c1 sees r1, r2; then Codex thread x1 sees r3, r4. */
function claudeThenCodex(s: ThreadStore) {
  const f = feeder(s);
  f.push({ type: "thread.native", harness: "claude", nativeThreadId: "c1", account: "acc-a", model: "opus", caps: ALL });
  run(f, "r1", "c1", "first question", "first answer");
  run(f, "r2", "c1", "second question", "second answer", { input: 3000, output: 500, cacheCreation: 200, cacheRead: 1000 });
  f.at(T0 + DAY);
  f.push({ type: "thread.native", harness: "codex", nativeThreadId: "x1", account: "acc-x", model: "gpt" });
  run(f, "r3", "x1", "third question", "third answer");
  run(f, "r4", "x1", "fourth question", "fourth answer");
  return f;
}

test("thread.native records a provider thread with caps; runs advance covered_through_run", () => {
  const s = store();
  claudeThenCodex(s);
  expect(s.providerThread("claude")).toMatchObject({ harness: "claude", account: "acc-a", nativeThreadId: "c1", coveredThroughRun: "r2", caps: ALL });
  expect(s.providerThread("codex")).toMatchObject({ nativeThreadId: "x1", coveredThroughRun: "r4", caps: null });
  expect(s.providerThread("codex")!.lastUsedAt).toBeGreaterThan(T0 + DAY);
  expect(s.providerThread("acp")).toBeNull();
});

test("a failed event for an unknown run does not advance the provider thread", () => {
  const s = store();
  const f = claudeThenCodex(s);
  f.push({ type: "run.failed", runId: "switch-1", error: "resume-failed" });
  expect(s.providerThread("codex")!.coveredThroughRun).toBe("r4");
});

test("same harness and account switches the model live", () => {
  const s = store();
  const t = planTransition({ harness: "claude", account: "acc-a", model: "opus", nativeThreadId: "c1" },
    { harness: "claude", account: "acc-a", model: "sonnet" }, s, "next", ALL, opts(T0));
  expect(t).toEqual({ kind: "set-model", model: "sonnet" });
});

test("same harness and account without live model switch restarts and resumes", () => {
  const s = store();
  const target = { harness: "codex", account: "acc-x", model: "gpt-mini" };
  const t = planTransition({ harness: "codex", account: "acc-x", model: "gpt", nativeThreadId: "x1" },
    target, s, "next", { ...ALL, liveModelSwitch: false }, opts(T0));
  expect(t).toEqual({ kind: "restart-resume", target, nativeThreadId: "x1" });
});

test("account change on the same harness restarts and resumes the current thread", () => {
  const s = store();
  const target = { harness: "claude", account: "acc-b", model: "opus" };
  const t = planTransition({ harness: "claude", account: "acc-a", model: "opus", nativeThreadId: "c1" }, target, s, "next", ALL, opts(T0));
  expect(t).toEqual({ kind: "restart-resume", target, nativeThreadId: "c1" });
});

test("account change on a harness that cannot resume starts fresh with a full handoff", () => {
  const s = store();
  claudeThenCodex(s);
  const t = planTransition({ harness: "codex", account: "acc-x", model: "gpt", nativeThreadId: "x1" },
    { harness: "codex", account: "acc-y", model: "gpt" }, s, "next", { ...ALL, resume: false }, opts(T0 + DAY));
  expect(t.kind).toBe("fresh-with-handoff");
  if (t.kind !== "fresh-with-handoff") return;
  expect(t.handoff.preamble).toContain("[user] first question");
  expect(t.handoff.preamble).toContain("[assistant] fourth answer");
});

test("returning to a harness used before resumes it with a delta over the runs it missed", () => {
  const s = store();
  claudeThenCodex(s);
  const target = { harness: "claude", account: "acc-a", model: "opus" };
  const request = "back to claude";
  const t = planTransition({ harness: "codex", account: "acc-x", model: "gpt", nativeThreadId: "x1" }, target, s, request, ALL, opts(T0 + 2 * DAY));
  expect(t.kind).toBe("resume-with-delta");
  if (t.kind !== "resume-with-delta") return;
  expect(t.target).toEqual(target);
  expect(t.nativeThreadId).toBe("c1");
  expect(t.handoff.preamble).toContain("[user] third question");
  expect(t.handoff.preamble).toContain("[assistant] fourth answer");
  expect(t.handoff.preamble).not.toContain("first question");
  expect(t.handoff.preamble).not.toContain("second answer");
  // used = context of the target thread's latest run (r2: input + output + cache).
  expect(t.handoff.budget).toBe(handoffBudget(200_000, 4700, new TextEncoder().encode(request).length, 20_000));
});

test("a stale thread of the target harness gets a fresh thread with a full handoff", () => {
  const s = store();
  claudeThenCodex(s);
  const lastUsed = s.providerThread("claude")!.lastUsedAt;
  const t = planTransition({ harness: "codex", account: "acc-x", model: "gpt", nativeThreadId: "x1" },
    { harness: "claude", account: "acc-a", model: "opus" }, s, "back", ALL, opts(lastUsed + STALE_MS));
  expect(t.kind).toBe("fresh-with-handoff");
  if (t.kind !== "fresh-with-handoff") return;
  expect(t.handoff.preamble).toContain("[user] first question");
  expect(t.handoff.preamble).toContain("[user] fourth question");
  // A fresh thread has used nothing yet.
  expect(t.handoff.budget).toBe(handoffBudget(200_000, 0, 4, 20_000));
});

test("a thread whose covered run is unknown is not resumed with a delta", () => {
  const s = store();
  const f = feeder(s);
  f.push({ type: "thread.native", harness: "codex", nativeThreadId: "x0", account: null, model: "gpt" });
  f.push({ type: "thread.native", harness: "claude", nativeThreadId: "c1", account: null, model: "opus" });
  run(f, "r1", "c1", "only question", "only answer");
  const t = planTransition({ harness: "claude", account: null, model: "opus", nativeThreadId: "c1" },
    { harness: "codex", account: null, model: "gpt" }, s, "go", ALL, opts(T0 + DAY));
  expect(t.kind).toBe("fresh-with-handoff");
});

test("a harness never used before gets a fresh thread with a full handoff", () => {
  const s = store();
  const f = feeder(s);
  f.push({ type: "thread.native", harness: "claude", nativeThreadId: "c1", account: null, model: "opus" });
  run(f, "r1", "c1", "only question", "only answer");
  const target = { harness: "codex", account: null, model: "gpt" };
  const t = planTransition({ harness: "claude", account: null, model: "opus", nativeThreadId: "c1" }, target, s, "go", ALL, opts(T0 + 1000));
  expect(t.kind).toBe("fresh-with-handoff");
  if (t.kind !== "fresh-with-handoff") return;
  expect(t.target).toEqual(target);
  expect(t.handoff.preamble).toContain("[user] only question");
});

test("a target without resume support never resumes a delta", () => {
  const s = store();
  claudeThenCodex(s);
  const t = planTransition({ harness: "codex", account: "acc-x", model: "gpt", nativeThreadId: "x1" },
    { harness: "claude", account: "acc-a", model: "opus" }, s, "back", { ...ALL, resume: false }, opts(T0 + 2 * DAY));
  expect(t.kind).toBe("fresh-with-handoff");
});

test("resume failure falls back to a full handoff", () => {
  const s = store();
  const f = claudeThenCodex(s);
  const target = { harness: "claude", account: "acc-a", model: "opus" };
  const planned = planTransition({ harness: "codex", account: "acc-x", model: "gpt", nativeThreadId: "x1" }, target, s, "back", ALL, opts(T0 + 2 * DAY));
  expect(planned.kind).toBe("resume-with-delta");

  f.at(T0 + 2 * DAY);
  f.push({ type: "run.failed", runId: "switch-1", error: "resume-failed" });
  const t = planAfterResumeFailure(target, s, "back", opts(T0 + 2 * DAY));
  expect(t.kind).toBe("fresh-with-handoff");
  if (t.kind !== "fresh-with-handoff") return;
  expect(t.target).toEqual(target);
  expect(t.handoff.preamble).toContain("[user] first question");
  expect(t.handoff.preamble).toContain("[assistant] fourth answer");
  const notices = s.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text);
  expect(notices).toContain(resumeFailedNotice("claude"));
});

test("a null target model on the same harness and account restarts, since only a restart applies the default", () => {
  const s = store();
  const target = { harness: "claude", account: "acc-a", model: null };
  const t = planTransition({ harness: "claude", account: "acc-a", model: "opus", nativeThreadId: "c1" }, target, s, "next", ALL, opts(T0));
  expect(t).toEqual({ kind: "restart-resume", target, nativeThreadId: "c1" });
});

test("a store file from before provider_threads opens and records threads", () => {
  const root = mkdtempSync(join(tmpdir(), "transition-"));
  mkdirSync(join(root, "_threads"));
  const old = new Database(ThreadStore.path(root, "s"), { create: true });
  old.run(`CREATE TABLE native (id INTEGER PRIMARY KEY CHECK (id = 1), harness TEXT NOT NULL, native_thread_id TEXT NOT NULL, account TEXT, model TEXT)`);
  old.close();
  const s = ThreadStore.open(root, "s");
  feeder(s).push({ type: "thread.native", harness: "codex", nativeThreadId: "x1", account: null, model: "gpt" });
  expect(s.providerThread("codex")).toMatchObject({ nativeThreadId: "x1", coveredThroughRun: null, caps: null });
});
