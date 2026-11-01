import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ackPushAlert, getPushAlert, insertPushAlert, listOpenPushAlerts, listPushDevices, openDb, upsertPushDevice,
} from "../src/db";
import { resetApnsJwtCache, resetApnsWarnings, type ApnsConfig } from "../src/apns";
import { EMERGENCY } from "../src/pushover";
import { createApnsChannel, tickPushAlerts, type RunFn } from "../src/pushChannel";

beforeEach(() => { resetApnsJwtCache(); resetApnsWarnings(); });

// The fire-and-forget work in `send()` goes through a real disk read of the key and
// a WebCrypto signature (no timer) — one macrotask tick is enough for it to finish
// (same pattern as cache.test.ts for background refresh).
const flush = () => new Promise((r) => setTimeout(r, 20));

function toPem(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

// A real P-256 pair, stored as .p8 — apnsJwt inside sendApns must be able to
// read and sign it, otherwise the push would never reach curl (mock `run`).
async function makeKeyFile(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const dir = mkdtempSync(join(tmpdir(), "pushchannel-test-"));
  const path = join(dir, "AuthKey_TEST.p8");
  writeFileSync(path, toPem(pkcs8));
  return path;
}

const cfg = (keyPath: string): ApnsConfig => ({ keyPath, keyId: "KEYID123", teamId: "TEAM123ABC", bundleId: "com.example.app" });

function findPayload(cmd: string[]): { aps: { category: string }; sessionId?: string; alertId?: string; terminal?: boolean; target?: string; targetId?: string } {
  return JSON.parse(cmd[cmd.indexOf("-d") + 1]);
}

function okRun(calls: string[][]): RunFn {
  return async (cmd) => { calls.push(cmd); return { code: 0, stdout: "200", stderr: "" }; };
}

test("without config the channel is enabled:false and send is a no-op", async () => {
  const db = openDb(":memory:");
  const calls: string[][] = [];
  const channel = createApnsChannel({ db, run: okRun(calls), now: () => Date.now() }, null);
  expect(channel.enabled).toBe(false);
  expect(channel.send("t", "m")).toBe(false);
  await flush();
  expect(calls).toHaveLength(0);
  expect(listOpenPushAlerts(db, Date.now())).toHaveLength(0);
});

test("with full config the channel is enabled:true", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  const channel = createApnsChannel({ db, run: okRun([]), now: () => Date.now() }, cfg(path));
  expect(channel.enabled).toBe(true);
});

test("priority 2 (EMERGENCY) → alert in the DB, push to all devices and touch last_sent_at", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  upsertPushDevice(db, { token: "tok2", platform: "ios" });
  const calls: string[][] = [];
  const mockNow = 1_000_000; // deliberately outside the real epoch, so it is clear that the touch happened
  const channel = createApnsChannel({ db, run: okRun(calls), now: () => mockNow }, cfg(path));

  const ret = channel.send("shop/cms", "Claude is waiting for input", EMERGENCY);
  expect(ret).toBe(true);
  await flush();

  expect(calls).toHaveLength(2); // 2 devices = 2 curl calls
  expect(calls[0].join(" ")).toContain("tok1");
  expect(calls[1].join(" ")).toContain("tok2");
  const p0 = findPayload(calls[0]);
  expect(p0.aps.category).toBe("emergency");
  expect(p0.alertId).toBeDefined();

  const alerts = listOpenPushAlerts(db, Date.now());
  expect(alerts).toHaveLength(1);
  expect(alerts[0].last_sent_at).toBe(mockNow); // touchPushAlert after a successful push
});

test("done/blocked (without priority 2) is not stored anywhere, only sent", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const calls: string[][] = [];
  const channel = createApnsChannel({ db, run: okRun(calls), now: () => Date.now() }, cfg(path));

  channel.send("devbox", "Session suspended after 4 h of inactivity");
  await flush();

  expect(calls).toHaveLength(1);
  expect(listOpenPushAlerts(db, Date.now())).toHaveLength(0); // no alert for non-emergency
});

test("category: text with \"is waiting for\" → blocked, otherwise done", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const calls: string[][] = [];
  const channel = createApnsChannel({ db, run: okRun(calls), now: () => Date.now() }, cfg(path));

  // Between the calls we wait for the fire-and-forget work to finish — without that the
  // completion order of two concurrent sends is not guaranteed (the JWT cache makes the second
  // call faster than the first, see the race under load from several test files at once).
  channel.send("shop/cms", "Claude is waiting for input");
  await flush();
  channel.send("shop/cms", "Claude finished working");
  await flush();

  expect(calls).toHaveLength(2);
  expect(findPayload(calls[0]).aps.category).toBe("blocked");
  expect(findPayload(calls[1]).aps.category).toBe("done");
});

