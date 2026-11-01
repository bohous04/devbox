import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { ProvisionInput } from "./dbProvision";
import { getDbRequest, listDbRequests, setDbRequestStatus, type DbRequestRow, type DbRequestScope } from "./dbRequests";
import { saveVerifiedDatabase, loadCatalog, addGrant, dbEntry, effectiveServer, grantAccess, isDirect, reloadCatalog, type Access, type Catalog, type DbEntry, type ServerRef } from "./prodDb";
import { getOperation, proposeOperation, setOperationStatus } from "./operationStore";
import { logEvent } from "./db";
import { createSerial } from "./sshAgent";
import { discoveryBlocksForTarget, type DiscoveryBlock } from "./coolify";

export interface Block extends DiscoveryBlock {}
export interface Candidate { id: string; instance?: string; server: string; container: string; engine: DbEntry["engine"]; name: string; db?: string; environment?: string; application?: string; applicationName?: string; verified?: boolean; matched?: boolean }
export interface OnboardingPlan {
  requestId: number; entry: DbEntry; input: ProvisionInput; server: ServerRef; trustedServer: ServerRef;
  requestedScope?: DbRequestScope;
  previousEntry?: DbEntry | null; write: boolean; migrations: boolean; changes: string[]; fingerprint: string;
}
export interface OnboardingHost {
  preflight(plan: OnboardingPlan): Promise<Block[]>;
  execute(plan: OnboardingPlan, onProgress: (step: string) => void): Promise<void>;
  verify(plan: OnboardingPlan): Promise<void>;
}
export type OnboardingState = "pending" | "blocked" | "awaiting_approval" | "executing" | "verifying" | "ready" | "rejected" | "failed";
export interface RequestView extends DbRequestRow { state: OnboardingState; operationId: number | null; plan: OnboardingPlan | null; blocks: Block[]; step: string | null; nextAction: string }
interface Stored { request_id: number; state: OnboardingState; plan: string | null; blocks: string; operation_id: number | null; step: string | null; updated_at: number }
export interface OnboardingDeps {
  db: Database; catalog?: Catalog; catalogPath?: string; access?: Record<string, Access>; accessPath?: string;
  host?: OnboardingHost; proxyReady: (engine?: string) => boolean;
  discover: (row: DbRequestRow) => Promise<{ candidates: Candidate[]; blocks: Block[] }>;
  portFree?: (port: number) => Promise<boolean>;
  notify?: (title: string, message: string) => void;
  /** Run verified host setup without a second human click. Exact SQL still uses its own approval queue. */
  autoApprove?: boolean;
}
const block = (code: string, message: string, action: string, category: Block["category"] = "configuration"): Block => ({ code, message, action, category });
const ident = /^[a-z_][a-z0-9_]{0,62}$/;
const token = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const trim = (v: unknown): string => typeof v === "string" ? v.trim() : "";
export const freeLocalPort = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = createServer();
  s.once("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});
const hash = (plan: Omit<OnboardingPlan, "fingerprint">) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

/** Transient host outages can heal without intervention. Configuration, permission
 * and selection blocks need a manual prepare/resume, not recurring 1Password calls. */
export const BLOCKED_RECHECK_INTERVAL_MS = 15 * 60_000;
function automaticRecheckDue(row: Stored, now: number): boolean {
  let blocks: unknown;
  try { blocks = JSON.parse(row.blocks); } catch { return false; }
  if (!Array.isArray(blocks)) return false;
  if (blocks.some((b) => !b || typeof b !== "object" || b.category !== "connection" || b.code === "unsupported_engine")) return false;
  // Resume an interrupted, already approved worker once. Its next preflight saves
  // any actual block and starts the normal persistent cooldown.
  if (!blocks.length && row.operation_id && row.step === "Resuming after host restart") return true;
  return row.updated_at <= now - BLOCKED_RECHECK_INTERVAL_MS;
}

/** One durable plan attached to the existing Operations queue. No shell text or secrets
 * cross the API boundary. Only the executor can move an approved request to ready. */
export function createDbOnboarding(d: OnboardingDeps) {
  const working = new Map<number, Promise<unknown>>();
  const serverWork = createSerial();
  // Provisioning steps are idempotent. Reconcile an interrupted approved setup
  // through preflight instead of reporting a worker that no longer exists.
  d.db.query("UPDATE db_onboarding SET state='blocked',step='Resuming after host restart',updated_at=? WHERE state IN ('executing','verifying')").run(Date.now());
  const state = (id: number) => d.db.query("SELECT * FROM db_onboarding WHERE request_id=?").get(id) as Stored | null;
  const save = (id: number, s: OnboardingState, plan: OnboardingPlan | null, blocks: Block[] = [], operationId: number | null = null, step: string | null = null) => {
    d.db.query(`INSERT INTO db_onboarding(request_id,state,plan,blocks,operation_id,step,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET state=excluded.state,plan=excluded.plan,blocks=excluded.blocks,
      operation_id=excluded.operation_id,step=excluded.step,updated_at=excluded.updated_at`)
      .run(id, s, plan ? JSON.stringify(plan) : null, JSON.stringify(blocks), operationId, step, Date.now());
  };
  function view(id: number): RequestView | undefined {
    const row = getDbRequest(d.db, id); if (!row) return;
    const s = state(id);
    const status = row.status === "rejected" ? "rejected" : s?.state ?? (row.status === "approved" ? "blocked" : row.status === "failed" ? "failed" : "pending");
    return { ...row, state: status, operationId: s?.operation_id ?? null, plan: s?.plan ? JSON.parse(s.plan) : null,
      blocks: s ? JSON.parse(s.blocks) : row.status === "approved" ? [block("legacy_unverified", "This older request was manually confirmed; host verification has not been recorded.", "Verify its catalog entry on the host before treating setup as complete.")] : [], step: s?.step ?? null,
      nextAction: status === "ready" ? "Retry prod-db connect/write in the same session. SQL still needs its own approval."
        : status === "awaiting_approval" ? "Approve the prepared database setup in Operations."
        : status === "executing" || status === "verifying" ? "Host executor is working; poll this request."
        : status === "rejected" ? "The request was rejected; do not bypass it with SSH."
        : status === "failed" ? "Inspect blocks, then resume the same approved operation."
        : "Resolve the listed blocks or prepare the target in Operations." };
  }
  async function exclusive<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const existing = working.get(id); if (existing) { await existing; return view(id) as T; }
    const promise = fn(); working.set(id, promise);
    try { return await promise; } finally { if (working.get(id) === promise) working.delete(id); }
  }
  async function checks(plan: OnboardingPlan): Promise<Block[]> {
    const blocks: Block[] = [];
    if (!d.catalog || !d.catalogPath || !d.access || !d.accessPath) blocks.push(block("catalog_unconfigured", "Database catalog or access persistence is unavailable.", "Configure the host catalog and access overlay."));
    const server = d.catalog?.servers[plan.entry.server];
    if (!server) blocks.push(block("unknown_server", `Server '${plan.entry.server}' is not in the server catalog.`, "Select a known server; a project name is not a server."));
    else if (JSON.stringify(server) !== JSON.stringify(plan.trustedServer)) blocks.push(block("target_changed", "Server configuration changed after this plan was prepared.", "Prepare and review a new plan."));
    if (!d.proxyReady(plan.entry.engine)) blocks.push(block("proxy_unavailable", "The host database proxy is unavailable.", "Enable the host DB proxy; real passwords cannot be returned to agent sessions."));
    const clash = d.catalog?.databases.find((e) => e.hostPort === plan.entry.hostPort && e.name !== plan.entry.name);
    if (clash) blocks.push(block("port_reserved", `Local port ${plan.entry.hostPort} belongs to ${clash.name}.`, "Choose a free local port."));
    const actualEntry = d.catalog && dbEntry(d.catalog, plan.entry.name);
    if (actualEntry && JSON.stringify(actualEntry) !== JSON.stringify(plan.entry) && JSON.stringify(actualEntry) !== JSON.stringify(plan.previousEntry)) blocks.push(block("catalog_changed", "Another operation changed this catalog target after preparation.", "Prepare a fresh plan against the existing entry before any host changes."));
    const reserved = d.db.query("SELECT request_id,plan FROM db_onboarding WHERE request_id < ? AND state NOT IN ('rejected','ready') AND plan IS NOT NULL").all(plan.requestId) as { request_id: number; plan: string }[];
    for (const r of reserved) {
      const p = JSON.parse(r.plan) as OnboardingPlan;
      if (p.entry.name === plan.entry.name || (p.entry.server === plan.entry.server && p.input.container === plan.input.container && p.entry.db === plan.entry.db)) blocks.push(block("target_reserved", `Request #${r.request_id} already owns setup of this database.`, `Continue request #${r.request_id}.`));
      else if (p.entry.hostPort === plan.entry.hostPort) blocks.push(block("port_reserved", `Request #${r.request_id} reserved local port ${plan.entry.hostPort}.`, "Choose another free port."));
    }
    if (!dbEntry(d.catalog ?? { servers: {}, databases: [] }, plan.entry.name) && !(await (d.portFree ?? freeLocalPort)(plan.entry.hostPort))) blocks.push(block("port_in_use", `Local port ${plan.entry.hostPort} is occupied.`, "Choose a free local port."));
    if (!d.host) blocks.push(block("executor_unconfigured", "Host setup executor is unavailable.", "Configure the host 1Password integration."));
    else if (server) {
      try { blocks.push(...await d.host.preflight(plan)); }
      catch { blocks.push(block("preflight_failed", "Host preflight could not complete.", "Check the host connection and 1Password availability, then retry.", "connection")); }
    }
    return blocks;
  }
  const planScope = (plan: OnboardingPlan): DbRequestScope => plan.requestedScope ?? (plan.migrations ? "migration" : plan.write ? "dml" : "read");
  const scopeIncreased = (plan: OnboardingPlan, row: DbRequestRow) => ({ read: 0, dml: 1, migration: 2 }[row.requested_scope ?? "read"] > { read: 0, dml: 1, migration: 2 }[planScope(plan)]);
  const priorInput = (plan: OnboardingPlan): Record<string, unknown> => ({ ...plan.input, server: plan.entry.server });
  async function readyPlan(id: number, plan: OnboardingPlan): Promise<RequestView> {
    const current = getDbRequest(d.db, id)!;
    if (current.status === "rejected") return view(id)!;
    if (scopeIncreased(plan, current)) return buildPlan(id, priorInput(plan));
    const blocks = await checks(plan);
    // Discovery/preflight await external I/O. A later migration request can raise
    // the unapproved scope during either await; never publish the stale read plan.
    const latest = getDbRequest(d.db, id)!;
    if (latest.status === "rejected") return view(id)!;
    if (scopeIncreased(plan, latest)) return buildPlan(id, priorInput(plan));
    if (blocks.length) { save(id, "blocked", plan, blocks); return view(id)!; }
    const operationId = proposeOperation(d.db, { session: latest.session_id, op: "db-onboard",
      params: { requestId: String(id), fingerprint: plan.fingerprint, server: plan.entry.server, database: plan.entry.db, access: plan.migrations ? "read + approved DML/DDL" : plan.write ? "read + approved DML" : "read only" } });
    save(id, "awaiting_approval", plan, [], operationId);
    logEvent(d.db, latest.session_id, "db_onboarding_prepared", { requestId: id, operationId, fingerprint: plan.fingerprint });
    return view(id)!;
  }
  async function prepare(id: number, raw: Record<string, unknown> = {}): Promise<RequestView> {
    const prepared = await exclusive(id, () => buildPlan(id, raw));
    if (d.autoApprove && prepared.state === "awaiting_approval" && prepared.operationId) {
      logEvent(d.db, prepared.session_id, "db_onboarding_auto_approved", {
        requestId: id, operationId: prepared.operationId, fingerprint: prepared.plan?.fingerprint,
      });
      return approve(prepared.operationId);
    }
    return prepared;
  }
  async function buildPlan(id: number, raw: Record<string, unknown>): Promise<RequestView> {
      const row = getDbRequest(d.db, id); if (!row) throw new Error("Unknown database request");
      const current = view(id)!;
      if (["ready", "rejected", "executing", "verifying"].includes(current.state)) return current;
      if (current.operationId) return current; // immutable once submitted for approval
      const currentEntry = d.catalog && dbEntry(d.catalog, row.wanted);
      if (current.plan && Object.keys(raw).length === 0) {
        if (scopeIncreased(current.plan, row)) raw = priorInput(current.plan);
        else if (!currentEntry || JSON.stringify(currentEntry) === JSON.stringify(current.plan.previousEntry) || JSON.stringify(currentEntry) === JSON.stringify(current.plan.entry)) return readyPlan(id, current.plan);
      }
      const directName = trim(raw.server) || (!trim(raw.candidateId) && !trim(raw.container) ? currentEntry?.server ?? "" : "");
      if (isDirect(d.catalog?.servers[directName])) return buildDirectPlan(id, row, raw, directName);
      const choice = trim(raw.candidateId);
      // A catalogued target was verified on the host before it was saved. Granting
      // another project or a higher scope on it must not depend on Coolify still
      // being able to rediscover the same container. Explicit overrides still discover.
      const catalogued = currentEntry && currentEntry.container && !choice && !trim(raw.server) && !trim(raw.container)
        ? { id: `catalog:${currentEntry.name}`, server: currentEntry.server, container: currentEntry.container, engine: currentEntry.engine,
            name: currentEntry.name, db: currentEntry.db, environment: "catalogued", verified: true, matched: true } satisfies Candidate
        : undefined;
      const discovery = catalogued ? { candidates: [catalogued], blocks: [] as Block[] } : await d.discover(row);
      const matches = discovery.candidates.filter((c) => c.matched && c.verified);
      const picked = choice ? discovery.candidates.find((c) => c.id === choice)
        : trim(raw.server) && trim(raw.container) ? discovery.candidates.find((c) => c.server === trim(raw.server) && c.container === trim(raw.container))
        : matches.length === 1 ? matches[0] : undefined;
      const blocks: Block[] = [];
      if (!picked?.verified) blocks.push(block("target_selection", "Select a database with a verified server and environment.", "Pick a target from the discovered candidates.", "decision"));
      const serverName = trim(raw.server) || picked?.server || "";
      const trustedServer = d.catalog?.servers[serverName];
      // With nothing selected, an empty server/container only restates target_selection.
      const untargeted = !picked && !serverName;
      if (!trustedServer && !untargeted) blocks.push(block("unknown_server", `Server '${serverName}' is not in the catalog.`, "Choose an existing server; do not use the project name."));
      const existing = d.catalog && dbEntry(d.catalog, row.wanted);
      const db = trim(raw.db) || existing?.db || picked?.db || row.wanted;
      const name = row.wanted.trim();
      const write = raw.write === true || (raw.write === undefined && row.requested_scope !== undefined && row.requested_scope !== "read"), migrations = write && (raw.migrations === true || raw.migrations === undefined && row.requested_scope === "migration");
      let hostPort = Number(raw.hostPort || existing?.hostPort || 0);
      if (hostPort === 0) {
        const occupied = new Set(d.catalog?.databases.map((e) => e.hostPort) ?? []);
        for (const s of d.db.query("SELECT plan FROM db_onboarding WHERE request_id != ? AND state != 'rejected' AND plan IS NOT NULL").all(id) as { plan: string }[]) occupied.add((JSON.parse(s.plan) as OnboardingPlan).entry.hostPort);
        for (hostPort = 15500; hostPort <= 15999; hostPort++) if (!occupied.has(hostPort) && await (d.portFree ?? freeLocalPort)(hostPort)) break;
      }
      const input: ProvisionInput = { sshAlias: "", container: picked?.container ?? trim(raw.container), engine: picked?.engine ?? "postgres", db,
        hostPort, roUser: trim(raw.roUser) || existing?.roUser || `${db}_ro`, opItem: trim(raw.opItem) || existing?.opItem || `prod-ro ${name}`,
        opVault: trim(raw.opVault) || trustedServer?.opVault,
        ...(write ? { rwUser: trim(raw.rwUser) || existing?.rwUser || `${db}_rw`, rwOpItem: trim(raw.rwOpItem) || existing?.rwOpItem || `prod-rw ${name}` } : {}),
        ...(migrations ? { migrationUser: existing?.migrationUser || `${db}_migration`, migrationOpItem: existing?.migrationOpItem || `prod-migration ${name}` } : {}) };
      for (const [key, value] of Object.entries({ name, db, roUser: input.roUser, ...(write ? { rwUser: input.rwUser! } : {}), ...(migrations ? { migrationUser: input.migrationUser! } : {}) })) if (!ident.test(value)) blocks.push(block("invalid_identifier", `Invalid ${key}: use a PostgreSQL identifier up to 63 characters.`, "Correct the advanced settings."));
      if (!token.test(input.container) && !(untargeted && !input.container)) blocks.push(block("invalid_container", "Invalid Docker container identifier.", "Select a discovered container."));
      if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) blocks.push(block("invalid_port", "Local port must be between 1024 and 65535.", "Choose Auto or a valid port."));
      if (picked && picked.server !== serverName) blocks.push(block("target_mismatch", "The selected database belongs to a different server.", "Select the matching server."));
      if (existing && (existing.server !== serverName || existing.db !== db || existing.engine !== input.engine)) blocks.push(block("catalog_target_mismatch", "The requested name already belongs to another catalog target.", "Use the correct catalog name."));
      const alias = d.catalog?.databases.find((e) => e.name !== name && e.server === serverName && e.db === db && (!e.container || e.container === input.container));
      if (alias) blocks.push(block("target_already_catalogued", `This database is already catalogued as '${alias.name}'.`, `Use prod-db ${alias.name}; do not create a second credential identity for the same database.`));
      if (blocks.length) {
        // Until a target is chosen, mapping problems of databases nobody asked for are noise.
        const relevant = picked ? discoveryBlocksForTarget(discovery.blocks, picked)
          : discovery.blocks.filter((b) => !b.candidateId || discovery.candidates.some((c) => c.matched && c.id === b.candidateId));
        // A missing selection is the actionable item; list it before supporting detail.
        const ordered = [...blocks.filter((b) => b.code === "target_selection"), ...relevant, ...blocks.filter((b) => b.code !== "target_selection")];
        save(id, "blocked", null, ordered); return view(id)!;
      }
      const entry: DbEntry = { ...existing, name, server: serverName, container: input.container, engine: input.engine, db, hostPort, roUser: input.roUser, opItem: input.opItem,
        ...(write ? { rwUser: input.rwUser, rwOpItem: input.rwOpItem } : {}),
        ...(migrations ? { migrationUser: input.migrationUser, migrationOpItem: input.migrationOpItem } : {}),
        tunnelUser: existing?.tunnelUser || "devbox-db-tunnel", tunnelKey: existing?.tunnelKey || trustedServer!.key };
      const base: Omit<OnboardingPlan, "fingerprint"> = { requestId: id, requestedScope: row.requested_scope ?? "read", entry, input, trustedServer: { ...trustedServer! }, server: effectiveServer(entry, trustedServer!), previousEntry: existing ?? null, write, migrations,
        changes: [
          ...(existing ? [`Extend/verify catalog access for ${name}; existing grants are preserved. New SQL permissions still require separate approvals.`] : []),
          `Verify ${picked!.name} / ${picked!.environment ?? "unknown environment"} on ${serverName}; Docker ${input.container}, database ${db}.`,
          `Create or reuse a dedicated 1Password tunnel key '${entry.tunnelKey}'; private material stays on the host.`,
          "Create dedicated SSH account devbox-db-tunnel with local TCP forwarding only; install restricted public key and validate SSH configuration before reload.",
          `Create a loopback-only relay on remote port ${hostPort}; no database restart.`,
          `Store credentials in 1Password and provision SELECT-only role '${input.roUser}'.`,
          ...(write ? [`Provision DML role '${input.rwUser}'; every SQL proposal requires separate approval.`] : []),
          ...(migrations ? [`Provision host-only migration role '${input.migrationUser}' scoped to this database; each exact migration requires separate approval.`] : []),
          "Verify tunnel login and database role permissions before saving catalog and project access.",
        ] };
      const plan = { ...base, fingerprint: hash(base) };
      // Reserve target/port before awaiting host preflight, so concurrent requests see it.
      save(id, "blocked", plan);
      return readyPlan(id, plan);
  }
  /** Direct server (no SSH/Docker): no Coolify discovery, the target is directly in the catalog.
   * The port is devd's local relay (tunnelPool), accounts are created by the admin from 1Password. */
  async function buildDirectPlan(id: number, row: DbRequestRow, raw: Record<string, unknown>, serverName: string): Promise<RequestView> {
    const trustedServer = d.catalog!.servers[serverName]!;
    const existing = dbEntry(d.catalog!, row.wanted);
    const name = row.wanted.trim();
    const db = trim(raw.db) || existing?.db || name;
    const engine = (trim(raw.engine) || existing?.engine || "mariadb") as DbEntry["engine"];
    const write = raw.write === true || (raw.write === undefined && row.requested_scope !== undefined && row.requested_scope !== "read"), migrations = write && (raw.migrations === true || raw.migrations === undefined && row.requested_scope === "migration");
    const blocks: Block[] = [];
    if (engine !== "mariadb") blocks.push(block("unsupported_engine", `Direct server supports MariaDB only; ${engine} needs its own adapter.`, "Use a MariaDB target or an SSH/Docker server."));
    let hostPort = Number(raw.hostPort || existing?.hostPort || 0);
    if (hostPort === 0) {
      const occupied = new Set(d.catalog!.databases.map((e) => e.hostPort));
      for (const s of d.db.query("SELECT plan FROM db_onboarding WHERE request_id != ? AND state != 'rejected' AND plan IS NOT NULL").all(id) as { plan: string }[]) occupied.add((JSON.parse(s.plan) as OnboardingPlan).entry.hostPort);
      for (hostPort = 15500; hostPort <= 15999; hostPort++) if (!occupied.has(hostPort) && await (d.portFree ?? freeLocalPort)(hostPort)) break;
    }
    const input: ProvisionInput = { sshAlias: "", container: "", engine, db, hostPort,
      roUser: trim(raw.roUser) || existing?.roUser || `${db}_ro`, opItem: trim(raw.opItem) || existing?.opItem || `prod-ro ${name}`,
      opVault: trim(raw.opVault) || trustedServer.opVault,
      ...(write ? { rwUser: trim(raw.rwUser) || existing?.rwUser || `${db}_rw`, rwOpItem: trim(raw.rwOpItem) || existing?.rwOpItem || `prod-rw ${name}` } : {}),
      ...(migrations ? { migrationUser: existing?.migrationUser || `${db}_migration`, migrationOpItem: existing?.migrationOpItem || `prod-migration ${name}` } : {}) };
    // MariaDB user names are limited to 80 chars, but keep the shared catalog rule.
    for (const [key, value] of Object.entries({ name, db, roUser: input.roUser, ...(write ? { rwUser: input.rwUser! } : {}), ...(migrations ? { migrationUser: input.migrationUser! } : {}) })) if (!ident.test(value)) blocks.push(block("invalid_identifier", `Invalid ${key}: use an identifier up to 63 characters.`, "Correct the advanced settings."));
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) blocks.push(block("invalid_port", "Local port must be between 1024 and 65535.", "Choose Auto or a valid port."));
    if (existing && (existing.server !== serverName || existing.db !== db || existing.engine !== engine)) blocks.push(block("catalog_target_mismatch", "The requested name already belongs to another catalog target.", "Use the correct catalog name."));
    const alias = d.catalog!.databases.find((e) => e.name !== name && e.server === serverName && e.db === db);
    if (alias) blocks.push(block("target_already_catalogued", `This database is already catalogued as '${alias.name}'.`, `Use prod-db ${alias.name}; do not create a second credential identity for the same database.`));
    if (blocks.length) { save(id, "blocked", null, blocks); return view(id)!; }
    const entry: DbEntry = { ...existing, name, server: serverName, engine, db, hostPort, roUser: input.roUser, opItem: input.opItem,
      ...(write ? { rwUser: input.rwUser, rwOpItem: input.rwOpItem } : {}),
      ...(migrations ? { migrationUser: input.migrationUser, migrationOpItem: input.migrationOpItem } : {}) };
    const base: Omit<OnboardingPlan, "fingerprint"> = { requestId: id, requestedScope: row.requested_scope ?? "read", entry, input, trustedServer: { ...trustedServer }, server: { ...trustedServer }, previousEntry: existing ?? null, write, migrations,
      changes: [
        ...(existing ? [`Extend/verify catalog access for ${name}; existing grants are preserved. New SQL permissions still require separate approvals.`] : []),
        `Direct MariaDB ${trustedServer.host}:${trustedServer.port} (server '${serverName}', no SSH/Docker), database ${db}.`,
        `Log in once with the admin account from 1Password '${trustedServer.adminOpItem ?? "?"}'; the admin password is never stored in the plan.`,
        `Store credentials in 1Password and provision SELECT-only account '${input.roUser}' bound to the devd egress IP.`,
        ...(write ? [`Provision DML account '${input.rwUser}' bound to the devd egress IP; every SQL proposal requires separate approval.`] : []),
        ...(migrations ? [`Provision migration account '${input.migrationUser}' (DDL on ${db} only) bound to the devd egress IP; each exact migration requires separate approval.`] : []),
        `Sessions connect through the devd proxy and a loopback relay on port ${hostPort}. The upstream link has no TLS (server does not offer it).`,
        "Verify each account's login and exact grants before saving catalog and project access.",
      ] };
    const plan = { ...base, fingerprint: hash(base) };
    save(id, "blocked", plan);
    return readyPlan(id, plan);
  }
  async function run(id: number): Promise<void> {
    await exclusive(id, async () => {
      const current = view(id); if (!current?.plan || !current.operationId) throw new Error("No prepared operation");
      const { plan, operationId } = current;
      const op = getOperation(d.db, operationId)!;
      if (!op || !["approved", "failed"].includes(op.status) || !op.decided_at) throw new Error("Operation has not been approved");
      if (JSON.parse(op.params).fingerprint !== plan.fingerprint) throw new Error("Approved plan mismatch");
      const { fingerprint, ...base } = plan;
      if (hash(base) !== fingerprint) throw new Error("Plan integrity check failed");
      await serverWork.run(plan.entry.server, async () => {
      try {
        // Claim a retry before awaiting anything: a concurrent reject must not
        // turn a failed operation into an approved executor behind the UI.
        if (!d.db.query("UPDATE operations SET status='approved' WHERE id=? AND status IN ('approved','failed')").run(operationId).changes) return;
        if (d.catalogPath) reloadCatalog(d.catalog!, d.catalogPath);
        const blocks = await checks(plan);
        if (getDbRequest(d.db, id)?.status === "rejected" || getOperation(d.db, operationId)?.status !== "approved") return;
        if (blocks.length) { save(id, "blocked", plan, blocks, operationId); return; }
        save(id, "executing", plan, [], operationId, "Starting approved setup");
        logEvent(d.db, current.session_id, "db_onboarding_started", { requestId: id, operationId });
        await d.host!.execute(plan, (step) => save(id, "executing", plan, [], operationId, step));
        save(id, "verifying", plan, [], operationId, "Verifying tunnel and role permissions");
        await d.host!.verify(plan);
        saveVerifiedDatabase(d.catalogPath!, plan.entry, plan.previousEntry ?? null);
        // Reconcile memory before a possibly failing overlay write, so retry can
        // recognize the already persisted verified target without a restart.
        reloadCatalog(d.catalog!, d.catalogPath!);
        if (current.project) {
          grantAccess(d.accessPath!, current.project, plan.entry.name, plan.write);
          addGrant(d.access!, current.project, plan.entry.name, "read");
          if (plan.write) addGrant(d.access!, current.project, plan.entry.name, "write");
        }
        reloadCatalog(d.catalog!, d.catalogPath!);
        setDbRequestStatus(d.db, id, "approved", { note: "Host setup and access verified" });
        setOperationStatus(d.db, operationId, "executed", { result: `Verified ${plan.entry.name} on ${plan.entry.server}` });
        save(id, "ready", plan, [], operationId, "Access verified and catalog updated");
        logEvent(d.db, current.session_id, "db_onboarding_verified", { requestId: id, operationId, fingerprint });
        d.notify?.("Database access ready", `Request #${id}: ${plan.entry.name}. Resume the pending SQL/deployment workflow.`);
      } catch (e) {
        // Only structured safe errors from the host are exposed; subprocess output may carry secrets.
        const safe = e && typeof e === "object" && "block" in e ? (e as { block: Block }).block : block("setup_failed", "Host setup or verification failed.", "Inspect host diagnostics, then resume this approved operation.", "connection");
        save(id, "failed", plan, [safe], operationId);
        setOperationStatus(d.db, operationId, "failed", { error: safe.message });
        logEvent(d.db, current.session_id, "db_onboarding_failed", { requestId: id, operationId, code: safe.code });
      }
      });
    });
  }
  function approve(operationId: number) {
    const op = getOperation(d.db, operationId); if (!op || op.op !== "db-onboard") throw new Error("Not a database onboarding operation");
    const id = Number(JSON.parse(op.params).requestId), r = view(id);
    if (!r || r.operationId !== operationId || r.state !== "awaiting_approval") throw new Error("Setup is not ready for approval");
    const changed = d.db.query("UPDATE operations SET status='approved',decided_at=? WHERE id=? AND status='pending'").run(Date.now(), operationId).changes;
    if (!changed) throw new Error("Operation already decided");
    save(id, "executing", r.plan, [], operationId, "Approval received");
    logEvent(d.db, r.session_id, "db_onboarding_approved", { requestId: id, operationId, fingerprint: r.plan!.fingerprint });
    void run(id).catch(() => {}); return view(id)!;
  }
  function reject(id: number) {
    const r = view(id); if (!r) throw new Error("Unknown database request");
    if (["ready", "executing", "verifying"].includes(r.state) || r.operationId && getOperation(d.db, r.operationId)?.status === "approved") throw new Error("An approved setup cannot be rejected while it is executing");
    if (r.operationId) setOperationStatus(d.db, r.operationId, "rejected");
    setDbRequestStatus(d.db, id, "rejected"); save(id, "rejected", r.plan, [], r.operationId);
    logEvent(d.db, r.session_id, "db_onboarding_rejected", { requestId: id, operationId: r.operationId });
  }
  async function tick() {
    const rows = d.db.query("SELECT * FROM db_onboarding WHERE state='blocked' AND plan IS NOT NULL").all() as Stored[];
    for (const r of rows) {
      if (working.has(r.request_id)) continue;
      const now = Date.now();
      if (!automaticRecheckDue(r, now)) continue;
      if (r.operation_id && getOperation(d.db, r.operation_id)?.status !== "approved") continue;
      // Claim before external I/O. Failed attempts, overlapping ticks and a process
      // restart must retain the cooldown even when preflight never reaches save().
      const claimed = d.db.query(`UPDATE db_onboarding SET updated_at=?,step=NULL
        WHERE request_id=? AND state='blocked' AND updated_at=? AND step IS ?`)
        .run(now, r.request_id, r.updated_at, r.step).changes;
      if (!claimed) continue;
      if (r.operation_id) await run(r.request_id);
      else await prepare(r.request_id);
    }
  }
  return { view, list: () => listDbRequests(d.db).map((r) => view(r.id)!), discover: d.discover, prepare, approve, reject, resume: run, tick,
    async settled(id: number) { await working.get(id); } };
}
export type DbOnboarding = ReturnType<typeof createDbOnboarding>;
