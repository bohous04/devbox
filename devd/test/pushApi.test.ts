import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { insertPushAlert, listPushDevices, openDb } from "../src/db";

function app() {
  const db = openDb(":memory:");
  const a = createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
  } as never);
  return { a, db };
}

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("register stores the device via upsert", async () => {
  const { a, db } = app();
  const r = await a.fetch(post("/api/push/register", { token: "a1b2c3d4e5f6", platform: "ios", name: "iPhone" }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
  const devices = listPushDevices(db);
  expect(devices).toHaveLength(1);
  expect(devices[0].token).toBe("a1b2c3d4e5f6");
  expect(devices[0].platform).toBe("ios");
  expect(devices[0].name).toBe("iPhone");
});

test("register without a token → 400", async () => {
  const { a } = app();
  const r = await a.fetch(post("/api/push/register", { platform: "ios" }));
  expect(r.status).toBe(400);
});

test("register without platform → 400", async () => {
  const { a } = app();
  const r = await a.fetch(post("/api/push/register", { token: "a1b2c3d4e5f6" }));
  expect(r.status).toBe(400);
});

test("register with a non-hexadecimal token → 400 (defense against curl glob/injection)", async () => {
  const { a, db } = app();
  const r = await a.fetch(post("/api/push/register", { token: "not-hex-{glob}", platform: "ios" }));
  expect(r.status).toBe(400);
  expect(listPushDevices(db)).toHaveLength(0);
});

test("ack acknowledges the alert (stopped true), a second call gives stopped false", async () => {
  const { a, db } = app();
  insertPushAlert(db, { alert_id: "alert-1", title: "t", message: "m", session_id: null });

  const first = await a.fetch(post("/api/push/ack", { alertId: "alert-1" }));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, stopped: true });

  const second = await a.fetch(post("/api/push/ack", { alertId: "alert-1" }));
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ ok: true, stopped: false });
});

test("ack without alertId → 400", async () => {
  const { a } = app();
  const r = await a.fetch(post("/api/push/ack", {}));
  expect(r.status).toBe(400);
});
