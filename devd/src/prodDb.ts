import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type Engine = "postgres" | "mysql" | "mariadb";
/** `kind: "direct"` = a database reachable directly over TCP (without SSH and Docker), e.g. a native
 *  MariaDB on a game server. It has no tunnel account or key; its `user`/`key` are empty
 *  and onboarding reads the admin account from the 1Password item `adminOpItem`. Missing `kind` = SSH. */
export interface ServerRef { kind?: "ssh" | "direct"; host: string; port: number; user: string; key: string; adminKey?: string; adminUser?: string; adminOpItem?: string; opVault?: string }
export const isDirect = (s: ServerRef | undefined): boolean => s?.kind === "direct";
export interface DbEntry {
  name: string;
  server: string;
  container?: string;
  engine: Engine;
  hostPort: number;
  db: string;
  roUser: string;
  opItem: string;
  rwUser?: string;
  rwOpItem?: string;
  migrationUser?: string;
  migrationOpItem?: string;
  tunnelUser?: string;
  tunnelKey?: string;
}
export function effectiveServer(entry: DbEntry, server: ServerRef): ServerRef {
  return { ...server, user: entry.tunnelUser ?? server.user, key: entry.tunnelKey ?? server.key };
}
export interface Catalog { servers: Record<string, ServerRef>; databases: DbEntry[] }

export function loadCatalog(path: string): Catalog {
  return JSON.parse(readFileSync(path, "utf8")) as Catalog;
}

export function dbEntry(cat: Catalog, name: string): DbEntry | undefined {
  return cat.databases.find((d) => d.name === name.trim());
}

export function roUrl(e: DbEntry, password: string): string {
  const auth = `${e.roUser}:${password}@127.0.0.1:${e.hostPort}/${e.db}`;
  return e.engine === "postgres" ? `postgresql://${auth}?sslmode=disable` : `mysql://${auth}`;
}

export type Mode = "read" | "write";
export interface Access { read?: string[]; write?: string[] }

export function entitledDbs(access: Record<string, Access>, project: string, mode: Mode = "read"): string[] {
  return access[project]?.[mode] ?? [];
}

/** Adds a claim to the map (in place). Returns true when something changed — a second call
 *  with the same claim is a no-op, so a repeated approval does not duplicate the list. */
export function addGrant(access: Record<string, Access>, project: string, name: string, mode: Mode): boolean {
  const acc = (access[project] ??= {});
  const list = (acc[mode] ??= []);
  if (list.includes(name)) return false;
  list.push(name);
  return true;
}

/** Union of claims from several sources (repo `prodDbAccess.json` + the host-side overlay that
 *  devd fills in when approving requests). Overwrites nothing: a claim given in one source
 *  does not disappear because the other does not know it. Leaves the inputs untouched. */
export function mergeAccess(...sources: Record<string, Access>[]): Record<string, Access> {
  const out: Record<string, Access> = {};
  for (const src of sources) {
    for (const [project, acc] of Object.entries(src)) {
      for (const mode of ["read", "write"] as const) for (const name of acc[mode] ?? []) addGrant(out, project, name, mode);
    }
  }
  return out;
}

/** Host-side claims overlay. A missing file = nobody has approved anything yet, not an error. */
export function readAccessFile(path: string): Record<string, Access> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, Access>;
}

/** Writes the requesting project's claim into the overlay file (next to the catalog): reading always,
 *  writing only on demand. At startup devd merges it with the repo default (mergeAccess),
 *  so a restart does not lose an approved claim. */
export function grantAccess(path: string, project: string, name: string, write: boolean): void {
  const acc = readAccessFile(path);
  addGrant(acc, project, name, "read");
  if (write) addGrant(acc, project, name, "write");
  writeFileSync(path, JSON.stringify(acc, null, 2) + "\n");
}

/** Reloads the in-memory catalog from disk and KEEPS the reference — the same object is held by api.ts,
 *  SessionManager and dbTargets, so a newly approved database is visible everywhere immediately, without
 *  a devd restart (a restart also locks the vault). */
export function reloadCatalog(cat: Catalog, path: string): void {
  Object.assign(cat, loadCatalog(path));
}

/** Forward-only SSH keys (per VPS) that the given project needs — the union of servers of
 *  all DBs it has a read OR write claim on. devd injects them into the container from 1P. */
export function keysForProject(cat: Catalog, access: Record<string, Access>, project: string): string[] {
  const names = new Set([...entitledDbs(access, project, "read"), ...entitledDbs(access, project, "write")]);
  const keys = new Set<string>();
  // A direct server has no SSH key — the session reaches it only through the proxy in devd.
  for (const d of cat.databases) if (names.has(d.name) && !isDirect(cat.servers[d.server])) keys.add(cat.servers[d.server].key);
  return [...keys];
}

/** Read-only bind mounts of forward-only keys for a project: `<hostPath>:/home/dev/.ssh/<key>:ro`.
 *  `keyPath` materializes the key from 1P on the host (owner 1000, so the container user can read it). */
export async function prodKeyMounts(cat: Catalog, access: Record<string, Access>, project: string, keyPath: (key: string) => string | Promise<string>): Promise<string[]> {
  return Promise.all(keysForProject(cat, access, project).map(async (k) => `${await keyPath(k)}:/home/dev/.ssh/${k}:ro`));
}

/** Adds a database to the catalog on disk. The checks here are deliberately strict: the catalog is
 *  the only truth about where the tunnel may go and whose password is read, so a silent overwrite or two
 *  databases on one port would only show up as a connection to the wrong database. */
export function addDatabase(path: string, entry: DbEntry): void {
  const cat = loadCatalog(path);
  if (!cat.servers[entry.server]) {
    throw new Error(`unknown server '${entry.server}' — add it to the catalog first`);
  }
  if (cat.databases.some((d) => d.name === entry.name)) {
    throw new Error(`database '${entry.name}' is already in the catalog`);
  }
  const clash = cat.databases.find((d) => d.hostPort === entry.hostPort);
  if (clash) {
    throw new Error(`port ${entry.hostPort} on server ${entry.server} is already used by '${clash.name}'`);
  }
  cat.databases.push(entry);
  writeFileSync(path, JSON.stringify(cat, null, 2) + "\n");
}

/** Compare with both the reviewed prior entry and the intended result. This makes
 * a crash after catalog persistence recoverable without overwriting another edit. */
export function saveVerifiedDatabase(path: string, entry: DbEntry, previous: DbEntry | null): void {
  const cat = loadCatalog(path), existing = dbEntry(cat, entry.name);
  if (JSON.stringify(existing ?? null) === JSON.stringify(entry)) return;
  if (JSON.stringify(existing ?? null) !== JSON.stringify(previous)) throw new Error("Catalog changed after approval");
  if (cat.databases.some((e) => e.name !== entry.name && e.hostPort === entry.hostPort)) throw new Error("Catalog port conflict");
  cat.databases = [...cat.databases.filter((e) => e.name !== entry.name), entry];
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(cat, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
