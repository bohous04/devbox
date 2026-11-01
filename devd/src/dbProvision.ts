import type { Engine } from "./prodDb";

// Composes the command for `tools/prod-db-provision.sh`. Devd DOES NOT RUN it ITSELF — the script
// needs admin SSH to the production server, which the devbox deliberately does not have (it has only
// forward-only tunnel keys that grant no shell). The user runs it from the mac, where
// that access already exists, and then confirms in the dashboard that it ran.
export interface ProvisionInput {
  /** SSH alias on the mac, typically `<project>-root-hardened`. */
  sshAlias: string;
  /** Name of the docker container with the database on the production server. */
  container: string;
  engine: Engine;
  db: string;
  roUser: string;
  hostPort: number;
  opItem: string;
  opVault?: string;
  /** Write role for human-approved proposals (`prod-db write`). Both fields, or neither —
   *  without an rw role the database stays read-only, which is the default state. */
  rwUser?: string;
  rwOpItem?: string;
  migrationUser?: string;
  migrationOpItem?: string;
}

/** Safe embedding into single quotes — an apostrophe in the value would otherwise escape
 *  and the user would copy a command that does something other than what they see. */
function q(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function provisionCommand(i: ProvisionInput): string {
  for (const [name, v] of Object.entries({
    sshAlias: i.sshAlias, container: i.container, engine: i.engine,
    db: i.db, roUser: i.roUser, opItem: i.opItem,
  })) {
    if (!String(v ?? "").trim()) throw new Error(`missing ${name}`);
  }
  if (!Number.isInteger(i.hostPort) || i.hostPort < 1024 || i.hostPort > 65535) {
    throw new Error(`host port ${i.hostPort} is outside the range 1024-65535`);
  }
  if (i.rwUser?.trim() && !i.rwOpItem?.trim()) {
    throw new Error("missing rwOpItem — the write role needs a 1P item where the script stores the password");
  }

  // `bash`, not `bun`: Bun shell supports neither the `${!v}` indirection nor the arrays the script
  // relies on (live: "Unexpected ')'"). The user would copy a command that cannot run.
  const parts = [
    "bash tools/prod-db-provision.sh",
    `--server ${q(i.sshAlias)}`,
    `--container ${q(i.container)}`,
    `--engine ${i.engine}`,
    `--db ${q(i.db)}`,
    `--ro-user ${q(i.roUser)}`,
    `--host-port ${i.hostPort}`,
    `--op-item ${q(i.opItem)}`,
  ];
  if (i.rwUser?.trim()) parts.push(`--rw-user ${q(i.rwUser)}`, `--rw-op-item ${q(i.rwOpItem!)}`);
  if (i.opVault?.trim()) parts.push(`--op-vault ${q(i.opVault)}`);
  return parts.join(" \\\n  ");
}
