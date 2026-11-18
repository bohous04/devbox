import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub, type NotifyExtra } from "../src/agentEvents";
import { ChatHub } from "../src/chatHub";
import { insertSession, listNotifyLog, openDb, type SessionRow } from "../src/db";
import { ThreadStore } from "../src/threadStore";
import type { BackgroundWork, BridgeEvent, LoggedEvent } from "../../shared/thread";

const QUIET = 20_000;

function fixture() {
  const db = openDb(":memory:");
  const row: SessionRow = {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat",
  };
  insertSession(db, row);
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  let t = 100_000;
  const hub = new AgentEventHub({ db, notify: (title, message, extra) => notified.push({ title, message, extra }), now: () => t, quietMs: QUIET });
  const logs: string[] = [];
  const chat = new ChatHub({ hub, session: (id) => (id === row.id ? row : null), now: () => t, log: (m) => logs.push(m) });
  const store = ThreadStore.open(mkdtempSync(join(tmpdir(), "chathub-")), row.id);
  let seq = 0;
  const feed = (...events: BridgeEvent[]) => {
    for (const event of events) {
      const e: LoggedEvent = { seq: ++seq, ts: t, event };
      store.apply(e);
      chat.onEvent(row.id, e, store.snapshot());
    }
  };
  const settle = () => { t += QUIET; hub.sweep(); };
  // counter-mismatch rows are the hub's diagnostics (chat sends no subagent counter), not decisions.
  const log = (event: string) => listNotifyLog(db, { session: row.id }).filter((r) => r.event === event && r.reason !== "counter-mismatch");
  return { db, row, hub, chat, notified, logs, feed, settle, log, tick: (ms: number) => { t += ms; } };
}

const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });
const background = (...work: BackgroundWork[]): BridgeEvent => ({ type: "background.changed", work });
const wakeup: BackgroundWork = { id: "w1", kind: "wakeup", label: "check CI", holding: true };
const devServer: BackgroundWork = { id: "c1", kind: "command", label: "npm run dev", holding: false };

test("a completed run without holding work sends done after the quiet window", () => {
  const f = fixture();
  f.feed(started("r1"), { type: "tool.started", runId: "r1", itemId: "t1", tool: "Bash", input: {} },
    { type: "tool.finished", runId: "r1", itemId: "t1", isError: false, output: "ok" }, background(devServer), completed("r1"));
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  expect(f.log("user_prompt_submit")).toHaveLength(1);
  expect(JSON.parse(f.log("stop")[0].detail!)).toMatchObject({ promptId: "r1", backgroundTasks: 0 });
});

test("no done while a wakeup is pending", () => {
  const f = fixture();
  f.feed(started("r1"), background(wakeup), completed("r1"));
  f.settle(); f.settle();
  expect(f.notified).toHaveLength(0);
  expect(f.log("stop")[0]).toMatchObject({ decision: "deferred", reason: "busy-background-tasks" });
  expect(f.hub.liveSnapshot(f.row.id)?.status).toBe("working");
});

test("done is sent once holding work clears", () => {
  const f = fixture();
  f.feed(started("r1"), background(wakeup), completed("r1"));
  f.settle();
  expect(f.notified).toHaveLength(0);
  f.feed(background(devServer));
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  // A later, unrelated background change does not re-send the completion of r1.
  f.feed(background(wakeup), background());
  f.settle();
  expect(f.notified).toHaveLength(1);
  expect(f.log("stop")).toHaveLength(2);
});

test("a new run cancels the pending completion of the previous one", () => {
  const f = fixture();
  f.feed(started("r1"), background(wakeup), completed("r1"), started("r2"), background());
  f.settle();
  expect(f.notified).toHaveLength(0);
  expect(f.log("stop")).toHaveLength(1);
});

test("question notifies as blocked input and the answer resumes the run", () => {
  const f = fixture();
  f.feed(started("r1"), { type: "request.opened", runId: "r1", requestId: "q1", kind: "question", prompt: "Which database?" });
  expect(f.notified).toHaveLength(1);
  expect(f.notified[0]).toMatchObject({ title: "shop/cms", message: "Claude is waiting for input", extra: { sound: true } });
  expect(f.hub.liveSnapshot(f.row.id)).toMatchObject({ status: "waiting", reason: "Which database?" });
  f.feed({ type: "request.resolved", requestId: "q1", answer: "Postgres", by: "user" });
  expect(f.hub.liveSnapshot(f.row.id)?.status).toBe("working");
  f.feed(completed("r1"));
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude is waiting for input", "Claude finished working"]);
});

test("plan notifies as blocked input; approval as blocked permission", () => {
  const f = fixture();
  f.feed(started("r1"), { type: "request.opened", runId: "r1", requestId: "p1", kind: "plan", prompt: "1. do it" });
  expect(f.notified.at(-1)?.message).toBe("Claude is waiting for input");
  const g = fixture();
  g.feed(started("r1"), { type: "request.opened", runId: "r1", requestId: "a1", kind: "approval", prompt: "rm -rf build" });
  expect(g.notified.at(-1)?.message).toBe("Claude is waiting for permission");
  g.feed({ type: "request.resolved", requestId: "a1", answer: null, by: "expired" });
  expect(g.hub.liveSnapshot(g.row.id)?.status).toBe("working");
});

test("failed run sends the failure path", () => {
  const f = fixture();
  f.feed(started("r1"), { type: "run.failed", runId: "r1", error: "rate limited" });
  f.settle();
  expect(f.hub.liveSnapshot(f.row.id)?.status).toBe("failed");
  expect(f.log("stop_failure")).toHaveLength(1);
  expect(f.notified).toHaveLength(0);
});

test("interrupted run maps to interrupted", () => {
  const f = fixture();
  f.feed(started("r1"), { type: "run.interrupted", runId: "r1" });
  expect(f.log("interrupted")).toHaveLength(1);
  expect(f.hub.liveSnapshot(f.row.id)?.status).toBe("unknown");
});

test("an unknown event type is ignored by the hub and logged once per type", () => {
  const f = fixture();
  const snap = { lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null };
  const odd = { seq: 1, ts: 0, event: { type: "run.teleported", runId: "r1" } } as unknown as LoggedEvent;
  f.chat.onEvent(f.row.id, odd, snap);
  f.chat.onEvent(f.row.id, { ...odd, seq: 2 }, snap);
  expect(f.logs).toEqual(["chat hub: ignoring unknown event type run.teleported"]);
  expect(listNotifyLog(f.db, { session: f.row.id })).toHaveLength(0);
});

test("events of an unknown session are logged, not handled", () => {
  const f = fixture();
  const snap = { lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null };
  f.chat.onEvent("dev-gone", { seq: 1, ts: 0, event: started("r1") }, snap);
  expect(f.logs).toEqual(["chat hub: no session dev-gone for event run.started (seq 1)"]);
});

test("link state: tracked while the session runs, none once it does not", () => {
  const f = fixture();
  expect(f.chat.link(f.row.id)).toBeNull();
  f.chat.onStatus(f.row.id, "connecting");
  f.tick(5);
  f.chat.onStatus(f.row.id, "disconnected");
  expect(f.chat.link(f.row.id)).toEqual({ status: "disconnected", since: 100_005 });
  f.row.status = "stopped";
  expect(f.chat.link(f.row.id)).toBeNull();
});
