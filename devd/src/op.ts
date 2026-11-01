// Host-side 1Password access. The service-account token lives ONLY here (devd, on the
// host) — never in a container. Containers ask devd for a specific SSH key through the
// /api/op routes; devd runs `op` with the token, whitelists to SSH-key items, and logs
// each access. So a compromised/prompt-injected agent can never exfiltrate the token or
// read passwords/API tokens — only pull the SSH keys it needs to do its work, on the record.

import { timeoutFor } from "./proc";
import { runOp } from "./opRateLimit";

export interface SshKeyRef { title: string; vault: string }
interface SshKeyFull extends SshKeyRef { id: string; vaultId: string }

async function opRun(token: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const ms = timeoutFor("NET_CLI");
  const r = await runOp(token, args, { timeoutMs: ms });
  // Only args[0] in the message: for `read`, args[1] is the full op:// reference (vaultId/itemId)
  // and for readSshKey this error is returned to the container as a 502 body (review finding) —
  // the rest of the module is otherwise careful about what crosses this boundary.
  if (r.timedOut) throw new Error(`op ${args[0]} timed out after ${Math.round(ms / 1000)} s`);
  return r;
}

/** Every SSH-key item the service account can see. This list is also the whitelist:
 *  readSshKey only serves a title that appears here. IDs are used for the op:// reference
 *  because titles/vaults can contain characters (spaces, '@') that break the reference. */
async function allSshKeys(token: string): Promise<SshKeyFull[]> {
  const r = await opRun(token, ["item", "list", "--categories", "SSH Key", "--format", "json"]);
  if (r.code !== 0) throw new Error(`op item list failed: ${r.stderr.trim() || "unknown error"}`);
  const items = JSON.parse(r.stdout) as { id: string; title: string; vault: { id: string; name: string } }[];
  return items.map((i) => ({ title: i.title, vault: i.vault.name, id: i.id, vaultId: i.vault.id }));
}

export async function listSshKeys(token: string): Promise<SshKeyRef[]> {
  return (await allSshKeys(token)).map(({ title, vault }) => ({ title, vault }));
}

/** Read one SSH private key in OpenSSH format — but only if `title` is genuinely an
 *  SSH-key item (whitelist), so this path can never leak a password/token/note. */
export async function readSshKey(token: string, title: string): Promise<string> {
  const match = (await allSshKeys(token)).find((k) => k.title === title);
  if (!match) throw new Error(`'${title}' is not an SSH key (or you have no access to it)`);
  const r = await opRun(token, ["read", `op://${match.vaultId}/${match.id}/private key?ssh-format=openssh`]);
  if (r.code !== 0 || !r.stdout.includes("PRIVATE KEY")) {
    throw new Error(`op read failed for '${title}': ${r.stderr.trim() || "empty key"}`);
  }
  return r.stdout;
}

/** Read the `password` field of a Password-category item — host-side only, for prod-db
 *  RO/RW DB credentials. Deliberately narrower use than readSshKey's whitelist: it is only
 *  ever called with opItem titles taken from the prod-db catalog (that catalog is the
 *  whitelist), gated by per-project entitlement. RW plaintext never reaches a container;
 *  RO is only ever returned as an assembled read-only URL to an entitled project. */
export async function readOpField(token: string, title: string, field = "password"): Promise<string> {
  // A service account MUST scope `op item get` to a vault ("a vault query must be provided",
  // live 2026-09-05) — but the catalog only knows the title. Hence the same path as for SSH keys:
  // find the item in the list and read via an op:// reference with both the vault and item id.
  const m = await findPasswordItem(token, title);
  const r = await opRun(token, ["read", `op://${m.vaultId}/${m.id}/${field}`]);
  const val = r.stdout.trim();
  if (r.code !== 0 || !val) throw new Error(`op read '${title}.${field}' failed: ${r.stderr.trim() || "empty"}`);
  return val;
}

/** A Password-category item by title — unambiguously, otherwise an error: two identically
 *  named items in different vaults would silently hand out the password to another database. */
async function findPasswordItem(token: string, title: string): Promise<{ id: string; vaultId: string }> {
  const r = await opRun(token, ["item", "list", "--categories", "Password", "--format", "json"]);
  if (r.code !== 0) throw new Error(`op item list failed: ${r.stderr.trim() || "unknown error"}`);
  const items = JSON.parse(r.stdout) as { id: string; title: string; vault: { id: string } }[];
  const matches = items.filter((i) => i.title === title);
  if (matches.length === 0) throw new Error(`'${title}' is not in 1Password (or the service account has no access to it)`);
  if (matches.length > 1) throw new Error(`'${title}' appears in 1Password more than once — the title must be unique`);
  return { id: matches[0]!.id, vaultId: matches[0]!.vault.id };
}
