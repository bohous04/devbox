import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { AgentEventHub } from "../src/agentEvents";
import { insertNotifyLog, insertSession, listNotifyLog, openDb, type SessionRow } from "../src/db";

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

function app() {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  const hub = new AgentEventHub({ db, notify: () => {} });
  const a = createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp", agentEvents: hub,
  } as never);
  return { a, db };
}

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("agent-event accepts subagent_start and forwards agentType to the log", async () => {
  const { a, db } = app();
  const r = await a.fetch(post("/api/agent-event", {
    sessionId: "dev-shop-cms", event: "subagent_start", agentSessionId: "main-1", agentType: "Explore",
  }));
  expect(r.status).toBe(200);
  const [row] = listNotifyLog(db, { limit: 1 });
  expect(row.event).toBe("subagent_start");
  expect(row.agent_session_id).toBe("main-1");
  expect(JSON.parse(row.detail ?? "{}").agentType).toBe("Explore");
});

test("agent-event rejects an unknown event", async () => {
  const { a } = app();
  const r = await a.fetch(post("/api/agent-event", { sessionId: "dev-shop-cms", event: "vymyslena" }));
  expect(r.status).toBe(400);
});

test("GET /api/notify-log returns rows and respects the sessionId filter", async () => {
  const { a } = app();
  await a.fetch(post("/api/agent-event", { sessionId: "dev-shop-cms", event: "stop", agentSessionId: "main-1" }));
  const r = await a.fetch(new Request("http://x/api/notify-log?sessionId=dev-shop-cms&limit=10"));
  expect(r.status).toBe(200);
  const rows = await r.json() as { event: string; decision: string }[];
  expect(rows[0].event).toBe("stop");
  expect(rows[0].decision).toBe("armed");

  const empty = await (await a.fetch(new Request("http://x/api/notify-log?sessionId=none"))).json() as unknown[];
  expect(empty).toHaveLength(0);
});

test('GET /api/notify-log?decision=sent returns only "sent" rows (server-side, not a client filter)', async () => {
  const { a, db } = app();
  // Simulates a live devbox: a few "deferred"/"armed" noise rows and one lone "sent"
  // (as if it fell behind the last 300 rows) — the filter must find it anyway.
  for (let i = 0; i < 5; i++) {
    insertNotifyLog(db, {
      ts: i, session_id: "dev-shop-cms", event: "subagent_start", decision: "none",
      reason: null, inflight: 1, teammates: 0, agent_session_id: "main-1", detail: null,
    });
  }
  insertNotifyLog(db, {
    ts: 100, session_id: "dev-shop-cms", event: "sweep_done", decision: "sent",
    reason: null, inflight: 0, teammates: 0, agent_session_id: null, detail: null,
  });

  const r = await a.fetch(new Request("http://x/api/notify-log?decision=sent"));
  expect(r.status).toBe(200);
  const rows = await r.json() as { decision: string; ts: number }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].ts).toBe(100);
});

test("GET /api/notify-log?decision=bogus → 400", async () => {
  const { a } = app();
  const r = await a.fetch(new Request("http://x/api/notify-log?decision=bogus"));
  expect(r.status).toBe(400);
});

test("GET /api/notify-log with a non-numeric limit does not crash, falls back to the default", async () => {
  const { a } = app();
  await a.fetch(post("/api/agent-event", { sessionId: "dev-shop-cms", event: "stop", agentSessionId: "main-1" }));
  const r = await a.fetch(new Request("http://x/api/notify-log?limit=abc"));
  expect(r.status).toBe(200);
  const rows = await r.json() as unknown[];
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
});

test("POST verdict flags a row, an empty verdict clears the flag", async () => {
  const { a, db } = app();
  await a.fetch(post("/api/agent-event", { sessionId: "dev-shop-cms", event: "stop", agentSessionId: "main-1" }));
  const id = listNotifyLog(db, { limit: 1 })[0].id;

  expect((await a.fetch(post(`/api/notify-log/${id}/verdict`, { verdict: "false_positive", note: "an agent was running" }))).status).toBe(200);
  expect(listNotifyLog(db, { limit: 1 })[0].verdict).toBe("false_positive");

  expect((await a.fetch(post(`/api/notify-log/${id}/verdict`, { verdict: null }))).status).toBe(200);
  expect(listNotifyLog(db, { limit: 1 })[0].verdict).toBeNull();
});

test("POST verdict: invalid value 400, unknown id 404", async () => {
  const { a } = app();
  expect((await a.fetch(post("/api/notify-log/1/verdict", { verdict: "wrong" }))).status).toBe(400);
  expect((await a.fetch(post("/api/notify-log/999/verdict", { verdict: "ok" }))).status).toBe(404);
});
