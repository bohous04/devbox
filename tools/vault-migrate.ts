#!/usr/bin/env bun
// Wraps secrets.json into an encrypted vault.
//
// The passphrase is read from STDIN, not argv — on the host argv is visible to everyone in `ps`.
// The original secrets.json is DELIBERATELY not deleted: deleting it is a conscious manual step after
// you verify that devd starts with the vault and unlocks it.
//
// Usage:  printf 'my phrase\n' | bun tools/vault-migrate.ts --in /etc/devd/secrets.json --out /etc/devd/vault.age
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { sealVault } from "../devd/src/vaultCrypto";

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const inPath = arg("--in") ?? "/etc/devd/secrets.json";
const outPath = arg("--out") ?? "/etc/devd/vault.age";

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const passphrase = (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
if (!passphrase.trim()) fail("passphrase is empty — the vault would protect nothing");

let content: string;
try { content = readFileSync(inPath, "utf8"); }
catch (e) { fail(`cannot read ${inPath}: ${(e as Error).message}`); }

// Verify that we are sealing valid JSON. Invalid content would only surface on unlock,
// when the original might already be deleted.
try { JSON.parse(content!); }
catch (e) { fail(`${inPath} is not valid JSON: ${(e as Error).message}`); }

writeFileSync(outPath, sealVault(content!, passphrase), { mode: 0o600 });
chmodSync(outPath, 0o600);
console.log(`vault written to ${outPath} (0600); ${inPath} left untouched — delete it manually once verified`);
