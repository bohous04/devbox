// Vault gate logic, separate from the component — the dashboard has no component tests,
// the pure function is tested instead (same as hardwareView, accountsView and co.).
export interface VaultStatus { locked: boolean }

export interface GateState {
  /** `loading` = the first request to /api/vault is still running. Previously NOTHING
   *  was rendered at that point (not even the menu) and the dashboard looked stuck; now a
   *  skeleton is shown instead. The unlock prompt still must not flash on an unlocked devd,
   *  which is why this is its own state, not "prompt". */
  show: "content" | "prompt" | "loading";
  canSubmit: boolean;
  label: string;
}

export function gateState(status: VaultStatus | null, pass: string, busy: boolean): GateState {
  if (!status) return { show: "loading", canSubmit: false, label: "Unlock" };
  return {
    show: status.locked ? "prompt" : "content",
    // trim: only spaces is not a passphrase, but the untrimmed value is sent —
    // a space inside or at the edge of the phrase is a legitimate character.
    canSubmit: status.locked && pass.trim().length > 0 && !busy,
    label: busy ? "Unlocking…" : "Unlock",
  };
}

/** How often the gate asks for the vault state. Same cadence as the rest of the dashboard
 *  (store.tsx), so a lock after a devd restart shows up within a few seconds. */
export const VAULT_POLL_MS = 5000;

/** State to render after the next request. `poll === null` = the request failed.
 *
 *  A missing response is NOT proof of either locked or unlocked: devd restarts routinely
 *  (deploy, upgrade) and does not answer at all at that moment. Flipping to either side would
 *  either close a working dashboard, or conversely hide that the vault is locked —
 *  exactly that hiding was why an open tab looked alive while
 *  the clipboard, notifications and prod-db behind it silently did not work.
 *
 *  The exception is the very first request (`prev === null`): an older devd does not know the
 *  `/api/vault` route at all, and there a failure must be read as "no vault" — otherwise the gate would
 *  permanently close a dashboard that needs no unlocking. */
export function nextVaultStatus(
  prev: VaultStatus | null, poll: VaultStatus | null, busy = false,
): VaultStatus | null {
  // An unlock is in progress: a response sent before it would overwrite the fresh unlock
  // back to locked and the user would have to enter the phrase a second time.
  if (busy) return prev;
  if (poll) return poll;
  return prev ?? { locked: false };
}
