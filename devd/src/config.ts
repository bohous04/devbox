import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CcUpkeepSettings } from "./ccUpkeep";
import type { ApnsConfig } from "./apns";
import { sshServerIssues, type SshServer } from "./sshServers";

export type Provider = "github" | "gitea";
export interface Source { provider: Provider; org?: string; user?: string; visibility?: "all" | "private" | "public"; instance?: string }
export interface RepoRef { name: string; provider: Provider; repo?: string; cloneUrl?: string }
export interface ProjectCfg { sources?: Source[]; repos?: RepoRef[] }
export interface FolderCfg extends ProjectCfg { projects?: Record<string, ProjectCfg> }
export interface CriticSettings { provider: "claude" | "codex" | "antigravity"; model: string; rounds: number; timeoutSec: number }
export interface AccountPoolSettings { thresholdPct: number; hysteresisPct: number; cooldownMinutes: number; activePollSec: number; idlePollSec: number; preferredAccountId: string | null; spilloverPct: number; projectAccounts: Record<string, string>; soloAccountId: string | null }
export interface Settings {
  autoStopHours: number; portRangeStart: number; portsPerSession: number; diskWarnPercent: number;
  critic?: Partial<CriticSettings>; ccUpkeep?: Partial<CcUpkeepSettings>; accountPool?: Partial<AccountPoolSettings>;
  /** modelKey (see agents.ts) → model name in the proxy. In config, not in code:
   *  model names change more often than the image should be rebuilt. */
  proxyModels?: Record<string, string>;
  /** modelKey → manually set context window (tokens). Overrides the OpenRouter catalog
   *  and the 1M default of cliproxy profiles (see agentContextTokens). Edited from the dashboard
   *  (AI subscriptions → Model context windows). */
  proxyContext?: Record<string, number>;
  /** Where containers go for the proxy. Default see DEFAULT_CLIPROXY_URL. */
  cliproxyUrl?: string;
  /** APNs key (.p8 path) + Key ID/Team ID/bundle id — ALWAYS in config, NEVER
   *  in the vault: the key lies in a file on the VPS disk (root-only), the same reasoning
   *  as for the OpenRouter key (a locked vault after a restart would otherwise silence exactly the
   *  notifications that are supposed to report that something is down). See devd/src/apns.ts. */
  apns?: ApnsConfig;
  /** Phone channel for the notify pipeline (devd/src/index.ts `notify`). Default
   *  "pushover" until the iOS app is live — switching to "apns" is a deliberate step
   *  (dashboard/config) + devd restart. */
  phoneChannel?: "apns" | "pushover";
  /** InstaBox overflow (the internal design notes).
   *  Without `devdUrl` the feature is off. Read at devd startup — enabling = restart. */
  instabox?: Partial<InstaboxSettings>;
}

// `vmPort`: a second devd listener only for the InstaBox VM (C1) — hooks, OTel, git proxy, health,
// lease. The host is taken from `devdUrl`; ACL tag:devbox-instabox may reach only this port.
export interface InstaboxSettings { devdUrl: string; vmPort: number; suggestRamPct: number; suggestLoadPerCore: number; desktopWidth: number; desktopHeight: number }

// InstaBox is opt-in: without devdUrl (the devd Tailscale address that hooks, OTel
// and git proxy from the VM target) the feature is not enabled at all — the container would otherwise hook into the void.
export function resolveInstaboxSettings(s?: Partial<InstaboxSettings>): InstaboxSettings | null {
  if (!s?.devdUrl) return null;
  return { vmPort: 4301, suggestRamPct: 80, suggestLoadPerCore: 1, desktopWidth: 1440, desktopHeight: 900, ...s, devdUrl: s.devdUrl };
}
export interface DevConfig {
  version: 1; settings: Settings; folders: Record<string, FolderCfg>; giteaInstances?: { name: string; url: string }[];
  /** Servers for SSH keys (see sshServers.ts) — alias → user/host/port for resolving
   *  the target of SSH permission requests. Editing only on the web, see docs spec section 5. */
  sshServers?: SshServer[];
}
export interface Secrets {
  giteaTokens?: Record<string, string>; listenerToken?: string; mcpServers?: Record<string, unknown>;
  pushover?: { token: string; user: string }; opServiceAccountToken?: string;
  // Monitoring (Hardware tab). None of this may leave the server — the API returns only
  // measured numbers, not credentials.
  beszel?: { url: string; email: string; password: string };
  uptimeKuma?: { url: string; apiKey: string };
  /** Coolify for the operation broker (operationExec). `apps` maps project → application uuid. */
  coolify?: { url: string; token: string; apps: Record<string, string> };
  /** SSH to the remote machine from hardware.json (`host: "remote"`). */
  remoteSsh?: { host: string; port: number | string; user: string; key: string };
  /** @deprecated old name `remoteSsh` — read as a fallback. */
  lnrtSsh?: { host: string; port: number | string; user: string; key: string };
  // WATCH OUT: the CLIProxyAPI key is DELIBERATELY not here — see readCliproxyKey below. It used to be, and it
  // cost manual rewriting without a tool plus a proxy-profile outage after every devd restart.
}

