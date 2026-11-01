/**
 * Pure logic of the visual config editor. No React — everything is small
 * testable functions. Every mutation returns a NEW config (deep clone);
 * the original is never modified.
 *
 * Types mirror devd/src/config.ts — the PUT /api/config contract is unchanged.
 */

export type Provider = "github" | "gitea";
export type Visibility = "all" | "private" | "public";
export interface Source { provider: Provider; org?: string; user?: string; visibility?: Visibility; instance?: string }
export interface RepoRef { name: string; provider: Provider; repo?: string; cloneUrl?: string }
export interface ProjectCfg { sources?: Source[]; repos?: RepoRef[] }
export interface FolderCfg extends ProjectCfg { projects?: Record<string, ProjectCfg> }
// `critic` is optional and Partial — mirrors devd/src/config.ts (critic?: Partial<CriticSettings>).
// `getCritic` below fills missing fields with defaults, the same way the server does resolveCriticCfg.
export interface Settings { autoStopHours: number; portRangeStart: number; portsPerSession: number; diskWarnPercent: number; critic?: Partial<CriticCfgView>; accountPool?: Partial<AccountPoolCfgView> }
export interface GiteaInstance { name: string; url: string }
// A server for an SSH key (see devd/src/sshServers.ts) — an alias the operator picks
// in the config. `key` is the title of the 1Password SSH-key item. The dashboard only
// mirrors this shape (devd validates PUT /api/config anyway); it decides nothing itself.
export interface SshServer { name: string; key: string; user: string; host: string; port: number; note?: string }
export interface DevConfig { version: 1; settings: Settings; folders: Record<string, FolderCfg>; giteaInstances?: GiteaInstance[]; sshServers?: SshServer[] }

/** Mutation target: the folder itself (project undefined) or a project inside the folder. */
export interface Target { folder: string; project?: string }

export const validSeg = (s: string): boolean => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";

export function targetLabel(t: Target): string {
  return t.project === undefined ? `${t.folder}/` : `${t.folder}/${t.project}`;
}

export function cloneConfig(cfg: DevConfig): DevConfig {
  return structuredClone(cfg);
}

/** Local mirror of devd validateConfig — we never send a shape the server would reject. */
export function validateConfig(value: unknown): DevConfig {
  const cfg = value as DevConfig;
  if (!cfg || typeof cfg !== "object") throw new Error("config must be an object");
  if (cfg.version !== 1) throw new Error("config.version must be 1");
  const s = cfg.settings;
  if (!s || [s.autoStopHours, s.portRangeStart, s.portsPerSession, s.diskWarnPercent].some((n) => typeof n !== "number"))
    throw new Error("config.settings must contain numbers autoStopHours, portRangeStart, portsPerSession, diskWarnPercent");
  if (!cfg.folders || typeof cfg.folders !== "object" || Array.isArray(cfg.folders))
    throw new Error("config.folders must be an object");
  return cfg;
}

function cfgAt(cfg: DevConfig, t: Target): ProjectCfg | undefined {
  const f = cfg.folders[t.folder];
  if (!f) return undefined;
  return t.project === undefined ? f : f.projects?.[t.project];
}

function requireCfgAt(cfg: DevConfig, t: Target): ProjectCfg {
  const p = cfgAt(cfg, t);
  if (!p) throw new Error(`Unknown target ${targetLabel(t)}`);
  return p;
}

/* ---------- repos ---------- */

export function hasRepo(cfg: DevConfig, t: Target, name: string): boolean {
  return (cfgAt(cfg, t)?.repos ?? []).some((r) => r.name === name);
}

/** Adds a repo (dedupe by name). Returns a new config, leaves siblings unchanged. */
export function addRepo(cfg: DevConfig, t: Target, ref: RepoRef): DevConfig {
  if (!validSeg(ref.name)) throw new Error(`Invalid repo name "${ref.name}"`);
  const next = cloneConfig(cfg);
  const p = requireCfgAt(next, t);
  const repos = p.repos ?? (p.repos = []);
  if (!repos.some((r) => r.name === ref.name)) repos.push({ ...ref });
  return next;
}

export function removeRepo(cfg: DevConfig, t: Target, name: string): DevConfig {
  const next = cloneConfig(cfg);
  const p = requireCfgAt(next, t);
  if (p.repos) p.repos = p.repos.filter((r) => r.name !== name);
  return next;
}

