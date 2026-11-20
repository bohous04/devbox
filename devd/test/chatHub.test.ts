import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub, type NotifyExtra } from "../src/agentEvents";
import { ChatHub } from "../src/chatHub";
import { CommandFailed } from "../src/bridgeLink";
import { insertSession, listCriticReviews, listEvents, listNotifyLog, openDb, setAutoEnd, type SessionRow } from "../src/db";
import { createCriticGate } from "../src/criticGate";
import { DEFAULT_CRITIC_CFG } from "../src/criticProvider";
import { chatAttention } from "../src/attention";
import { endFinishedRuns } from "../src/autoEnd";
import { ThreadStore } from "../src/threadStore";
import type { BackgroundWork, BridgeEvent, LoggedEvent, RunOrigin, ThreadSnapshot } from "../../shared/thread";

const QUIET = 20_000;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** `critic`: the session has the critic on; `review` answers each critic run (raw critic stdout), in order. */
interface CriticOpts {
  review: (prompt: string) => Promise<string>;
  bridgeVersion?: string | null;
  followUpError?: Error;
}

function fixture(opts: { critic?: CriticOpts; prCheck?: (id: string) => Promise<unknown> } = {}) {
  const db = openDb(":memory:");
  const row: SessionRow = {
    id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
    port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat",
    critic: opts.critic ? 1 : 0,
  };
  insertSession(db, row);
  const criticPrompts: string[] = [];
  const followUps: { sessionId: string; text: string }[] = [];
  const changed: string[] = [];
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  let t = 100_000;
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "chathub-"));
  const store = ThreadStore.open(dir, row.id);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); db.close(); });
  const make = () => {
    const hub = new AgentEventHub({ db, notify: (title, message, extra) => notified.push({ title, message, extra }), now: () => t, quietMs: QUIET });
    const c = opts.critic;
    const critic = c && {
      gate: createCriticGate({
        db,
        head: async () => "abc123",
        diff: async () => ({ diff: "--- a\n+++ b\n+change", newFiles: [], truncated: [] }),
        run: async (_s, prompt) => { criticPrompts.push(prompt); return c.review(prompt); },
        cfg: () => DEFAULT_CRITIC_CFG,
        now: () => t,
      }),
      bridgeVersion: () => (c.bridgeVersion === undefined ? "1.3.0" : c.bridgeVersion),
      userText: (_id: string, runId: string) => store.userText(runId),
      followUp: async (sessionId: string, text: string) => {
        if (c.followUpError) throw c.followUpError;
        followUps.push({ sessionId, text });
      },
    };
    return {
      hub,
      chat: new ChatHub({
        hub, session: (id) => (id === row.id ? row : null), now: () => t, log: (m) => logs.push(m),
        prCheck: opts.prCheck, critic, changed: (id) => changed.push(id),
      }),
    };
  };
  let seq = 0;
  const f = {
    db, row, store, notified, logs, criticPrompts, followUps, changed, ...make(),
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
    /** Lets the critic's and the PR read's promises run. */
    drain: async () => { for (let i = 0; i < 10; i++) await Bun.sleep(0); },
    attention: () => chatAttention(store.snapshot({ limit: 0 }), f.chat.link(row.id), t),
  };
  return f;
}
const empty: ThreadSnapshot = { lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null, effort: null };
const noSnapshot = (): ThreadSnapshot => { throw new Error("snapshot read for an event the hub ignores"); };

const started = (runId: string, origin: RunOrigin = "user"): BridgeEvent => ({ type: "run.started", runId, origin, nativeThreadId: null, model: null });
const userMessage = (runId: string, text: string): BridgeEvent => ({ type: "message.final", runId, itemId: `user:${runId}`, role: "user", text });
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

const OK = JSON.stringify({ result: '{"verdict":"ok","findings":[]}' });
const ISSUES = JSON.stringify({
  result: '{"verdict":"issues","findings":[{"severity":"critical","file":"a.ts","line":2,"what":"broken migration"}]}',
});

