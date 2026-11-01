// Notifications about a locked/unlocked vault — devd sends them itself via `notify()`,
// so in the app they arrive with the target "vault" (a tap opens the unlock). This used to be done by
// devd-watch directly via Pushover; the APNs channel, however, does not depend on the vault (see index.ts),
// so devd can also report its own locking.
//
// One "lock episode" = at most one notification about locking and one about unlocking.
// After startup we wait VAULT_LOCK_GRACE_MS: a deploy with a quick manual unlock should not
// make the phone ring needlessly. A manual lock (POST /api/vault/lock) is a deliberate step,
// it is reported immediately.
import type { NotifyFn } from "./agentEvents";

export const VAULT_LOCK_GRACE_MS = 30_000;

export interface VaultNotifierDeps {
  isLocked: () => boolean;
  notify: NotifyFn;
  /** Injected timers — tests run on fake clocks. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface VaultNotifier {
  /** After devd startup: a locked vault is reported if it stays locked even after the grace period. */
  start(): void;
  /** Z hooku onUnlock. */
  unlocked(): void;
  /** From the onLock hook (manual lock) — a new episode, reported immediately. */
  locked(): void;
}

export function createVaultNotifier(d: VaultNotifierDeps): VaultNotifier {
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  // Was a lock notification sent in this episode? Only then does reporting the unlock make sense.
  let notified = false;

  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const sendLocked = () => {
    if (notified) return;
    notified = true;
    d.notify("Vault is locked", "Unlock it in the Devbox app, otherwise SSH keys and secrets will not work.",
      { target: { kind: "vault" }, blocked: true, sound: true });
  };

  return {
    start() {
      if (!d.isLocked()) return;
      cancel();
      timer = setTimer(() => { timer = null; if (d.isLocked()) sendLocked(); }, VAULT_LOCK_GRACE_MS);
    },
    unlocked() {
      cancel();
      if (!notified) return;
      notified = false;
      d.notify("Vault unlocked", "Devbox is fully working again.", { target: { kind: "vault" } });
    },
    locked() {
      cancel();
      sendLocked();
    },
  };
}
