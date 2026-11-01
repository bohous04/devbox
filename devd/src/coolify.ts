import type { Catalog, Engine } from "./prodDb";

/** Host-only credentials; never include this object in an API response. */
export interface CoolifyInstance {
  name: string;
  url: string;
  token: string;
  headers: Record<string, string>;
}
type McpDef = { env?: Record<string, string> };
type Fetch = (req: Request) => Promise<Response>;
type Row = Record<string, any>;

export function coolifyInstancesFromMcp(mcp: Record<string, unknown>): Record<string, CoolifyInstance> {
  const out: Record<string, CoolifyInstance> = {};
  for (const [server, raw] of Object.entries(mcp ?? {})) {
    if (!server.endsWith("-coolify")) continue;
    const env = (raw as McpDef)?.env ?? {};
    const url = env.COOLIFY_BASE_URL?.trim(), token = env.COOLIFY_ACCESS_TOKEN?.trim();
    if (!url || !token) continue;
    const headers: Record<string, string> = {};
    if (env.COOLIFY_CF_ACCESS_CLIENT_ID && env.COOLIFY_CF_ACCESS_CLIENT_SECRET) {
      headers["CF-Access-Client-Id"] = env.COOLIFY_CF_ACCESS_CLIENT_ID.trim();
      headers["CF-Access-Client-Secret"] = env.COOLIFY_CF_ACCESS_CLIENT_SECRET.trim();
    }
    const name = server.replace(/-coolify$/, "").trim();
    out[name] = { name, url, token, headers };
  }
  return out;
}

const ENGINES: Record<string, Engine> = {
  "standalone-postgresql": "postgres", "standalone-mysql": "mysql", "standalone-mariadb": "mariadb",
};
const str = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export class CoolifyError extends Error {
  constructor(public code: string, public category: "configuration" | "connection" | "permission", message: string) { super(message); }
}

/** Errors deliberately omit raw response bodies/URLs: upstream payloads may carry credentials. */
export async function coolifyJson(inst: CoolifyInstance, path: string, doFetch: Fetch = (r) => fetch(r), init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(new Request(`${inst.url.replace(/\/+$/, "")}/api/v1${path}`, {
      ...init, signal: init?.signal ?? AbortSignal.timeout(15_000), redirect: "error",
      headers: { authorization: `Bearer ${inst.token}`, accept: "application/json", ...inst.headers, ...init?.headers },
    }));
  } catch {
    throw new CoolifyError("coolify_connection", "connection", `Coolify ${inst.name}: the connection failed or timed out.`);
  }
  if (!res.ok) throw new CoolifyError(res.status === 401 || res.status === 403 ? "coolify_permission" : "coolify_http", res.status === 401 || res.status === 403 ? "permission" : "connection", `Coolify ${inst.name} responded with ${res.status}.`);
  try { return await res.json(); }
  catch { throw new CoolifyError("coolify_invalid_response", "connection", `Coolify ${inst.name}: the response is not valid JSON.`); }
}

function rowsOf(value: unknown, label: string): Row[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Row).data) ? (value as Row).data : null;
  if (!rows || rows.some((r: unknown) => !r || typeof r !== "object" || Array.isArray(r))) throw new CoolifyError("coolify_invalid_response", "connection", `Coolify: unexpected format of ${label}.`);
  return rows;
}

/** Safe, explicit projection. Docker uses UUID, not the human-readable resource name. */
export interface CoolifyDatabase {
  container: string; uuid: string; name: string; engine: Engine; status: string;
  db?: string; environment?: string; environmentId?: number; server?: string; serverHost?: string; serverUuid?: string;
  /** UUID of the Coolify service that owns this database (one-click services). */
  service?: string;
}
function projectDatabase(r: Row): CoolifyDatabase | undefined {
  const engine = ENGINES[str(r.type) ?? str(r.database_type) ?? ""];
  const uuid = str(r.uuid), name = str(r.name);
  if (!engine) return undefined;
  if (!uuid || !ID.test(uuid) || !name) throw new CoolifyError("coolify_invalid_response", "configuration", "Coolify: the SQL database has no valid UUID or name.");
  const server = r.destination?.server ?? r.server;
  return {
    container: uuid, uuid, name, engine, status: str(r.status) ?? "unknown",
    ...(str(r.postgres_db ?? r.mysql_database ?? r.mariadb_database) ? { db: str(r.postgres_db ?? r.mysql_database ?? r.mariadb_database) } : {}),
    ...(str(r.environment?.name ?? r.environment_name) ? { environment: str(r.environment?.name ?? r.environment_name) } : {}),
    ...(typeof r.environment_id === "number" ? { environmentId: r.environment_id } : {}),
    ...(str(server?.name) ? { server: str(server.name) } : {}),
    ...(str(server?.ip ?? server?.host) ? { serverHost: str(server.ip ?? server.host) } : {}),
    ...(str(server?.uuid) ? { serverUuid: str(server.uuid) } : {}),
  };
}
export async function listCoolifyDatabases(inst: CoolifyInstance, doFetch: Fetch = (r) => fetch(r)): Promise<CoolifyDatabase[]> {
  return rowsOf(await coolifyJson(inst, "/databases", doFetch), "databases").flatMap((r) => {
    const db = projectDatabase(r); return db ? [db] : [];
  });
}

