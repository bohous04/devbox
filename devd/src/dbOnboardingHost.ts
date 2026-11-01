import { mariaRoleScript, mariaRoleSql, verifyMariaRole } from "./mariaDbOnboarding";
import { mysqlPasswordHash } from "./mysqlAuth";
/** Fixed, host-only production DB setup. The Operations decision is owned by the
 * caller; this module never exposes an arbitrary command or SQL execution API.
 * Every secret is read on the host, sent on stdin, and discarded with its 0700
 * temporary directory. Subprocess output is never included in a public error. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import postgres from "postgres";
import { createConnection, type Connection, type ConnectionOptions } from "mysql2/promise";
import { run as procRun, type RunOpts, type RunResult } from "./proc";
import { createOpRunner, OpRateLimited, runOp } from "./opRateLimit";
import { createSerial } from "./sshAgent";
import { isAddressInCidr } from "./network";
import { isDirect, type Catalog, type ServerRef } from "./prodDb";
import type { Block, OnboardingPlan } from "./dbOnboarding";
import { onboardingInspectionScript, onboardingInstallScript, onboardingRoleSql, onboardingVerifySql, onboardingWriteVerifySql, type TargetInspection } from "./dbOnboardingScripts";

export interface DbOnboardingHost {
  preflight(plan: OnboardingPlan): Promise<Block[]>;
  execute(plan: OnboardingPlan, onProgress?: (step: string) => void): Promise<void>;
  verify(plan: OnboardingPlan): Promise<void>;
}
type Run = (cmd: string[], options: RunOpts) => Promise<RunResult>;
interface Item { id: string; title: string; category: string; vault: { id: string; name: string }; sshUser?: string }
export interface HostDeps {
  token(): string;
  catalog(): Catalog;
  proxyReady(engine?: string): boolean;
  /** Optional trusted srv audit/catalog resolver. It must only return keys tied
   * to this exact catalog target; it confers no session SSH grant. */
  adminKeyForServer?: (name: string, server: ServerRef) => { title: string; user: string } | undefined | Promise<{ title: string; user: string } | undefined>;
  run?: Run;
  /** Trusted host configuration only. Omit to discover the service account's
   * create_items permission with read-only CLI calls; unknown fails closed. */
  canCreateItems?: (vault: string) => Promise<boolean | undefined>;
  portFree?: (port: number) => Promise<boolean>;
  ownsTunnel?: (plan: OnboardingPlan) => boolean;
  /** Tests replace the DB wire driver, not the secret boundary or SSH scripts. */
  verifyDatabase?: (plan: OnboardingPlan, password: string, port: number) => Promise<void>;
  /** Public IPv4 devd connects from. Direct-server accounts are bound to it, never to '%'. */
  egressHost?: string;
  /** Tests replace the MariaDB driver used against direct servers. */
  connectMaria?: (options: ConnectionOptions) => Promise<Connection>;
}
export class OnboardingHostError extends Error {
  constructor(public readonly block: Block) { super(block.message); this.name = "OnboardingHostError"; }
}
const block = (code: string, category: Block["category"], message: string, action: string): Block => ({ code, category, message, action });
const fail = (code: string, category: Block["category"], message: string, action: string): never => { throw new OnboardingHostError(block(code, category, message, action)); };
const safeError = (error: unknown, fallback: Block): Block => error instanceof OnboardingHostError ? error.block : fallback;
const shell = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const unixUser = /^[a-z_][a-z0-9_-]{0,30}$/;

