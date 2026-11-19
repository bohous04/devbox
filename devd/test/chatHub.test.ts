import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub, type NotifyExtra } from "../src/agentEvents";
import { ChatHub } from "../src/chatHub";
import { insertSession, listNotifyLog, openDb, setAutoEnd, type SessionRow } from "../src/db";
import { endFinishedRuns } from "../src/autoEnd";
import { ThreadStore } from "../src/threadStore";
import type { BackgroundWork, BridgeEvent, LoggedEvent, ThreadSnapshot } from "../../shared/thread";

const QUIET = 20_000;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const db = openDb(":memory:");
  const row: SessionRow = {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat",
  };
  insertSession(db, row);
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  let t = 100_000;
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "chathub-"));
  const store = ThreadStore.open(dir, row.id);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); db.close(); });
  const make = () => {
    const hub = new AgentEventHub({ db, notify: (title, message, extra) => notified.push({ title, message, extra }), now: () => t, quietMs: QUIET });
    return { hub, chat: new ChatHub({ hub, session: (id) => (id === row.id ? row : null), now: () => t, log: (m) => logs.push(m) }) };
  };
  let seq = 0;
  const f = {
    db, row, store, notified, logs, ...make(),
    feed: (...events: BridgeEvent[]) => {
      for (const event of events) {
        const e: LoggedEvent = { seq: ++seq, ts: t, event };
        store.apply(e);
        f.chat.onEvent(row.id, e, () => store.snapshot({ limit: 0 }));
      }
    },
    /** devd restarts: a fresh hub and ChatHub over the same DB and thread store, then the link connects. */
    restart: () => {
      Object.assign(f, make());
      f.chat.onStatus(row.id, "connecting", () => store.snapshot({ limit: 0 }));
      f.chat.onStatus(row.id, "connected", () => store.snapshot({ limit: 0 }));
    },
    settle: () => { t += QUIET; f.hub.sweep(); },
    // Decision rows only: the hub adds counter-mismatch diagnostics when holding work is not a subagent.
    log: (event: string) => listNotifyLog(db, { session: row.id }).filter((r) => r.event === event && r.reason !== "counter-mismatch"),
    tick: (ms: number) => { t += ms; },
  };
  return f;
}
const empty: ThreadSnapshot = { lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null };
const noSnapshot = (): ThreadSnapshot => { throw new Error("snapshot read for an event the hub ignores"); };

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
  expect(g.hub.liveSnapshot(g.row.id)?.reason).toBe("Allow: rm -rf build");
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
  const odd = { seq: 1, ts: 0, event: { type: "run.teleported", runId: "r1" } } as unknown as LoggedEvent;
  f.chat.onEvent(f.row.id, odd, noSnapshot);
  f.chat.onEvent(f.row.id, { ...odd, seq: 2 }, noSnapshot);
  expect(f.logs).toEqual(["chat hub: ignoring unknown event type run.teleported"]);
  expect(listNotifyLog(f.db, { session: f.row.id })).toHaveLength(0);
});

test("events of an unknown session are logged, not handled", () => {
  const f = fixture();
  f.chat.onEvent("dev-gone", { seq: 1, ts: 0, event: started("r1") }, () => empty);
  expect(f.logs).toEqual(["chat hub: no session dev-gone for event run.started (seq 1)"]);
});

test("link state: tracked while the session runs, none once it does not", () => {
  const f = fixture();
  expect(f.chat.link(f.row.id)).toBeNull();
  f.chat.onStatus(f.row.id, "connecting", () => empty);
  f.tick(5);
  f.chat.onStatus(f.row.id, "disconnected", () => empty);
  expect(f.chat.link(f.row.id)).toEqual({ status: "disconnected", since: 100_005 });
  f.row.status = "stopped";
  expect(f.chat.link(f.row.id)).toBeNull();
});

const subagent: BackgroundWork = { id: "s1", kind: "subagent", label: "explore", holding: true };

