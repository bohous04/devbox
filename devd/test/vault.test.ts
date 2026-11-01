import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sealVault } from "../src/vaultCrypto";
import { createVault, VaultLocked } from "../src/vault";

function vaultFile(content: object, pass: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "vault-")), "vault.age");
  writeFileSync(p, sealVault(JSON.stringify(content), pass));
  return p;
}

test("after start it is locked and secrets() throws VaultLocked", () => {
  const v = createVault(vaultFile({ opServiceAccountToken: "t" }, "phrase"));
  expect(v.isLocked()).toBe(true);
  expect(() => v.secrets()).toThrow(VaultLocked);
});

test("unlock with the correct phrase exposes the content", () => {
  const v = createVault(vaultFile({ opServiceAccountToken: "tok" }, "phrase"));
  v.unlock("phrase");
  expect(v.isLocked()).toBe(false);
  expect(v.secrets().opServiceAccountToken).toBe("tok");
});

test("a wrong phrase keeps it locked", () => {
  const v = createVault(vaultFile({}, "phrase"));
  expect(() => v.unlock("wrong")).toThrow();
  expect(v.isLocked()).toBe(true);
});

test("lock() forgets the content", () => {
  const v = createVault(vaultFile({ opServiceAccountToken: "t" }, "f"));
  v.unlock("f"); v.lock();
  expect(() => v.secrets()).toThrow(VaultLocked);
});

test("update writes back and a new instance reads it with the same phrase", () => {
  const path = vaultFile({ giteaTokens: { a: "1" } }, "f");
  const v = createVault(path);
  v.unlock("f");
  v.update((s) => { s.giteaTokens = { ...s.giteaTokens, b: "2" }; });

  const znovu = createVault(path);
  znovu.unlock("f");
  expect(znovu.secrets().giteaTokens).toEqual({ a: "1", b: "2" });
});

test("update on a locked vault throws VaultLocked and leaves the file alone", () => {
  const path = vaultFile({ giteaTokens: { a: "1" } }, "f");
  const v = createVault(path);
  expect(() => v.update((s) => { s.giteaTokens = {}; })).toThrow(VaultLocked);
  const znovu = createVault(path);
  znovu.unlock("f");
  expect(znovu.secrets().giteaTokens).toEqual({ a: "1" });
});

test("onUnlock gets the content, but is not called on a wrong phrase", () => {
  const videno: string[] = [];
  const path = vaultFile({ listenerToken: "tok" }, "f");
  const v = createVault(path, { onUnlock: (s) => videno.push(s.listenerToken ?? "") });
  expect(() => v.unlock("wrong")).toThrow();
  expect(videno).toEqual([]);
  v.unlock("f");
  expect(videno).toEqual(["tok"]);
});

test("onLock is called after lock() — devd uses it to report a manual lock", () => {
  let calls = 0;
  const v = createVault(vaultFile({}, "f"), { onLock: () => { calls++; } });
  v.unlock("f"); v.lock();
  expect(calls).toBe(1);
});
