import { loadRemoteRoute, inspectRemoteContainer, prepareRemoteWorkspace, restoreExactSession, retainRemoteWorkspace, type RemoteRoute } from "../../infra/codex-remote/restoreSession";
import { codexRemoteLaunchScope } from "./codexRemoteLaunch";
import type { Database } from "bun:sqlite";
import { chmodSync, chownSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { liveAgentPresent, staleAccountMounts } from "./accountMountRepair";
import { specFor, usesProxy, type Upstream } from "./agents";
import { parseProcTree, PS_TREE_CMD } from "./ccUpkeep";
import { insteadOfEnv } from "./gitProxy";
import { dindCleanupPlan, dindEnsurePlan, dindName, dindNetwork, dindNetworkCreate, dindSubnetCandidates, dockerHostFor } from "./dind";
import { IBX_PATHS, toRemoteRunOpts } from "./instabox/runOpts";
import type { DevConfig, Settings } from "./config";
import { deleteGitStat, deleteSession, getRepoAgent, getSession, insertSession, listSessions, logEvent, releaseLeasesForSession, setAutoEnd, setRepoAgent, setSessionAgent, setSessionBranch, updateSession, type AgentName, type SessionRow } from "./db";
import { containerEnv, containerMountDestinations, containerState, execInContainer, removeContainer, runContainer, startContainer, stopContainer, type RunOpts } from "./docker";
import { dockerArgv } from "./dockerTarget";
import { inspectCanonicalWorkspace, removeStoppedWorkspaceContainer, type CanonicalWorkspaceContainer } from "./canonicalWorkspace";
import { archiveBranch, cloneBare, cloneRepo, conflictPrompt, type CloneProgress, defaultBranch, ensureWorktree, fetchBare, pullWithRebase, removeWorktree, sh, trackRemote, worktreeBranch, type PullResult } from "./git";
import { contextLengthCached } from "./openrouterModels";
import { allocatePortBase } from "./ports";
import { barePath, isBareLayout, workspacePath } from "./tree";
import { prodKeyMounts, type Access, type Catalog } from "./prodDb";
import { recoverManagedSession } from "./recovery";
import { revokeSessionShares } from "./shares";

export const DEFAULT_CONTROL_ROOT = "/var/lib/devd/sessions";
export const DEFAULT_DEVD_URL = "http://host.docker.internal:4300";
export const DEFAULT_CLIPROXY_URL = "http://host.docker.internal:8317";
/** OpenRouter serves the Anthropic protocol under this root. Claude Code appends
 *  `/v1/messages` itself, which is why `/v1` is DELIBERATELY not here — with it,
 *  requests would go to /v1/v1/messages, i.e. a 404 on every request. */
export const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api";

/** Resource attributes for the OTel exporter in the container.
 *  `repo` is deliberately here next to `project`: metrics must be attributable even after
 *  the session ends and its row disappears from the `sessions` table. While the repo was looked up
 *  via a join, ALL ended sessions fell into a single "—".
 *  `devbox.host` distinguishes work done in the devbox from work on the mac — the mac sends into the same
 *  pipe with host=mac. */
export function otelResourceAttributes(sessionId: string, project: string, repo: string): string {
  return `devbox.session.id=${sessionId},project=${project},repo=${repo},devbox.host=devbox`;
}

export class ExternalStartError extends Error {
  constructor(message: string, public kind: "unknown" | "not-running") { super(message); }
}

export class RestartError extends Error {
  constructor(message: string, public kind: "unknown" | "not-solo" | "not-stopped") { super(message); }
}

/** Lifecycle of an InstaBox session as the SessionManager calls it (implemented by
 *  instabox/sessions.ts InstaboxSessions). Interface only, so sessions.ts does not have to
 *  import the InstaBox module at runtime. */
export interface InstaboxLifecycle {
  resume(s: SessionRow): Promise<void>;
  pause(s: SessionRow, reason: "manual" | "idle"): Promise<void>;
  end(s: SessionRow): Promise<void>;
}

export interface SessionDeps {
  db: Database; cfg: DevConfig; root: string; image: string;
  bindIp?: string; extraMounts?: string[]; cmd?: string[]; now?: () => number;
  controlRoot?: string; devdUrl?: string;
  /** Time zone of the containers. Without it they would run in UTC, i.e. differently from the host. */
  tz?: string;
  /** Whether the host runs the storage guard (infra/storage-guard); sessions then get
   *  DEVBOX_STORAGE_GUARD=1 and the in-container git/docker wrapper enforces budgets. */
  storageGuard?: () => boolean;
  ghConfigDir?: string; giteaTokensPath?: string;
  /** Issues a dummy git token for the session. Without it the shared file with the
   *  real tokens is mounted (the state before phase 2). */
  issuePlaceholder?: (session: string, instance: string) => string;
  giteaInstances?: () => { name: string; url: string }[];
  /** Invalidates the session's dummies when the session ends. */
  revokePlaceholder?: (session: string) => void;
  /** Sidecar with its own docker daemon instead of the host socket. Opt-in. */
  dind?: boolean;
  /** Is the session shared or tainted (shareTaint.ts) RIGHT NOW, relative to the container that
   *  exists? Such sessions do not get a dind sidecar (a privileged daemon = root on the
   *  host for the terminal guest, final review C2). Error = fail-closed (treated as yes). */
  shareRestricted?: (session: string) => Promise<boolean>;
  // Per-repo git auth env keyed by clone URL (see giteaAuthEnv): host git has no
  // gitea credential helper, so clone/pull of a private gitea repo would otherwise fail.
  credentials?: (url: string) => Record<string, string>;
  notify?: (title: string, message: string) => void;
  // Account profile mounts. A FUNCTION, not an array: accounts are added while devd runs, so the list
  // must be computed when the container is created, not once at startup.
  accountMounts?: () => string[];
  prodCatalog?: Catalog; prodDbAccess?: Record<string, Access>; prodKeyPath?: (key: string) => string | Promise<string>;
  /** Key for the proxy. A FUNCTION, not a value: the vault is unlocked while devd runs, so it
   *  must be read when the container is created, not once at startup. */
  cliproxyKey?: () => string | null;
  /** Key for OpenRouter. A FUNCTION again: the file can be overwritten from the dashboard while devd runs,
   *  so a value captured at startup would lie after the key is replaced. */
  openrouterKey?: () => string | null;
  /** Fresh settings from disk. A FUNCTION, not a value: `cfg` is a snapshot from the moment
   *  devd started, but the model of the proxy profile changes from the dashboard at runtime. Whoever reads
   *  from the snapshot assembles a container environment that has long been invalid on disk. */
  settings?: () => Settings;
  /** Keys of currently running operations, SHARED with accountSwitch/agentSwitch (index.ts
   *  `accountSwitchInFlight`). Without sharing, lifecycle and an account switch could
   *  restart the same container at once. Tests supply their own Set. */
  instabox?: InstaboxLifecycle;
  inFlight?: Set<string>;
  /** Offsite backup of the session before its container is deleted (storageGuard.ts). It can take
   *  tens of minutes — End must wait for it, otherwise the storage guard refuses `docker rm`. */
  preserveForEnd?: (container: string) => Promise<void>;
}

// Read-only bind mounts that give the container git credentials: the host's gh
// config (for github.com, via `gh auth setup-git`) and a token file materialized
// from secrets.giteaTokens (consumed by image/git-credential-devbox).
/** Contents of `gitea-tokens.json` for the CONTAINER: the key is the devd host (git now goes there via
 *  `insteadOf`), the value a dummy. The real token never reaches the container.
 *  One dummy per session is enough — the proxy recognizes the instance from the path `/git/<instance>/`. */
export function sessionGitTokens(
  instances: { name: string; url: string }[],
  session: string,
  issue: (session: string, instance: string) => string,
  devdUrl: string,
): Record<string, string> {
  if (!instances.length) return {};
  let host: string;
  // A broken URL must not take down the whole session — better no git credentials than a crash.
  try { host = new URL(devdUrl).host; } catch { return {}; }
  if (!host) return {};
  return { [host]: issue(session, instances[0]!.name) };
}

export function credentialMounts(ghConfigDir?: string, giteaTokensPath?: string): string[] {
  const m: string[] = [];
  if (ghConfigDir) m.push(`${ghConfigDir}:/home/dev/.config/gh:ro`);
  if (giteaTokensPath) m.push(`${giteaTokensPath}:/run/devbox-git/gitea-tokens.json:ro`);
  return m;
}

// Which agent will run: explicit choice (picker, API) → the remembered choice for the repo
// (repo_prefs) → claude. Pure, so it can be tested without docker.
export function resolveAgent(explicit: AgentName | undefined, remembered: AgentName | null | undefined): AgentName {
  return explicit ?? remembered ?? "claude";
}

/** Must the container be rebuilt because of the agent? It compares REALITY — the container's
 *  baked-in DEVD_AGENT — not the DB record: after a live agent swap (agentSwitch.ts) the
 *  DB carries the new profile, but the container has the old one baked in, so `docker start` would
 *  silently return the session to the old agent. The DB serves only as a fallback when the env cannot be read
 *  (container missing, inspect failed, a prehistoric container without DEVD_AGENT). */
export function bakedAgentStale(baked: string | undefined, dbAgent: string | null | undefined, resolved: AgentName): boolean {
  return (baked ?? dbAgent ?? "claude") !== resolved;
}

/** Env for profiles running through the proxy; an empty object for native profiles.
 *  A locked vault MUST NOT prevent the container from being created — a session without a key is
 *  fine, a session without a container is not. The missing key is reported later by
 *  agent-launch, loudly and clearly (see Task 13). */
/** Which key source belongs to which upstream. A separate function so it can be verified without
 *  docker — otherwise swapped sources only show up as a 401 on the first request inside cc.
 *  `?? null` unifies "dep not wired" (undefined) and "no key" (null) into one
 *  value; nobody needs to distinguish them, both end with the same message from agent-launch. */
/** Settings the container environment is assembled from. Without a wired reader, and also with an
 *  unreadable config, it falls back to the startup snapshot — a stale value is still better
 *  than a session that never gets created because of the config. */
export function sessionSettings(d: Pick<SessionDeps, "cfg" | "settings">): Settings {
  try { return d.settings?.() ?? d.cfg.settings; }
  catch (e) { console.error("fresh config unavailable, using the startup snapshot:", (e as Error).message); return d.cfg.settings; }
}

export function upstreamKey(d: Pick<SessionDeps, "cliproxyKey" | "openrouterKey">): (u: Upstream) => string | null {
  return (u) => (u === "openrouter" ? d.openrouterKey?.() : d.cliproxyKey?.()) ?? null;
}

/** Default window for cliproxy models (gpt-5.6-sol, grok-4.5): the public catalog has no windows
 *  for them, and cc's assumed 200k made them compact over and over (with ~120k of MCP tools
 *  at baseline, immediately). User decision 2026-08-22: rather 1M with the risk that a model
 *  with a smaller real window hits an API error instead of compacting (handled by a manual /compact),
 *  than a guaranteed endless compact. */
export const CLIPROXY_DEFAULT_CTX = 1_000_000;

/** Valid manual window override from the dashboard (settings.proxyContext), otherwise null.
 *  Nonsense values (0, negative, NaN) behave as if they were not in the config. */
export function contextOverride(settings: Settings, modelKey: string): number | null {
  const v = settings.proxyContext?.[modelKey];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Context window for a proxy profile: the manual override from the dashboard beats everything;
 *  without it, OpenRouter has a public catalog (lookup, cache see openrouterModels.ts)
 *  and cliproxy gets CLIPROXY_DEFAULT_CTX. Native profile null — cc knows its models
 *  including their windows and the env would only lie to it. */
export async function agentContextTokens(agent: AgentName, settings: Settings, lookup: (model: string) => Promise<number | null>): Promise<number | null> {
  if (!usesProxy(agent)) return null;
  const spec = specFor(agent);
  const manual = contextOverride(settings, spec.modelKey!);
  if (manual !== null) return manual;
  if (spec.upstream === "cliproxy") return CLIPROXY_DEFAULT_CTX;
  const model = settings.proxyModels?.[spec.modelKey!];
  if (!model) return null;
  return lookup(model);
}

/** All DEVD_* names that proxyEnv() can emit — they live RIGHT NEXT TO the emitter,
 *  so a new key cannot be added without extending the list (guarded by proxyEnv.test.ts).
 *  An agent swap (agentSwitch.ts) uses the list to clear the old profile's values
 *  from the pane shell and from the tmux env — a key outside the list would silently survive the switch. */
export const PROXY_ENV_KEYS = [
  "DEVD_AGENT_MODEL", "DEVD_UPSTREAM_URL", "DEVD_UPSTREAM_KEY", "DEVD_AGENT_CTX",
  "DEVD_CLIPROXY_URL", "DEVD_CLIPROXY_KEY",
] as const;

export function proxyEnv(agent: AgentName, settings: Settings, key: (u: Upstream) => string | null, ctx?: number | null): Record<string, string> {
  if (!usesProxy(agent)) return {};
  const spec = specFor(agent);
  const modelKey = spec.modelKey!;    // usesProxy() above guarantees it is here
  const upstream = spec.upstream!;    // and agents.test.ts that a proxy profile has this too
  const url = upstream === "openrouter"
    ? DEFAULT_OPENROUTER_URL
    : settings.cliproxyUrl ?? DEFAULT_CLIPROXY_URL;
  let apiKey = "";
  try { apiKey = key(upstream) ?? ""; }
  catch (e) { console.error(`key for upstream ${upstream} unavailable:`, (e as Error).message); }
  return {
    DEVD_AGENT_MODEL: settings.proxyModels?.[modelKey] ?? "",
    DEVD_UPSTREAM_URL: url,
    DEVD_UPSTREAM_KEY: apiKey,
    // The model's context window (OpenRouter /v1/models). Without it cc assumes 200k for an unknown model
    // and keeps compacting. Inert name: it is translated to CLAUDE_CODE_MAX_CONTEXT_TOKENS
    // only by agent-launch in the proxy branch, so the active ANTHROPIC_* name does not leak
    // into another profile started alongside in the same container. An unknown window omits the key
    // (not empty): proxyEnvStale compares only keys present in fresh, so a lookup outage
    // does not cause a recreate — and a later success, conversely, quietly heals the container.
    ...(typeof ctx === "number" ? { DEVD_AGENT_CTX: String(ctx) } : {}),
    // Old names with the same value. A devd deploy does NOT recreate containers and
    // `agent-launch.sh` is baked into the image, so until the image is rebuilt and the
    // containers are recreated, a running claude-gpt/claude-grok still reads these names.
    // Once both have happened, this pair can go.
    DEVD_CLIPROXY_URL: url,
    DEVD_CLIPROXY_KEY: apiKey,
  };
}

/** Id for a new session in the given repo. The first keeps today's form (`dev-<project>-<repo>`),
 *  so running sessions on the VPS do not have to be renumbered — they carry it in the event history,
 *  metrics and the container name. Further ones get the lowest free `n ≥ 2`.
 *
 *  The number is searched from the bottom, so a gap left by an ended session gets filled. Without that the numbers
 *  would keep climbing and nothing would ever compact them. */
export function nextSessionId(db: Database, project: string, repo: string, leftover: (id: string) => boolean = () => false): string {
  // `leftover`: an ended session left its working directory behind (end() keeps it for restoring
  // the native conversation). A new session would settle into it along with foreign files and a branch —
  // such a number is skipped until the directory disappears.
  const free = (id: string) => !getSession(db, id) && !leftover(id);
  const base = `dev-${project}-${repo}`;
  if (free(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (free(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error(`Too many sessions for ${project}/${repo}`);
}

/** The session `open()` WITHOUT `fresh` should attach to — i.e. "give me the one that exists for this
 *  repo". `null` = there is none and the caller creates a new one.
 *
 *  The lookup is by columns (project, repo), not by the base id: that was silent and
 *  wrong. When the row `dev-<project>-<repo>` was missing (the session ended, `end()` deletes it),
 *  `nextSessionId` returned it as free and "attach" created a NEW container next to the
 *  running `-2`; when it was stopped, it was revived instead of the running one.
 *
 *  The order is DETERMINISTIC, so `dev <repo>` does not do something different each time:
 *  1. running before stopped — the user was answering a question about a RUNNING session,
 *  2. on a tie, the lowest ordinal (base, then `-2`, `-3`).
 *
 *  The ordinal is read from the rest of the id after the KNOWN base (empty = 1), not by guessing a number from the end
 *  of the string — `dev-portal-web-2` is otherwise indistinguishably the second session of repo `web` and the first
 *  session of repo `web-2`. The column filter knows the base, so the rest is unambiguous.
 *  The key (project, repo) is the same one `nextSessionId` numbers by (the folder is not in the id). */
export function existingSessionId(db: Database, project: string, repo: string, accept: (s: SessionRow) => boolean = () => true): string | null {
  const base = `dev-${project}-${repo}`;
  const ordinal = (id: string) => {
    if (!id.startsWith(base)) return Number.MAX_SAFE_INTEGER;   // foreign id form → last
    const rest = id.slice(base.length);
    return rest === "" ? 1 : Number(rest.slice(1)) || Number.MAX_SAFE_INTEGER;
  };
  const rows = listSessions(db)
    .filter((s) => s.project === project && s.repo === repo && accept(s))
    .sort((a, b) =>
      (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1)
      || ordinal(a.id) - ordinal(b.id));
  return rows[0]?.id ?? null;
}

/** Session worktree. Deliberately outside the repo tree: inside it would get mixed into the working
 *  directory as unversioned clutter. */
export function sessionWorktreePath(root: string, id: string): string {
  return join(root, "_sessions", id);
}

/** Branch for the session. `null` = the first session in the repo, it takes the default branch.
 *  Further ones get their own, because git does not allow the same branch to be checked out in two
 *  worktrees. The name is determined ONCE, at creation, and is fixed.
 *
 *  "Is this the first session?" is DELIBERATELY not guessed from the id form — it is ambiguous:
 *  `dev-portal-web-2` can be the second session of repo `web` or the first session of repo
 *  `web-2`. The decision is made by `isFirst`, which the caller determines from the DB by columns
 *  (project, repo). If it were read from the string, the first session of repo
 *  `web-2` would get a branch instead of the default — silently.
 *
 *  The rest of the id after the known base is then used in the branch name only to make it
 *  unique and deterministic; it has no effect on the null/non-null decision. */
export function sessionBranch(project: string, repo: string, id: string, isFirst: boolean): string | null {
  if (isFirst) return null;
  const base = `dev-${project}-${repo}`;
  // Base id form, and yet not the first session: the repo's first session ended, but another
  // is still running, so `nextSessionId` handed out the bare form again. One is permanently free
  // for this case — `nextSessionId` numbers from two, so `session/<repo>-1` cannot
  // belong to anyone else. Without this the whole id would yield `session/app-dev-p-app`.
  const suffix = id === base ? "1" : id.startsWith(`${base}-`) ? id.slice(base.length + 1) : id;
  return `session/${repo}-${suffix}`;
}

/** Branch the session worktree returns to. An existing session carries its branch in its row
 *  (`recorded`) and that wins: `isFirst` holds only at the moment of creation — on reopen the
 *  siblings that caused the session to get `session/<repo>-1` may have ended, and a re-derived
 *  branch would then come out as the default (an incident on 2026-10-05). */
export function restoreBranch(recorded: string | null | undefined, project: string, repo: string, id: string, isFirst: boolean): string | null {
  return recorded ?? sessionBranch(project, repo, id, isFirst);
}

/** Mounts without which git in a worktree session is dead. Both deliberately at the SAME
 *  absolute path as on the host:
 *  1. Bare clone — `.git` in the worktree is not a directory but a file with the absolute host
 *     path `gitdir: <bare>/worktrees/<id>`. Without this mount that path does not exist inside the
 *     container and EVERY git command ends with "not a git repository".
 *  2. The worktree also under its host path (next to `/workspace`) — otherwise the session
 *     in its own container looks "prunable" (its directory is not there under the recorded path)
 *     and `git worktree prune` unregisters its own working tree.
 *  Both verified by experiment in a container, not by guesswork. DO NOT SIMPLIFY to a single mount or to
 *  a different target path: either would make the record in `.git` diverge from reality.
 *
 *  Residual risk, knowingly accepted: an explicit `git worktree prune` inside one session
 *  unregisters the worktrees of the OTHER sessions of the same repo (their paths are not mounted
 *  in this container). `git gc --auto` does not do that — it has a three-month expiry. A damaged
 *  registration is fixed by `git worktree repair <path>` in the bare clone; there is deliberately
 *  no self-repair logic here. */
export function worktreeMounts(bare: string, worktree: string): string[] {
  return [`${bare}:${bare}`, `${worktree}:${worktree}`];
}

/** A path with symlinks resolved. Git records canonical paths into both the worktree and the bare
 *  clone, so the same ones must be mounted — otherwise the container cannot find them on its side.
 *  (`/srv/dev` on the VPS contains no symlink, temporary directories on the mac do: `/var` →
 *  `/private/var`. It has to work for both.) */
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** An operation on the same session's container is already running. The API maps this to 409 `{ error, inProgress }`.
 *  `op` is the name of the running operation ("recreate", "open", …, "switch" = held by
 *  accountSwitch/agentSwitch, which do not write a name into the shared Set). */
export class SessionBusyError extends Error {
  constructor(public readonly key: string, public readonly op: string) {
    super(`${op} is already running on ${key}`);
    this.name = "SessionBusyError"; // otherwise it reports as "Error" in name-driven logging/serialization
  }
}

const openKey = (t: { folder: string; project: string; repo: string }) => `open:${t.folder}/${t.project}/${t.repo}`;
export const openLockKey = openKey;

/** What a running open() of the repo is doing right now — the CLI shows it in the spinner, so the initial
 *  clone of a large repo (minutes) does not look like a hang. In memory only, lives for the duration of open(). */
export interface OpenProgress {
  step: "clone" | "fetch" | "worktree" | "pull" | "container";
  /** git's own progress: `clone` while cloning, `git` while checking out the worktree. */
  clone?: CloneProgress;
  git?: CloneProgress;
  /** What the step is doing inside (container: ownership, docker sidecar, start). */
  detail?: string;
}

export class SessionManager {
  constructor(private d: SessionDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }

  /** Revokes the session's sharing — either because it is ending entirely (`end()`), or because
   *  its container is being replaced: the new tmux sessions inside have a different history, so
   *  the old token would lead nowhere. One helper for all these paths: `end()`,
   *  `recreate()`, `open()` (missing container, agent switch, stale proxy/
   *  mount), `restartSolo()`, and the recovery `create` callbacks (`recoverAfterRestart`,
   *  `resumeRemote`) — there it is a no-op if the session does not have a DB row yet.
   *  `stop()`/a plain `startContainer` without replacing the container does NOT belong here — sharing
   *  should survive an agent stop/restart. */
  private revokeShares(id: string): void {
    revokeSessionShares(this.d.db, id, this.now());
  }

  private readonly openProgress = new Map<string, OpenProgress>();
  openProgressFor(t: { folder: string; project: string; repo: string }): OpenProgress | null {
    return this.openProgress.get(openKey(t)) ?? null;
  }

  private readonly ownInFlight = new Set<string>();
  private readonly opNames = new Map<string, string>();

  /** Lock on the keys for the duration of `fn`. It rejects, it does not queue: a second click should get
   *  "already running", not a fourth recreate in a row (decision in the spec §3.4). A key
   *  taken elsewhere (shared Set without a name) reports op "switch". `opNames` is
   *  per instance — the shared `Set` (`this.d.inFlight`) can hold a key taken by an
   *  entirely DIFFERENT `SessionManager`, which never wrote its operation name into this map,
   *  and then exactly that default "switch" is reported. */
  private async locked<T>(keys: string[], op: string, fn: () => Promise<T>): Promise<T> {
    const set = this.d.inFlight ?? this.ownInFlight;
    for (const k of keys) if (set.has(k)) throw new SessionBusyError(k, this.opNames.get(k) ?? "switch");
    for (const k of keys) { set.add(k); this.opNames.set(k, op); }
    try { return await fn(); }
    finally { for (const k of keys) { set.delete(k); this.opNames.delete(k); } }
  }

  /** Lock for operations outside the SessionManager (InstaBox create). Same semantics as
   *  locked(): the keys are taken synchronously, a second attempt gets SessionBusyError. */
  withLock<T>(keys: string[], op: string, fn: () => Promise<T>): Promise<T> { return this.locked(keys, op, fn); }

  /** InstaBox is wired in only after the SessionManager exists (InstaboxSessions needs
   *  mgr.remoteRunOpts and withLock, see index.ts). */
  attachInstabox(i: InstaboxLifecycle): void { this.d.instabox = i; }

  private instaboxOrThrow(): InstaboxLifecycle {
    if (!this.d.instabox) throw new Error("InstaBox is not configured on this devd");
    return this.d.instabox;
  }

  // Existing InstaBox session: no pull, no docker inspect (SSH to a paused machine
  // would wake it before we decide to) — just resume, or attach to the running one.
  private async openInstabox(s: SessionRow, t: { folder: string; project: string; repo: string; agent?: AgentName }): Promise<{ session: SessionRow; pull: PullResult; created: boolean; claudePrompt?: string }> {
    // An explicit agent choice is remembered just like on the VPS path. The container in the VM is not
    // rebuilt because of it (there is no recreate on InstaBox v1) — it applies to the repo's next session.
    if (t.agent) setRepoAgent(this.d.db, t.folder, t.project, t.repo, t.agent, this.now());
    if (s.status !== "running") await this.instaboxOrThrow().resume(s);
    else updateSession(this.d.db, s.id, { last_active_at: this.now() });
    return { session: getSession(this.d.db, s.id)!, pull: { status: "clean" } as PullResult, created: false };
  }

  private controlDir(id: string) {
    return join(this.d.controlRoot ?? DEFAULT_CONTROL_ROOT, id);
  }

  // Per-session directory for Claude Code transcripts. It is bind-mounted OVER the shared
  // project key `~/.claude/projects/-workspace` (cwd is /workspace in all containers
  // and claude-home is a shared volume, so without the overlay the transcripts of the
  // whole devbox land in one directory and /resume offers hundreds of foreign conversations).
  // The rest of ~/.claude stays shared — auth, settings and the nightly upkeep keep working;
  // so does `--resume <id>` across account profiles (accountSwitch), the overlay is the same for all
  // profiles. Deliberately under `root` (=/srv/dev): that directory is in the borg backup
  // (infra/devbox-backup.sh), so the conversation history is not lost from the backup.
  private claudeProjectsDir(id: string) {
    return join(this.d.root, "_claude-projects", id);
  }

  // A bind mount to a nonexistent target would be created by docker as ROOT-owned and cc (uid 1000)
  // would silently not write transcripts — the same trap as a root-owned .git in a fresh
  // clone. That is why it is created (and chowned) here, right before `docker run`.
  /** Writes a file with the DUMMY into the session's control dir and returns its path. When dummies
   *  are not configured, returns the shared file with the real tokens (the state before phase 2). */
  private gitTokensFor(id: string, devdUrl?: string): string | undefined {
    if (!this.d.issuePlaceholder || !this.d.giteaInstances) return this.d.giteaTokensPath;
    const tokens = sessionGitTokens(
      this.d.giteaInstances(), id, this.d.issuePlaceholder, devdUrl ?? this.d.devdUrl ?? DEFAULT_DEVD_URL,
    );
    const dir = this.controlDir(id);
    const path = join(dir, "gitea-tokens.json");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(tokens), { mode: 0o600 });
      // Read by uid 1000 in the container via a :ro mount; devd runs as root.
      try { chownSync(path, 1000, 1000); } catch { chmodSync(path, 0o644); }
    } catch (e) {
      console.error(`writing placeholders for ${id} failed:`, (e as Error).message);
      return this.d.giteaTokensPath;   // better the state before phase 2 than a session without git
    }
    return path;
  }

  /** Builds the sidecar when dind is enabled. An "already exists" error is fine —
   *  it means the sidecar is still there from the previous start. */
  private async ensureDind(id: string, requireReady = false): Promise<void> {
    if (!this.d.dind) return;
    // Shared / tainted session: the sidecar stays stopped (docker does not work in it)
    // until the container is rebuilt. Also called from recreate() — there the old container
    // no longer exists, the taint does not apply to it and the new container gets dind again.
    let restricted = false;
    try { restricted = (await this.d.shareRestricted?.(id)) ?? false; }
    catch (e) { console.error(`dind for ${id}: cannot verify the sharing state (${(e as Error).message}) — not starting the sidecar`); restricted = true; }
    if (restricted) {
      const r = await sh(this.d.root, "docker", "stop", dindName(id));
      if (r.code !== 0 && !/No such container/i.test(r.stderr)) console.error(`dind for ${id}: stopping the sidecar of a tainted session failed: ${r.stderr.trim()}`);
      return;
    }
    await this.ensureDindNetwork(id);
    for (const cmd of dindEnsurePlan(id)) {
      const r = await sh(this.d.root, ...cmd);
      if (r.code !== 0 && !/already exists|Conflict/i.test(r.stderr)) {
        console.error(`dind for ${id}: '${cmd.slice(0, 3).join(" ")}' failed: ${r.stderr.trim()}`);
      }
    }
    // docker run reports a conflict for a retained stopped sidecar. Explicitly
    // start that same daemon so its persisted images/volumes are usable again.
    await startContainer(dindName(id));
    // Wait until the daemon inside the sidecar is actually up. Dind takes several
    // seconds to start and without waiting the session comes up first — the agent's first `docker` command then
    // fails with "Cannot connect to the Docker daemon" and it looks like a broken session.
    for (let i = 0; i < 40; i++) {
      const r = await sh(this.d.root, "docker", "exec", dindName(id), "docker", "version", "--format", "{{.Server.Version}}");
      if (r.code === 0 && r.stdout.trim()) return;
      await Bun.sleep(500);
    }
    // Without a running daemon the session starts with DOCKER_HOST pointing at nothing and docker
    // silently does not work in it. Better to have it in the log as one sentence than only from the cryptic message
    // the agent gets half an hour later.
    console.error(`dind for ${id} did not come up within 20 s — docker inside the session will not work`);
    if (requireReady) throw new Error(`DinD for ${id} is not ready`);
  }

  /** Session network with its own subnet. Subnet taken ("Pool overlaps") = try the next one;
   *  "already exists" = the network is still there from the previous start. */
  private async ensureDindNetwork(id: string): Promise<void> {
    for (const subnet of dindSubnetCandidates(id)) {
      const r = await sh(this.d.root, ...dindNetworkCreate(id, subnet));
      if (r.code === 0 || /already exists/i.test(r.stderr)) return;
      if (/overlap/i.test(r.stderr)) continue;
      console.error(`dind for ${id}: 'docker network create' failed: ${r.stderr.trim()}`);
      return;
    }
    console.error(`dind for ${id}: all subnets in 10.213.0.0/16 are taken`);
  }

  /** An orphaned sidecar holds a privileged container and tens of GB of layers, so cleanup
   *  is not cosmetic. On `stop` the data is kept — the session should be openable again. */
  private async cleanupDind(id: string, keepData: boolean): Promise<void> {
    if (!this.d.dind) return;
    for (const cmd of dindCleanupPlan(id, { keepData })) {
      const r = await sh(this.d.root, ...cmd);
      if (r.code !== 0) console.error(`dind cleanup ${id}: ${cmd.join(" ")} → ${r.stderr.trim()}`);
    }
  }

  private async ensureClaudeProjectsDir(id: string): Promise<string> {
    const dir = this.claudeProjectsDir(id);
    try {
      mkdirSync(dir, { recursive: true });
      if (statSync(dir).uid !== 1000) await sh(dir, "chown", "-R", "1000:1000", dir);
    } catch (e) { console.error(`claude projects dir ${dir} failed:`, e); }
    return dir;
  }

  // Writes the conflict prompt for the container launcher (or clears a stale one).
  // Must run BEFORE the container is run/started; docker start re-runs the
  // entrypoint, so the file channel also covers restarted containers.
  private syncPromptFile(id: string, pull: PullResult, override?: string): string | undefined {
    const dir = this.controlDir(id);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777); // devd may run as root; container user is uid 1000
    const file = join(dir, "prompt");
    if (pull.status === "conflict") {
      const prompt = conflictPrompt(pull.files);
      writeFileSync(file, prompt);
      chmodSync(file, 0o666);
      return prompt;                                   // a conflict takes precedence (Claude handles the rebase)
    }
    if (override) {                                     // scheduled run: initial prompt into the channel
      writeFileSync(file, override);
      chmodSync(file, 0o666);
      return override;
    }
    rmSync(file, { force: true });
    return undefined;
  }

  list(): SessionRow[] { return listSessions(this.d.db); }

  // devd clones/inits the workspace as root, but the container runs as uid 1000 (dev).
  // Without the chown dev could not write into its /workspace — Claude could not
  // edit files (Permission denied). We chown only when it is not dev-owned yet
  // (cheap: one stat); devd runs as root, so the chown goes through.
  private async ensureOwned(ws: string): Promise<void> {
    try {
      if (statSync(ws).uid !== 1000) await sh(ws, "chown", "-R", "1000:1000", ws);
    } catch (e) { console.error(`chown workspace ${ws} failed:`, e); }
  }

  // Sibling of ensureOwned for the bare clone. Git in the container (uid 1000) writes into it
  // exactly as into the working directory — objects, refs as well as the worktree's HEAD and index
  // in `<bare>/worktrees/<id>` — but it was created by root (devd). A guard "does the top already belong
  // to the dev user?" would be BROKEN here: after the first session `app.git` belongs to the dev user,
  // but the second session's directory under it is freshly root-owned and the second session could not
  // commit. Hence the whole tree — and only when the worktree is created, not on every open.
  // Only entries NOT yet owned by uid 1000 are changed: `chown -R` touched every inode of a
  // 54 GB / 620k-entry clone (2.9 s), a `find` that only stats them takes half of that.
  private async ownBare(bare: string): Promise<void> {
    try {
      const r = await sh(bare, "find", bare, "!", "-uid", "1000", "-exec", "chown", "-h", "1000:1000", "{}", "+");
      if (r.code !== 0) console.error(`chown bare ${bare} failed: ${r.stderr.trim()}`);
    } catch (e) { console.error(`chown bare ${bare} failed:`, e); }
  }

  // `project` uses non-colliding resource-attribute keys: Claude Code's own OTel
  // export already emits a datapoint-level `session.id` (its own conversation UUID)
  // and no `project` attribute. Using the same key for our session id would let
  // Claude's value clobber ours (see metrics.ts pointsToRows / attrList merge order),
  // so we key ours as `devbox.session.id` and add `project` alongside it.
  /** The key into the prod-db catalog is historically `<project>-<repo>` (it used to be built
   *  from the id by cutting off "dev-"). It is now built from the columns, not from the id — the id no longer
   *  has to have a form it could be read from. A failure (key not in 1P) MUST NOT break
   *  session creation — log and return [], the container comes up without prod access. */
  private async prodMounts(project: string, repo: string): Promise<string[]> {
    if (!this.d.prodCatalog || !this.d.prodKeyPath) return [];
    const key = `${project}-${repo}`;
    try { return await prodKeyMounts(this.d.prodCatalog, this.d.prodDbAccess ?? {}, key, this.d.prodKeyPath); }
    catch (e) { console.error(`prod key mounts for ${key} failed:`, e); return []; }
  }

  // Same reason as prodMounts a few lines above: `accountMounts` reads SQLite at
  // runtime (accounts get added), and a faulty dependency (temporarily unavailable DB) must not
  // prevent the container from being created — a session without pool mounts is fine, a session
  // without a container is not.
  private accountMounts(): string[] {
    try { return this.d.accountMounts?.() ?? []; }
    catch (e) { console.error("account mounts failed:", e); return []; }
  }

  /** Must the container be rebuilt because its baked-in proxy environment no longer
   *  matches the configuration? The proxy env (key, model, URL) is injected only on
   *  `docker run` — reopen goes through `docker start`, which does not change the environment, and
   *  reopening a running session is even just an attach.
   *
   *  Without this the common path was a dead end: every devd restart locks the vault →
   *  the user opens claude-gpt → the container is created with an empty key → agent-launch
   *  correctly says "unlock the vault and open the session again" → the user unlocks and
   *  opens → the container is still running (agent-launch fell into zsh, so it did not exit) → the same
   *  message, forever. The only way out was switching the profile, which recreates the container.
   *  The same applied to the model: filling in settings.proxyModels never got
   *  inside either.
   *
   *  Two safeguards so a recreate never takes away work in progress:
   *  - An empty new key (vault still locked) is NEVER considered newer,
   *    otherwise a locked vault would tear down a working container.
   *  - A RUNNING container is rebuilt only when the agent provably never
   *    started in it — i.e. when it lacked a key or model and agent-launch therefore
   *    fell into zsh. A key rotation under a live agent waits for the next stop.
   *
   *  For a stopped session a recreate is cheap: the workspace is a bind mount and a stopped
   *  container has no live tmux sessions anyway. */
  private agentCtx(agent: AgentName): Promise<number | null> {
    return agentContextTokens(agent, sessionSettings(this.d), (m) => contextLengthCached(m, DEFAULT_OPENROUTER_URL));
  }

  /** Fresh DEVD_* env for a profile — one assembler for both a new container (runOpts)
   *  and a live agent swap (agentSwitch via index.ts), so the two paths
   *  cannot diverge in where they take the key/model/context window from. */
  async proxyEnvFor(agent: AgentName): Promise<Record<string, string>> {
    return proxyEnv(agent, sessionSettings(this.d), upstreamKey(this.d), await this.agentCtx(agent));
  }

  private async proxyEnvStale(current: Record<string, string> | null, agent: AgentName, running: boolean): Promise<boolean> {
    if (!usesProxy(agent)) return false;
    const fresh = proxyEnv(agent, sessionSettings(this.d), upstreamKey(this.d), await this.agentCtx(agent));
    if (!fresh.DEVD_CLIPROXY_KEY) return false;
    if (!current) return false;                       // container disappeared → handled as state "missing"
    if (!Object.entries(fresh).some(([k, v]) => current[k] !== v)) return false;
    if (!running) return true;
    return !current["DEVD_CLIPROXY_KEY"] || !current["DEVD_AGENT_MODEL"];
  }

  // `bare` != null only for a worktree session (see worktreeMounts). A repo in the old form
  // does not have it and gets exactly the same mounts as before.
  // `remote` = the container will run on an InstaBox VM: no dind (R2), no prod-db keys, no
  // local mkdir of transcripts and with a devd address reachable from the VM (Tailscale).
  private async runOpts(id: string, ws: string, portBase: number, project: string, repo: string, agent: AgentName, bare?: string | null, remote?: { devdUrl: string }): Promise<RunOpts> {
    const projectsDir = remote ? this.claudeProjectsDir(id) : await this.ensureClaudeProjectsDir(id);
    const prod = remote ? [] : await this.prodMounts(project, repo);
    const dind = !!this.d.dind && !remote;
    const devdUrl = remote?.devdUrl ?? this.d.devdUrl ?? DEFAULT_DEVD_URL;
    return {
      name: id, image: this.d.image, workspace: ws,
      ...(dind ? { network: dindNetwork(id) } : {}),
      portBase, portsPerSession: this.d.cfg.settings.portsPerSession,
      bindIp: this.d.bindIp,
      extraMounts: [...(this.d.extraMounts ?? []), `${this.controlDir(id)}:/run/devd`, `${this.d.root}/_inbox:/inbox:ro`, `${projectsDir}:/home/dev/.claude/projects/-workspace`, ...(bare ? worktreeMounts(canonical(bare), canonical(ws)) : []), ...credentialMounts(this.d.ghConfigDir && existsSync(this.d.ghConfigDir) ? this.d.ghConfigDir : undefined, this.gitTokensFor(id, remote?.devdUrl)), ...prod, ...this.accountMounts()],
      cmd: this.d.cmd,
      env: {
        DEVD_SESSION_ID: id,
        // Gitea instance for `insteadOf` in the entrypoint — git then goes through the devd proxy
        // and the original readable address stays in .git/config.
        DEVD_GIT_INSTEADOF: this.d.giteaInstances ? insteadOfEnv(this.d.giteaInstances()) : "",
        // With dind, the docker client in the container talks to the sidecar, not to the host socket.
        ...(dind ? { DOCKER_HOST: dockerHostFor(id) } : {}),
        // Time zone: without it the container runs in UTC. It is also sent from devd (not just from the image),
        // so that it applies to containers built from an image before the rebuild too.
        TZ: this.d.tz ?? "UTC",
        ...(this.d.storageGuard?.() ? { DEVBOX_STORAGE_GUARD: "1" } : {}),
        // Session identity for the tmux status bar (project/repo on the left). Taken from the parameters,
        // NOT from `id` — since multiple sessions per repo were introduced, the second and later ones have the form
        // `dev-<project>-<repo>-<n>` and deriving the repo from it would give `web-2`.
        DEVD_PROJECT: project,
        DEVD_REPO: repo,
        // The agent default for this container: read by agent-launch when the tmux
        // session starts, when the container restarts and in the web terminal.
        DEVD_AGENT: agent,
        DEVD_URL: devdUrl,
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: devdUrl,
        OTEL_METRIC_EXPORT_INTERVAL: "10000",
        OTEL_RESOURCE_ATTRIBUTES: otelResourceAttributes(id, project, repo),
        ...await this.proxyEnvFor(agent),
      },
    };
  }

  /** RunOpts for an InstaBox session container: paths inside the VM, no dind, with a desktop. */
  async remoteRunOpts(id: string, portBase: number, project: string, repo: string, agent: AgentName, devdUrl: string): Promise<RunOpts> {
    const base = await this.runOpts(id, IBX_PATHS.ws(id), portBase, project, repo, agent, null, { devdUrl });
    return toRemoteRunOpts(base, { id, controlDir: this.controlDir(id), claudeProjectsDir: this.claudeProjectsDir(id), ghConfigDir: this.d.ghConfigDir });
  }

  /** `sessionId`: open (resume/attach) EXACTLY this existing session of the repo, not the one
   *  existingSessionId would pick — e.g. a paused InstaBox session when the repo also has a VPS
   *  session (smoke test, M8). Never creates a new one. */
  async open(t: { folder: string; project: string; repo: string; cloneUrl?: string; prompt?: string; agent?: AgentName; fresh?: boolean; sessionId?: string }) {
    // The repo key while the id is not known (a new session only gets it here); then also the id,
    // so open does not collide with stop/end/recreate of the same existing session.
    return this.locked([openKey(t)], "open", async () => {
      // `fresh` = the user explicitly wanted ANOTHER session, not to attach to the existing one.
      // Without it a second `dev <repo>` would silently create an extra container. Without `fresh` it
      // attaches to an existing session of the repo (see existingSessionId), and only when there is none
      // is a new one created.
      const leftover = (id: string) => existsSync(sessionWorktreePath(this.d.root, id));
      // A scheduled run (prompt) never attaches to an InstaBox session: its prompt channel
      // is in the VM and resume does not write the prompt — the work would silently not get done. The scheduler is VPS-only.
      const accept = t.prompt !== undefined ? (s: SessionRow) => (s.host ?? "vps") === "vps" : undefined;
      const id = t.sessionId ?? (t.fresh
        ? nextSessionId(this.d.db, t.project, t.repo, leftover)
        : (existingSessionId(this.d.db, t.project, t.repo, accept) ?? nextSessionId(this.d.db, t.project, t.repo, leftover)));
      try {
        return await this.locked([id], "open", () => this.openWithEarlyDind(t, id));
      } finally {
        this.openProgress.delete(openKey(t));
      }
    });
  }

  // A NEW session starts its dind sidecar right away, in parallel with the worktree checkout,
  // pull and chown — the sidecar does not depend on the workspace, and network create + daemon
  // start + the readiness wait took ~3 s on the critical path (measured 1 Nov 2026 on a 54 GB
  // repo: 14 s → the sidecar alone ~3 s of it). openUnlocked still awaits it before the session
  // container runs, so "docker works from the first command" holds. When the open fails before
  // the container exists, the sidecar would be an orphaned privileged container — removed here.
  private async openWithEarlyDind(t: { folder: string; project: string; repo: string; cloneUrl?: string; prompt?: string; agent?: AgentName; fresh?: boolean; sessionId?: string }, id: string) {
    const fresh = !t.sessionId && !getSession(this.d.db, id);   // sessionId never creates (see open)
    const dind = fresh && this.d.dind ? this.ensureDind(id).catch((e) => { console.error(`dind for ${id} failed:`, e); }) : undefined;
    try {
      return await this.openUnlocked(t, id, dind);
    } catch (e) {
      if (dind && !getSession(this.d.db, id)) { await dind; await this.cleanupDind(id, false); }
      throw e;
    }
  }

  private async openUnlocked(t: { folder: string; project: string; repo: string; cloneUrl?: string; prompt?: string; agent?: AgentName; fresh?: boolean; sessionId?: string }, id: string, earlyDind?: Promise<void>) {
    const ws = workspacePath(this.d.root, t.folder, t.project, t.repo);
    const existing = getSession(this.d.db, id);
    // The session ended in the meantime (or belongs to another repo) → an error, not a silent new session with the same id.
    if (t.sessionId && (!existing || existing.folder !== t.folder || existing.project !== t.project || existing.repo !== t.repo)) {
      throw new Error(`Unknown session ${t.sessionId} for ${t.folder}/${t.project}/${t.repo}`);
    }
    if (existing?.host === "instabox") return this.openInstabox(existing, t);
    const observed: CanonicalWorkspaceContainer = existing ? await inspectCanonicalWorkspace(id) : { state: "missing" };
    const state = observed.state === "stopped" ? "exited" : observed.state;

    const agent = resolveAgent(t.agent, getRepoAgent(this.d.db, t.folder, t.project, t.repo));
    if (t.agent) setRepoAgent(this.d.db, t.folder, t.project, t.repo, t.agent, this.now());

    // One `docker inspect` on the existing container — the env is read ONCE and serves
    // two checks: a stale proxy environment (proxyEnvStale) and the baked-in
    // DEVD_AGENT after a live agent swap (bakedAgentStale in the branch below). It must be
    // evaluated BEFORE the attach shortcut below — exactly that shortcut kept the user
    // in the endless "unlock and open again" loop.
    const bakedEnv = existing && state !== "missing" ? await containerEnv(id) : null;
    const staleProxy = existing && state !== "missing"
      ? await this.proxyEnvStale(bakedEnv, agent, state === "running")
      : false;

    if (existing && state === "running" && !staleProxy) {
      const staleAccounts = await this.accountMountsStale(id);
      if (staleAccounts && !await this.hasLiveAgent(id)) {
        // open() already holds the `id` lock — the public recreate() would deadlock on itself.
        const session = await this.recreateUnlocked(id, "account-mounts");
        return { session, pull: { status: "clean" } as PullResult, created: false };
      }
      updateSession(this.d.db, id, { last_active_at: this.now() });
      return { session: getSession(this.d.db, id)!, pull: { status: "clean" } as PullResult, created: false };
    }

    if (existing && observed.state === "stopped" && canonical(observed.workspace!) !== canonical(existing.worktree ?? ws)) {
      throw new Error("Container workspace differs from the recorded session; refusing recreation");
    }
    const staleCanonicalMount = observed.state === "stopped" && !observed.canonicalMount;

    // Below this line the container is always (re)started — and that is a new life of the
    // session, so without an inherited "end after the finished turn" (autoEnd.ts).
    // Otherwise a stopped scheduled run that you open manually later would vanish
    // right after your first turn. The scheduler sets the flag itself after open().
    // DELIBERATELY after the attach shortcut above: merely attaching to a RUNNING cron run should not
    // cancel the cleanup — the session does not stop ending just because you look into it.
    if (existing) setAutoEnd(this.d.db, id, 0);

    // Auth for host git (both the clone and the subsequent pull) against a private gitea instance;
    // empty for github/local. Without a URL (existing repo without cloneUrl) → no auth.
    const authEnv = t.cloneUrl ? (this.d.credentials?.(t.cloneUrl) ?? {}) : {};

    // Repo form. An existing session CARRIES it in the `worktree` column and it is not re-derived
    // from disk: a bare clone can appear next to the old repo at any time and the old session would
    // thereby silently switch its working directory under itself. A new session gets the new form when
    // the repo is already in it, OR when it is only being cloned — new repos are created directly in the new
    // form. An existing repo with a shared workspace is not migrated.
    const bare = barePath(this.d.root, t.folder, t.project, t.repo);
    const worktree = existing
      ? existing.worktree ?? null
      : isBareLayout(this.d.root, t.folder, t.project, t.repo) || !existsSync(ws)
        ? sessionWorktreePath(this.d.root, id)
        : null;
    const dir = worktree ?? ws;                        // working directory of THIS session
    const progress = (p: OpenProgress) => this.openProgress.set(openKey(t), p);
    const onClone = (clone: CloneProgress) => progress({ step: "clone", clone });
    let bornWorktree = false;
    let settledBranch: string | null = null;

    if (worktree) {
      if (existsSync(bare) && !existsSync(worktree)) {
        // A new worktree is cut from origin/<default> (addWorktree) — make that fresh first.
        progress({ step: "fetch" });
        await fetchBare(bare, authEnv);
      }
      if (!existsSync(bare)) {
        if (!t.cloneUrl) throw new Error(`No clone URL for ${t.project}/${t.repo}`);
        mkdirSync(dirname(bare), { recursive: true });
        progress({ step: "clone" });
        await cloneBare(t.cloneUrl, bare, authEnv, onClone);
        await trackRemote(bare, authEnv);            // a bare clone has no tracking refs on its own
        logEvent(this.d.db, id, "clone", { url: t.cloneUrl });
      }
      // Also missing on reopen of a session whose directory someone deleted outside devd — without restoring it
      // the container would get an empty /workspace (the docker mount creates the directory) and the session would
      // look like a repo without files. What is checked, though, is USABILITY, not the presence of
      // `.git`: a directory with `.git` pointing to a vanished registration looks healthy and yet
      // git in it is dead — a container over it ends up in a restart loop (see ensureWorktree).
      //
      // `isFirst` must be computed BEFORE insertSession below, otherwise this session's row
      // would count itself and the first session in the repo would come out as a further one. Excluding
      // the own id covers both situations at once — before the insert and after it (reopen).
      const rows = listSessions(this.d.db);
      const sameRepo = rows.filter((r) => r.project === t.project && r.repo === t.repo && r.id !== id);
      // The default branch belongs only to the session with the base id: a skipped number (see
      // nextSessionId) means it is most likely held by a leftover of an ended session.
      const branch = restoreBranch(existing?.branch, t.project, t.repo, id, sameRepo.length === 0 && id === `dev-${t.project}-${t.repo}`);
      // A new session starts clean: a branch left behind by an earlier session with the
      // same number is moved aside under `ended/…` (the commits stay visible) and the session
      // gets a fresh branch from the default. It used to take it over including the old commits and the first
      // pull then rebased dozens of long-squashed commits into conflicts.
      if (!existing && branch) {
        const archived = await archiveBranch(bare, branch, new Date(this.now()));
        if (archived) logEvent(this.d.db, id, "branch-archived", { from: branch, to: archived });
      }
      // Siblings = worktrees of the other sessions of the SAME repo. Their registrations are normalized
      // to host paths before `addWorktree` runs prune — otherwise prune would
      // unregister a live session whose `gitdir` points into the container.
      const siblings = sameRepo.map((r) => r.worktree).filter((w): w is string => !!w);
      progress({ step: "worktree" });
      const state = await ensureWorktree(bare, worktree, branch, await defaultBranch(bare), siblings, (git) => progress({ step: "worktree", git }));
      if (state !== "ok") {
        // The worktree metadata (registration in the bare clone, `.git` in the worktree, the computed index)
        // was written by root; the container runs as uid 1000. Without the chown git could not commit in it.
        bornWorktree = true;
        await sh(worktree, "chown", "1000:1000", join(worktree, ".git"));
        logEvent(this.d.db, id, "worktree", { path: worktree, branch, state });
      }
      // Record what the session actually sits on — for a new one right into the row below, for an old row
      // without the column fill it in now, while the registration is alive and the branch can be read from it.
      settledBranch = await worktreeBranch(worktree);
      if (existing && !existing.branch && settledBranch) setSessionBranch(this.d.db, id, settledBranch);
    } else if (!existsSync(ws)) {
      if (!t.cloneUrl) throw new Error(`No clone URL for ${t.project}/${t.repo}`);
      mkdirSync(dirname(ws), { recursive: true });
      progress({ step: "clone" });
      await cloneRepo(t.cloneUrl, ws, authEnv, onClone);
      logEvent(this.d.db, id, "clone", { url: t.cloneUrl });
    }

    // The pull runs over THIS session's working directory, i.e. for the new form over its
    // worktree. The semantics stay as today — "the session starts on a fresh upstream and
    // local work is rebased onto it" — it just means something different for each session:
    // the first is on the default branch (fast-forward), further ones on `session/<repo>-<n>` (rebase of its
    // work onto upstream). That this works relies on the upstream that trackRemote and addWorktree
    // add to the bare clone; without them a pull on a branch without tracking fails. Do not simplify
    // back to a shared repo directory — the sessions would step on each other's files again.
    progress({ step: "pull" });
    const pull = await pullWithRebase(dir, authEnv);
    progress({ step: "container", detail: "setting file ownership" });
    const claudePrompt = this.syncPromptFile(id, pull, t.prompt);
    if (pull.status === "conflict") {
      logEvent(this.d.db, id, "pull-conflict", { files: pull.files });
      this.d.notify?.("devbox", `${t.project}/${t.repo}: pull conflict — Claude is resolving it`);
    } else if (pull.status === "error") {
      // Used to be silent: the pull failed (network, auth, once dubious-ownership) and the session
      // opened on old code without a trace. Now at least it stays in the audit log.
      logEvent(this.d.db, id, "pull-error", { message: pull.message });
    }

    // After root git ops, before the container starts (uid 1000); the bare clone for the same
    // reason. Independent trees, so in parallel.
    await Promise.all([this.ensureOwned(dir), bornWorktree ? this.ownBare(bare) : undefined]);

    if (existing) {
      // Reality, not the DB: after a live agent swap (agentSwitch.ts) the container has a different
      // DEVD_AGENT baked in than the DB claims — docker start would return the session to the old profile.
      const switching = bakedAgentStale(bakedEnv?.DEVD_AGENT, existing.agent, agent);
      const staleAccounts = state !== "missing" && await this.accountMountsStale(id);
      if (state === "missing" || switching || staleProxy || staleCanonicalMount || staleAccounts) {
        this.revokeShares(id); // the container is being (re)created — the old sharing would lead nowhere
        if (staleCanonicalMount) {
          await removeStoppedWorkspaceContainer(observed);
        } else if ((switching || staleProxy || staleAccounts) && state !== "missing") {
          // Agent switch = a new container with the correct DEVD_AGENT. Safe: a stopped
          // container has no live tmux sessions anyway, the workspace is a bind mount.
          await removeContainer(id);
        }
        await this.ensureDind(id);
        await runContainer(await this.runOpts(id, dir, existing.port_base, t.project, t.repo, agent, worktree ? bare : null));
        // Audit log: an agent switch is always logged, even when the container was missing and would
        // have to be created again anyway — "agent-switch" carries more information than a plain "recreate".
        if (switching) logEvent(this.d.db, id, "agent-switch", { from: existing.agent ?? "claude", to: agent });
        else logEvent(this.d.db, id, "recreate", staleCanonicalMount ? { reason: "canonical-workspace" } : staleProxy ? { reason: "proxy-env" } : staleAccounts ? { reason: "account-mounts" } : undefined);
      } else {
        await startContainer(id);
      }
      setSessionAgent(this.d.db, id, agent);
      updateSession(this.d.db, id, { status: "running", last_active_at: this.now() });
      return { session: getSession(this.d.db, id)!, pull, created: false, claudePrompt };
    }

    const port_base = allocatePortBase(this.d.db, this.d.cfg.settings);
    const row: SessionRow = {
      id, folder: t.folder, project: t.project, repo: t.repo, container: id, port_base,
      status: "running", solo: 0, created_at: this.now(), last_active_at: this.now(), important: 0, agent,
      worktree, branch: settledBranch,
    };
    insertSession(this.d.db, row);
    try {
      progress({ step: "container", detail: "waiting for the docker sidecar" });
      const [opts] = await Promise.all([
        this.runOpts(id, dir, port_base, t.project, t.repo, agent, worktree ? bare : null),
        earlyDind ?? this.ensureDind(id),
      ]);
      progress({ step: "container", detail: "starting the container" });
      await runContainer(opts);
    } catch (e) {
      deleteSession(this.d.db, id);
      throw e;
    }
    logEvent(this.d.db, id, "open");
    return { session: row, pull, created: true, claudePrompt };
  }

  async openSolo(folder: string, project: string, agent?: AgentName) {
    // Same lock as open(): the repo key (here the generic "claudeSolo") while the id
    // is not known (finding a free `n` below), then also the id itself.
    return this.locked([openKey({ folder, project, repo: "claudeSolo" })], "open", async () => {
      let n = 1;
      while (getSession(this.d.db, `dev-${project}-claudeSolo-${n}`) ||
             existsSync(workspacePath(this.d.root, folder, project, `claudeSolo-${n}`))) n++;
      const repo = `claudeSolo-${n}`;
      const id = `dev-${project}-${repo}`;
      return this.locked([id], "open", async () => {
        const ws = workspacePath(this.d.root, folder, project, repo);
        mkdirSync(ws, { recursive: true });
        await sh(ws, "git", "init");
        // claudeSolo is remembered under the generic repo "claudeSolo" (not claudeSolo-3) —
        // the same key the tree and the pickers offer.
        const chosen = resolveAgent(agent, getRepoAgent(this.d.db, folder, project, "claudeSolo"));
        if (agent) setRepoAgent(this.d.db, folder, project, "claudeSolo", agent, this.now());
        const port_base = allocatePortBase(this.d.db, this.d.cfg.settings);
        const row: SessionRow = {
          id, folder, project, repo, container: id, port_base,
          status: "running", solo: 1, created_at: this.now(), last_active_at: this.now(), important: 0, agent: chosen,
        };
        insertSession(this.d.db, row);
        this.syncPromptFile(id, { status: "clean" });
        await this.ensureOwned(ws); // git init ran as root → chown to dev (uid 1000)
        try {
          await this.ensureDind(id);
          await runContainer(await this.runOpts(id, ws, port_base, project, repo, chosen));
        } catch (e) {
          deleteSession(this.d.db, id);
          throw e;
        }
        logEvent(this.d.db, id, "open-solo");
        return { session: row, created: true };
      });
    });
  }

  // `reason: "idle"` = put to sleep by the watchdog, not the user. This must be distinguishable in the log,
  // otherwise a vanished session looks as if someone stopped it manually.
  async stop(id: string, reason: "manual" | "idle" = "manual") {
    return this.locked([id], "stop", async () => {
      const s = getSession(this.d.db, id);
      if (s?.host === "instabox") {
        await this.instaboxOrThrow().pause(s, reason);
        try { releaseLeasesForSession(this.d.db, id, this.now()); }
        catch (e) { console.error(`release lease for ${id} failed:`, e); }
        return;
      }
      await this.checkpointRecovery(id);
      const recovery = join(this.controlDir(id), "recovery");
      mkdirSync(recovery, { recursive: true });
      try { chownSync(recovery, 1000, 1000); } catch { /* existing image may own it already */ }
      writeFileSync(join(recovery, "manual-stop"), "1\n");
      // Desired stopped state is durable before awaiting Docker. A host crash
      // during stop must not turn the interrupted lifecycle into restart intent.
      updateSession(this.d.db, id, { status: "stopped" });
      await this.cleanupDind(id, true);
      await stopContainer(id);
      // Symmetry with `end()` below: the lease belongs to the session, not the container — without releasing it
      // a stopped session would still look running in the dashboard (account occupied
      // until `autoStopHours` expires) and the poller would needlessly keep running on that account
      // at the fast cadence even after the stop. Same guard as in `end()`: an error here
      // must not prevent the stop itself, which from the operator's point of view has already happened
      // (the container is stopped) — a side effect must not drown the main one.
      try { releaseLeasesForSession(this.d.db, id, this.now()); }
      catch (e) { console.error(`release lease for ${id} failed:`, e); }
      updateSession(this.d.db, id, { status: "stopped" });
      logEvent(this.d.db, id, "stop", reason === "idle" ? { reason: "idle-timeout" } : undefined);
    });
  }

  /** Rebuilds the session's container AGAIN, with the same id, port, agent and working
   *  directory — just from FRESH runOpts. The only operation that can replace
   *  container-level settings that are baked in at `docker run` and cannot be changed otherwise:
   *  typically the list of account mounts (accountMountList). After an account is removed, its volume is held by
   *  EVERY old container, so `docker volume rm` fails until all of them are
   *  rebuilt — and without this method there was no way to do it: `stop()` leaves the container
   *  existing (and the mount with it), `end()` does remove it, but together with the worktree and
   *  transcripts, i.e. with the work in progress.
   *
   *  Knowingly does NOTHING around the container: no pull, clone, worktree creation or
   *  touching branches. The repo form is read from the DB (`worktree`), not from disk — exactly as
   *  in open() — so the session does not switch its working directory under itself if a bare clone
   *  appeared next to it in the meantime.
   *
   *  Before replacement, checkpoint the exact tmux conversations and running
   *  inner containers. A recovery-capable image restores these from the journal;
   *  interrupted work continues only with a recorded, unblocked conversation. */
  async recreate(id: string, reason = "manual") {
    return this.locked([id], "recreate", () => this.recreateUnlocked(id, reason));
  }

  /** Body of recreate for a caller that already holds the `id` lock (open). */
  private async recreateUnlocked(id: string, reason: string) {
    const s = getSession(this.d.db, id);
    if (!s) throw new Error(`Unknown session ${id}`);
    if (s.host === "instabox") throw new Error("Recreate is not supported for InstaBox sessions (v1)");
    const ws = workspacePath(this.d.root, s.folder, s.project, s.repo);
    const dir = s.worktree ?? ws;
    const bare = barePath(this.d.root, s.folder, s.project, s.repo);
    const agent = s.agent ?? "claude";
    this.revokeShares(id);
    await this.checkpointRecovery(id);
    await removeContainer(id);
    await this.ensureDind(id);
    await runContainer(await this.runOpts(id, dir, s.port_base, s.project, s.repo, agent, s.worktree ? bare : null));
    updateSession(this.d.db, id, { status: "running", last_active_at: this.now() });
    logEvent(this.d.db, id, "recreate", { reason });
    return getSession(this.d.db, id)!;
  }

  /** Recreate an idle running container whose baked account mounts are behind the catalog. */
  async repairAccountMounts(id: string): Promise<boolean> {
    const s = getSession(this.d.db, id);
    if (!s || s.status !== "running" || s.host === "instabox") return false;
    if (!await this.accountMountsStale(id)) return false;
    if (await this.hasLiveAgent(id)) return false;
    await this.recreate(id, "account-mounts");
    return true;
  }

  private async accountMountsStale(id: string): Promise<boolean> {
    const expected = this.accountMounts();
    if (!expected.length) return false;
    const observed = await containerMountDestinations(id);
    if (observed === null) return false;
    return staleAccountMounts(expected, observed);
  }

  private async hasLiveAgent(id: string): Promise<boolean> {
    let ps = await execInContainer(id, PS_TREE_CMD);
    if (ps.code !== 0 || ps.timedOut) ps = await execInContainer(id, ["ps"]);
    if (ps.code !== 0 || ps.timedOut) return true;
    const procs = parseProcTree(ps.stdout);
    if (procs.length) return liveAgentPresent(procs.map(proc => proc.comm));
    return liveAgentPresent(ps.stdout.split(/\s+/).map(token => token.replace(/.*\//, "")));
  }

  private async checkpointRecovery(id: string): Promise<void> {
    // Older images have no helper. A failed best-effort checkpoint never causes
    // a destructive repair or discards a previous valid journal.
    await sh(this.d.root, ...dockerArgv(id), "exec", id, "sh", "-c",
      "if [ -x /usr/local/bin/devbox-recovery ]; then timeout 10 /usr/local/bin/devbox-recovery snapshot; fi");
  }

  /** Fills in the branch for rows from before the `branch` column. Called at devd startup, because
   *  running sessions never reach the write when attaching in open() — and once the registration
   *  disappears, there is nowhere left to read the branch from. A broken worktree is skipped, nothing is guessed. */
  async recordBranches(): Promise<void> {
    for (const s of listSessions(this.d.db)) {
      if (!s.worktree || s.branch || !existsSync(s.worktree)) continue;
      const branch = await worktreeBranch(s.worktree);
      if (branch) setSessionBranch(this.d.db, s.id, branch);
    }
  }

  async checkpointRunning(): Promise<void> {
    // InstaBox: the VM does not shut down with devd, a checkpoint over SSH would only use up the 15s shutdown budget.
    await Promise.allSettled(this.list().filter(s => s.status === "running" && s.host !== "instabox")
      .map(s => this.checkpointRecovery(s.id)));
  }

  private async requireRecoveryReady(id: string): Promise<void> {
    const result = await sh(this.d.root, ...dockerArgv(id), "exec", id, "sh", "-c",
      "if [ -x /usr/local/bin/devbox-recovery ]; then /usr/local/bin/devbox-recovery check-ready; fi");
    if (result.code !== 0) throw new Error("Container is running but its tmux/Docker recovery is still pending");
  }

  /** Recover only the desired running row; stopped sessions remain stopped.
   * No git operations, account selection, prompt injection or activity bump. */
  async recoverAfterRestart(id: string): Promise<void> {
    return this.locked([id], "recovery", async () => {
      if (getSession(this.d.db, id)?.host === "instabox") return; // the container in the VM has --restart unless-stopped, a devd restart does not affect it
      const workspace = (s: SessionRow) => s.worktree ?? workspacePath(this.d.root, s.folder, s.project, s.repo);
      await recoverManagedSession({
        get: () => getSession(this.d.db, id),
        hasStopIntent: () => existsSync(join(this.controlDir(id), "recovery", "manual-stop")),
        markStopped: () => updateSession(this.d.db, id, { status: "stopped" }),
        hasWorkspace: s => existsSync(workspace(s)) && statSync(workspace(s)).isDirectory(),
        workspace: s => canonical(workspace(s)),
        inspect: async s => {
          const observed = await inspectCanonicalWorkspace(s.container);
          return { ...observed, workspace: observed.workspace ? canonical(observed.workspace) : undefined };
        },
        ensureDind: () => this.ensureDind(id, true),
        hasJournal: () => existsSync(join(this.controlDir(id), "recovery", "latest.json")),
        create: async s => {
          this.revokeShares(id); // this create() = a missing container is being created again
          await runContainer(await this.runOpts(id, workspace(s), s.port_base, s.project, s.repo,
            s.agent ?? "claude", s.worktree ? barePath(this.d.root, s.folder, s.project, s.repo) : null));
        },
        start: s => startContainer(s.container),
        ready: () => this.requireRecoveryReady(id),
        restored: (_, recreated) => logEvent(this.d.db, id, "restart-recovery", { recreated }),
      });
    });
  }

  /** Reopen the exact trusted Remote workspace without git pull or replacement ID selection. */
  async resumeRemote(id: string): Promise<{ session: SessionRow; cwd: string }> {
    const initial = loadRemoteRoute(id, this.d.root);
    const scope = codexRemoteLaunchScope(this.d.inFlight, id);
    if (scope) return this.confirmCodexRemoteLaunch(id, initial, scope);
    return this.locked([openKey(initial.restore)], "remote-resume", () => this.locked([id], "remote-resume", async () => {
      const route = loadRemoteRoute(id, this.d.root);
      if (JSON.stringify(route.restore) !== JSON.stringify(initial.restore) || route.cwd !== initial.cwd) {
        throw new Error("Remote restore descriptor changed while acquiring session locks");
      }
      const session = await restoreExactSession(route, {
        get: () => getSession(this.d.db, id),
        inspect: () => inspectRemoteContainer(id),
        prepareWorkspace: () => prepareRemoteWorkspace(route),
        ensureOwned: async (created) => {
          await this.ensureOwned(route.cwd);
          if (created && route.restore.bare) await this.ownBare(route.restore.bare);
        },
        clearPrompt: () => { this.syncPromptFile(id, { status: "clean" }); },
        ensureDind: () => this.ensureDind(id),
        start: () => startContainer(id),
        removeStopped: (observed) => removeStoppedWorkspaceContainer(observed),
        create: async (row) => {
          this.revokeShares(id); // no-op if the session did not have a row yet (fresh Remote resume)
          await runContainer(await this.runOpts(id, route.cwd, row.port_base,
            row.project, row.repo, row.agent ?? "codex", route.restore.bare));
        },
        allocatePort: () => allocatePortBase(this.d.db, this.d.cfg.settings),
        insert: (row) => insertSession(this.d.db, row),
        removeInserted: () => deleteSession(this.d.db, id),
        markRunning: (recreated, agent) => {
          setAutoEnd(this.d.db, id, 0);
          if (recreated && agent) setSessionAgent(this.d.db, id, agent);
          updateSession(this.d.db, id, { status: "running", last_active_at: this.now() });
          logEvent(this.d.db, id, "remote-resume", { recreated });
        },
        now: () => this.now(),
      });
      return { session, cwd: route.cwd };
    }));
  }

  /** A default-account continuation already owns the lifecycle lock. Its nested
   * dispatcher callbacks may confirm this exact live workspace, but cannot
   * reconcile a row, start a container, create an alias, or restore anything. */
  private async confirmCodexRemoteLaunch(id: string, route: RemoteRoute, scope: symbol): Promise<{ session: SessionRow; cwd: string }> {
    const matches = (row: SessionRow | null | undefined) => row && row.status === "running" && row.agent === "codex"
      && row.id === id && row.container === route.container && row.folder === route.restore.folder
      && row.project === route.restore.project && row.repo === route.restore.repo && row.solo === route.restore.solo
      && (row.worktree ?? null) === route.restore.worktree;
    if (!matches(getSession(this.d.db, id))) throw new SessionBusyError(id, "switch");
    // Compare the persisted raw bind source: resolving a symlink here could
    // hide that its persistent alias exists at a different path than route.cwd.
    const observed = await inspectCanonicalWorkspace(id);
    const latest = loadRemoteRoute(id, this.d.root);
    const session = getSession(this.d.db, id);
    if (codexRemoteLaunchScope(this.d.inFlight, id) !== scope || !matches(session)
      || latest.cwd !== route.cwd || JSON.stringify(latest.restore) !== JSON.stringify(route.restore)
      || observed.state !== "running" || observed.workspace !== route.cwd || observed.canonicalMount !== true) {
      throw new SessionBusyError(id, "switch");
    }
    return { session: session!, cwd: route.cwd };
  }

  // Reconcile only a verified external start; never pull, recreate, or start an agent.
  async markExternallyStarted(id: string): Promise<SessionRow> {
    const scope = codexRemoteLaunchScope(this.d.inFlight, id);
    if (scope) return (await this.confirmCodexRemoteLaunch(id, loadRemoteRoute(id, this.d.root), scope)).session;
    return this.locked([id], "external-resume", async () => {
      const session = getSession(this.d.db, id);
      if (!session) throw new ExternalStartError(`Unknown session ${id}`, "unknown");
      if (await containerState(session.container) !== "running") {
        throw new ExternalStartError(`Session ${id} container is not running`, "not-running");
      }
      if (session.status !== "running") {
        setAutoEnd(this.d.db, id, 0);
        updateSession(this.d.db, id, { status: "running", last_active_at: this.now() });
        logEvent(this.d.db, id, "external-resume");
      }
      return getSession(this.d.db, id)!;
    });
  }

  async restartSolo(id: string) {
    return this.locked([id], "restart", async () => {
      const s = getSession(this.d.db, id);
      if (!s) throw new RestartError(`Unknown session ${id}`, "unknown");
      if (s.solo !== 1) throw new RestartError(`${id} is not a claudeSolo session`, "not-solo");
      const observed = await inspectCanonicalWorkspace(id);
      if (observed.state !== "stopped") throw new RestartError(`${id} is not stopped (state: ${observed.state})`, "not-stopped");
      const ws = workspacePath(this.d.root, s.folder, s.project, s.repo);
      if (canonical(observed.workspace!) !== canonical(ws)) throw new Error("Container workspace differs from the recorded session; refusing recreation");
      const staleCanonicalMount = !observed.canonicalMount;

      const agent = s.agent ?? "claude";
      // Same trap as in open() (see proxyEnvStale above): this container is
      // STOPPED, so a mere startContainer does not change the environment — if an
      // old/empty proxy key or model stayed in it, after unlocking the vault the user would get
      // a reopened session with the same "unlock the vault" message forever. `running:
      // false` lets proxyEnvStale return true right away once the fresh env differs — for
      // a stopped session there is nothing to lose, a recreate is cheap (the workspace is a bind mount).
      const staleProxy = await this.proxyEnvStale(await containerEnv(id), agent, false);
      if (staleProxy || staleCanonicalMount) {
        this.revokeShares(id);
        if (staleCanonicalMount) await removeStoppedWorkspaceContainer(observed);
        else await removeContainer(id);
        await this.ensureDind(id);
        await runContainer(await this.runOpts(id, ws, s.port_base, s.project, s.repo, agent));
        logEvent(this.d.db, id, "recreate", { reason: staleCanonicalMount ? "canonical-workspace" : "proxy-env" });
      } else {
        await startContainer(id);
      }
      updateSession(this.d.db, id, { status: "running", last_active_at: this.now() });
      logEvent(this.d.db, id, "restart-solo");
    });
  }

  /** `keepWorktree`: do NOT delete the session's working directory. Used by a single caller —
   *  the automatic cleanup after a scheduled run (autoEnd.ts), when uncommitted work
   *  remained in the directory. It is not passed on a manual end (F9, `dev end`, dashboard):
   *  there a human is in the loop and the text tells them what will happen. */
  async end(id: string, soloAction: "keep" | "delete" = "keep", opts: { keepWorktree?: boolean } = {}) {
    return this.locked([id], "end", async () => {
      const s = getSession(this.d.db, id);
      if (!s) throw new Error(`Unknown session ${id}`);
      // Sharing belongs to the session, not the container — it ends with it (end/delete), but survives
      // stop/restart (that goes through stop(), not end()).
      this.revokeShares(id);
      if (s.host === "instabox") {
        await this.instaboxOrThrow().end(s);
        this.d.revokePlaceholder?.(id);
        rmSync(this.controlDir(id), { recursive: true, force: true });
        rmSync(this.claudeProjectsDir(id), { recursive: true, force: true });
        deleteGitStat(this.d.db, id);
        try { releaseLeasesForSession(this.d.db, id, this.now()); }
        catch (e) { console.error(`release lease for ${id} failed:`, e); }
        deleteSession(this.d.db, id);
        logEvent(this.d.db, id, "end", { host: "instabox" });
        return;
      }
      // Native history may resume after end(): retain its exact files, including uncommitted work.
      // Validate authority BEFORE removing Docker or files; malformed registry fails closed.
      const keepRemote = retainRemoteWorkspace(s, this.d.root);
      await this.d.preserveForEnd?.(s.container);
      await removeContainer(id);
      // The worktree belongs to the session, so it goes with it — except for `keepWorktree` (see above).
      // The branch does NOT: there may be work in progress on it and deleting it quietly when the window is closed
      // would be destructive. Orphaned branches are an acceptable price.
      // `worktree === null` means a repo in the old form with a SHARED workspace — that one
      // must not be deleted, it also belongs to the other sessions over the same repo.
      if (s.worktree && !opts.keepWorktree && !keepRemote) {
        await removeWorktree(barePath(this.d.root, s.folder, s.project, s.repo), s.worktree);
      }
      this.d.revokePlaceholder?.(id);   // the dummy must not outlive the session it belonged to
      await this.cleanupDind(id, false);
      rmSync(this.controlDir(id), { recursive: true, force: true });
      // Transcripts die with the session — same semantics as the worktree above. Without
      // cleanup, directories of dead sessions would pile up under _claude-projects forever.
      rmSync(this.claudeProjectsDir(id), { recursive: true, force: true });
      deleteGitStat(this.d.db, id);
      // The lease belongs to the session — without releasing it the account would look occupied until the
      // period expires and the poller would needlessly keep it at the fast cadence. An error here must not, however,
      // leave an orphaned session row (the container is already gone, the row below still has to be
      // deleted) — like prodMounts/accountMounts, a failure of a side
      // effect must do no more harm than if it were missing entirely.
      try { releaseLeasesForSession(this.d.db, id, this.now()); }
      catch (e) { console.error(`release lease for ${id} failed:`, e); }
      if (s.solo === 1 && soloAction === "delete") {
        rmSync(workspacePath(this.d.root, s.folder, s.project, s.repo), { recursive: true, force: true });
      }
      deleteSession(this.d.db, id);
      logEvent(this.d.db, id, "end", { soloAction: s.solo === 1 ? soloAction : undefined, ...(keepRemote ? { retainedRemoteWorkspace: true } : {}) });
    });
  }
}
