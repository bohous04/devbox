import { expect, test } from "bun:test";
import { startDbProxy } from "../src/dbProxy";
import { createDbTargets } from "../src/dbTargets";
import type { DbEntry } from "../src/prodDb";
import { VaultLocked, type Vault } from "../src/vault";

const entry = { name: "shop", server: "s1", engine: "postgres", hostPort: 15501, db: "shop", roUser: "shop_ro", opItem: "shop pw" } as DbEntry;
const openVault = { isLocked: () => false, unlock: () => {}, lock: () => {}, secrets: () => ({}), update: () => {} } as Vault;
const lockedVault = { ...openVault, isLocked: () => true, secrets: () => { throw new VaultLocked(); } } as Vault;

function startupPacket(user: string): Buffer {
  const body = ["user", user, "database", "shop"].join("\0") + "\0\0";
  const len = 8 + Buffer.byteLength(body);
  const b = Buffer.alloc(len);
  b.writeInt32BE(len, 0); b.writeInt32BE(196608, 4); b.write(body, 8, "utf8");
  return b;
}

/** Sends a startup message and returns "closed" if the proxy closes the connection within 2 s, otherwise "open". */
async function tryConnect(port: number, user: string): Promise<"closed" | "open"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("open"), 2000);
    Bun.connect({
      hostname: "127.0.0.1", port,
      socket: {
        open(s) { s.write(startupPacket(user)); },
        close() { clearTimeout(timer); resolve("closed"); },
        data() {},
        error() { clearTimeout(timer); resolve("closed"); },
      },
    }).catch(() => { clearTimeout(timer); resolve("closed"); });
  });
}

const upstream = () => ({ write: () => {}, end: () => {} });

test("an unknown placeholder closes the connection and never reaches the target", async () => {
  let connected = 0;
  const p = await startDbProxy({
    port: 0, hostname: "127.0.0.1", targets: createDbTargets({ entries: () => [entry] }),
    vault: openVault, readSecret: () => "SKUTECNE",
    connect: async () => { connected++; return upstream(); },
  });
  expect(await tryConnect(p.port, "cizi_uzivatel")).toBe("closed");
  expect(connected).toBe(0);
  p.stop();
});

test("a locked vault closes the connection and never reaches the target", async () => {
  const targets = createDbTargets({ entries: () => [entry] });
  const cred = targets.issue("dev-a-b", "shop");
  let connected = 0;
  const p = await startDbProxy({
    port: 0, hostname: "127.0.0.1", targets, vault: lockedVault, readSecret: () => "SKUTECNE",
    connect: async () => { connected++; return upstream(); },
  });
  expect(await tryConnect(p.port, cred.user)).toBe("closed");
  expect(connected).toBe(0);
  p.stop();
});

test("a valid placeholder connects with the REAL credentials", async () => {
  const targets = createDbTargets({ entries: () => [entry] });
  const cred = targets.issue("dev-a-b", "shop");
  let seenPassword = "", seenUser = "";
  const p = await startDbProxy({
    port: 0, hostname: "127.0.0.1", targets, vault: openVault, readSecret: () => "SKUTECNE",
    connect: async (t, password) => { seenPassword = password; seenUser = t.entry.roUser; return upstream(); },
  });
  await tryConnect(p.port, cred.user);
  await Bun.sleep(150);
  expect(seenPassword).toBe("SKUTECNE");
  expect(seenUser).toBe("shop_ro");
  p.stop();
});

test("a failed password read closes the connection instead of letting it through", async () => {
  const targets = createDbTargets({ entries: () => [entry] });
  const cred = targets.issue("dev-a-b", "shop");
  let connected = 0;
  const p = await startDbProxy({
    port: 0, hostname: "127.0.0.1", targets, vault: openVault,
    readSecret: () => { throw new Error("1P unavailable"); },
    connect: async () => { connected++; return upstream(); },
  });
  expect(await tryConnect(p.port, cred.user)).toBe("closed");
  expect(connected).toBe(0);
  p.stop();
});

test("the target's response is relayed back to the client", async () => {
  const targets = createDbTargets({ entries: () => [entry] });
  const cred = targets.issue("dev-a-b", "shop");
  let odpoved: Uint8Array | null = null;
  const p = await startDbProxy({
    port: 0, hostname: "127.0.0.1", targets, vault: openVault, readSecret: () => "SKUTECNE",
    connect: async (_t, _pw, onData) => { onData(new Uint8Array([82, 0, 0, 0, 8])); return upstream(); },
  });
  await new Promise<void>((resolve) => {
    Bun.connect({
      hostname: "127.0.0.1", port: p.port,
      socket: {
        open(s) { s.write(startupPacket(cred.user)); },
        data(_s, chunk) { odpoved = chunk; resolve(); },
        close() { resolve(); }, error() { resolve(); },
      },
    }).catch(() => resolve());
  });
  expect(odpoved).not.toBeNull();
  p.stop();
});

test("the audit records the session and the database, not the password", async () => {
  const targets = createDbTargets({ entries: () => [entry] });
  const cred = targets.issue("dev-a-b", "shop");
  const seen: { session: string; db: string }[] = [];
  const p = await startDbProxy({
    port: 0, hostname: "127.0.0.1", targets, vault: openVault, readSecret: () => "SKUTECNE",
    connect: async () => upstream(), audit: (e) => seen.push(e),
  });
  await tryConnect(p.port, cred.user);
  await Bun.sleep(150);
  expect(seen).toEqual([{ session: "dev-a-b", db: "shop" }]);
  expect(JSON.stringify(seen)).not.toContain("SKUTECNE");
  p.stop();
});
