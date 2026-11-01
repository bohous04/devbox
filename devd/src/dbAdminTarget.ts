import type { Database } from "bun:sqlite";
import type { ServerRef } from "./prodDb";

export interface DbAdminTarget { title: string; user: string }
const userName = /^[a-z_][a-z0-9_-]{0,30}$/;
const hostName = /^[A-Za-z0-9.:[\]-]+$/;
const normalizeHost = (value: string) => value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).toLowerCase() : value.toLowerCase();

/** A credential identity hint from the existing human-decided srv audit.
 * Activation proves only that the key was selected, not that SSH succeeded:
 * onboarding still verifies the exact catalog target, and Operations must approve
 * its fixed setup independently. No grant is read, extended, copied or activated.
 * A bare SSH alias cannot establish the remote user, so it is deliberately ignored. */
export function resolveDbAdminTarget(db: Database, name: string, server: ServerRef): DbAdminTarget | undefined {
  const hosts = new Set([normalizeHost(name.trim()), normalizeHost(server.host.trim())]);
  const rows = db.query(`SELECT DISTINCT title,target FROM ssh_approvals
    WHERE status='activated' AND decided_at IS NOT NULL AND decided_by IN ('mac','ios','dashboard')
      AND target IS NOT NULL`).all() as { title: string; target: string }[];
  const candidates = new Map<string, DbAdminTarget>();
  for (const row of rows) {
    const title = row.title.trim(); const target = row.target.trim();
    if (!title || /[\x00-\x1f\x7f]/.test(title) || title.startsWith("prod-tunnel-")) continue;
    const parts = target.split("@");
    if (parts.length !== 2 || !userName.test(parts[0]!) || !hostName.test(parts[1]!)) continue;
    if (!hosts.has(normalizeHost(parts[1]!))) continue;
    const candidate = { title, user: parts[0]! };
    candidates.set(JSON.stringify([candidate.title, candidate.user]), candidate);
    // Never select the most recent of several plausible administrator keys.
    if (candidates.size > 1) return undefined;
  }
  return candidates.values().next().value;
}
