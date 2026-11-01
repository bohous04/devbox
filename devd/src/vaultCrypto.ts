import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Blob format: MAGIC(8) | salt(16) | IV(12) | GCM tag(16) | ciphertext
// scrypt with N=2^17 needs 128*N*r = 128 MB of memory, hence maxmem 256 MB — without it
// node aborts the derivation at the default limit of 32 MB. The cost is intentional: guessing the phrase
// hurts, a single unlock from the dashboard takes under a second.
const MAGIC = Buffer.from("DEVDVLT1");
const N = 1 << 17, r = 8, p = 1, KEYLEN = 32;
const HEADER = MAGIC.length + 16 + 12 + 16;   // 52 B

export class VaultError extends Error {}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
}

export function sealVault(plaintext: string, passphrase: string): Buffer {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

/** Opens the vault and also returns the derived key with the salt, so it can be written back without keeping
 *  the passphrase. A new seal MUST use a fresh IV (sealWithKey generates it) —
 *  reusing a (key, IV) pair would be fatal with GCM. */
export function openVaultDetailed(blob: Buffer, passphrase: string): { plaintext: string; key: Buffer; salt: Buffer } {
  const { salt, key } = readHeader(blob, passphrase);
  return { plaintext: decrypt(blob, key), key, salt };
}

/** Seals again with an already derived key (same salt, new IV). */
export function sealWithKey(plaintext: string, key: Buffer, salt: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

function readHeader(blob: Buffer, passphrase: string): { salt: Buffer; key: Buffer } {
  if (blob.length < HEADER || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new VaultError("file is not a valid vault");
  }
  const salt = blob.subarray(8, 24);
  return { salt, key: deriveKey(passphrase, salt) };
}

function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(24, 36), tag = blob.subarray(36, 52);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  // GCM detects both a wrong key and a tampered byte — both fail only at final().
  try { return Buffer.concat([d.update(blob.subarray(HEADER)), d.final()]).toString("utf8"); }
  catch { throw new VaultError("wrong passphrase or corrupted vault"); }
}

export function openVault(blob: Buffer, passphrase: string): string {
  return decrypt(blob, readHeader(blob, passphrase).key);
}
