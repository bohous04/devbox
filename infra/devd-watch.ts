#!/usr/bin/env bun
// devd-watch — watches from the outside that devd is alive and sends a Pushover notification about it.
//
// Why this is NOT part of devd: it has to speak up even when devd is not running at all.
// The Pushover credentials live in the vault, so the watchdog has its own copy in
// /etc/devd/watch.env (root-only, outside the vault) and calls the Pushover API directly.
//
// Since 2026-10 it does NOT report a locked/unlocked vault — devd does that itself through the app
// (devd/src/vaultNotifier.ts; the APNs channel does not depend on the vault and a tap goes straight
// to unlocking). The vault state is still checked here for the Kuma heartbeat (heartbeat()).
//
// Run by a systemd timer (infra/devd-watch.timer); it keeps state in a file
// so that only CHANGES are reported, not every tick.

export type Health = "ok" | "locked" | "down";
export interface WatchState {
  /** Last REPORTED state — not the last observed one. A locked vault is
   *  not reported, hence only ok/down. */
  last: "ok" | "down";
  /** How many consecutive ticks devd has been unreachable. A restart takes a few seconds and reporting
   *  an outage from the first failed request would mean a false alert on every
   *  deploy. */
  downTicks: number;
}

export const INITIAL: WatchState = { last: "ok", downTicks: 0 };

/** How many consecutive ticks devd must be unreachable before it is reported. */
const DOWN_AFTER = 2;

export interface Decision { next: WatchState; notify: { title: string; message: string } | null }

export function decide(prev: WatchState, probe: Health): Decision {
  if (probe === "down") {
    const downTicks = prev.downTicks + 1;
    if (downTicks < DOWN_AFTER || prev.last === "down") {
      return { next: { last: prev.last, downTicks }, notify: null };
    }
    return {
      next: { last: "down", downTicks },
      notify: { title: "devd is not responding", message: "The dashboard and session management are down. Check `systemctl status devd`." },
    };
  }

  // "locked" = devd responds; devd reports the vault itself (see the file header).
  if (prev.last === "ok") return { next: INITIAL, notify: null };
  return { next: INITIAL, notify: { title: "devd is back up", message: "devd is responding." } };
}

/** `last` from the state file. An older version also stored "locked" — that was
 *  reported as a locked vault, not as an outage, so it is read as "ok" (the recovery
 *  would otherwise send a false "devd is back up"). Anything else → null = clean start. */
export function normalizeLast(v: unknown): WatchState["last"] | null {
  if (v === "ok" || v === "locked") return "ok";
  if (v === "down") return "down";
  return null;
}

// ---- Kuma heartbeat ----
//
// Why Pushover is not enough: the watchdog reports outward, but on 21 Aug 2026 it was precisely
// "outward" that was broken (Netcup, loss of outgoing UDP/ICMP/TCP for ten minutes). An alert about an outage of outgoing
// connectivity by definition cannot be sent over outgoing connectivity. The fix is reversing
// the direction: the devbox pings a push monitor in Kuma, which runs OUTSIDE Netcup, and when the heartbeat
// stops arriving, Kuma raises the alarm. It catches not just the network — also a dead machine or a broken timer.
//
// The heartbeat also carries the state (`status`), so one monitor covers both "machine/network alive" and
// "devd running and vault unlocked".
export interface Heartbeat { status: "up" | "down"; msg: string }

export function heartbeat(health: Health): Heartbeat {
  if (health === "ok") return { status: "up", msg: "devd ok, vault unlocked" };
  if (health === "locked") return { status: "down", msg: "vault is locked — clipboard, notifications and monitoring are not working" };
  return { status: "down", msg: "devd is not responding" };
}

/** Kuma push URL with the state appended. `URL` on purpose, not for nicer code, but
 *  because it correctly assembles the query even for a URL that already has one. */
export function heartbeatUrl(pushUrl: string, hb: Heartbeat): string {
  const u = new URL(pushUrl);
  u.searchParams.set("status", hb.status);
  u.searchParams.set("msg", hb.msg);
  return u.toString();
}

// ---- runner (run by systemd; nothing of this happens when imported from a test) ----

const STATE_PATH = process.env.DEVD_WATCH_STATE ?? "/var/lib/devd/devd-watch.state";
const DEVD_URL = process.env.DEVD_URL ?? "http://127.0.0.1:4300";
const PROBE_TIMEOUT_MS = 5000;

async function probe(): Promise<Health> {
  try {
    const r = await fetch(`${DEVD_URL}/api/vault`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return "down";
    return ((await r.json()) as { locked: boolean }).locked ? "locked" : "ok";
  } catch {
    return "down";
  }
}

async function readState(): Promise<WatchState> {
  try {
    const p = JSON.parse(await Bun.file(STATE_PATH).text()) as { last?: unknown; downTicks?: unknown };
    // Unknown content (manual edit, older format) is read as a clean start —
    // better one extra notification than a silent watchdog.
    const last = normalizeLast(p.last);
    if (!last) return INITIAL;
    return { last, downTicks: typeof p.downTicks === "number" ? p.downTicks : 0 };
  } catch {
    return INITIAL;
  }
}

async function push(title: string, message: string): Promise<void> {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) throw new Error("PUSHOVER_TOKEN/PUSHOVER_USER missing (see /etc/devd/watch.env)");
  const body = new URLSearchParams({ token, user, title, message, priority: "0" });
  const r = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", body, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Pushover rejected: ${r.status} ${await r.text()}`);
}

/** Heartbeat to the Kuma push monitor. NEVER throws: an unsent heartbeat IS the alarm (Kuma
 *  flags it itself), and it must not abort the run before Pushover is tried. Without
 *  `KUMA_PUSH_URL` it is a no-op, so the watchdog works even before the monitor is set up. */
async function beat(health: Health): Promise<void> {
  const url = process.env.KUMA_PUSH_URL;
  if (!url) return;
  try {
    const r = await fetch(heartbeatUrl(url, heartbeat(health)), { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) console.error(`Kuma heartbeat: HTTP ${r.status}`);
  } catch (e) {
    console.error(`Kuma heartbeat not sent: ${(e as Error).message}`);
  }
}

if (import.meta.main) {
  const state = await readState();
  const health = await probe();
  // Heartbeat BEFORE Pushover: `push()` throws on an outgoing network outage and ends the run,
  // and the heartbeat is the only thing that can signal such an outage.
  await beat(health);
  const { next, notify } = decide(state, health);
  if (notify) {
    // State is saved only after a SUCCESSFUL send. If it were written earlier, a failed
    // notification would never be retried and the watchdog would stay silent about a problem
    // it believes it has reported.
    await push(notify.title, notify.message);
    console.log(`${health}: reported "${notify.title}"`);
  }
  await Bun.write(STATE_PATH, JSON.stringify(next));
}
