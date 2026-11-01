import { expect, test } from "bun:test";
import { decide, heartbeat, heartbeatUrl, INITIAL, normalizeLast, type WatchState } from "./devd-watch";

const s = (last: WatchState["last"], downTicks = 0): WatchState => ({ last, downTicks });

// Since 2026-10 devd reports a locked/unlocked vault itself through the app (vaultNotifier.ts,
// target "vault" → a tap opens unlocking). The watchdog stays silent about the vault — otherwise
// the same message would arrive twice (app + Pushover).
test("watchdog does not report a locked vault — neither the first time nor repeatedly", () => {
  const a = decide(s("ok"), "locked");
  expect(a.notify).toBeNull();
  expect(decide(a.next, "locked").notify).toBeNull();
});

test("watchdog does not report the vault being unlocked", () => {
  const r = decide(s("ok"), "locked");
  expect(decide(r.next, "ok").notify).toBeNull();
});

test("nothing is sent from unlocked to unlocked", () => {
  expect(decide(s("ok"), "ok").notify).toBeNull();
});

// A devd restart takes a few seconds. If the watchdog reported an outage from the first
// failed request, every deploy would send a false alert.
test("unreachable devd is reported only from the second consecutive tick", () => {
  const first = decide(s("ok"), "down");
  expect(first.notify).toBeNull();
  expect(first.next.last).toBe("ok");        // the state does not flip yet
  expect(first.next.downTicks).toBe(1);

  const second = decide(first.next, "down");
  expect(second.notify?.title).toContain("devd");
  expect(second.next.last).toBe("down");
});

test("a one-off outage between two successful requests is not reported", () => {
  const blip = decide(s("ok"), "down");
  const back = decide(blip.next, "ok");
  expect(back.notify).toBeNull();            // never reported, nothing to retract
  expect(back.next.downTicks).toBe(0);
});

test("after a reported outage the recovery is reported", () => {
  const back = decide(s("down"), "ok");
  expect(back.notify).not.toBeNull();
  expect(back.next.last).toBe("ok");
});

// A deploy looks exactly like this: devd does not respond for a while and comes up with a locked
// vault. The watchdog reports only "devd is back up" — devd reports the lock itself.
test("from outage straight to a locked vault → devd is back up, nothing about the vault", () => {
  const r = decide(s("down"), "locked");
  expect(r.notify?.title).toBe("devd is back up");
  expect(r.notify?.message).not.toContain("vault");
  expect(r.next.last).toBe("ok");
});

test("first run after install: neither unlocked nor locked is reported", () => {
  expect(decide(INITIAL, "ok").notify).toBeNull();
  expect(decide(INITIAL, "locked").notify).toBeNull();
});

test("old \"locked\" state from the file is read as ok — the recovery is then not reported", () => {
  expect(normalizeLast("locked")).toBe("ok");
  expect(normalizeLast("down")).toBe("down");
  expect(normalizeLast("nonsense")).toBeNull();
});

// --- Kuma heartbeat (since 21 Aug 2026) ---
//
// Neither Pushover nor the listener can report an outage of OUTGOING connectivity — reporting
// outward is exactly what is broken then. So devd-watch also beats on a Kuma push
// monitor running outside Netcup: a missing heartbeat is an alarm in itself.
test("heartbeat: a healthy state beats as up", () => {
  expect(heartbeat("ok")).toEqual({ status: "up", msg: "devd ok, vault unlocked" });
});

test("heartbeat: a locked vault beats as down — sessions run, but half the features do not", () => {
  const h = heartbeat("locked");
  expect(h.status).toBe("down");
  expect(h.msg).toContain("vault");
});

test("heartbeat: unreachable devd beats as down immediately, without DOWN_AFTER", () => {
  // The notification waits for the second tick so a devd restart does not cause a false alert. The heartbeat
  // does not: Kuma handles the delay with its own "Retries" setting and the heartbeat must carry the TRUTH.
  expect(heartbeat("down").status).toBe("down");
});

test("heartbeatUrl appends status and message as query", () => {
  const u = heartbeatUrl("https://uptime.acme.example/api/push/AbC123", heartbeat("locked"));
  expect(u.startsWith("https://uptime.acme.example/api/push/AbC123?")).toBe(true);
  expect(u).toContain("status=down");
  expect(u).toContain("msg=");
});

test("heartbeatUrl does not break a URL that already has a query", () => {
  const u = heartbeatUrl("https://x/api/push/T?ping=1", heartbeat("ok"));
  expect(u).toContain("ping=1");
  expect(u).toContain("&status=up");
});