/* ---------- repos by upstream (RepoBrowser) ---------- */

/**
 * The same repo name can exist under several owners (alice/x vs. bob/x) —
 * the browser therefore matches by provider + upstream `repo`, not by the local
 * `name`. Entries without `repo` (hand-written) fall back to a name match.
 * There can be several Gitea instances and the same owner/repo can live on both —
 * where both the entry and the query carry `cloneUrl` (it contains the instance host), it decides.
 */
function sameUpstream(r: RepoRef, provider: Provider, repo: string, cloneUrl?: string): boolean {
  if (r.provider !== provider) return false;
  if (r.cloneUrl !== undefined && cloneUrl !== undefined) return r.cloneUrl.toLowerCase() === cloneUrl.toLowerCase();
  if (r.repo === undefined) return r.name === repo.split("/").pop();
  return r.repo.toLowerCase() === repo.toLowerCase();
}

export function hasUpstreamRepo(cfg: DevConfig, t: Target, provider: Provider, repo: string, cloneUrl?: string): boolean {
  return (cfgAt(cfg, t)?.repos ?? []).some((r) => sameUpstream(r, provider, repo, cloneUrl));
}

export function removeUpstreamRepo(cfg: DevConfig, t: Target, provider: Provider, repo: string, cloneUrl?: string): DevConfig {
  const next = cloneConfig(cfg);
  const p = requireCfgAt(next, t);
  if (p.repos) p.repos = p.repos.filter((r) => !sameUpstream(r, provider, repo, cloneUrl));
  return next;
}