/** Thresholds of the account selection policy and the poller cadence. In config, not hard-wired —
 *  tuned in operation according to how the pool on two accounts actually behaves.
 *
 *  `preferredAccountId` = null means "no preference" and the policy behaves
 *  exactly as before (the least loaded wins) — that is why it is the default: deploying
 *  the code by itself must not change the behaviour of the live pool. The preference is enabled
 *  deliberately by writing the id into the config.
 *
 *  `spilloverPct` is a LOWER threshold than `thresholdPct`: at it the others are only ADDED to the
 *  preferred account, whereas `thresholdPct` removes the account from the offer entirely. */
export const ACCOUNT_POOL_DEFAULTS: AccountPoolSettings = {
  thresholdPct: 90, hysteresisPct: 10, cooldownMinutes: 5, activePollSec: 60, idlePollSec: 300,
  preferredAccountId: null, spilloverPct: 60,
  // Empty map = no pinning, i.e. the existing behaviour. `soloAccountId`
  // is a MANUAL override of the whole policy (see allowedAccounts) — hence null, not "".
  projectAccounts: {}, soloAccountId: null,
};

/** Missing fields get defaults — old configs without `accountPool` remain valid. */
export function resolveAccountPool(s: Settings): AccountPoolSettings {
  return { ...ACCOUNT_POOL_DEFAULTS, ...(s.accountPool ?? {}) };
}

export class ConfigError extends Error {}

export const DEFAULT_CONFIG: DevConfig = {
  version: 1,
  settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 5, diskWarnPercent: 80, ccUpkeep: { enabled: true, windowStartHour: 3, windowEndHour: 5 } },
  folders: {
    apps: { repos: [], sources: [] },
    websites: { sources: [] },
  },
};

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
    );
  }
  return v;
}

export function saveJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(sortKeys(value), null, 2) + "\n");
}

export function saveConfig(path: string, cfg: DevConfig): void {
  saveJson(path, cfg);
}

export function validateConfig(value: unknown): DevConfig {
  const cfg = value as DevConfig;
  if (cfg?.version !== 1) throw new ConfigError("config.version must be 1");
  const s = cfg.settings;
  if (!s || [s.autoStopHours, s.portRangeStart, s.portsPerSession, s.diskWarnPercent].some((n) => typeof n !== "number"))
    throw new ConfigError("config.settings must contain numeric autoStopHours, portRangeStart, portsPerSession, diskWarnPercent");
  if (!cfg.folders || typeof cfg.folders !== "object") throw new ConfigError("config.folders must be an object");
  const sshIssues = sshServerIssues(cfg.sshServers);
  if (sshIssues.length > 0) throw new ConfigError(sshIssues[0]);
  return cfg;
}

export function loadConfig(path: string): DevConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`Cannot read config at ${path}: ${(e as Error).message}`);
  }
  return validateConfig(parsed);
}

/** MCP servers for `tools/agent-sync.ts`. It runs as a SEPARATE process, so it cannot
 *  reach the vault contents (which live only in devd memory) — after the switch to the vault
 *  on 12 Aug 2026 its `secrets.json` therefore vanished from under it, and since then it propagated only
 *  marketplaces and plugins, no MCP servers. Silently: `loadSecrets` on a missing file
 *  returns empty without an error. It only showed when the newly added Grok had no servers
 *  at all (Claude and Codex keep what was synced before the migration).
 *
 *  The fix is the same pattern as for gitea tokens a bit below: after the vault is unlocked, devd
 *  writes the values into a file with 0600 permissions and the tool picks them up from there.
 *
 *  An empty map is DELIBERATELY not saved: devd with a locked vault would otherwise overwrite a good
 *  file with emptiness and agent-sync would lose the servers it already had — exactly the trap
 *  the comment at materializeGiteaTokens warns about. */