test("opts.url with ?terminal=<id> → sessionId + terminal:true in the payload", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const calls: string[][] = [];
  const channel = createApnsChannel({ db, run: okRun(calls), now: () => Date.now() }, cfg(path));

  channel.send("shop/cms", "m", { url: "https://dev.example.com/sessions?terminal=dev-shop-cms", url_title: "Open terminal" });
  await flush();

  const payload = findPayload(calls[0]);
  expect(payload.sessionId).toBe("dev-shop-cms");
  expect(payload.terminal).toBe(true);
});

test("410 (gone) → the dead device is deleted from push_devices", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok-dead", platform: "ios" });
  const run: RunFn = async () => ({ code: 0, stdout: "410", stderr: "" });
  const channel = createApnsChannel({ db, run, now: () => Date.now() }, cfg(path));

  channel.send("t", "m");
  await flush();

  expect(listPushDevices(db)).toHaveLength(0);
});

test("tickPushAlerts: without config it is a no-op", async () => {
  const db = openDb(":memory:");
  insertPushAlert(db, { alert_id: "a1", title: "T", message: "M", session_id: null });
  const calls: string[][] = [];
  await tickPushAlerts({ db, run: okRun(calls), now: () => Date.now() }, null);
  expect(calls).toHaveLength(0);
});

test("tickPushAlerts: an unacked alert older than 30 s is resent and touches last_sent_at", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const base = Date.now();
  insertPushAlert(db, { alert_id: "a1", title: "T", message: "M", session_id: null });
  const calls: string[][] = [];

  await tickPushAlerts({ db, run: okRun(calls), now: () => base + 31_000 }, cfg(path));

  expect(calls).toHaveLength(1);
  expect(getPushAlert(db, "a1")!.last_sent_at).toBe(base + 31_000);
});

test("tickPushAlerts: an alert younger than 30 s since last_sent_at is not resent yet", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const base = Date.now();
  insertPushAlert(db, { alert_id: "a1", title: "T", message: "M", session_id: null });
  const calls: string[][] = [];

  await tickPushAlerts({ db, run: okRun(calls), now: () => base + 10_000 }, cfg(path));

  expect(calls).toHaveLength(0);
});

test("tickPushAlerts: an acked alert is not resent", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const base = Date.now();
  insertPushAlert(db, { alert_id: "a1", title: "T", message: "M", session_id: null });
  ackPushAlert(db, "a1", base);
  const calls: string[][] = [];

  await tickPushAlerts({ db, run: okRun(calls), now: () => base + 31_000 }, cfg(path));

  expect(calls).toHaveLength(0);
});

test("tickPushAlerts: after the 10 min window the alert is no longer sent (listOpenPushAlerts drops it)", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const base = Date.now();
  insertPushAlert(db, { alert_id: "a1", title: "T", message: "M", session_id: null });
  const calls: string[][] = [];

  await tickPushAlerts({ db, run: okRun(calls), now: () => base + 11 * 60_000 }, cfg(path));

  expect(calls).toHaveLength(0);
});

test("category: blocked: true → blocked even without \"is waiting for\"; target/targetId are passed into the payload", async () => {
  const db = openDb(":memory:");
  const path = await makeKeyFile();
  upsertPushDevice(db, { token: "tok1", platform: "ios" });
  const calls: string[][] = [];
  const channel = createApnsChannel({ db, run: okRun(calls), now: () => Date.now() }, cfg(path));

  channel.send("Vault is locked", "Unlock it in the Devbox app", { blocked: true, target: "vault" });
  await flush();
  channel.send("Production SQL awaiting approval", "#7: shop — dml", { blocked: true, target: "prodWrites", targetId: "7" });
  await flush();
  channel.send("devbox", "Scheduled run failed", { target: "schedules" });
  await flush();

  expect(calls).toHaveLength(3);
  const [a, b, c] = calls.map(findPayload);
  expect(a.aps.category).toBe("blocked");
  expect(a.target).toBe("vault");
  expect(a.targetId).toBeUndefined();
  expect(b.aps.category).toBe("blocked");
  expect(b).toMatchObject({ target: "prodWrites", targetId: "7" });
  expect(c.aps.category).toBe("done");
  expect(c.target).toBe("schedules");
});
