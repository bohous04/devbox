import { expect, test } from "bun:test";
import { ackPushAlert, deletePushDevice, getPushAlert, insertPushAlert, listOpenPushAlerts, listPushDevices, openDb, prunePushAlerts, touchPushAlert, upsertPushDevice } from "../src/db";

test("push_devices: upsert is idempotent, delete removes", () => {
  const db = openDb(":memory:");
  upsertPushDevice(db, { token: "t1", platform: "ios", name: "iPhone" });
  upsertPushDevice(db, { token: "t1", platform: "ios", name: "iPhone 2" }); // rename, not a duplicate
  expect(listPushDevices(db)).toHaveLength(1);
  expect(listPushDevices(db)[0].name).toBe("iPhone 2");
  deletePushDevice(db, "t1");
  expect(listPushDevices(db)).toHaveLength(0);
});

test("push_alerts: open → ack → closed; expires after 10 min", () => {
  const db = openDb(":memory:");
  insertPushAlert(db, { alert_id: "a1", title: "T", message: "M", session_id: "dev-p-r" });
  expect(listOpenPushAlerts(db, Date.now())).toHaveLength(1);
  expect(ackPushAlert(db, "a1", Date.now())).toBe(true);
  expect(ackPushAlert(db, "a1", Date.now())).toBe(false);
  expect(listOpenPushAlerts(db, Date.now())).toHaveLength(0);
  insertPushAlert(db, { alert_id: "a2", title: "T", message: "M", session_id: null });
  expect(listOpenPushAlerts(db, Date.now() + 11 * 60_000)).toHaveLength(0); // gone after 10 min
  touchPushAlert(db, "a2", 123);
  expect(getPushAlert(db, "a2")!.last_sent_at).toBe(123);
});

test("prunePushAlerts: deletes those older than 7 days, keeps fresh ones", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  // insertPushAlert stamps created_at with the real Date.now(), so the old row
  // goes into the DB directly (same trick as the other prune tests in the repo).
  db.query(`INSERT INTO push_alerts (alert_id, title, message, session_id, created_at, last_sent_at, acked_at) VALUES (?,?,?,?,?,?,?)`)
    .run("old", "T", "M", null, now - 8 * 86_400_000, now - 8 * 86_400_000, null);
  insertPushAlert(db, { alert_id: "fresh", title: "T", message: "M", session_id: null });

  prunePushAlerts(db);

  const remaining = db.query(`SELECT alert_id FROM push_alerts`).all() as { alert_id: string }[];
  expect(remaining.map((r) => r.alert_id)).toEqual(["fresh"]);
});