export function materializeMcpServers(path: string, mcpServers: Record<string, unknown>): void {
  if (Object.keys(mcpServers).length === 0) return;
  try { writeFileSync(path, JSON.stringify({ mcpServers }), { mode: 0o600 }); }
  catch (e) { console.error(`materializing MCP servers into ${path} failed:`, (e as Error).message); return; }
  try { chmodSync(path, 0o600); } catch { /* the file exists, only the permissions did not stick */ }
}

/** Counterpart for agent-sync. A missing or corrupt file = empty, never an exception:
 *  the tool must finish even when nobody unlocked the vault — it just has nothing to propagate. */
export function readMcpServers(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ?? {};
  } catch { return {}; }
}

/** Shared key to CLIProxyAPI. It is NOT in the vault on purpose: it is a local password between devd
 *  and a service on the SAME machine, both under root — whoever reads that file can also read
 *  devd memory, so the vault protected almost nothing here. But it was paid for dearly:
 *  by manual rewriting for which no tool existed, and by proxy profiles not coming up after
 *  every devd restart (= locked vault).
 *
 *  The file is created by `install_cliproxy` with 0600 permissions next to the proxy config, into which it writes
 *  the same value. If it is missing, it returns null — devd must start even without the proxy
 *  installed, and agent-launch in the container handles it loudly. Empty content counts as
 *  missing: an empty key would be silently propagated into the container and cc would only fail on 401. */
/** Key to a foreign upstream (CLIProxyAPI, OpenRouter) from the file that owns it.
 *  DELIBERATELY not from the vault: it locks after every devd restart, so profiles running
 *  through a foreign model would be down after every deploy until someone manually unlocks it. */
export function readKeyFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const key = readFileSync(path, "utf8").trim();
  return key || null;
}

/** Saves the key (0600, creates the directory itself). An empty value DELETES the file —
 *  "disconnect the upstream" and "set an empty key" are not two states: readKeyFile reads
 *  an empty file the same as a missing one, so it would leave behind a seemingly
 *  configured state that does not work. */
export function writeKeyFile(path: string, key: string): void {
  const trimmed = key.trim();
  if (!trimmed) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${trimmed}\n`, { mode: 0o600 });
  // writeFileSync `mode` applies only on file CREATION — on rotation an existing
  // file would keep its original permissions. So chmod is unconditional.
  chmodSync(path, 0o600);
}

export function loadSecrets(path: string): Secrets {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Secrets;
}

/** Saves the gitea token map into secrets.json — keeps other keys. 0600 on creation. */
export function saveGiteaTokens(secretsPath: string, tokens: Record<string, string>): void {
  const secrets = loadSecrets(secretsPath);
  secrets.giteaTokens = tokens;
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(secretsPath, 0o600); } catch { /* best-effort — the write above already happened */ }
}

/** Map `host:port` → token for git credential lookup. An instance is keyed by HOST
 * (git sends `host:port`, e.g. `198.51.100.7:3000`), NOT by name — otherwise the
 * in-container helper and host-side clone would not find the token and fail with "could not read
 * Username". The single source of truth about keying; shared by materializeGiteaTokens (file for
 * git-credential-devbox) and credentialsForUrl in index.ts. `tokens` is name→token
 * (as in secrets.json), `instances` supplies the name→url map. */
export function giteaTokensByHost(instances: { name: string; url: string }[], tokens: Record<string, string>): Record<string, string> {
  const byHost: Record<string, string> = {};
  for (const inst of instances) {
    const token = tokens[inst.name];
    if (!token) continue;
    let host: string;
    try { host = new URL(inst.url).host; } catch { continue; } // unparsable URL → skip
    if (host) byHost[host] = token;
  }
  return byHost;
}

/** Materializes tokens (keyed by host, see giteaTokensByHost) for the in-container
 * credential helper. It must be readable by uid 1000 in the container (mount :ro), devd runs as
 * root. On the production host (root) we therefore give the file to the container user
 * (1000:1000) and keep 0600 — the token is NOT world-readable. When chown fails (test /
 * non-root), we fall back to 0644 so the helper never breaks (single-operator host;
 * the same 1000:1000 assumption as ensureOwned for the workspace). */
export function materializeGiteaTokens(path: string, tokens: Record<string, string>, instances: { name: string; url: string }[]): void {
  try { writeFileSync(path, JSON.stringify(giteaTokensByHost(instances, tokens)), { mode: 0o600 }); }
  catch (e) { console.error(`materializing gitea tokens into ${path} failed:`, (e as Error).message); return; }
  try { chownSync(path, 1000, 1000); chmodSync(path, 0o600); } // root: owned by the container user → 0600 is enough
  catch { try { chmodSync(path, 0o644); } catch { /* the file exists, only the permissions did not stick */ } }
}
