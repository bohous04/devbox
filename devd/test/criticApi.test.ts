import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { AgentEventHub } from "../src/agentEvents";
import { insertSession, listNotifyLog, openDb, type SessionRow } from "../src/db";
import type { Decision } from "../src/criticGate";

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

function app(criticStop: (s: SessionRow) => Promise<Decision>) {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  const prompts: string[] = [];
  const stops: string[] = [];
  const hub = new AgentEventHub({ db, notify: () => {} });
  const handled: string[] = [];
  const spyHub = {
    handle: (s: SessionRow, e: string, meta?: never) => { handled.push(e); hub.handle(s, e as never, meta); },
    sweep: () => hub.sweep(), lastHookTs: () => null, turnInProgress: () => false,
    retainRunning: () => {}, forget: () => {}, counters: (id: string) => hub.counters(id),
    lastStopTs: (id: string) => hub.lastStopTs(id),   // prompt statistics in api.ts call it
  };
  const a = createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp", agentEvents: spyHub as never,
    critic: {
      onPrompt: (_s: SessionRow, task: string) => { prompts.push(task); },
      onStop: async (s: SessionRow) => { stops.push(s.id); return criticStop(s); },
    },
  } as never);
  return { a, db, prompts, stops, handled };
}

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("stop with a blocking verdict returns decision:block and does NOT register the stop in the hub", async () => {
  const { a, stops, handled } = app(async () => ({ block: true, reason: "missing await" }));
  const res = await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "stop" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ decision: "block", reason: "missing await" });
  expect(stops).toEqual([ROW.id]);
  expect(handled).toHaveLength(0);        // "finished" must not be scheduled
});

test("stop with a blocking verdict writes suppressed/critic-block to notify_log", async () => {
  const { a, db } = app(async () => ({ block: true, reason: "missing await" }));
  const res = await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "stop" }));
  expect(await res.json()).toEqual({ decision: "block", reason: "missing await" });
  const rows = listNotifyLog(db, { session: ROW.id });
  expect(rows).toHaveLength(1);
  expect(rows[0].event).toBe("stop");
  expect(rows[0].decision).toBe("suppressed");
  expect(rows[0].reason).toBe("critic-block");
});

test("stop with a blocking verdict writes the real hub counters to notify_log, not a hardcoded zero", async () => {
  const { a, db } = app(async () => ({ block: true, reason: "missing await" }));
  await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "subagent_start", agentSessionId: "main-1" }));
  await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "stop" }));
  const rows = listNotifyLog(db, { session: ROW.id });
  const blocked = rows.find((r) => r.reason === "critic-block");
  expect(blocked?.inflight).toBe(1);
  expect(blocked?.teammates).toBe(0);
});

test("stop with a clean verdict goes through to the hub and returns no decision", async () => {
  const { a, handled } = app(async () => ({ block: false }));
  const res = await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "stop" }));
  expect(await res.json()).toEqual({ ok: true });
  expect(handled).toEqual(["stop"]);
});

test("user_prompt_submit passes the prompt text to the critic", async () => {
  const { a, prompts } = app(async () => ({ block: false }));
  await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "user_prompt_submit", prompt: "add SSO" }));
  expect(prompts).toEqual(["add SSO"]);
});

test("long prompt: the critic gets the full text, notify_log only the first 200 characters", async () => {
  const { a, prompts, db } = app(async () => ({ block: false }));
  const long = "x".repeat(250);
  await a.fetch(post("/api/agent-event", { sessionId: ROW.id, event: "user_prompt_submit", prompt: long }));
  expect(prompts).toEqual([long]); // critic gets it untruncated

  const [row] = listNotifyLog(db, { session: ROW.id });
  const detail = JSON.parse(row.detail ?? "{}") as { prompt?: string };
  expect(detail.prompt).toBe(long.slice(0, 200));
  expect(detail.prompt?.length).toBe(200);
});

test("POST /api/sessions/:id/critic toggles the column, unknown session → 404", async () => {
  const { a, db } = app(async () => ({ block: false }));
  expect((await a.fetch(post(`/api/sessions/${ROW.id}/critic`, { critic: true }))).status).toBe(204);
  expect((db.query("SELECT critic FROM sessions WHERE id=?").get(ROW.id) as { critic: number }).critic).toBe(1);
  expect((await a.fetch(post(`/api/sessions/${ROW.id}/critic`, { critic: false }))).status).toBe(204);
  expect((db.query("SELECT critic FROM sessions WHERE id=?").get(ROW.id) as { critic: number }).critic).toBe(0);
  expect((await a.fetch(post("/api/sessions/unknown/critic", { critic: true }))).status).toBe(404);
});

test("GET /api/sessions/:id/reviews returns stored reviews", async () => {
  const { a, db } = app(async () => ({ block: false }));
  const { insertCriticReview } = await import("../src/db");
  insertCriticReview(db, {
    session_id: ROW.id, turn_id: "t1", round: 1, verdict: "issues",
    findings: '[{"severity":"critical","what":"x"}]', evidence: null, ms: 10, at: 5,
  });
  const res = await a.fetch(new Request(`http://x/api/sessions/${ROW.id}/reviews`));
  const rows = await res.json() as { verdict: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].verdict).toBe("issues");
});