// One-click services (umami, plane…) keep their database inside the service, so
// /databases never lists it. The container name and DB name come from the parsed
// compose; the compose text itself is never stored or returned (it embeds secrets).
function serviceEngine(image: string | undefined): Engine | undefined {
  if (!image) return undefined;
  if (/(^|\/)(postgres|postgis|timescaledb)/i.test(image)) return "postgres";
  if (/(^|\/)mariadb/i.test(image)) return "mariadb";
  if (/(^|\/)mysql/i.test(image)) return "mysql";
  return undefined;
}
function composeBlock(compose: string, service: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}
function composeValue(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^\\s+-?\\s*['"]?${key}[:=]\\s*['"]?([^'"\\s]+)`, "m"));
  return m && !m[1]!.includes("$") ? m[1] : undefined;
}
const SERVICE_DB_KEYS: Record<Engine, string[]> = {
  postgres: ["POSTGRES_DB"], mysql: ["MYSQL_DATABASE"], mariadb: ["MARIADB_DATABASE", "MYSQL_DATABASE"],
};
export async function listCoolifyServiceDatabases(inst: CoolifyInstance, doFetch: Fetch = (r) => fetch(r)): Promise<CoolifyDatabase[]> {
  const services = rowsOf(await coolifyJson(inst, "/services", doFetch), "services");
  const found = await Promise.all(services.map(async (svc): Promise<CoolifyDatabase[]> => {
    const uuid = str(svc.uuid), serviceName = str(svc.name);
    if (!uuid || !ID.test(uuid) || !serviceName) return [];
    let detail: Row;
    try { detail = await coolifyJson(inst, `/services/${encodeURIComponent(uuid)}`, doFetch) as Row; } catch { return []; }
    if (!detail || typeof detail !== "object" || !Array.isArray(detail.databases)) return [];
    const compose = typeof detail.docker_compose === "string" ? detail.docker_compose : "";
    const server = detail.server ?? detail.destination?.server;
    const dbs = (detail.databases as Row[]).filter((d) => serviceEngine(str(d.image)));
    return dbs.flatMap((d): CoolifyDatabase[] => {
      const engine = serviceEngine(str(d.image))!, part = str(d.name), dbUuid = str(d.uuid);
      if (!part || !ID.test(part) || !dbUuid || !ID.test(dbUuid)) return [];
      const block = composeBlock(compose, part);
      const container = composeValue(block, "container_name") ?? `${part}-${uuid}`;
      if (!ID.test(container)) return [];
      const dbName = SERVICE_DB_KEYS[engine].map((k) => composeValue(block, k)).find(Boolean);
      return [{
        container, uuid: dbUuid, name: dbs.length === 1 ? serviceName : `${serviceName}-${part}`, engine,
        status: str(d.status) ?? str(detail.status) ?? "unknown", service: uuid,
        ...(dbName ? { db: dbName } : {}),
        ...(str(detail.environment?.name) ? { environment: str(detail.environment.name) } : {}),
        ...(typeof detail.environment_id === "number" ? { environmentId: detail.environment_id } : {}),
        ...(str(server?.name) ? { server: str(server.name) } : {}),
        ...(str(server?.ip ?? server?.host) ? { serverHost: str(server.ip ?? server.host) } : {}),
        ...(str(server?.uuid) ? { serverUuid: str(server.uuid) } : {}),
      }];
    });
  }));
  return found.flat();
}

export interface DatabaseTarget extends CoolifyDatabase {
  id: string; instance: string; server: string; verified: boolean; matched: boolean; application?: string; applicationName?: string;
}
export interface DiscoveryBlock {
  code: string; category: "configuration" | "connection" | "permission" | "decision"; message: string; action: string; instance?: string; candidateId?: string;
}
/** Once a target is selected, other instances/databases cannot block its setup. */
export function discoveryBlocksForTarget<T extends DiscoveryBlock>(blocks: T[], candidate?: { id: string; instance?: string }): T[] {
  if (!candidate) return blocks;
  return blocks.filter((b) => b.code !== "target_choice" &&
    (!b.candidateId || b.candidateId === candidate.id) &&
    (!b.instance || !candidate.instance || b.instance === candidate.instance));
}
function matchName(value: string | undefined, wanted: string): boolean {
  const norm = (v: string) => v.toLowerCase().trim().replace(/^apps[-/]/, "").replace(/[-_](db|database|postgres|postgresql|mysql|mariadb)$/, "").replace(/[_/]/g, "-");
  return !!value && norm(value) === norm(wanted);
}
function catalogServers(db: CoolifyDatabase, inst: CoolifyInstance, catalog: Catalog): string[] {
  const host = db.serverHost?.toLowerCase();
  const local = host && ["host.docker.internal", "localhost", "127.0.0.1", "::1"].includes(host);
  return Object.entries(catalog.servers).filter(([key, server]) =>
    host && server.host.trim().toLowerCase() === host ||
    !host && db.server && key.toLowerCase() === db.server.toLowerCase() ||
    local && key === inst.name,
  ).map(([key]) => key);
}

/** Match known catalog servers against observed Coolify destinations, never a project name. */
export async function discoverDatabaseTargets(opts: {
  catalog: Catalog; instances: Record<string, CoolifyInstance>; wanted: string; project?: string; applicationMappings?: Record<string, string>;
}, doFetch: Fetch = (r) => fetch(r)): Promise<{ candidates: DatabaseTarget[]; blocks: DiscoveryBlock[] }> {
  const candidates: DatabaseTarget[] = [], blocks: DiscoveryBlock[] = [];
  const wanted = opts.wanted.trim(), project = opts.project?.trim();
  if (!Object.keys(opts.instances).length) blocks.push({ code: "coolify_missing", category: "configuration", message: "No Coolify configuration is available.", action: "Unlock the vault or add a Coolify configuration." });
  await Promise.all(Object.values(opts.instances).map(async (inst) => {
    const fail = (error: unknown, candidateId?: string) => {
      const e = error instanceof CoolifyError ? error : new CoolifyError("coolify_connection", "connection", `Coolify ${inst.name}: target discovery failed.`);
      blocks.push({ code: e.code, category: e.category, message: e.message, action: e.category === "permission" ? "Check the Coolify token's read permission." : "Check the connection and the host's Coolify configuration.", instance: inst.name, ...(candidateId ? { candidateId } : {}) });
    };
    let databases: CoolifyDatabase[];
    try { databases = await listCoolifyDatabases(inst, doFetch); } catch (error) { fail(error); return; }
    // Service databases are an extra source: an older Coolify or a token without
    // service read access must not block the standalone databases above.
    try { databases.push(...await listCoolifyServiceDatabases(inst, doFetch)); } catch { /* ignore */ }
    let apps: Row[] = [];
    if (project) {
      try { apps = rowsOf(await coolifyJson(inst, "/applications", doFetch), "applications"); } catch (error) { fail(error); }
    }
    for (let db of databases) {
      const candidateId = `${inst.name}:${db.uuid}`;
      if (!db.service && (!db.db || !db.environment || !db.serverHost)) {
        try {
          const detail = await coolifyJson(inst, `/databases/${encodeURIComponent(db.uuid)}`, doFetch);
          if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw new CoolifyError("coolify_invalid_response", "connection", "Coolify: invalid database detail.");
          const enriched = projectDatabase(detail as Row);
          if (!enriched || enriched.uuid !== db.uuid) throw new CoolifyError("coolify_invalid_response", "connection", "Coolify: the detail does not match the database UUID.");
          db = { ...db, ...enriched };
        } catch (error) { fail(error, candidateId); }
      }
      const servers = catalogServers(db, inst, opts.catalog);
      const relevantApps = apps.filter((app) => typeof db.environmentId === "number" && app.environment_id === db.environmentId);
      const appMatches = relevantApps.filter((app) => matchName(str(app.name), wanted) || project && (
        str(app.uuid) === opts.applicationMappings?.[project] || matchName(str(app.name), project) || matchName(str(app.base_directory)?.replace(/^\//, ""), project)
      ));
      const application = appMatches.length === 1 ? str(appMatches[0].uuid) : undefined;
      const applicationName = application ? str(appMatches[0].name) : undefined;
      // Agents often cite the Coolify resource UUID verbatim; it identifies exactly one database.
      const matched = wanted === db.uuid || wanted === db.container || matchName(db.name, wanted) || matchName(db.db, wanted) || appMatches.length === 1 && relevantApps.length === 1;
      if (servers.length !== 1) blocks.push({ code: "server_mapping", category: "configuration", message: `${inst.name}: the server of database ${db.name} cannot be unambiguously matched to the catalog.`, action: "Select and verify the actual server in the advanced settings.", instance: inst.name, candidateId });
      candidates.push({ ...db, id: candidateId, instance: inst.name, server: servers.length === 1 ? servers[0]! : "", verified: servers.length === 1 && !!db.db && !!db.environment && db.status.startsWith("running"), matched, ...(application ? { application } : {}), ...(applicationName ? { applicationName } : {}) });
    }
  }));
  candidates.sort((a, b) => Number(b.matched) - Number(a.matched) || a.id.localeCompare(b.id));
  const matches = candidates.filter((c) => c.matched);
  if (matches.length > 1) blocks.push({ code: "target_choice", category: "decision", message: "More than one matching database was found.", action: "Select the database by name, server and environment." });
  return { candidates, blocks };
}