test("critic block: the reason goes back as a critic follow-up, no done until the critic lets the work pass", async () => {
  const verdicts = [ISSUES, OK];
  const f = fixture({ critic: { review: async () => verdicts.shift()! } });
  f.feed({ type: "run.queued", runId: "r1", text: "add the orders table", attachments: [] }, started("r1"), completed("r1"));
  await f.drain();
  expect(f.followUps).toHaveLength(1);
  expect(f.followUps[0].text).toContain("broken migration");
  f.settle();
  expect(f.notified).toHaveLength(0);
  expect(f.log("stop")).toEqual([expect.objectContaining({ decision: "suppressed", reason: "critic-block" })]);
  // The follow-up is not a new task: the critic keeps the user's task and counts on.
  f.feed(started("r2", "critic"), userMessage("r2", f.followUps[0].text), completed("r2"));
  await f.drain();
  expect(f.followUps).toHaveLength(1);
  expect(f.criticPrompts).toHaveLength(2);
  expect(f.criticPrompts[1]).toContain("add the orders table");
  expect(listCriticReviews(f.db, f.row.id).map((r) => r.round).sort()).toEqual([1, 2]);
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  expect(JSON.parse(f.log("stop").find((r) => r.reason !== "critic-block")!.detail!)).toMatchObject({ promptId: "r2" });
});

test("critic pass: done goes out; the task of a run that was not queued comes with its user message", async () => {
  const f = fixture({ critic: { review: async () => OK } });
  f.feed(started("r1"), userMessage("r1", "rename the helper"), completed("r1"));
  await f.drain();
  expect(f.criticPrompts[0]).toContain("rename the helper");
  expect(f.followUps).toHaveLength(0);
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  expect(listEvents(f.db, { type: "critic_pass" })).toHaveLength(1);
});

test("critic rounds cap: after the last round the work passes with reservations and done goes out", async () => {
  const f = fixture({ critic: { review: async () => ISSUES } });
  f.feed(started("r1"), userMessage("r1", "add the orders table"), completed("r1"));
  await f.drain();
  f.feed(started("r2", "critic"), userMessage("r2", "fix it"), completed("r2"));
  await f.drain();
  expect(f.followUps).toHaveLength(DEFAULT_CRITIC_CFG.rounds - 1);
  expect(listEvents(f.db, { type: "critic_giveup" })).toHaveLength(1);
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
});

test("critic error fails open: critic_error is logged and done goes out", async () => {
  const f = fixture({ critic: { review: async () => { throw new Error("critic exited with code 1"); } } });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  expect(listEvents(f.db, { type: "critic_error" })).toHaveLength(1);
  expect(f.followUps).toHaveLength(0);
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
});

test("a follow-up that cannot be sent fails open: logged, done goes out", async () => {
  const f = fixture({ critic: { review: async () => ISSUES, followUpError: new Error("agent not connected") } });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  expect(f.logs.some((l) => l.includes("agent not connected"))).toBe(true);
});

test("a bridge older than 1.3.0 gets no critic: logged once, done goes out without a review", async () => {
  const f = fixture({ critic: { review: async () => ISSUES, bridgeVersion: "1.2.0" } });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"), started("r2"), userMessage("r2", "do Y"), completed("r2"));
  await f.drain();
  expect(f.criticPrompts).toHaveLength(0);
  expect(f.followUps).toHaveLength(0);
  expect(f.logs.filter((l) => l.includes("critic disabled"))).toHaveLength(1);
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
});

test("while the critic reviews, the run counts as working and the hub holds its stop (no done, no autoEnd)", async () => {
  let verdict: (raw: string) => void = () => {};
  const f = fixture({ critic: { review: () => new Promise<string>((r) => { verdict = r; }) } });
  setAutoEnd(f.db, f.row.id, 1);
  f.chat.onStatus(f.row.id, "connected", () => f.store.snapshot({ limit: 0 }));
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  f.tick(QUIET);
  expect(f.hub.sweep()).toEqual([]);
  expect(f.attention()).toMatchObject({ section: "working", reason: "running" });
  verdict(OK);
  await f.drain();
  expect(f.changed).toContain(f.row.id);
  expect(f.attention().section).not.toBe("working");
  f.tick(QUIET);
  expect(f.hub.sweep()).toEqual([f.row.id]);
});