test("held completion with a subagent: no counter mismatch, done once the subagent ends", () => {
  const f = fixture();
  f.feed(started("r1"), background(subagent), completed("r1"));
  f.settle();
  expect(f.notified).toHaveLength(0);
  f.feed(background());
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  const rows = listNotifyLog(f.db, { session: f.row.id });
  expect(rows.filter((r) => r.reason === "counter-mismatch" || r.reason === "counter-underflow")).toEqual([]);
  expect(rows.map((r) => r.event).filter((e) => e.startsWith("subagent"))).toEqual(["subagent_stop", "subagent_start"]);
});

test("a subagent running across a new run keeps the hub's counter", () => {
  const f = fixture();
  f.feed(started("r1"), background(subagent), completed("r1"), started("r2"), completed("r2"));
  expect(f.hub.counters(f.row.id).inflight).toBe(1);
  expect(f.log("stop")[0]).toMatchObject({ decision: "deferred", reason: "busy-background-tasks" });
  f.feed(background());
  expect(f.hub.counters(f.row.id).inflight).toBe(0);
});

test("holding work going from 2 to 1 sends no stop", () => {
  const f = fixture();
  f.feed(started("r1"), background(wakeup, subagent), completed("r1"), background(wakeup));
  f.settle();
  expect(f.log("stop")).toHaveLength(1);
  expect(f.notified).toHaveLength(0);
});

test("a held completion survives a devd restart: done is sent exactly once", () => {
  const f = fixture();
  f.feed(started("r1"), background(wakeup, subagent), completed("r1"));
  f.restart();
  f.feed(background(wakeup));
  f.settle();
  expect(f.notified).toHaveLength(0);
  f.feed(background());
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  f.feed(background(wakeup), background());
  f.settle();
  expect(f.notified).toHaveLength(1);
  expect(listNotifyLog(f.db, { session: f.row.id }).filter((r) => r.reason === "counter-underflow")).toEqual([]);
});

test("a restart after a completion that was not held does not send it again", () => {
  const f = fixture();
  f.feed(started("r1"), completed("r1"));
  f.settle();
  f.restart();
  f.feed(background(wakeup), background());
  f.settle();
  expect(f.notified).toHaveLength(1);
});

test("Claude's order: AskUserQuestion tool then its request with the same id notifies once", () => {
  const f = fixture();
  f.feed(started("r1"), { type: "tool.started", runId: "r1", itemId: "tu1", tool: "AskUserQuestion", input: {} },
    { type: "request.opened", runId: "r1", requestId: "tu1", kind: "question", prompt: "Which database?" });
  expect(f.notified.map((n) => n.message)).toEqual(["Claude is waiting for input"]);
  expect(f.hub.liveSnapshot(f.row.id)).toMatchObject({ status: "waiting", reason: "Which database?" });
  f.feed({ type: "request.resolved", requestId: "tu1", answer: "Postgres", by: "user" },
    { type: "tool.finished", runId: "r1", itemId: "tu1", isError: false, output: "Postgres" });
  expect(f.hub.liveSnapshot(f.row.id)?.status).toBe("working");
});

test("ignored event types never read the snapshot; drop forgets the session", () => {
  const f = fixture();
  f.chat.onEvent(f.row.id, { seq: 1, ts: 0, event: { type: "message.delta", runId: "r1", itemId: "m", text: "x" } }, noSnapshot);
  f.chat.onStatus(f.row.id, "connected", () => empty);
  f.chat.drop(f.row.id);
  expect(f.chat.link(f.row.id)).toBeNull();
});

test("a completed chat run is returned by sweep and ends an auto_end session", async () => {
  const f = fixture();
  setAutoEnd(f.db, f.row.id, 1);
  f.feed(started("r1"), completed("r1"));
  f.tick(QUIET);
  const done = f.hub.sweep();
  expect(done).toEqual([f.row.id]);
  const ended: string[] = [];
  expect(await endFinishedRuns({ db: f.db, end: async (id) => { ended.push(id); } }, done)).toEqual([f.row.id]);
  expect(ended).toEqual([f.row.id]);
});
