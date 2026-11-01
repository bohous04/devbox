import { expect, test } from "bun:test";
import { gateState, nextVaultStatus } from "./vaultView";

test("a locked vault shows a prompt instead of content", () => {
  expect(gateState({ locked: true }, "", false).show).toBe("prompt");
});

// While the first /api/vault request was running, the gate returned `null` and the dashboard was
// ENTIRELY empty — including the menu. On the tailnet that is ~190 ms of a white page, on a worse
// line much more, and the user reads it as "I clicked and nothing happens".
test("while the vault state is unknown, a skeleton is shown — not an empty page", () => {
  const s = gateState(null, "", false);
  expect(s.show).toBe("loading");
  expect(s.canSubmit).toBe(false);
});

test("an unlocked vault lets the content through", () => {
  expect(gateState({ locked: false }, "", false).show).toBe("content");
});

test("an empty passphrase cannot be submitted", () => {
  expect(gateState({ locked: true }, "", false).canSubmit).toBe(false);
  expect(gateState({ locked: true }, "phrase", false).canSubmit).toBe(true);
});

test("while unlocking, the button is disabled and changes its label", () => {
  const s = gateState({ locked: true }, "phrase", true);
  expect(s.canSubmit).toBe(false);
  expect(s.label).toBe("Unlocking…");
});

test("whitespace only does not count as a passphrase", () => {
  expect(gateState({ locked: true }, "   ", false).canSubmit).toBe(false);
});

// VaultGate used to ask for the vault state only once on mount, so an open tab
// after a devd restart (which ALWAYS locks the vault) kept showing a stale
// dashboard: cards kept redrawing via the poller, but everything touching
// credentials failed silently and it was visible nowhere. The gate now keeps polling —
// and these tests ensure a missing response does not flip the gate.
test("a fresh response overrides the previous state", () => {
  expect(nextVaultStatus({ locked: false }, { locked: true })).toEqual({ locked: true });
  expect(nextVaultStatus({ locked: true }, { locked: false })).toEqual({ locked: false });
});

test("first request failing = older devd without the route → the dashboard must not close", () => {
  expect(nextVaultStatus(null, null)).toEqual({ locked: false });
});

test("a later request failing keeps the known state, does not flip the gate", () => {
  // devd is restarting: a missing response is proof of neither locked nor unlocked.
  expect(nextVaultStatus({ locked: true }, null)).toEqual({ locked: true });
  expect(nextVaultStatus({ locked: false }, null)).toEqual({ locked: false });
});

test("while unlocking the state is not overwritten — an older response would bring the lock back", () => {
  expect(nextVaultStatus({ locked: true }, { locked: true }, true)).toEqual({ locked: true });
  expect(nextVaultStatus({ locked: false }, { locked: true }, true)).toEqual({ locked: false });
});
