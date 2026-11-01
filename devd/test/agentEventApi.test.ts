import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { AgentEventHub } from "../src/agentEvents";
import { getHarvestState, insertSession, openDb, setHarvestState, type SessionRow } from "../src/db";

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

// grok session — different id/port so it does not collide with ROW (port_base is UNIQUE).
const GROK_ROW: SessionRow = {
  ...ROW, id: "dev-p-r", container: "dev-p-r", project: "p", repo: "r", port_base: 40200, agent: "grok",
};

// antigravity session (runtime "agy") — different id/port so it does not collide with the others.
const AGY_ROW: SessionRow = {
  ...ROW, id: "dev-g-h", container: "dev-g-h", project: "g", repo: "h", port_base: 40300, agent: "antigravity",
};

function app(extra: SessionRow[] = []) {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  for (const r of extra) insertSession(db, r);
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

const SID = "01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

test("session_start of a grok session stores the sid mapping in harvest_state (with project/repo — attribution after the session is deleted)", async () => {
  const { a, db } = app([GROK_ROW]);
  const r = await a.fetch(post("/api/agent-event", { sessionId: "dev-p-r", event: "session_start", agentSessionId: SID }));
  expect(r.status).toBe(200);
  const map = getHarvestState<Record<string, { session: string; project: string; repo: string }>>(db, "grok-sids");
  expect(map![SID].session).toBe("dev-p-r");
  expect(map![SID].project).toBe("p");
  expect(map![SID].repo).toBe("r");
});

test("session_start of a non-grok session returns 200 and creates no mapping", async () => {
  const { a, db } = app();
  const r = await a.fetch(post("/api/agent-event", { sessionId: "dev-shop-cms", event: "session_start", agentSessionId: SID }));
  expect(r.status).toBe(200);
  expect(getHarvestState(db, "grok-sids")).toBeNull();
});

test("session_start of an unknown session → 404", async () => {
  const { a } = app();
  const r = await a.fetch(post("/api/agent-event", { sessionId: "dev-nope", event: "session_start", agentSessionId: SID }));
  expect(r.status).toBe(404);
});

test("session_start of an antigravity session stores the conversation in agy-sids with the model; an unsafe id does not", async () => {
  const { a, db } = app([AGY_ROW]);
  const r = await a.fetch(post("/api/agent-event", {
    sessionId: "dev-g-h", event: "session_start", agentSessionId: "ab32-01", agentModel: "gemini-3.8-flash-high",
  }));
  expect(r.status).toBe(200);
  const map = getHarvestState<Record<string, { session: string; project: string; repo: string; model: string | null }>>(db, "agy-sids");
  expect(map!["ab32-01"].session).toBe("dev-g-h");
  expect(map!["ab32-01"].project).toBe("g");
  expect(map!["ab32-01"].repo).toBe("h");
  expect(map!["ab32-01"].model).toBe("gemini-3.8-flash-high");

  // An unsafe id (e.g. shell injection) does not pass the regex — the map does not change.
  const r2 = await a.fetch(post("/api/agent-event", {
    sessionId: "dev-g-h", event: "session_start", agentSessionId: "x; rm -rf /", agentModel: "gemini-3.8-flash-high",
  }));
  expect(r2.status).toBe(200);
  const map2 = getHarvestState<Record<string, unknown>>(db, "agy-sids");
  expect(Object.keys(map2!)).toEqual(["ab32-01"]);
});

test("session_start antigravity: a model switch is added to the history, a repeated same model is not", async () => {
  const { a, db } = app([AGY_ROW]);
  const send = (m: string) => a.fetch(post("/api/agent-event", { sessionId: "dev-g-h", event: "session_start", agentSessionId: "ab32-01", agentModel: m }));
  await send("gemini-3.8-flash-high");
  await send("gemini-3.8-flash-high");
  await send("claude-opus-5-5-high");
  const e = getHarvestState<Record<string, { model: string | null; models?: { from: number; model: string }[] }>>(db, "agy-sids")!["ab32-01"];
  expect(e.models!.map((h) => h.model)).toEqual(["gemini-3.8-flash-high", "claude-opus-5-5-high"]);
  expect(e.models![0].from).toBeLessThanOrEqual(e.models![1].from);
  expect(e.model).toBe("claude-opus-5-5-high");
});

test("session_start antigravity: an old record without history is taken over as the first entry", async () => {
  const { a, db } = app([AGY_ROW]);
  setHarvestState(db, "agy-sids", { "ab32-01": { session: "dev-g-h", project: "g", repo: "h", model: "gemini-3.8-flash-low", ts: 1000 } });
  await a.fetch(post("/api/agent-event", { sessionId: "dev-g-h", event: "session_start", agentSessionId: "ab32-01", agentModel: "claude-sonnet-5-5-low" }));
  const e = getHarvestState<Record<string, { models?: { from: number; model: string }[] }>>(db, "agy-sids")!["ab32-01"];
  expect(e.models).toEqual([{ from: 1000, model: "gemini-3.8-flash-low" }, { from: expect.any(Number), model: "claude-sonnet-5-5-low" }]);
});