/** Local name for a new repo: `name`, on collision `name-owner` (then `name-owner-2`…). */
export function uniqueRepoName(cfg: DevConfig, t: Target, name: string, owner: string): string {
  const taken = new Set((cfgAt(cfg, t)?.repos ?? []).map((r) => r.name));
  if (!taken.has(name)) return name;
  const base = `${name}-${owner}`;
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

/* ---------- sources ---------- */

/** Source identity: provider + owner (org/user) + instance. */
export function sourceKey(s: Source): string {
  return `${s.provider}:${(s.org ?? s.user ?? "").toLowerCase()}:${s.instance ?? ""}`;
}

export function sourceOwner(s: Source): string {
  return s.org ?? s.user ?? "?";
}

export function findSource(cfg: DevConfig, t: Target, key: string): Source | undefined {
  return (cfgAt(cfg, t)?.sources ?? []).find((s) => sourceKey(s) === key);
}

/** Adds a source; replaces an existing one with the same identity (visibility change). */
export function addSource(cfg: DevConfig, t: Target, src: Source): DevConfig {
  if (!sourceOwner(src) || sourceOwner(src) === "?") throw new Error("Source must have an org or user");
  const next = cloneConfig(cfg);
  const p = requireCfgAt(next, t);
  const sources = p.sources ?? (p.sources = []);
  const i = sources.findIndex((s) => sourceKey(s) === sourceKey(src));
  if (i >= 0) sources[i] = { ...src };
  else sources.push({ ...src });
  return next;
}

export function removeSource(cfg: DevConfig, t: Target, key: string): DevConfig {
  const next = cloneConfig(cfg);
  const p = requireCfgAt(next, t);
  if (p.sources) p.sources = p.sources.filter((s) => sourceKey(s) !== key);
  return next;
}

/* ---------- folders & projects ---------- */

export function addFolder(cfg: DevConfig, name: string): DevConfig {
  if (!validSeg(name)) throw new Error(`Invalid folder name "${name}"`);
  if (cfg.folders[name]) throw new Error(`Folder "${name}" already exists`);
  const next = cloneConfig(cfg);
  next.folders[name] = {};
  return next;
}

export function removeFolder(cfg: DevConfig, name: string): DevConfig {
  const next = cloneConfig(cfg);
  delete next.folders[name];
  return next;
}

export function addProject(cfg: DevConfig, folder: string, name: string): DevConfig {
  if (!validSeg(name)) throw new Error(`Invalid project name "${name}"`);
  const next = cloneConfig(cfg);
  const f = next.folders[folder];
  if (!f) throw new Error(`Unknown folder "${folder}"`);
  const projects = f.projects ?? (f.projects = {});
  if (projects[name]) throw new Error(`Project "${name}" already exists`);
  projects[name] = {};
  return next;
}

export function removeProject(cfg: DevConfig, folder: string, name: string): DevConfig {
  const next = cloneConfig(cfg);
  const f = next.folders[folder];
  if (f?.projects) {
    delete f.projects[name];
    if (Object.keys(f.projects).length === 0) delete f.projects;
  }
  return next;
}

/* ---------- settings & gitea ---------- */

// Only plain NUMERIC settings edited with sliders/numbers on the Settings page.
// `critic` (and any other structured fields) do NOT BELONG in this list —
// they are edited/validated another way (getCritic/setCritic). A dedicated type instead
// of `keyof Settings` because `Settings` now also carries `critic` — `Record<keyof
// Settings, …>` would require it too, and assigning it min/max/label makes no sense.
export type NumericSettingKey = "autoStopHours" | "portRangeStart" | "portsPerSession" | "diskWarnPercent";

export function updateSetting(cfg: DevConfig, key: NumericSettingKey, value: number): DevConfig {
  const next = cloneConfig(cfg);
  next.settings[key] = value;
  return next;
}

export const SETTING_BOUNDS: Record<NumericSettingKey, { min: number; max: number; label: string }> = {
  autoStopHours: { min: 1, max: 168, label: "Auto-stop" },
  portRangeStart: { min: 1024, max: 64000, label: "Port range start" },
  portsPerSession: { min: 1, max: 100, label: "Ports per session" },
  diskWarnPercent: { min: 10, max: 99, label: "Disk warning" },
};

export function settingsIssues(s: Settings): string[] {
  const out: string[] = [];
  for (const k of Object.keys(SETTING_BOUNDS) as NumericSettingKey[]) {
    const b = SETTING_BOUNDS[k];
    const v = s[k];
    if (!Number.isFinite(v)) out.push(`${b.label}: must be a number`);
    else if (!Number.isInteger(v)) out.push(`${b.label}: must be an integer`);
    else if (v < b.min || v > b.max) out.push(`${b.label}: allowed range ${b.min}–${b.max}`);
  }
  return out;
}

export function addGiteaInstance(cfg: DevConfig): DevConfig {
  const next = cloneConfig(cfg);
  (next.giteaInstances ?? (next.giteaInstances = [])).push({ name: "", url: "" });
  return next;
}

export function updateGiteaInstance(cfg: DevConfig, index: number, patch: Partial<GiteaInstance>): DevConfig {
  const next = cloneConfig(cfg);
  const row = next.giteaInstances?.[index];
  if (!row) throw new Error("Unknown Gitea instance");
  Object.assign(row, patch);
  return next;
}

export function removeGiteaInstance(cfg: DevConfig, index: number): DevConfig {
  const next = cloneConfig(cfg);
  if (next.giteaInstances) {
    next.giteaInstances = next.giteaInstances.filter((_, i) => i !== index);
    if (next.giteaInstances.length === 0) delete next.giteaInstances;
  }
  return next;
}

export function giteaIssues(list: GiteaInstance[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of list ?? []) {
    if (!validSeg(g.name)) out.push(`Gitea: invalid instance name "${g.name || "(empty)"}"`);
    else if (seen.has(g.name)) out.push(`Gitea: duplicate name "${g.name}"`);
    seen.add(g.name);
    if (!/^https?:\/\/.+/.test(g.url)) out.push(`Gitea "${g.name || "?"}": URL must start with http(s)://`);
  }
  return out;
}

/* ---------- ssh servers ---------- */

export function addSshServer(cfg: DevConfig): DevConfig {
  const next = cloneConfig(cfg);
  (next.sshServers ?? (next.sshServers = [])).push({ name: "", key: "", user: "", host: "", port: 22 });
  return next;
}

export function updateSshServer(cfg: DevConfig, index: number, patch: Partial<SshServer>): DevConfig {
  const next = cloneConfig(cfg);
  const row = next.sshServers?.[index];
  if (!row) throw new Error("Unknown SSH server");
  Object.assign(row, patch);
  return next;
}

export function removeSshServer(cfg: DevConfig, index: number): DevConfig {
  const next = cloneConfig(cfg);
  if (next.sshServers) {
    next.sshServers = next.sshServers.filter((_, i) => i !== index);
    if (next.sshServers.length === 0) delete next.sshServers;
  }
  return next;
}

const SSH_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isNonEmptyNoWhitespace(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !/\s/.test(v);
}

/** Mirror of devd sshServerIssues (devd/src/sshServers.ts) — the same rules
 *  (name shape + uniqueness, key/user/host non-empty without spaces, port 1–65535),
 *  so the UI never offers to save a shape the server would reject anyway. */
export function sshServerIssues(list: SshServer[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  (list ?? []).forEach((s, i) => {
    if (typeof s.name !== "string" || !SSH_SERVER_NAME_RE.test(s.name)) {
      out.push(`SSH server[${i}]: invalid name "${s.name || "(empty)"}"`);
    } else if (seen.has(s.name)) {
      out.push(`SSH server[${i}]: duplicate name "${s.name}"`);
    } else {
      seen.add(s.name);
    }
    // `key` is a 1Password item title ("SSH Key - Client shop"): spaces are fine, empty is not.
    if (typeof s.key !== "string" || s.key.trim() === "") {
      out.push(`SSH server[${i}] ("${s.name || "?"}"): key must be a non-empty string`);
    }
    for (const field of ["user", "host"] as const) {
      if (!isNonEmptyNoWhitespace(s[field])) {
        out.push(`SSH server[${i}] ("${s.name || "?"}"): ${field} must be a non-empty string without whitespace`);
      }
    }
    if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
      out.push(`SSH server[${i}] ("${s.name || "?"}"): port must be an integer 1–65535`);
    }
  });
  return out;
}

/** All client-side validation problems at once (empty array = can be saved). */
export function configIssues(cfg: DevConfig): string[] {
  return [...settingsIssues(cfg.settings), ...giteaIssues(cfg.giteaInstances), ...sshServerIssues(cfg.sshServers)];
}

/* ---------- labels ---------- */

export function visibilityLabel(v: Visibility | undefined): string {
  return v === "private" ? "private only" : v === "public" ? "public only" : "all";
}

export function sourceLabel(s: Source): string {
  const inst = s.instance ? ` · ${s.instance}` : "";
  return `${sourceOwner(s)} · ${s.provider}${inst} · ${visibilityLabel(s.visibility)}`;
}

/* ---------- critic (settings.critic — consumed by resolveCriticCfg on the server) ---------- */

export interface CriticCfgView { provider: "claude" | "codex" | "antigravity"; model: string; rounds: number; timeoutSec: number }

export function getCritic(cfg: DevConfig): CriticCfgView {
  const c = cfg.settings.critic ?? {};
  return {
    provider: c.provider === "codex" || c.provider === "antigravity" ? c.provider : "claude",
    model: typeof c.model === "string" ? c.model : "",
    rounds: Number.isFinite(c.rounds) ? (c.rounds as number) : 2,
    timeoutSec: Number.isFinite(c.timeoutSec) ? (c.timeoutSec as number) : 240,
  };
}

// Models cannot be listed programmatically from the Claude, Codex or Antigravity CLI (see
// the comment at the datalist in Settings.tsx), so the field stays free text — this
// function only gives the datalist the usual values for the selected provider.
export function criticModelSuggestions(provider: CriticCfgView["provider"]): string[] {
  if (provider === "claude") return ["opus", "sonnet", "haiku"];
  if (provider === "antigravity") {
    return ["default", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "claude-opus-5-5-high"];
  }
  return ["default"];
}

export function setCritic(cfg: DevConfig, patch: Partial<CriticCfgView>): DevConfig {
  const cur = getCritic(cfg);
  const critic = { ...cur, ...patch };
  // Switching the provider discards the previously typed model (it belonged to the old provider) →
  // the new provider uses its default. An explicit model in the same patch takes precedence.
  if (patch.provider && patch.provider !== cur.provider && patch.model === undefined) {
    critic.model = "";
  }
  return { ...cfg, settings: { ...(cfg.settings ?? {}), critic } };
}

/* ---------- account pool (settings.accountPool — consumed by resolveAccountPool on the server) ---------- */

/** Account pool policy. Mirrors `AccountPoolSettings` in devd/src/config.ts —
 *  only the fields controlled from the dashboard (poller cadence, hysteresis and
 *  cooldown stay in the config on the server; nobody tunes them from here). */
export interface AccountPoolCfgView {
  preferredAccountId: string | null;
  spilloverPct: number;
  thresholdPct: number;
  projectAccounts: Record<string, string>;
  soloAccountId: string | null;
}

const ACCOUNT_POOL_VIEW_DEFAULTS: AccountPoolCfgView = {
  preferredAccountId: null, spilloverPct: 60, thresholdPct: 90,
  projectAccounts: {}, soloAccountId: null,
};

export function getAccountPool(cfg: DevConfig): AccountPoolCfgView {
  const p = cfg.settings.accountPool ?? {};
  return {
    preferredAccountId: typeof p.preferredAccountId === "string" ? p.preferredAccountId : null,
    spilloverPct: typeof p.spilloverPct === "number" ? p.spilloverPct : ACCOUNT_POOL_VIEW_DEFAULTS.spilloverPct,
    thresholdPct: typeof p.thresholdPct === "number" ? p.thresholdPct : ACCOUNT_POOL_VIEW_DEFAULTS.thresholdPct,
    // A copy, not a live reference to the map from the config (M5) — callers (setProjectPin,
    // pinnedProjects, …) chain further spreads on the result, but if someone reached
    // in here directly, the mutation would go all the way into `cfg.settings.accountPool`.
    projectAccounts: { ...(p.projectAccounts ?? {}) },
    soloAccountId: typeof p.soloAccountId === "string" ? p.soloAccountId : null,
  };
}

// The patch is merged ONTO the raw `cfg.settings.accountPool`, not onto the five-field
// view from getAccountPool (I1). The server holds nine fields (`AccountPoolSettings` in
// devd/src/config.ts), the dashboard controls only five of them — `hysteresisPct`,
// `cooldownMinutes`, `activePollSec` and `idlePollSec` are not projected here at all
// (see AccountPoolCfgView above). Building `accountPool` purely from
// `getAccountPool(cfg)` would silently drop them on EVERY save from the dashboard
// and the server would replace them with defaults — exactly what the comment at
// `getAccountPool` promised would not happen.
export function setAccountPool(cfg: DevConfig, patch: Partial<AccountPoolCfgView>): DevConfig {
  const accountPool = { ...(cfg.settings.accountPool ?? {}), ...patch };
  return { ...cfg, settings: { ...(cfg.settings ?? {}), accountPool } };
}

// A copy of the map, not a mutation: the draft goes to the server only via Save + push, so
// the originally loaded config must stay untouched for the "is there anything to save" comparison.
export function setProjectPin(cfg: DevConfig, project: string, accountId: string): DevConfig {
  const projectAccounts = { ...getAccountPool(cfg).projectAccounts, [project]: accountId };
  return setAccountPool(cfg, { projectAccounts });
}

export function removeProjectPin(cfg: DevConfig, project: string): DevConfig {
  const projectAccounts = { ...getAccountPool(cfg).projectAccounts };
  delete projectAccounts[project];
  return setAccountPool(cfg, { projectAccounts });
}

/* ---------- merging on save ---------- */

/**
 * Folders and Settings are two pages over ONE config file. If each one
 * saved its whole draft, the second save would silently revert the first one's changes.
 * So before the PUT, a FRESH state is taken from the server and only the keys
 * owned by the given page are overwritten.
 */
export function mergeFolders(server: DevConfig, draft: DevConfig): DevConfig {
  return { ...server, folders: structuredClone(draft.folders) };
}

/** The opposite: Settings owns everything EXCEPT folders. */
export function mergeSettings(server: DevConfig, draft: DevConfig): DevConfig {
  return { ...structuredClone(draft), folders: server.folders };
}

/** SshApprovals (Servers section) owns only `sshServers` — not settings,
 *  giteaInstances or folders. Without its own merge it would share mergeSettings
 *  with the Settings page and two saves from different tabs would overwrite each other. */
export function mergeSshServers(server: DevConfig, draft: DevConfig): DevConfig {
  const next = { ...server };
  if (draft.sshServers?.length) next.sshServers = structuredClone(draft.sshServers);
  else delete next.sshServers;
  return next;
}