test("the critic decides before the PR read: a blocked run never asks for the PR", async () => {
  const order: string[] = [];
  const verdicts = [ISSUES, OK];
  const f = fixture({
    critic: { review: async () => { order.push("critic"); return verdicts.shift()!; } },
    prCheck: async () => { order.push("pr"); },
  });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  expect(order).toEqual(["critic"]);
  f.feed(started("r2", "critic"), userMessage("r2", "fix"), completed("r2"));
  await f.drain();
  expect(order).toEqual(["critic", "critic", "pr"]);
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
});

test("no critic while holding work keeps the run going; a new user run makes a pending verdict stale", async () => {
  let verdict: (raw: string) => void = () => {};
  const f = fixture({ critic: { review: () => new Promise<string>((r) => { verdict = r; }) } });
  f.feed(started("r1"), userMessage("r1", "do X"), background(wakeup), completed("r1"));
  await f.drain();
  expect(f.criticPrompts).toHaveLength(0);
  f.feed(background(), started("r2"), userMessage("r2", "do Y"), completed("r2"));
  await f.drain();
  expect(f.criticPrompts).toHaveLength(1);
  f.feed(started("r3"), userMessage("r3", "do Z"));
  verdict(ISSUES);
  await f.drain();
  expect(f.followUps).toHaveLength(0);
});

test("a critic off session completes at once, as before", () => {
  const f = fixture();
  f.feed(started("r1"), completed("r1"));
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
});

test("a devd restart while the critic reviews: the completion is re-sent at connect and done goes out once", async () => {
  const f = fixture({ critic: { review: () => new Promise<string>(() => {}) } });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  expect(f.log("sweep_done")).toEqual([expect.objectContaining({ decision: "deferred", reason: "critic-review" })]);
  f.restart();
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  f.restart();
  f.settle();
  expect(f.notified).toHaveLength(1);
});

test("a blocked run restarted before its follow-up: no done until the follow-up finishes", async () => {
  const f = fixture({ critic: { review: async () => ISSUES } });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  expect(f.followUps).toHaveLength(1);
  expect(f.log("stop")).toEqual([expect.objectContaining({ decision: "suppressed", reason: "critic-block" })]);
  f.restart();
  f.settle();
  expect(f.notified).toHaveLength(0);
  f.feed(started("r2", "critic"), userMessage("r2", f.followUps[0].text), completed("r2"));
  await f.drain();
  f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
});

test("a critic follow-up the bridge refuses (run-active) is logged and the run finishes with one done", async () => {
  const f = fixture({ critic: { review: async () => ISSUES, followUpError: new CommandFailed("run-active") } });
  f.feed(started("r1"), userMessage("r1", "do X"), completed("r1"));
  await f.drain();
  f.settle(); f.settle();
  expect(f.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  expect(f.logs.some((l) => l.includes("run-active"))).toBe(true);
});

test("T10: a completion already sent is not re-sent after a restart that finds holding work again", () => {
  const f = fixture();
  f.feed(started("r1"), completed("r1"));
  f.settle();
  expect(f.notified).toHaveLength(1);
  // Holding work came back without a new run (a background subagent started its own task), then devd restarted.
  f.feed(background(wakeup));
  f.restart();
  f.feed(background());
  f.settle();
  expect(f.notified).toHaveLength(1);
});

test("T10: a session stopped and started again before the hub forgot it does not count its subagents twice", () => {
  const f = fixture();
  f.chat.onStatus(f.row.id, "connected", () => f.store.snapshot({ limit: 0 }));
  f.feed(started("r1"), background(subagent));
  expect(f.hub.counters(f.row.id).inflight).toBe(1);
  // stop (releaseThread drops the chat state), start: the link connects again and seeds from the store.
  f.chat.drop(f.row.id);
  // The corrective subagent_stop says why in notify_log, so it does not read as a real subagent ending.
  expect(f.log("subagent_stop").map((r) => r.reason)).toEqual(["drop-correction"]);
  f.chat.onStatus(f.row.id, "connected", () => f.store.snapshot({ limit: 0 }));
  expect(f.hub.counters(f.row.id).inflight).toBe(1);
  f.feed(background());
  expect(f.hub.counters(f.row.id).inflight).toBe(0);
});
