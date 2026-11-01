import { expect, test } from "bun:test";
import { openVault, sealVault, VaultError } from "../src/vaultCrypto";

test("seal → open returns the original content", () => {
  const blob = sealVault('{"opToken":"abc"}', "correct phrase");
  expect(openVault(blob, "correct phrase")).toBe('{"opToken":"abc"}');
});

test("a wrong passphrase does not open it", () => {
  const blob = sealVault("secret", "correct phrase");
  expect(() => openVault(blob, "wrong")).toThrow(VaultError);
});

test("a corrupted blob does not open (GCM tag)", () => {
  const blob = sealVault("secret", "phrase");
  blob[blob.length - 1] ^= 0xff;
  expect(() => openVault(blob, "phrase")).toThrow(VaultError);
});

test("the same content gives a different blob each time (random salt and IV)", () => {
  expect(sealVault("x", "f").equals(sealVault("x", "f"))).toBe(false);
});
