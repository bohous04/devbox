import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config";
import type { ConfigRepo } from "../../src/configrepo";
import { openDb } from "../../src/db";
import type { ApiDeps } from "../../src/api";
import { CloneQueue } from "../../src/clone";
import { SessionManager } from "../../src/sessions";
import { AgentEventHub } from "../../src/agentEvents";
import { VaultLocked, type Vault } from "../../src/vault";
import type { Secrets } from "../../src/config";

/** Minimal ApiDeps for route tests that do not work with sessions. The shape is copied
 *  from `app()` in api.test.ts — that one stays where it is so existing tests do not move. */
export function fakeDeps(extra: Partial<ApiDeps> = {}): ApiDeps {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-vault-"));
  const dashboardDir = mkdtempSync(join(tmpdir(), "devd-vault-dash-"));
  writeFileSync(join(dashboardDir, "index.html"), "HELLO");
  return {
    db, root, dashboardDir,
    cfg: DEFAULT_CONFIG,
    mgr: new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] }),
    tree: async () => [],
    listener: {
      open: async () => {}, notify: () => {},
      clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }),
      openUrl: async () => {},
      proxyBridge: async () => {},
      dbRequest: async () => {}, sshApproval: async () => {},
    },
    notify: () => {},
    stats: () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } }),
    cloneQueue: new CloneQueue({ db, root, tree: async () => [] }),
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} } as ConfigRepo,
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    agentEvents: new AgentEventHub({ db, notify: () => {}, quietMs: 0, coalesceMs: 0 }),
    scheduler: { fireNow: async () => true },
    // The default address is loopback so existing route tests behind approvalGate (see
    // api.ts) do not fail with 403 just because they did not set a network address —
    // tests that want to verify the gate itself override `remoteAddr`.
    remoteAddr: () => "127.0.0.1",
    // Creating a share touches docker (container id, stopping dind) — a stub in tests.
    shareLockdown: { containerId: async (container: string) => `cid-${container}`, stopDind: async () => {} },
    ...extra,
  } as ApiDeps;
}

/** Vault for tests: `passphrase` is the only one that unlocks it. */
export function fakeVault({ locked = true, passphrase = "phrase", secrets = {} as Secrets } = {}): Vault {
  let open = !locked;
  return {
    isLocked: () => !open,
    unlock(p: string) { if (p !== passphrase) throw new Error("wrong passphrase"); open = true; },
    lock() { open = false; },
    secrets() { if (!open) throw new VaultLocked(); return secrets; },
    update(mutate) { if (!open) throw new VaultLocked(); mutate(secrets); },
  };
}
