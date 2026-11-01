import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { Secrets } from "./config";
import { openVaultDetailed, sealWithKey } from "./vaultCrypto";

// The vault contents live ONLY in process memory. The unpacked state is never written to disk
// and at most key names may go into the log, never values.
//
// After unlocking we keep the derived key, not the passphrase — that is enough for writes (the dashboard saves a new
// gitea token) and the phrase is not lying around anywhere.
export class VaultLocked extends Error {
  constructor() { super("vault is locked — unlock it in the dashboard"); }
}

export interface Vault {
  isLocked(): boolean;
  unlock(passphrase: string): void;
  lock(): void;
  secrets(): Secrets;
  /** Changes the contents and seals it back to disk. Throws VaultLocked when locked. */
  update(mutate: (s: Secrets) => void): void;
}

export interface VaultOptions {
  /** Called after a successful unlock — devd uses it to re-hydrate its dependencies on secrets. */
  onUnlock?: (s: Secrets) => void;
  /** Called after locking (POST /api/vault/lock) — devd uses it to announce a new lock episode. */
  onLock?: () => void;
}

export function createVault(path: string, opts: VaultOptions = {}): Vault {
  let open: Secrets | null = null;
  let key: Buffer | null = null;
  let salt: Buffer | null = null;

  const self: Vault = {
    isLocked: () => open === null,
    unlock(passphrase) {
      const d = openVaultDetailed(readFileSync(path), passphrase);
      open = JSON.parse(d.plaintext) as Secrets;
      key = d.key; salt = d.salt;
      // The hook only after successful unpacking — with a wrong phrase nothing may be hydrated.
      opts.onUnlock?.(open);
    },
    lock() { open = null; key = null; salt = null; opts.onLock?.(); },
    secrets() { if (!open) throw new VaultLocked(); return open; },
    update(mutate) {
      if (!open || !key || !salt) throw new VaultLocked();
      mutate(open);
      writeFileSync(path, sealWithKey(JSON.stringify(open, null, 2) + "\n", key, salt), { mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
  return self;
}
