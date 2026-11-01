// Reading lease history for the selection policy. Pure functions over rows (newest
// first, as leaseHistory returns them) — testable without a DB.

import type { AccountLeaseRow } from "./db";

/** The account the client runs on now. Empty history = the client has never got anything. */
export function currentAccount(history: AccountLeaseRow[]): string | null {
  return history[0]?.account_id ?? null;
}

/** When the client moved to the CURRENT account. Returns the time of the OLDEST lease in
 *  the uninterrupted run with the same account — not the time of the last lease, otherwise
 *  every session start would reset the cooldown and it would never kick in. `null` = the
 *  client has never switched. */
export function lastSwitchAt(history: AccountLeaseRow[]): number | null {
  const current = currentAccount(history);
  if (current === null) return null;
  let started: number | null = null;
  for (const l of history) {
    if (l.account_id !== current) return started;
    started = l.created_at;
  }
  return null;   // the whole known history is one account → never switched
}

/** Which account each devbox session is running on right now — input is typically
 *  `activeLeases()`. Mac leases (`session_id === null`, a shim on the mac without a matching
 *  devd session) cannot be filed under any key, so they are skipped — otherwise the first
 *  of them could easily clobber a real devbox entry or add an entry with the key `null`. */
export function accountsBySession(leases: AccountLeaseRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of leases) if (l.session_id !== null) m.set(l.session_id, l.account_id);
  return m;
}