export async function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export function validateHostPlan(plan: OnboardingPlan, cat: Catalog): Block[] {
  const out: Block[] = [];
  const add = (code: string, message: string) => out.push(block(code, "configuration", message, "Fix the target's advanced settings and prepare the plan again."));
  const e = plan.entry; const s = plan.server;
  const trusted = cat.servers[e.server];
  if (!trusted) add("unknown_server", `Server '${e.server}' is not in the server catalog.`);
  else if (trusted.host !== s.host || trusted.port !== s.port || trusted.adminKey !== s.adminKey || trusted.adminUser !== s.adminUser) add("server_mismatch", "The SSH target does not match the trusted server catalog.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(e.name)) add("invalid_name", "Invalid catalog database name.");
  for (const [key, value] of Object.entries({ db: e.db, roUser: e.roUser, rwUser: e.rwUser, migrationUser: e.migrationUser })) {
    if (value !== undefined && !identifier.test(value)) add(`invalid_${key}`, `Invalid SQL identifier ${key}.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(plan.input.container)) add("invalid_container", "Invalid Docker container identifier.");
  if (!Number.isInteger(e.hostPort) || e.hostPort < 1024 || e.hostPort > 65535) add("invalid_port", "The local port must be in the range 1024–65535.");
  if (!unixUser.test(s.user) || !s.user.startsWith("devbox-db-")) add("unsafe_tunnel_user", "The DB tunnel requires a dedicated devbox-db-* account.");
  if (!s.key.startsWith("prod-tunnel-") || s.key === s.adminKey) add("unsafe_tunnel_key", "The DB tunnel must use a dedicated prod-tunnel-* key, separate from the admin key.");
  if (!["postgres", "mariadb"].includes(e.engine)) add("unsupported_engine", `Verified host-side onboarding currently supports PostgreSQL and MariaDB; ${e.engine} needs a separate adapter.`);
  if (e.rwUser && !e.rwOpItem) add("missing_rw_item", "The write role has no 1Password item.");
  if (e.migrationUser && !e.migrationOpItem) add("missing_migration_item", "The migration role has no 1Password item.");
  if (new Set([e.roUser, e.rwUser, e.migrationUser].filter(Boolean)).size !== [e.roUser, e.rwUser, e.migrationUser].filter(Boolean).length) add("role_collision", "The read, write and migration roles must be different.");
  if ([e.opItem, e.rwOpItem, e.migrationOpItem, s.key].filter(Boolean).some(v => /[\r\n\0]/.test(v!))) add("invalid_item", "A 1Password title must not contain control characters.");
  const clash = cat.databases.find(d => d.name !== e.name && d.hostPort === e.hostPort);
  if (clash) add("port_catalog_conflict", `Local port ${e.hostPort} is already used by database '${clash.name}'.`);
  return out;
}

/** Conservatively check existing sshd policies before an approval. Actual
 * key auth and the effective restrictions are verified again after installation. */
export function validateSshPolicy(plan: OnboardingPlan, target: Pick<TargetInspection, "sshEffective" | "sshInclude" | "clientAddress" | "sshScopedAllow">): Block[] {
  const out: Block[] = [];
  const add = (code: string, message: string) => out.push(block(code, "permission", message, "Adjust the trusted SSH configuration for the dedicated account and run the check again."));
  if (!target.sshInclude) add("sshd_include_missing", "sshd does not load the supported /etc/ssh/sshd_config.d directory; the account restrictions would not apply.");
  const lines = new Map(target.sshEffective.split("\n").filter(Boolean).map(l => { const i = l.indexOf(" "); return [l.slice(0, i), l.slice(i + 1)]; }));
  if (!lines.size) { add("sshd_inspection_failed", "The effective SSH configuration cannot be checked for the current host address."); return out; }
  if (lines.get("pubkeyauthentication") !== "yes") add("ssh_pubkey_disabled", "The SSH policy disables public key authentication for the tunnel account.");
  const methods = lines.get("authenticationmethods");
  if (methods && methods !== "any" && !methods.split(" ").includes("publickey")) add("ssh_additional_auth", "The SSH policy requires an additional authentication method for the tunnel.");
  const keys = (lines.get("authorizedkeysfile") ?? "").split(" ");
  if (!keys.some(k => [".ssh/authorized_keys", "%h/.ssh/authorized_keys", `/var/lib/${plan.server.user}/.ssh/authorized_keys`].includes(k))) add("ssh_authorized_keys_path", "The SSH policy does not read public keys from the dedicated account.");
  const matches = (pattern: string, value: string) => new RegExp("^" + pattern.split("").map(c => c === "*" ? ".*" : c === "?" ? "." : /^[a-zA-Z0-9_-]$/.test(c) ? c : `\\${c}`).join("") + "$").test(value);
  const userMatch = (pattern: string) => {
    const [user, address] = pattern.split("@");
    return matches(user!, plan.server.user) && (!address || (address.includes("/") ? isAddressInCidr(target.clientAddress, address) : matches(address, target.clientAddress)));
  };
  if (lines.has("allowusers") && !target.sshScopedAllow && !lines.get("allowusers")!.split(" ").some(userMatch)) add("ssh_user_not_allowed", "AllowUsers does not allow the dedicated tunnel account from the current Devbox address.");
  if (lines.get("denyusers")?.split(" ").some(userMatch)) add("ssh_user_denied", "DenyUsers denies the dedicated tunnel account from the current Devbox address.");
  if (lines.has("allowgroups") && !lines.get("allowgroups")!.split(" ").some(p => matches(p, plan.server.user))) add("ssh_group_not_allowed", "AllowGroups does not allow the tunnel account's dedicated group.");
  if (lines.get("denygroups")?.split(" ").some(p => matches(p, plan.server.user))) add("ssh_group_denied", "DenyGroups denies the tunnel account's dedicated group.");
  return out;
}

/** No live calls occur until a method is invoked. Safe to construct while the
 * host vault is locked; retry reads the current token and catalog afresh. */
export function createDbOnboardingHost(d: HostDeps): DbOnboardingHost {
  const run = d.run ?? procRun;
  const opRun = d.run ? createOpRunner({ run: d.run }) : runOp;
  const serial = createSerial();
  async function op(args: string[], input?: string): Promise<RunResult> {
    let token: string;
    try { token = d.token(); } catch { return fail("op_unavailable", "connection", "1Password is unavailable or the host vault is locked.", "Unlock the vault or restore the 1Password integration; the request can then be checked again."); }
    if (!token) return fail("op_unavailable", "configuration", "The 1Password service account is missing.", "Configure the 1Password integration on the host.");
    // op selects Connect mode even when these variables are present but empty.
    // Remove them only from this child; keep the service token host-side in env.
    try { return await opRun(token, args, { stdin: input, timeoutMs: 30_000 }); }
    catch (e) {
      if (e instanceof OpRateLimited) return fail("op_rate_limited", "connection", e.message, "Run the check again once the quota resets; further automatic queries are paused until then.");
      throw e;
    }
  }
  async function inventory(): Promise<Item[]> {
    const r = await op(["item", "list", "--format", "json"]);
    if (r.code || r.timedOut) return fail("op_unavailable", "connection", "Cannot load the 1Password catalog.", "Check the integration, the service account's permissions and that the vault is unlocked.");
    try { const parsed = JSON.parse(r.stdout); if (!Array.isArray(parsed)) throw Error(); return parsed; }
    catch { return fail("op_invalid_response", "connection", "1Password returned an invalid catalog.", "Restore the 1Password integration and run the check again."); }
  }
  function match(items: Item[], title: string, category: "SSH_KEY" | "PASSWORD" | "LOGIN"): Item | undefined {
    const matches = items.filter(x => x.title === title);
    if (matches.length > 1) return fail("op_ambiguous_item", "configuration", `Item '${title}' exists more than once in 1Password.`, "Make the item title unique; Devbox never picks a secret by order.");
    if (matches[0] && matches[0].category !== category) return fail("op_wrong_category", "configuration", `Item '${title}' has the wrong category.`, `Use a separate item of type ${category === "SSH_KEY" ? "SSH Key" : category === "LOGIN" ? "Login" : "Password"}.`);
    return matches[0];
  }
  async function read(item: Item, field: string): Promise<string> {
    const r = await op(["read", `op://${item.vault.id}/${item.id}/${field}`]);
    if (r.code || !r.stdout.trim()) return fail("op_read_denied", "permission", `Cannot read the required field of item '${item.title}'.`, "Allow the host service account to read the correct item.");
    return r.stdout.trim() + (field.includes("private key") ? "\n" : "");
  }
  async function createPermission(vault: string): Promise<boolean | undefined> {
    if (d.canCreateItems) return d.canCreateItems(vault);
    const who = await op(["user", "get", "--me", "--format", "json"]);
    if (who.code) return undefined;
    let id: string;
    try { id = JSON.parse(who.stdout).id; if (!id) return undefined; } catch { return undefined; }
    const r = await op(["vault", "list", "--user", id, "--permission", "create_items", "--format", "json"]);
    if (r.code) return undefined;
    try { return (JSON.parse(r.stdout) as { id: string; name: string }[]).some(v => v.id === vault || v.name === vault); } catch { return undefined; }
  }
  async function ensureItem(title: string, category: "SSH_KEY" | "PASSWORD", vault: string): Promise<Item> {
    // Serialized per server, and store BEFORE touching a DB role. A crash/retry
    // therefore reuses both the exact item identity and the same password.
    const existing = match(await inventory(), title, category);
    if (existing) return existing;
    const r = await op(["item", "create", "--category", category === "SSH_KEY" ? "ssh" : "password", "--title", title, "--vault", vault,
      ...(category === "SSH_KEY" ? ["--ssh-generate-key=ed25519"] : ["--generate-password=48,letters,digits"]), "--format", "json"]);
    // Never return create output: even with default redaction it is not an API contract.
    if (r.code) return fail("op_create_denied", "permission", `1Password did not allow creating item '${title}'.`, "Create this dedicated item in an accessible vault or grant the service account read_items/write_items; then retry the same operation.");
    const saved = match(await inventory(), title, category);
    if (!saved) return fail("op_create_unverified", "connection", `Creation of item '${title}' was not verified.`, "Check the same operation again; do not create another item by hand.");
    return saved;
  }
  async function withKey<T>(item: Item, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "devd-db-host-"));
    try {
      const key = await read(item, "private key?ssh-format=openssh");
      if (!key.includes("PRIVATE KEY")) return fail("op_invalid_key", "configuration", "The 1Password item does not contain a usable SSH key.", "Fix the SSH Key item and run the check again.");
      const path = join(dir, "identity"); writeFileSync(path, key, { mode: 0o600 });
      return await fn(path);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  function sshArgs(plan: OnboardingPlan, path: string, admin: boolean, adminUser?: string): string[] {
    const s = plan.server;
    return ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "ForwardAgent=no", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12", "-i", path, "-p", String(s.port), `${admin ? adminUser ?? s.adminUser ?? "root" : s.user}@${s.host}`];
  }
  // Targets rate-limit new SSH connections (ufw LIMIT: 6 per 30 s). One setup
  // runs several admin steps and preflight repeats before execution, so every
  // admin step shares one authenticated connection that idles out on its own.
  const masters = new Map<string, { dir: string; sock: string }>();
  async function adminConnection(plan: OnboardingPlan, path: string, adminUser: string): Promise<string | undefined> {
    const key = `${adminUser}@${plan.server.host}:${plan.server.port}`;
    const known = masters.get(key);
    if (known) {
      const alive = await run(["ssh", "-F", "/dev/null", "-S", known.sock, "-O", "check", "-p", String(plan.server.port), `${adminUser}@${plan.server.host}`], { timeoutMs: 5_000 });
      if (!alive.code && !alive.timedOut) return known.sock;
      masters.delete(key); rmSync(known.dir, { recursive: true, force: true });
    }
    const dir = mkdtempSync(join(tmpdir(), "devd-db-ssh-")), sock = join(dir, "control");
    const started = await run([...sshArgs(plan, path, true, adminUser), "-M", "-S", sock, "-f", "-N", "-o", "ControlPersist=60"], { timeoutMs: 20_000 });
    // Without a master each step still works, just with its own connection.
    if (started.code || started.timedOut) { rmSync(dir, { recursive: true, force: true }); return undefined; }
    masters.set(key, { dir, sock });
    return sock;
  }
  async function remote(plan: OnboardingPlan, item: Item, script: string): Promise<string> {
    return withKey(item, async path => {
      const adminUser = item.sshUser ?? plan.server.adminUser ?? "root";
      const sock = await adminConnection(plan, path, adminUser);
      const r = await run([...sshArgs(plan, path, true, adminUser), ...(sock ? ["-S", sock, "-o", "ControlMaster=no"] : []), adminUser !== "root" ? 'sudo -n env DEVD_SSH_CONNECTION="$SSH_CONNECTION" bash -s' : "bash -s"], { stdin: script, timeoutMs: 90_000 });
      if (r.code || r.timedOut) {
        const known = r.stdout.match(/^BLOCK:([a-z_]+)$/m)?.[1] ?? r.stderr.match(/devd (role_conflict|ddl_owner)/)?.[1];
        const reasons: Record<string, [string, string]> = {
          admin_privileges: ["The SSH account lacks the required host permission.", "Allow this account to administer via sudo -n for the approved onboarding."],
          role_conflict: ["An existing SQL role does not belong to this operation.", "Choose unique roles or verify their ownership and permissions."],
          ddl_owner: ["The DB owner has admin privileges or does not own the required tables; migrations cannot be safely delegated to it.", "Set up a separate owner of the application schema without superuser/CREATEROLE/CREATEDB privileges."],
          tunnel_user_conflict: ["The dedicated tunnel account name is already used by an unmanaged account.", "Choose a different dedicated account name."],
          sshd_config: ["The SSH tunnel restrictions could not be verified; the configuration was rolled back.", "Check sshd_config.d support and that the SSH service can be reloaded."],
          host_tools_missing: ["The target host is missing a tool required for a safe setup.", "Prepare again to get the exact list of dependencies and install them before approval."],
          relay_conflict: ["The port or systemd relay is already used by another target.", "Choose a free port and prepare the plan again."],
        };
        if (known && reasons[known]) return fail(known, "permission", reasons[known]![0], reasons[known]![1]);
        return fail("ssh_failed", "connection", r.timedOut ? "The host SSH step timed out." : "The host SSH step failed; the setup is not verified.", "Check the connection, the known host fingerprint, the admin key and sudo permission; a retry reuses the same operation.");
      }
      return r.stdout;
    });
  }
  async function inspect(plan: OnboardingPlan, item: Item): Promise<TargetInspection> {
    const raw = await remote(plan, item, onboardingInspectionScript(plan));
    const values = Object.fromEntries(raw.split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    try {
      return { missingTools: (values.MISSING_TOOLS ?? "").split(",").filter(Boolean), running: values.RUNNING === "true", image: JSON.parse(values.IMAGE ?? '""'), networks: JSON.parse(values.NETWORKS ?? "{}"), ports: JSON.parse(values.PORTS ?? "{}"), remotePortBusy: values.PORT_BUSY === "yes", relayManaged: values.RELAY_MANAGED === "yes", systemd: values.SYSTEMD === "yes", proxyBinary: values.PROXY_BINARY || "", sshd: values.SSHD === "yes", tunnelUserConflict: values.USER_CONFLICT === "yes", sshEffective: Buffer.from(values.SSH_EFFECTIVE ?? "", "base64").toString("utf8"), sshInclude: values.SSH_INCLUDE === "yes", sshScopedAllow: values.SSH_SCOPED_ALLOW === "yes", clientAddress: values.CLIENT_ADDRESS ?? "", database: JSON.parse(values.DATABASE ?? "null") };
    } catch { return fail("target_inspection_failed", "connection", "The target did not return a valid Docker/SQL check result.", "Check that the database is running and a database client is available in the target container."); }
  }
  async function context(plan: OnboardingPlan, suppliedItems?: Item[]) {
    const items = suppliedItems ?? await inventory();
    // srv exposes only 1P titles. This exact conventional title is a candidate
    // tied to an actual catalog server, and read-only SSH verifies the mapping.
    // Never derive a server from the project or try unrelated keys in sequence.
    const resolved = !plan.server.adminKey ? await d.adminKeyForServer?.(plan.entry.server, plan.trustedServer) : undefined;
    if (resolved && (!unixUser.test(resolved.user) || !resolved.title.trim())) return fail("admin_mapping_invalid", "configuration", "The server's verified SSH metadata is invalid.", "Fix the key and account mapping in the host catalog.");
    const exact = `${plan.entry.server}-root-hardened`;
    const adminTitle = plan.server.adminKey || resolved?.title.trim() || (items.filter(x => x.title === exact && x.category === "SSH_KEY").length === 1 ? exact : undefined);
    if (!adminTitle) return fail("admin_key_missing", "configuration", `Server '${plan.entry.server}' has no verified admin SSH key.`, "Add adminKey/adminUser to the server catalog or select the server's verified key in 1Password.");
    const admin = match(items, adminTitle, "SSH_KEY");
    if (!admin) return fail("admin_key_missing", "permission", `Admin key '${adminTitle}' is not accessible.`, "Allow reading the corresponding SSH Key in 1Password.");
    return { items, admin: { ...admin, sshUser: plan.server.adminUser ?? resolved?.user ?? "root" }, vault: plan.input.opVault?.trim() || plan.server.opVault?.trim() || admin.vault.id };
  }

  // ---- Direct server: MariaDB reachable over plain TCP, no SSH or Docker. ----
  // Admin credentials come from a 1Password Login item and live only for the
  // duration of one call. Server error text never reaches a block (it may echo SQL).
  const connectMaria = d.connectMaria ?? ((o: ConnectionOptions) => createConnection(o));
  const directRoles = (plan: OnboardingPlan): [string, string][] => ([[plan.entry.roUser, plan.entry.opItem], [plan.entry.rwUser, plan.entry.rwOpItem], [plan.entry.migrationUser, plan.entry.migrationOpItem]] as const)
    .filter((r): r is [string, string] => !!r[0] && !!r[1]).map(([u, t]) => [u, t]);
  const egress = (): string | undefined => { const v = d.egressHost?.trim(); return v && /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : undefined; };
  function validateDirectPlan(plan: OnboardingPlan): Block[] {
    const out: Block[] = [];
    const add = (code: string, message: string, action = "Fix the server catalog or the advanced settings and prepare the plan again.") => out.push(block(code, "configuration", message, action));
    const e = plan.entry, trusted = d.catalog().servers[e.server];
    if (!trusted || !isDirect(trusted)) add("unknown_server", `Server '${e.server}' is not in the catalog as a direct server.`);
    else if (JSON.stringify(trusted) !== JSON.stringify(plan.trustedServer)) add("server_mismatch", "The direct server in the catalog changed after the plan was prepared.");
    if (!plan.trustedServer.adminOpItem?.trim()) add("direct_admin_item", "The direct server has no adminOpItem in the catalog.", "Add the name of the 1Password Login item with the admin account to the server catalog.");
    if (!egress()) add("direct_egress_unknown", "devd's outbound IPv4 address (DEVD_EGRESS_IP) is not set.", "Set DEVD_EGRESS_IP to the host's public IPv4 and restart devd; the accounts are bound to it.");
    if (e.engine !== "mariadb") add("unsupported_engine", `Direct servers currently support only MariaDB; ${e.engine} needs a separate adapter.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(e.name)) add("invalid_name", "Invalid catalog database name.");
    for (const [key, value] of Object.entries({ db: e.db, roUser: e.roUser, rwUser: e.rwUser, migrationUser: e.migrationUser })) if (value !== undefined && !identifier.test(value)) add(`invalid_${key}`, `Invalid SQL identifier ${key}.`);
    if (!Number.isInteger(e.hostPort) || e.hostPort < 1024 || e.hostPort > 65535) add("invalid_port", "The local port must be in the range 1024–65535.");
    if (e.rwUser && !e.rwOpItem) add("missing_rw_item", "The write role has no 1Password item.");
    if (e.migrationUser && !e.migrationOpItem) add("missing_migration_item", "The migration role has no 1Password item.");
    const users = [e.roUser, e.rwUser, e.migrationUser].filter(Boolean);
    if (new Set(users).size !== users.length) add("role_collision", "The read, write and migration roles must be different.");
    if ([e.opItem, e.rwOpItem, e.migrationOpItem, plan.trustedServer.adminOpItem].filter(Boolean).some(v => /[\r\n\0]/.test(v!))) add("invalid_item", "A 1Password title must not contain control characters.");
    const clash = d.catalog().databases.find(x => x.name !== e.name && x.hostPort === e.hostPort);
    if (clash) add("port_catalog_conflict", `Local port ${e.hostPort} is already used by database '${clash.name}'.`);
    return out;
  }
  async function directAdmin<T>(plan: OnboardingPlan, items: Item[], fn: (c: Connection) => Promise<T>): Promise<T> {
    const item = match(items, plan.trustedServer.adminOpItem!, "LOGIN");
    if (!item) return fail("direct_admin_item", "permission", `Admin item '${plan.trustedServer.adminOpItem}' is not accessible in 1Password.`, "Create a Login item with the database admin account in the host integration's vault.");
    const user = await read(item, "username"), password = await read(item, "password");
    let c: Connection;
    try { c = await connectMaria({ host: plan.trustedServer.host, port: plan.trustedServer.port, user, password, connectTimeout: 10_000 }); }
    catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_HOST_NOT_PRIVILEGED") return fail("direct_admin_denied", "permission", "The database server rejected the admin login.", "Check the admin account in 1Password and that it may connect from devd's outbound IP.");
      return fail("direct_unreachable", "connection", `Database server ${plan.trustedServer.host}:${plan.trustedServer.port} is unreachable.`, "Check that the server is running and the port is reachable from the devd host.");
    }
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }
  async function directPreflight(plan: OnboardingPlan): Promise<Block[]> {
    const blocks = validateDirectPlan(plan);
    if (!d.proxyReady(plan.entry.engine)) blocks.push(block("proxy_unavailable", "configuration", "The host DB proxy is unavailable.", "Enable and verify DEVD_MYSQL_PROXY_PORT; real DB passwords must never be handed to a session."));
    if (Number.isInteger(plan.entry.hostPort) && !(await (d.portFree ?? isLocalPortFree)(plan.entry.hostPort)) && !d.ownsTunnel?.(plan)) blocks.push(block("local_port_busy", "configuration", `Local port ${plan.entry.hostPort} is in use.`, "Choose another free local port and prepare the plan again."));
    if (blocks.length) return blocks;
    let items: Item[];
    try { items = await inventory(); }
    catch (e) { blocks.push(safeError(e, block("op_unavailable", "connection", "The 1Password check failed.", "Restore the integration and run the check again."))); return blocks; }
    const existing = new Map<string, string>(), missing: string[] = [];
    for (const [role, title] of directRoles(plan)) {
      try { const found = match(items, title, "PASSWORD"); if (found) existing.set(role, await read(found, "password")); else missing.push(title); }
      catch (e) { blocks.push(safeError(e, block("op_read_denied", "permission", `Item '${title}' cannot be verified.`, "Check the integration's read permission."))); }
    }
    if (missing.length) {
      const vault = plan.input.opVault?.trim() || plan.trustedServer.opVault?.trim();
      const canCreate = vault ? await createPermission(vault).catch(() => undefined) : undefined;
      if (canCreate !== true) blocks.push(block("op_manual_items", "permission", `Missing 1Password items: ${missing.join(", ")}. ${canCreate === false ? "The service account is not allowed to create items." : "Could not verify the permission to create items."}`, `Create the listed Password items in vault '${vault || "accessible to the host integration"}' or allow item creation; the same request then continues.`));
    }
    try {
      await directAdmin(plan, items, async c => {
        const [schemas] = await c.query<any[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [plan.entry.db]);
        if (!schemas.length) blocks.push(block("direct_db_missing", "configuration", `Database '${plan.entry.db}' does not exist on the server.`, "Fix the database name in the advanced settings."));
        const [grants] = await c.query<any[]>("SHOW GRANTS FOR CURRENT_USER()");
        const global = grants.map(r => String(Object.values(r)[0])).filter(l => / ON \*\.\* TO /.test(l));
        if (!global.some(l => /WITH GRANT OPTION/.test(l)) || !global.some(l => /ALL PRIVILEGES|CREATE USER/.test(l))) blocks.push(block("direct_admin_privileges", "permission", "The admin account does not have global CREATE USER and GRANT OPTION.", "Use an admin account that can create accounts and grant privileges."));
        let accounts: any[];
        try { [accounts] = await c.query<any[]>("SELECT User AS user, Host AS host, authentication_string AS hash FROM mysql.user WHERE User IN (?)", [directRoles(plan).map(r => r[0])]); }
        catch { blocks.push(block("direct_admin_privileges", "permission", "The admin account cannot read mysql.user; account ownership cannot be verified.", "Use an admin account that can read the mysql system database.")); return; }
        for (const a of accounts) {
          const pw = existing.get(a.user);
          // Ours only when bound to the egress IP and holding the password stored in 1Password.
          if (a.host !== egress() || !pw || a.hash !== mysqlPasswordHash(pw)) blocks.push(block("role_conflict", "configuration", `Existing account '${a.user}@${a.host}' does not belong to this database operation.`, "Choose unique account names; Devbox does not overwrite accounts it does not own."));
        }
      });
    } catch (e) { blocks.push(safeError(e, block("direct_unreachable", "connection", "The direct server check failed.", "Check that the server is reachable and the admin account."))); }
    return blocks;
  }
  async function directExecute(plan: OnboardingPlan, onProgress: (step: string) => void): Promise<void> {
    const blocks = await directPreflight(plan);
    if (blocks.length) throw new OnboardingHostError(blocks[0]!);
    const vault = plan.input.opVault?.trim() || plan.trustedServer.opVault?.trim();
    if (!vault) return fail("op_vault_missing", "configuration", "The direct server has no 1Password vault set.", "Add opVault to the server catalog.");
    onProgress("1password_items");
    const credentials: [string, string][] = [];
    for (const [role, title] of directRoles(plan)) credentials.push([role, await read(await ensureItem(title, "PASSWORD", vault), "password")]);
    onProgress("database_roles");
    await directAdmin(plan, await inventory(), async c => {
      for (const [role, password] of credentials) {
        try { await c.query(mariaRoleSql(plan, role, password, egress()!)); }
        catch (e) {
          if ((e as { sqlState?: string }).sqlState === "45000") return fail("role_conflict", "permission", "An existing SQL account does not belong to this operation.", "Choose unique account names or verify their ownership.");
          return fail("direct_role_failed", "permission", `Account '${role}' could not be created or configured.`, "Check the admin account's privileges (CREATE USER, GRANT OPTION on the target DB); a retry reuses the same operation.");
        }
      }
    });
    onProgress("database_roles_ready");
  }
  async function directVerify(plan: OnboardingPlan): Promise<void> {
    const items = await inventory();
    for (const [role, title] of directRoles(plan)) {
      const item = match(items, title, "PASSWORD");
      if (!item) return fail("setup_incomplete", "configuration", "The setup does not have all expected 1Password items.", "Retry the approved operation with the same ID.");
      const password = await read(item, "password");
      try {
        if (d.verifyDatabase) await d.verifyDatabase(plan, password, plan.trustedServer.port);
        else await verifyMariaRole(plan, role, password, plan.trustedServer.port, { host: plan.trustedServer.host, accountHost: egress() });
      } catch (e) {
        if (e instanceof OnboardingHostError) throw e;
        return fail(role === plan.entry.roUser ? "ro_verification_failed" : "write_verification_failed", "permission", `Account '${role}' failed the login or exact-privilege check.`, "Check the account on the server; the catalog has not been updated yet.");
      }
    }
  }
  async function preflight(plan: OnboardingPlan): Promise<Block[]> {
    if (isDirect(plan.trustedServer)) return directPreflight(plan);
    const blocks = validateHostPlan(plan, d.catalog());
    if (!d.proxyReady(plan.entry.engine)) blocks.push(block("proxy_unavailable", "configuration", "The host DB proxy is unavailable.", "Enable and verify DEVD_DB_PROXY_PORT; real DB passwords must never be handed to a session."));
    if (Number.isInteger(plan.entry.hostPort) && !(await (d.portFree ?? isLocalPortFree)(plan.entry.hostPort)) && !d.ownsTunnel?.(plan)) blocks.push(block("local_port_busy", "configuration", `Local port ${plan.entry.hostPort} is in use.`, "Choose another free local port and prepare the plan again."));
    if (blocks.some(b => b.code.startsWith("invalid_") || ["unknown_server", "server_mismatch", "unsupported_engine"].includes(b.code))) return blocks;
    let items: Item[];
    try { items = await inventory(); }
    catch (e) { blocks.push(safeError(e, block("op_unavailable", "connection", "The 1Password check failed.", "Restore the integration and run the check again."))); return blocks; }
    let ctx: Awaited<ReturnType<typeof context>> | undefined;
    try { ctx = await context(plan, items); }
    catch (e) { blocks.push(safeError(e, block("admin_key_missing", "configuration", "Verified admin access is missing.", "Add a trusted server configuration."))); }
    const required: [string | undefined, "SSH_KEY" | "PASSWORD"][] = [[plan.server.key, "SSH_KEY"], [plan.entry.opItem, "PASSWORD"], [plan.entry.rwOpItem, "PASSWORD"], [plan.entry.migrationOpItem, "PASSWORD"]];
    const missing: string[] = [];
    for (const [title, category] of required) {
      if (!title) continue;
      try {
        const found = match(items, title, category);
        if (!found) missing.push(title);
        else {
          const value = await read(found, category === "SSH_KEY" ? "private key?ssh-format=openssh" : "password");
          if (category === "SSH_KEY" && ctx?.admin && value === await read(ctx.admin, "private key?ssh-format=openssh")) blocks.push(block("admin_key_reused", "permission", "The tunnel item contains the admin key.", "Generate a separate dedicated SSH key."));
        }
      } catch (e) { blocks.push(safeError(e, block("op_read_denied", "permission", `Item '${title}' cannot be verified.`, "Check the integration's read permission."))); }
    }
    if (missing.length) {
      const vault = ctx?.vault || plan.input.opVault?.trim() || plan.server.opVault?.trim();
      const canCreate = vault ? await createPermission(vault).catch(() => undefined) : undefined;
      if (canCreate !== true) blocks.push(block("op_manual_items", "permission", `Missing 1Password items: ${missing.join(", ")}. ${canCreate === false ? "The service account is not allowed to create items." : "Could not verify the permission to create items."}`, `Create the listed dedicated SSH Key/Password items in vault '${vault || "accessible to the host integration"}' or allow read_items/write_items; the same request then continues.`));
    }
    if (!ctx) return blocks;
    try {
      const target = await inspect(plan, ctx.admin);
      if (target.missingTools.length) {
        blocks.push(block("host_tools_missing", "configuration", `The target host is missing required tools: ${target.missingTools.join(", ")}.`, "Install the listed dependencies and prepare again before approval."));
        return blocks;
      }
      if (!target.running) blocks.push(block("container_unavailable", "connection", "The selected Docker container is not running.", "Select a running database container."));
      if (!target.database || target.database.db !== plan.entry.db) blocks.push(block("database_unavailable", "connection", "The database cannot be verified in the target container.", "Check the DB name and the container's local admin access."));
      if (!Object.values(target.networks).some(n => /^\d+\.\d+\.\d+\.\d+$/.test(n.IPAddress ?? ""))) blocks.push(block("container_network_missing", "configuration", "The database container has no IPv4 address on a Docker network.", "Set up a private Docker network for the loopback relay."));
      if (!target.systemd || !target.proxyBinary || !target.sshd) blocks.push(block("host_tools_missing", "configuration", "The host needs systemd, systemd-socket-proxyd and sshd.", "Install the missing host tools before approval."));
      blocks.push(...validateSshPolicy(plan, target));
      const binding = target.ports[plan.entry.engine === "mariadb" ? "3306/tcp" : "5432/tcp"]?.some(p => p.HostIp === "127.0.0.1" && Number(p.HostPort) === plan.entry.hostPort);
      if (target.remotePortBusy && !target.relayManaged && !binding) blocks.push(block("remote_port_busy", "configuration", `Port ${plan.entry.hostPort} is used by another process on the target server.`, "Choose another port and prepare the plan again."));
      if (target.tunnelUserConflict) blocks.push(block("tunnel_user_conflict", "configuration", "The dedicated SSH account name is already used by an unmanaged account.", "Choose a different dedicated tunnel account."));
      if (target.database && !target.database.publicReadOnlySafe && target.database.publicReadOnlySafe !== undefined) blocks.push(block("public_write_privileges", "permission", "The PUBLIC role has write privileges or access to application SECURITY DEFINER functions; read-only access cannot be guaranteed.", "Review and adjust the PUBLIC privileges separately. Onboarding does not change other applications' privileges."));
      if (plan.entry.migrationUser && target.database && (!target.database.ownerSafe || !target.database.ownerOwnsTables)) blocks.push(block("ddl_owner", "permission", "Migrations need a separate owner of the application tables without admin privileges.", "Set up a safe DB/schema owner; onboarding does not take over superuser privileges."));
      for (const role of target.database?.roles ?? []) if (!role.managed) blocks.push(block("role_conflict", "configuration", `Existing role '${role.name}' does not belong to this database operation.`, "Choose unique role names; Devbox does not overwrite roles it does not own."));
    } catch (e) { blocks.push(safeError(e, block("ssh_failed", "connection", "The SSH check of the target failed.", "Check that the server is reachable and its admin access."))); }
    return blocks;
  }
  async function verify(plan: OnboardingPlan): Promise<void> {
    if (isDirect(plan.trustedServer)) return directVerify(plan);
    const ctx = await context(plan);
    const tunnel = match(ctx.items, plan.server.key, "SSH_KEY");
    const passwordItem = match(ctx.items, plan.entry.opItem, "PASSWORD");
    if (!tunnel || !passwordItem) return fail("setup_incomplete", "configuration", "The setup does not have all expected 1Password items.", "Retry the approved operation with the same ID.");
    const password = await read(passwordItem, "password");
    await withKey(tunnel, async path => {
      // Use an isolated ephemeral local port for verification, never collide
      // with a running proxy tunnel or mistake an unrelated listener for SSH.
      const reserve = createServer();
      const port = await new Promise<number>((resolve, reject) => { reserve.once("error", reject); reserve.listen(0, "127.0.0.1", () => { const p = (reserve.address() as { port: number }).port; reserve.close(() => resolve(p)); }); });
      const dir = mkdtempSync(join(tmpdir(), "devd-db-check-")); const sock = join(dir, "ssh-control");
      try {
        const start = await run([...sshArgs(plan, path, false), "-M", "-S", sock, "-f", "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${plan.entry.hostPort}`], { timeoutMs: 20_000 });
        if (start.code || start.timedOut) return fail("tunnel_verification_failed", "connection", "The dedicated DB tunnel failed verification.", "Check the public key installation, the SSH restrictions and the loopback relay; a retry reuses the same operation.");
        try {
          if (d.verifyDatabase) await d.verifyDatabase(plan, password, port);
          else {
            const checks: [string, string, string][] = [[plan.entry.roUser, password, onboardingVerifySql(plan)]];
            for (const [role, title, migration] of [[plan.entry.rwUser, plan.entry.rwOpItem, false], [plan.entry.migrationUser, plan.entry.migrationOpItem, true]] as const) {
              if (!role || !title) continue;
              const item = match(ctx.items, title, "PASSWORD");
              if (!item) return fail("setup_incomplete", "configuration", "The write role has no verified credentials.", "Retry the approved operation.");
              checks.push([role, await read(item, "password"), onboardingWriteVerifySql(plan, role, migration)]);
            }
            for (const [role, secret, query] of checks) {
              if (plan.entry.engine === "mariadb") { await verifyMariaRole(plan, role, secret, port); continue; }
              const sql = postgres({ host: "127.0.0.1", port, database: plan.entry.db, username: role, password: secret, max: 1, prepare: false, connect_timeout: 10, idle_timeout: 1 });
              try {
                const rows = await sql.unsafe(query);
                if (rows[0]?.verified !== true) return fail(role === plan.entry.roUser ? "ro_verification_failed" : "write_verification_failed", "permission", `Role '${role}' failed the approved-privileges check.`, "Check the roles and the implicit PUBLIC privileges; access is not ready yet.");
              } finally { await sql.end({ timeout: 2 }); }
            }
          }
        } catch (e) {
          if (e instanceof OnboardingHostError) throw e;
          return fail("db_verification_failed", "connection", "The real DB login through the dedicated tunnel failed.", "Check the database authentication, the psql/pg_hba rules and the relay; the catalog has not been updated yet.");
        }
      } finally {
        await run([...sshArgs(plan, path, false), "-S", sock, "-O", "exit"], { timeoutMs: 5_000 });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  return {
    preflight, verify,
    execute: (plan, onProgress = () => {}) => serial.run(plan.entry.server, async () => {
      if (isDirect(plan.trustedServer)) return directExecute(plan, onProgress);
      const blocks = await preflight(plan);
      if (blocks.length) throw new OnboardingHostError(blocks[0]!);
      const ctx = await context(plan);
      onProgress("1password_items");
      const tunnel = await ensureItem(plan.server.key, "SSH_KEY", ctx.vault);
      const credentials: Record<string, string> = {};
      for (const [role, title] of [[plan.entry.roUser, plan.entry.opItem], [plan.entry.rwUser, plan.entry.rwOpItem], [plan.entry.migrationUser, plan.entry.migrationOpItem]]) {
        if (role && title) credentials[role] = await read(await ensureItem(title, "PASSWORD", ctx.vault), "password");
      }
      // Derive public keys from private material locally; never trust freeform
      // public-key fields and never install the admin key as a tunnel key.
      const publicKey = await withKey(tunnel, async path => {
        const r = await run(["ssh-keygen", "-y", "-f", path], { timeoutMs: 10_000 });
        const publicPart = r.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
        if (r.code || !/^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+$/.test(publicPart)) return fail("invalid_tunnel_key", "configuration", "The dedicated SSH key is invalid.", "Fix the SSH Key item in 1Password.");
        return publicPart;
      });
      const adminPublic = await withKey(ctx.admin, async path => (await run(["ssh-keygen", "-y", "-f", path], { timeoutMs: 10_000 })).stdout.trim().split(/\s+/).slice(0, 2).join(" "));
      if (adminPublic === publicKey) return fail("admin_key_reused", "permission", "The tunnel item contains the admin key.", "Generate a separate SSH key; admin key material is never used for the DB tunnel.");
      onProgress("restricted_tunnel_and_loopback_relay");
      const catalogPorts = d.catalog().databases.filter(e => e.server === plan.entry.server && (e.tunnelUser ?? "") === plan.server.user).map(e => e.hostPort);
      await remote(plan, ctx.admin, onboardingInstallScript(plan, publicKey, [...new Set([...catalogPorts, plan.entry.hostPort])].sort((a, b) => a - b)));
      onProgress("database_roles");
      if (plan.entry.engine === "mariadb") {
        await remote(plan, ctx.admin, mariaRoleScript(plan, credentials));
        onProgress("database_roles_ready");
        return;
      }
      const sql = onboardingRoleSql(plan, credentials);
      // SQL containing passwords goes over the encrypted SSH stdin into psql;
      // role statements deliberately suppress statement/error logging remotely.
      const script = `set -eu\n[ "$(id -u)" = 0 ] || { echo BLOCK:admin_privileges; exit 1; }\ndocker exec -i ${shell(plan.input.container)} sh -c ${shell(`exec psql -X -h /var/run/postgresql -q -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d ${shell(plan.entry.db)}`)} <<'DEVD_SQL_END'\n${sql}\nDEVD_SQL_END\n`;
      await remote(plan, ctx.admin, script);
      onProgress("database_roles_ready");
      // The durable Operations workflow owns the separate verification phase
      // and commits the catalog only after verify(plan) succeeds.
    }),
  };
}
