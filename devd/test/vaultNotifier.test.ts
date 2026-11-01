import { expect, test } from "bun:test";
import type { NotifyExtra } from "../src/agentEvents";
import { createVaultNotifier, VAULT_LOCK_GRACE_MS } from "../src/vaultNotifier";

// Fake clock: timers are only recorded and `advance` fires those whose time has elapsed.
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}

function harness(initiallyLocked: boolean) {
  let locked = initiallyLocked;
  const sent: { title: string; message: string; extra?: NotifyExtra }[] = [];
  const clock = fakeClock();
  const n = createVaultNotifier({
    isLocked: () => locked, notify: (title, message, extra) => { sent.push({ title, message, extra }); },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  return { n, sent, clock, setLocked: (v: boolean) => { locked = v; } };
}

const LOCKED = {
  title: "Vault is locked",
  message: "Unlock it in the Devbox app, otherwise SSH keys and secrets will not work.",
  extra: { target: { kind: "vault" }, blocked: true, sound: true } as NotifyExtra,
};
const UNLOCKED = { title: "Vault unlocked", message: "Devbox is fully working again.", extra: { target: { kind: "vault" } } as NotifyExtra };

test("locked after start and still locked after 30 s → one notification, nothing more", () => {
  const h = harness(true);
  h.n.start();
  h.clock.advance(VAULT_LOCK_GRACE_MS - 1);
  expect(h.sent).toEqual([]);
  h.clock.advance(1);
  expect(h.sent).toEqual([LOCKED]);
  h.clock.advance(10 * VAULT_LOCK_GRACE_MS);
  expect(h.sent).toHaveLength(1);
});

test("after a reported lock, the unlock is reported — once", () => {
  const h = harness(true);
  h.n.start();
  h.clock.advance(VAULT_LOCK_GRACE_MS);
  h.setLocked(false); h.n.unlocked();
  h.n.unlocked();
  expect(h.sent).toEqual([LOCKED, UNLOCKED]);
});

test("a quick unlock within 30 s → no notification, not even about the unlock", () => {
  const h = harness(true);
  h.n.start();
  h.clock.advance(5_000);
  h.setLocked(false); h.n.unlocked();
  h.clock.advance(VAULT_LOCK_GRACE_MS);
  expect(h.sent).toEqual([]);
  expect(h.clock.pending()).toBe(0);
});

test("unlocked after start → nothing is scheduled", () => {
  const h = harness(false);
  h.n.start();
  h.clock.advance(VAULT_LOCK_GRACE_MS);
  expect(h.sent).toEqual([]);
});

test("a manual lock is a new episode: notification right away, no waiting; the unlock is then reported", () => {
  const h = harness(false);
  h.n.start();
  h.setLocked(true); h.n.locked();
  expect(h.sent).toEqual([LOCKED]);
  h.n.locked(); // locking an already locked vault again reports nothing new
  expect(h.sent).toHaveLength(1);
  h.setLocked(false); h.n.unlocked();
  expect(h.sent).toEqual([LOCKED, UNLOCKED]);
});

test("a manual lock during the 30 s window after start cancels the timer and does not report twice", () => {
  const h = harness(true);
  h.n.start();
  h.n.locked();
  h.clock.advance(VAULT_LOCK_GRACE_MS);
  expect(h.sent).toEqual([LOCKED]);
});
