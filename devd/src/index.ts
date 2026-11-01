import { launchAgentStatus, updateLaunchAgent } from "./agentUpkeep";
import { preserveForEnd, STORAGE_GUARD } from "./storageGuard";
import type { UpkeepProvider, AgentUpkeepResult } from "../../shared/agentUpkeep";
import { startMysqlProxy } from "./mysqlProxy";
import { effectiveServer } from "./prodDb";
import { createDbOnboardingHost } from "./dbOnboardingHost";
import { resolveDbAdminTarget } from "./dbAdminTarget";
import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createVault } from "./vault";
import { createVaultNotifier } from "./vaultNotifier";
import { createGitProxy } from "./gitProxy";
import { createPlaceholderStore } from "./placeholders";
import { createOperationExec, prepareCoolifyDeployment } from "./operationExec";
import { createDbTargets } from "./dbTargets";
import { startDbProxy } from "./dbProxy";
import { createTunnelPool } from "./tunnelPool";
import { coolifyInstancesFromMcp } from "./coolify";
import { createPgConnect } from "./pgConnect";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { LiveActivities } from "./liveActivities";
import { AgentEventHub, STUCK_MS, stuckText, type NotifyExtra } from "./agentEvents";
import { endFinishedRuns } from "./autoEnd";
import { createApp, type ApiDeps } from "./api";
import { loadCatalog, mergeAccess, readAccessFile, type Access, type DbEntry, type ServerRef } from "./prodDb";
import { listSshKeys, readOpField, readSshKey } from "./op";
import { createProdKeyPath } from "./prodKeys";
import { executeWrite } from "./prodWrites";
import { buildBackupTar, restoreBackup } from "./backup";
import { CloneQueue } from "./clone";
import { alertNotifyExtra, pinAlerts, switchAlerts } from "./accountAlerts";
import { accountsBySession } from "./accountLease";
import { buildAccountViews } from "./accounts";
import { switchAccount } from "./accountSwitch";
import { switchAgent, type SwitchAgentDeps } from "./agentSwitch";
import { giteaTokensByHost, loadConfig, loadSecrets, materializeGiteaTokens, materializeMcpServers, readKeyFile, resolveAccountPool, resolveInstaboxSettings, saveGiteaTokens, writeKeyFile, type Secrets } from "./config";
import { createConfigRepo } from "./configrepo";
import { createGiteaApi } from "./gitea";
import { giteaAuthEnv } from "./git";
import {
  activeLeases, diskHistoryEnds, failRunningCloneJobs, getSession, type SessionRow, insertDiskTotal, lastMetricTs, listAccounts, listSessions, logEvent,
  openDb, pruneAccountLeases, pruneCriticReviews, pruneDiskStats, pruneEvents, pruneNotifyLog, prunePushAlerts,
} from "./db";
import { createSshAgents } from "./sshAgent";
import { pendingSshLabel, reapExpiredGrants } from "./sshApprovals";
import { isWideCidr } from "./network";
import { createCriticGate } from "./criticGate";
import type { CodexAuthDeps } from "./agentAuth";
import { accountMountList, type ProfileDeps } from "./accountProfiles";
import { pollAccount, pollAllDue, type PollerDeps } from "./accountPoller";
import { buildCodexView, type CodexPollerDeps } from "./codexPoller";
import { CodexAccounts } from "./codexAccounts";
import { readCodexServerAuth } from "./codexServerAuth";
import { CodexSessionAccounts } from "./codexSessionAccounts";
import { initCodexAccounts, listCodexAccounts } from "./codexAccountsDb";
import { codexAccountMountList } from "./codexAccountProfiles";
import { buildGrokView, pollGrok } from "./grokPoller";
import { pollAgy } from "./antigravityPoller";
import { harvestAgy } from "./antigravityHarvester";
import { harvestCodexAccounts } from "./codexHarvester";
import { startRecovery } from "./recovery";
import { harvestGrok } from "./grokHarvester";
import { collectTurnDiff, headSha } from "./criticDiff";
import { criticArgv, resolveCriticCfg } from "./criticProvider";
import { diskWarnMessage, pushOptsFor, shouldWarnDisk } from "./notify";
import { createListenerClient, type ListenerClient } from "./listener";
import { guardedTick } from "./tick";
import { createPushover, type Pushover } from "./pushover";
import { createApnsChannel, tickPushAlerts, type RunFn } from "./pushChannel";
import { predictDisk } from "./aggregate";
import { DEFAULT_CONTROL_ROOT, DEFAULT_DEVD_URL, DEFAULT_OPENROUTER_URL, SessionManager, upstreamKey } from "./sessions";
import { contextLengthCached } from "./openrouterModels";
import { parseMeminfo, resourceBreakdown } from "./resources";
import { classifyClaudeState, collectDiskUsage, collectDockerStatsAsync, collectGitStats, collectSessionGitStat, type DockerStat, type Runner } from "./stats";
import { createTmuxProbe } from "./tmux";
import { barePath, buildTree, ghLister, giteaLister, sessionWorkdir } from "./tree";
import { setUntrustedGitRoots } from "./safeGit";
import { memoAsync, memoAsyncStrict } from "./cache";
import { buildUnpushedReport, unpushedOps } from "./unpushed";
import { ApiErrorRetry, sweep429 } from "./apiErrorRetry";
import { defaultProbe, sweepIdleSessions } from "./watchdog";
import { getConnInfo, websocket } from "hono/bun";
import { vmFetch } from "./vmListener";
import { createShareApp, createShareFetch, shareHostFromEnv, startShareServer, tcpListening } from "./shareListener";
import { createPreview, DEFAULT_PREVIEW_DOMAIN } from "./sharePreview";
import { isShared, onShareRevoked } from "./shares";
import { dockerContainerId, isTainted, pruneTaints, sessionsWithTaint, stopDindSidecar, taintedContainerIds } from "./shareTaint";
import { createShareFirewall, firewallOnDockerEvent } from "./shareFirewall";
import { containerIdentity, dockerContainerSnapshot, SharedSessions, watchDockerEvents } from "./containerIdentity";
import { realSpawnPty } from "./pty";
import { containerState, execInContainer, execInContainerAsync, spawnWithTimeout } from "./docker";
import { dockerArgv, loadRemoteDockers, remoteDockerAlias, runDocker, setRemoteAuthRefresher } from "./dockerTarget";
import { createSdkClient } from "./instabox/client";
import { InstaboxSsh } from "./instabox/ssh";
import { InstaboxSessions, loadInstaboxIps } from "./instabox/sessions";
import { BaseBuilder, localImageDigest } from "./instabox/base";
import { createStatusCache, killOrphan, reconcile } from "./instabox/reconcile";
import { IBX_PATHS } from "./instabox/runOpts";
import { readHostLoad } from "./placement";
import { timeoutFor } from "./proc";
import { createScheduler } from "./scheduler";
import { ccStatus, dueForCheck, inWindow, resolveCcUpkeep, runCcUpkeep, type UpkeepDeps, type UpkeepResult } from "./ccUpkeep";
import { beszelFrom, createHardware, loadMachines, sshArgv } from "./hardware";

const env = (k: string, dflt: string) => process.env[k] ?? dflt;

const root = env("DEVD_ROOT", "/srv/dev");
const configDir = env("DEVD_CONFIG_DIR", "/etc/devd/config");
const cfg = loadConfig(join(configDir, "config.json"));
const configRepo = createConfigRepo(configDir);
const secretsPath = env("DEVD_SECRETS", "/etc/devd/secrets.json");
// File holding the proxy key — created by `install_cliproxy` (0600) next to the proxy config.
const cliproxyKeyPath = env("DEVD_CLIPROXY_KEY_FILE", "/etc/devd/cliproxy/api-key");
// OpenRouter key. Its own file, not the vault — for the same reason as the proxy above.
// Unlike that one, though, it is created by the dashboard via the API, not by the installer.
const openrouterKeyPath = env("DEVD_OPENROUTER_KEY_FILE", "/etc/devd/openrouter/api-key");
// Bridge to agent-sync, which runs outside devd and cannot see into the vault (see materializeMcpServers).
const agentSecretsPath = env("DEVD_AGENT_SECRETS", "/etc/devd/agent-secrets.json");
const vaultPath = process.env.DEVD_VAULT;
// With the vault, secrets.json is NOT READ at all and we start with empty secrets: the vault is
// locked after startup and its content only arrives in hydrate() after unlock. Without the vault
// everything stays as before, so a code deploy by itself changes nothing.
//
// The vault is used only when the file actually exists — if the variable pointed nowhere
// (rebuilt VPS, typo), we fall back to secrets.json; otherwise devd would run without
// secrets AND without any way to unlock.
const useVault = !!vaultPath && existsSync(vaultPath);
const secrets: Secrets = useVault ? {} : loadSecrets(secretsPath);
const db = openDb(env("DEVD_DB", "/var/lib/devd/devd.sqlite"));
initCodexAccounts(db);

// listener and pushover both take the token at construction, so we rebuild them after unlock.
// We hand out a thin delegate with a stable identity — subsystems that captured it
// (agentEvents, watchdog) do not need to know about the swap inside.
let listenerInner = createListenerClient(process.env.DEVD_LISTENER_URL, secrets.listenerToken);
const listener: ListenerClient = {
  open: (p) => listenerInner.open(p),
  openUrl: (u) => listenerInner.openUrl(u),
  proxyBridge: (ttl, port) => listenerInner.proxyBridge(ttl, port),
  notify: (t, m, e) => listenerInner.notify(t, m, e),
  clipboard: (k) => listenerInner.clipboard(k),
  dbRequest: (row, decide) => listenerInner.dbRequest(row, decide),
  sshApproval: (row, decide) => listenerInner.sshApproval(row, decide),
};
let pushoverInner = createPushover(secrets.pushover?.token, secrets.pushover?.user);
const pushoverChannel: Pushover = {
  get enabled() { return pushoverInner.enabled; },
  send: (t, m, o) => pushoverInner.send(t, m, o),
};

// APNs talks via curl (HTTP/2, see apns.ts) — the same Bun.spawn pattern as
// codexAuth.run below, just a different binary and no stdin (argv already carries `-d <json>`).
const runCurl: RunFn = async (cmd) => {
  const p = Bun.spawn(["curl", ...cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: code ?? 1, stdout, stderr };
};
// The APNs channel DELIBERATELY does not depend on the vault/hydrate() — the .p8 key sits on the
// VPS disk (root-only), not in the vault (same reasoning as the OpenRouter key: a locked
// vault after a restart would otherwise silence exactly the notifications meant to report that
// something is down). It therefore works right from startup, even before the vault is unlocked.
const apnsChannel = createApnsChannel({ db, run: runCurl, now: () => Date.now() }, cfg.settings.apns ?? null);
// The phone channel is chosen ONCE at startup from `settings.phoneChannel`
// (default "pushover") — switching is a deliberate step via config + devd restart,
// same as other values that are only read from the startup `cfg` snapshot.
const pushover: Pushover = cfg.settings.phoneChannel === "apns" ? apnsChannel : pushoverChannel;
// Emergency queue: until someone acknowledges the alert (POST /api/push/ack) or
// 10 min pass (see listOpenPushAlerts), APNs resends it every 30 s.
// APNs channel only — Pushover has retries built right into the EMERGENCY
// request (priority/retry/expire) and needs no queue in devd.
if (cfg.settings.phoneChannel === "apns") {
  if (!cfg.settings.apns) {
    console.warn(`phoneChannel="apns", but settings.apns is missing — the phone channel will run as a no-op (no push notifications)`);
  }
  // Single-flight guard: `--max-time 10` in apnsCurlArgs bounds the curl request, but
  // with more devices/alerts a single run can take over 30 s sequentially (the tick runs
  // serially through all of them). Without the guard, ticks would pile up on a hanging/slow
  // run and after the network recovers the same alerts would be sent several times at once
  // — the same pattern as `startUsagePoll`/`accountPollRunning` a bit above.
  let pushAlertsTickRunning = false;
  setInterval(() => {
    if (pushAlertsTickRunning) return;
    pushAlertsTickRunning = true;
    tickPushAlerts({ db, run: runCurl, now: () => Date.now() }, cfg.settings.apns ?? null)
      .catch((e) => console.error("APNs emergency queue failed:", (e as Error).message))
      .finally(() => { pushAlertsTickRunning = false; });
  }, 30_000);
}

// Public dashboard URL for links in notifications; without it notifications carry no link.
const dashboardUrl = env("DEVD_DASHBOARD_URL", "").replace(/\/+$/, "");
// Every notification fans out to the Mac (listener) AND the phone (Pushover, no-op until configured).
// important session → loud, persistent alert on the phone (Pushover emergency),
// otherwise a normal push. The Mac listener gets extra unchanged. The tap target
// (session terminal, or a page/screen per `extra.target`) is built by pushOptsFor.
// Defined BEFORE the vault: its hooks (onUnlock/onLock) notify through vaultNotifier.
const notify = (title: string, message: string, extra?: NotifyExtra) => {
  listener.notify(title, message, extra);
  pushover.send(title, message, pushOptsFor(extra, dashboardUrl));
};
// A vault locked after startup (= after every devd restart) is reported by devd itself via
// notify() with target "vault" — the APNs channel does not depend on the vault. Episode details
// in vaultNotifier.ts. Created BEFORE `vault`, so vault hooks never hit the TDZ (e.g. a future
// automatic unlock at startup); `isLocked` reads `vault` lazily, only when called.
const vaultNotifier = createVaultNotifier({ isLocked: () => vault?.isLocked() ?? false, notify });

// The vault is opt-in via DEVD_VAULT. Without it, it stays undefined and devd runs as before.
// `hydrate` is a function declaration (hoisted) — it is only called on unlock, when everything
// below is long initialized. hydrate() goes BEFORE the notification so that "unlocked" already
// reaches the rebuilt listener and Pushover; `finally` — the vault IS unlocked even if
// hydration fails, and the lock episode must be closed (the exception goes on to /api/vault/unlock).
const vault = useVault
  ? createVault(vaultPath!, {
    onUnlock: (s) => { try { hydrate(s); } finally { vaultNotifier.unlocked(); } },
    onLock: () => vaultNotifier.locked(),
  })
  : undefined;
if (vaultPath && !useVault) console.error(`DEVD_VAULT=${vaultPath} does not exist — devd runs from secrets.json`);
vaultNotifier.start();

/** After unlock, fills in secrets and rebuilds everything that takes values at construction.
 *  Only key NAMES go to the log, never values. */
function hydrate(s: Secrets): void {
  Object.assign(secrets, s);
  // giteaTokens must remain the SAME object — the gitea API and lister work on its identity.
  Object.assign(giteaTokens, s.giteaTokens ?? {});
  secrets.giteaTokens = giteaTokens;
  materializeGiteaTokens(giteaTokensPath, giteaTokens, getGiteaInstances());
  // Same for MCP servers: agent-sync is a separate process and cannot see into the vault.
  materializeMcpServers(agentSecretsPath, (secrets.mcpServers as Record<string, unknown>) ?? {});

  listenerInner = createListenerClient(process.env.DEVD_LISTENER_URL, secrets.listenerToken);
  pushoverInner = createPushover(secrets.pushover?.token, secrets.pushover?.user);
  hardware = buildHardware();
  apiDeps.hardware = hardware;
  apiDeps.opToken = secrets.opServiceAccountToken;
  console.log(`vault unlocked — available: ${Object.keys(s).sort().join(", ") || "nothing"}`);
}
const agentEvents = new AgentEventHub({ db, notify });
// State of running sessions surviving a devd restart (see agentEvents.ts loadPersisted):
// working/waiting come back as unknown (that state cannot be restored reliably without
// hook memory), done/failed unchanged. Must run before the first hook/sweep tick manages
// to overwrite the default "unknown" with a new state.
agentEvents.loadPersisted(listSessions(db));
// Independent of phoneChannel/important notification filtering; dedicated iOS opt-in.
const liveActivities = new LiveActivities({ db, hub: agentEvents, config: cfg.settings.apns ?? null, run: runCurl });
setInterval(() => { void liveActivities.tick().catch(() => console.warn("live activities: tick failed")); }, 5_000);

const giteaTokensPath = process.env.DEVD_GITEA_TOKENS ?? "/etc/devd/gitea-tokens.json";
// Shared mutable object: the lister, /api/gitea/* and token writes all work on
// the same map, so a new token takes effect immediately without restarting devd.
const giteaTokens: Record<string, string> = secrets.giteaTokens ?? {};
secrets.giteaTokens = giteaTokens;
// With the vault we do NOT MATERIALIZE at startup: we do not know the tokens yet, and overwriting
// the existing file with an empty map would break git in all running containers until someone
// unlocks. It is written only in hydrate(), when we have something to write.
if (!useVault) materializeGiteaTokens(giteaTokensPath, giteaTokens, cfg.giteaInstances ?? []);
if (!useVault) materializeMcpServers(agentSecretsPath, (secrets.mcpServers as Record<string, unknown>) ?? {});
const ghConfigDir = process.env.DEVD_GH_CONFIG_DIR ?? "/root/.config/gh";
// devd runs as a systemd service without $HOME, so host-side `gh` calls (github.ts
// owners/repos, tree.ghLister) can't find root's auth in ~/.config/gh. Point gh at the
// config dir explicitly so every gh subprocess we Bun.spawn inherits it via process.env.
process.env.GH_CONFIG_DIR = ghConfigDir;
// gh writes its config dir 0700 with config.yml/hosts.yml at 0600, but containers mount it
// read-only as uid 1000 and gh refuses to start if it can't read config.yml (so private-repo
// git auth via `gh auth setup-git` breaks in sessions AND agent-sync). Relax to container-
// readable — single-operator host, same trade-off as the gitea tokens above. Best-effort.
try {
  chmodSync(ghConfigDir, 0o755);
  for (const f of ["config.yml", "hosts.yml"]) { try { chmodSync(join(ghConfigDir, f), 0o644); } catch { /* file absent */ } }
} catch { /* gh not logged in yet */ }

// Install-specific tools for sessions (e.g. private MCP servers), mounted read-only at
// /opt/devbox-tools. Checked at startup: creating the directory later needs a devd restart.
const toolsDir = env("DEVD_TOOLS_DIR", "/opt/devbox-tools");
const prodCatalogPath = env("PROD_DB_CATALOG", "/srv/prod-db/catalog.json");
const prodCatalog = existsSync(prodCatalogPath) ? loadCatalog(prodCatalogPath) : undefined;
// Claims = repo default + host-side overlay that devd writes into on approval of a
// database request (api.ts /confirm). The overlay sits next to the catalog — so the host has
// one place where prod-db is configured, and a restart does not lose an approved claim.
const prodAccessPath = env("PROD_DB_ACCESS", join(dirname(prodCatalogPath), "access.json"));
const prodDbAccess = mergeAccess(
  JSON.parse(readFileSync(new URL("./prodDbAccess.json", import.meta.url), "utf8")) as Record<string, Access>,
  readAccessFile(prodAccessPath),
);
// The 1P token is read on use, not at startup — with the vault we do not have it yet at that point.
// Whether the routes exist depends on whether the token *can* exist (vault or secrets.json).
const needOpToken = (): string => {
  const t = secrets.opServiceAccountToken;
  if (!t) throw new Error("1Password token is not available — is the vault unlocked?");
  return t;
};
const opAvailable = useVault || !!secrets.opServiceAccountToken;
const readProdSecret = opAvailable ? (opItem: string) => readOpField(needOpToken(), opItem) : undefined;
// Injected lister for POST /api/ssh-approvals (see ApiDeps.sshKeyLister) — same
// convention as readProdSecret: the token is read on call, not at startup, so
// with the vault it starts working right after unlock without restarting devd.
//
// `op item list` goes through `run()` (see proc.ts) — asynchronously, but POST /api/ssh-approvals
// is reachable with just an x-devbox-session header. The call count is bounded by `approvalLimiter`
// (api.ts), the cost of one call by this cache: without it even requests within the limit
// would hammer `op` with made-up titles on every request from all sessions and the dashboard. memoAsyncStrict (60 s): the cost is that a key newly added in 1Password
// shows up in the approval flow only after that time. Errors are not cached, so a 1Password outage
// does not trap the flow for a minute.
// `async` wrapper (not just `() => listSshKeys(...)`): a locked vault makes
// `needOpToken()` throw before a promise even exists, and `memoAsyncStrict`
// would then let the failure through as a SYNCHRONOUS throw instead of a rejection (review finding)
// — both current callers (api.ts) catch it in try/catch, but `async` here
// costs nothing and makes the type (`() => Promise<...>`) truthful for future callers too.
const sshKeyLister = opAvailable ? memoAsyncStrict(async () => listSshKeys(needOpToken()), 60_000) : undefined;
// Escape hatch for approvalGate (see api.ts, network.ts): loopback + tailnet (100.64.0.0/10)
// are always in the allowlist, this is only a manual extra addition — typically the IP the
// dashboard's cloudflared tunnel comes from (could not be verified in advance on a live host, see docs/mac.md).
// If the dashboard starts reporting 403 after a deploy, the address is in the devd log at the rejected
// request ("SSH approval: denied … address …") — add it here, not to the code.
const approvalAllowExtra = env("DEVD_APPROVAL_ALLOW", "").split(",").map((s) => s.trim()).filter(Boolean);
// We do not reject a wide entry (an operator in an emergency has the right to put e.g. 0.0.0.0/0),
// but we warn loudly about it at startup — the most common mistake is carelessly pasting an
// address from the log without /32 (see isWideCidr in network.ts for the threshold and reasoning).
for (const entry of approvalAllowExtra) {
  if (isWideCidr(entry)) {
    console.warn(`⚠ DEVD_APPROVAL_ALLOW: "${entry}" is a suspiciously wide range — the SSH approval gate will be reachable from far more addresses than a single tunnel/network. Check whether that is intended.`);
  }
}
const prodKeyDir = mkdtempSync(join(tmpdir(), "prod-keys-"));
// createProdKeyPath (prodKeys.ts) caches the in-flight promise, not the finished path —
// concurrent calls for the same key (typically two sessions being created at once for the same
// project) share one op read and one write, instead of both writeFileSync calls
// truncating the same path under each other (see the comment in prodKeys.ts).
const prodKeyPath = createProdKeyPath(
  prodKeyDir,
  (key) => readSshKey(needOpToken(), key),
  // Host-owned keys never become readable by the agent UID.
  () => {},
);
const prodTunnels = createTunnelPool({ keyPath: (k) => prodKeyPath(k) });
const execProdWrite = opAvailable && prodCatalog
  ? async ({ entry, server, sql, preview, scope }: { entry: DbEntry; server: ServerRef; sql: string; preview: boolean; scope?: "dml" | "migration" }) => {
      const target = effectiveServer(entry, server);
      const item = scope === "migration" ? entry.migrationOpItem : entry.rwOpItem;
      if (!item) throw new Error(scope === "migration" ? "migration_credentials_missing" : "write_credentials_missing");
      return executeWrite(entry, target, "", await readOpField(needOpToken(), item), sql, {
        preview, scope, ensureTunnel: () => prodTunnels.ensure(target, entry.hostPort),
      });
    }
  : undefined;

// Config is read fresh from disk — PUT /api/config only writes, and the process otherwise holds
// the startup snapshot; tree/clone/gitea thus see dashboard changes without a restart.
// Falls back to the startup snapshot if the file happens to be unreadable.
const freshCfg = () => { try { return configRepo.read(); } catch { return cfg; } };
const getGiteaInstances = () => freshCfg().giteaInstances ?? [];
// devd on the host has no gitea credential helper (that one is only in the container image),
// so clone/pull of a private gitea repo (bulk Cloning and open session) would otherwise
// fail with "could not read Username". Map clone URL → gitea instance (by
// host) → token → git auth env. Shared by CloneQueue and SessionManager.
const hostOf = (u: string): string | null => { try { return new URL(u).host; } catch { return null; } };
const credentialsForUrl = (url: string): Record<string, string> => {
  const host = hostOf(url);
  if (!host) return {};
  return giteaAuthEnv(url, giteaTokensByHost(getGiteaInstances(), giteaTokens)[host]);
};

// Shared with sshAgents below: the ssh-agent socket lives in the same per-session
// directory that SessionManager mounts into the container as /run/devd.
const controlRoot = env("DEVD_CONTROL_ROOT", DEFAULT_CONTROL_ROOT);
// Git token placeholders. Created BEFORE SessionManager — it hands them out when creating a session.
// dind is opt-in: without DEVD_DIND the host socket stays where it was, and a code deploy
// by itself does not change the behavior of a running box. Enabling it is a deliberate step — new
// containers then get their own daemon and stop seeing the host.
const dindEnabled = process.env.DEVD_DIND === "1";

const placeholders = createPlaceholderStore(db);

// `dev switch`: decision + panel restart + lease write, all in accountSwitch.ts.
// The lock AGAINST CONCURRENCY on the SAME session lives inside switchAccount (`inFlight` set,
// shared across calls through this single object) — without it two concurrent
// `dev switch` calls on the same session could send /exit into each other: the second
// call would hit a panel the first had just returned to a live conversation, and
// would also discard what the first had just restored (review round 2). Concurrent calls on a
// DIFFERENT session (another container/lease) are harmless — hence NO global lock
// like `accountPollRunning`/`ccUpkeepRunning` above, just this per-session set.
// SessionManager shares it too (open/stop/end/recreate/restart).
const accountSwitchInFlight = new Set<string>();
// One source for session mounts and for InstaBox (volume copies, credentials sync, R1) —
// if the filter diverged, the VM would get different accounts than the container mounts.
const poolAccountIds = () => ({
  claude: listAccounts(db).map((a) => a.id),
  codex: listCodexAccounts(db).filter((a) => a.id !== "default" && a.status === "ready").map((a) => a.id),
});
const mgr = new SessionManager({
  // Session time zone: DEVD_TZ, otherwise the host zone (not UTC — see sessions.ts).
  tz: env("DEVD_TZ", Intl.DateTimeFormat().resolvedOptions().timeZone),
  dind: dindEnabled,
  preserveForEnd: (container) => preserveForEnd(container),
  storageGuard: () => existsSync(STORAGE_GUARD),
  // A shared / tainted session gets no dind sidecar (shareTaint.ts, final review C2).
  shareRestricted: async (id) => {
    if (isShared(db, id)) return true;
    if (taintedContainerIds(db, id).length === 0) return false;
    const s = getSession(db, id);
    return !!s && isTainted(db, id, await dockerContainerId(s.container));
  },
  issuePlaceholder: (session, instance) => placeholders.issue(session, instance),
  revokePlaceholder: (session) => placeholders.revoke(session),
  giteaInstances: getGiteaInstances,
  db, cfg, root,
  image: env("DEVD_IMAGE", "devbox:latest"),
  bindIp: process.env.DEVD_BIND_IP,
  controlRoot,
  devdUrl: env("DEVD_URL", DEFAULT_DEVD_URL),
  // vscode-server is a shared volume so that "Attach to Running Container" does not download the
  // VS Code server again into every session.
  // prod-db catalog from the HOST (not the one baked into the image): the `prod-db list/connect` skill
  // in the container would otherwise not know databases approved after the last image build. Read-only, only if it exists.
  extraMounts: [...(dindEnabled ? [] : ["/var/run/docker.sock:/var/run/docker.sock"]), ...(existsSync(prodCatalogPath) ? [`${prodCatalogPath}:/srv/prod-db/catalog.json:ro`] : []), "claude-home:/home/dev/.claude", "codex-home:/home/dev/.codex", "grok-home:/home/dev/.grok", "antigravity-home:/home/dev/.gemini", "vscode-server:/home/dev/.vscode-server", "/etc/devd/mac-mcp:/opt/mac-mcp:ro", ...(existsSync(toolsDir) ? [`${toolsDir}:/opt/devbox-tools:ro`] : [])],
  ghConfigDir, // presence re-checked per-session in SessionManager.runOpts (existsSync there), so a post-startup `gh auth login` doesn't need a devd restart
  giteaTokensPath,                                                // always materialized above, so always present
  credentials: credentialsForUrl,
  notify,
  accountMounts: () => { const ids = poolAccountIds(); return [...accountMountList(ids.claude), ...codexAccountMountList(ids.codex)]; },
  prodCatalog, prodDbAccess, // Production keys remain host-only; sessions use the DB proxy.
  // Keys for third-party upstreams are read from the files that own them (see readKeyFile) — NOT from the vault.
  // Read when EVERY container is created, so a freshly installed proxy starts working without
  // a devd restart. And unlike the vault, it does not matter here whether it is unlocked.
  cliproxyKey: () => readKeyFile(cliproxyKeyPath),
  openrouterKey: () => readKeyFile(openrouterKeyPath),
  // The proxy profile model is changed from the dashboard at runtime, so it MUST be read from disk.
  // From the startup snapshot (`cfg`) the change would only apply after a devd restart — and that
  // is exactly what the dashboard card does not promise.
  settings: () => freshCfg().settings,
  inFlight: accountSwitchInFlight,
});
// InstaBox overflow (opt-in via settings.instabox.devdUrl). Keys from files, not from the vault
// (decision in the plan, Task 1): pause/resume must work even with a vault locked after a restart.
const ibxResolved = resolveInstaboxSettings(cfg.settings.instabox);
// VM listener port (C1): `DEVD_VM_PORT` overrides config — one value for the listener and for
// DEVD_URL/OTel/git proxy that containers in the VM receive (vmDevdUrl).
const ibxSettings = ibxResolved ? { ...ibxResolved, vmPort: Number(env("DEVD_VM_PORT", String(ibxResolved.vmPort))) } : null;
const ibxKeyPath = env("DEVD_INSTABOX_KEY_FILE", "/etc/devd/instabox/api-key");
const ibxTsKeyPath = env("DEVD_INSTABOX_TS_KEY_FILE", "/etc/devd/instabox/tailscale-auth-key");
const ibxImage = env("DEVD_IMAGE", "devbox:latest");
const ibxClient = ibxSettings ? createSdkClient(() => readKeyFile(ibxKeyPath)) : null;
const ibxSsh = ibxClient ? new InstaboxSsh(ibxClient) : null;
// The real gitea tokens (credentialsForUrl) DELIBERATELY do NOT go here — they must not reach the VM (Task 8).
// ghConfigDir and placeholder revoke are the SAME as for SessionManager.
const ibxSessions = ibxClient && ibxSsh && ibxSettings ? new InstaboxSessions({
  db, cfg, root, controlRoot, client: ibxClient, ssh: ibxSsh, settings: ibxSettings,
  tailscaleAuthKey: () => readKeyFile(ibxTsKeyPath),
  image: ibxImage, mgr, ghConfigDir,
  revokePlaceholder: (session) => placeholders.revoke(session),
  accountIds: poolAccountIds, notify: (title, message) => notify(title, message),
}) : null;
if (ibxSessions) mgr.attachInstabox(ibxSessions);
// Single instance per process: two builders would overwrite each other's instabox_base.
const baseBuilder = ibxClient && ibxSsh ? new BaseBuilder({ db, client: ibxClient, ssh: ibxSsh, image: ibxImage }) : null;
// Aliases of running InstaBox sessions must be known before startupRecovery, the watchdog
// or the terminal touch their container (otherwise they would go to local docker → "missing").
loadRemoteDockers(db);
// C1: tailnet IPs of known InstaBox machines back into the approval-gate ban list (network.ts).
loadInstaboxIps(db);
setRemoteAuthRefresher(ibxSsh ? async (container) => {
  const s = listSessions(db).find((x) => x.container === container);
  if (s?.instabox_machine_id) await ibxSsh.ensure(s.instabox_machine_id, true);
} : null);
// Create interrupted by a devd restart: a row without a finished machine would otherwise hang as "running".
if (ibxSessions) void ibxSessions.sweepInterruptedCreates().catch((e) => console.error("instabox sweep failed:", e));
const runningIbx = () => listSessions(db).filter((s) => s.host === "instabox" && s.status === "running" && s.instabox_machine_id);
// reconcile() does not throw (API outage → ok:false). The dashboard gets status up to 30 s old,
// otherwise freshly recomputed; the 10-min timer below keeps the cache warm.
const ibxStatus = ibxClient ? createStatusCache(() => reconcile(db, ibxClient, () => localImageDigest(ibxImage), { buildRunning: () => baseBuilder?.isRunning() ?? false }), 30_000) : null;
const ibxMetrics = new Map<string, { cpuPct: number; memBytes: number }>();
const refreshIbxMetrics = async () => {
  if (!ibxClient) return;
  const running = runningIbx();
  const live = new Set(running.map((s) => s.container));
  for (const c of ibxMetrics.keys()) if (!live.has(c)) ibxMetrics.delete(c);
  for (const s of running) {
    try { const m = await ibxClient.metrics(s.instabox_machine_id!); if (m) ibxMetrics.set(s.container, m); }
    catch { /* next round; status will show the API outage */ }
  }
};
// Per-session ssh-agent on the host (see sshAgent.ts) — the key is read from 1P only on
// activation, not at devd startup. `sshAgents` is both here and in ApiDeps: the interval
// below (cleanup of expired grants) needs it too.
const sshAgents = createSshAgents({
  controlDir: (s) => join(controlRoot, s),
  readKey: (title) => readSshKey(needOpToken(), title),
});
const listers = { github: ghLister, gitea: giteaLister(getGiteaInstances, giteaTokens) };
const gitea = createGiteaApi({
  getInstances: getGiteaInstances,
  tokens: giteaTokens,
  // With the vault, the new token is sealed back into it (we hold the key since unlock),
  // without the vault it goes to secrets.json as before.
  persist: (t) => {
    if (vault) vault.update((s) => { s.giteaTokens = { ...t }; });
    else saveGiteaTokens(secretsPath, t);
    materializeGiteaTokens(giteaTokensPath, t, getGiteaInstances());
  },
});
// buildTree runs `gh repo list` (subprocess + GitHub API) and a fetch to Gitea, so
// raw it takes ~1.4 s — and the dashboard asks for it every time Sessions
// or Folders is opened. Config and newly cloned repos invalidate the cache explicitly, so the TTL
// is only a safety net for changes that come from outside (a new repo in the GitHub organization).
const treeCache = memoAsync(() => buildTree(freshCfg(), root, listers), 60_000);
const tree = () => treeCache.get();
// Unpushed commits across the whole workspace (Work in progress page). Scan = several
// git calls per repo, four at a time; stale-while-revalidate just like
// tree — the page gets the old value immediately and the refresh runs in the background.
const unpushedCache = memoAsync(() => buildUnpushedReport(root, { giteaHosts: getGiteaInstances().map((i) => i.url) }), 60_000);
// Push / Create PR from the page: git auth for Gitea same as for clone (credentialsForUrl),
// GitHub goes through the gh helper on the host; PRs on Gitea via the API with a token from the vault.
const unpushed = {
  ...unpushedCache,
  ...unpushedOps(root, {
    authFor: credentialsForUrl,
    giteaToken: (host) => giteaTokensByHost(getGiteaInstances(), giteaTokens)[host],
    giteaUrls: () => getGiteaInstances().map((i) => i.url),
  }),
};
const diskTotal = Number(env("DEVD_DISK_TOTAL", "2000000000000"));
let lastDiskWarnTs = 0;

// devd restart recovery: any clone_jobs row still marked "running" belongs to an
// in-memory CloneQueue that no longer exists — finalize it now so CLI/dashboard
// pollers (which loop `while status==="running"` with no timeout) don't hang forever.
failRunningCloneJobs(db);

// `docker stats --no-stream` takes 1-2s; liveStats() is polled every 5s by
// /api/stats/live, and running it synchronously on every request would block the
// daemon's single JS thread for that long each time. Collect it on its own timer
// into a cache instead; liveStats() just reads the cache.
let dockerStatsCache: DockerStat[] = [];
async function refreshDockerStatsCache() {
  dockerStatsCache = await collectDockerStatsAsync();
}
refreshDockerStatsCache().catch((e) => console.error("docker stats refresh failed:", e));
setInterval(guardedTick("docker stats refresh", () => refreshDockerStatsCache()), 15_000);

// Hardware → "Sessions by resources". Reads only the docker stats cache and two files
// from /proc and /sys — no subprocess, so it may be called on every request.
function codexMemBytes(): number | null {
  try { return Number(readFileSync("/sys/fs/cgroup/system.slice/codex-remote-control.service/memory.current", "utf8").trim()) || null; }
  catch { return null; }
}
function resources() {
  let mem = { totalBytes: 0, usedBytes: 0 };
  try { mem = parseMeminfo(readFileSync("/proc/meminfo", "utf8")); } catch { /* only outside Linux */ }
  return resourceBreakdown(listSessions(db), dockerStatsCache, mem, codexMemBytes());
}

function liveStats() {
  const now = Date.now();
  // Session account from active leases — one source of truth, so the dashboard does not
  // compute it itself (forked logic for "which account the session runs on").
  const leaseBySession = accountsBySession(activeLeases(db, now, leaseMaxAgeMs()));
  const taints = sessionsWithTaint(db);
  // After a rebuild the container map must know the new docker id — the next poll (5 s) sees the result.
  if (taints.size) void containerIdentity.refreshIfStale().catch(() => {});
  const sessions = listSessions(db).map((s) => {
    const ibx = s.host === "instabox";
    const ws = ibx ? IBX_PATHS.ws(s.id) : sessionWorkdir(root, s);
    const dstat = ibx ? ibxMetrics.get(s.container) : dockerStatsCache.find((x) => x.container === s.container);
    return {
      ...s,
      ports: Array.from({ length: cfg.settings.portsPerSession }, (_, i) => ({ host: s.port_base + i, container: 3000 + i })),
      claudeState: classifyClaudeState(lastMetricTs(db, s.id), s.last_active_at, now),
      cpuPct: dstat?.cpuPct ?? 0, memBytes: dstat?.memBytes ?? 0, workspace: ws,
      accountId: leaseBySession.get(s.id) ?? null,
      dockerHost: remoteDockerAlias(s.container),
      // The container was shared and has not been rebuilt yet → restricted (shareTaint.ts); the UI offers a rebuild.
      tainted: taints.has(s.id) && restrictedView.tainted(s.id),
    };
  });
  const usedBytes = diskHistoryEnds(db).at(-1)?.bytes ?? 0;
  return { sessions, disk: { usedBytes, totalBytes: diskTotal } };
}

const cloneQueue = new CloneQueue({
  db, root, tree,
  credentials: credentialsForUrl,
  diskCheck: () => ({ ...liveStats().disk, warnPercent: cfg.settings.diskWarnPercent }),
  onDone: (job) => {
    treeCache.invalidate();   // `cloned: true` on new repos must show up immediately
    const errs = job.results.filter((r) => !r.ok);
    notify("devbox", `Cloning finished: ${job.done}/${job.total}${errs.length ? ` (errors: ${errs.map((e) => e.repo).join(", ")})` : ""}`);
  },
});
const dashboardDir = env("DEVD_DASHBOARD_DIR", `${import.meta.dir}/../../dashboard/dist`);
const backupDeps = { volume: "claude-home", codexVolume: "codex-home", extraVolumes: [{ volume: "grok-home", file: "grok-home.tgz" }, { volume: "antigravity-home", file: "antigravity-home.tgz" }], secretsPath, vaultPath, dbPath: env("DEVD_DB", "/var/lib/devd/devd.sqlite"), tmpDir: "/tmp/devd-backup" };

// Scheduled (cron) runs: reuse the prompt channel (mgr.open with a prompt), run in
// bypass in tmux `main`, are important (the stuck detector watches). Skip when the session is running.
const scheduler = createScheduler({
  db, notify,
  open: (t) => mgr.open(t),
  containerRunning: async (id) => (await containerState(id)) === "running",
});

// Standing critic: Stop hook → criticGate → review in the SAME container via docker exec.
// Config is read fresh (freshCfg), so a provider/model change from the dashboard
// applies without restarting devd.
const critic = createCriticGate({
  db,
  cfg: () => resolveCriticCfg(freshCfg().settings.critic),
  head: (s) => headSha(sessionWorkdir(root, s)),
  diff: (s, baseline) => collectTurnDiff(sessionWorkdir(root, s), baseline),
  run: async (s, prompt, cfg) => {
    const r = await execInContainerAsync(s.container, criticArgv(cfg), cfg.timeoutSec * 1000, prompt);
    if (r.timedOut) throw new Error(`kritik nestihl ${cfg.timeoutSec} s`);
    if (r.code !== 0) throw new Error(`critic exited with code ${r.code}: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  },
});

// codexAuth: docker CLI via the host socket (async so it does not block the event loop), short sleep for log-poll.
const codexAuth: CodexAuthDeps = {
  run: async (cmd, input) => {
    const p = Bun.spawn(["docker", ...cmd], { stdout: "pipe", stderr: "pipe", stdin: input !== undefined ? "pipe" : "ignore" });
    if (input !== undefined && p.stdin) { p.stdin.write(input); p.stdin.end(); }
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code: code ?? 1, stdout, stderr };
  },
  sleep: (ms) => Bun.sleep(ms),
  image: env("DEVD_IMAGE", "devbox:latest"),
};

// Account profiles: the same docker calls as codexAuth, just a different purpose.
const accountProfiles: ProfileDeps = {
  run: codexAuth.run,
  image: env("DEVD_IMAGE", "devbox:latest"),
};
const codexAccounts = new CodexAccounts({ db, auth: codexAuth, fetch, readServerAuth: readCodexServerAuth });
// After this long an unreleased lease counts as abandoned. Read fresh (freshCfg),
// same convention as getGiteaInstances/tree above — otherwise a change to autoStopHours
// from the dashboard would only apply after a devd restart (the poller and /api/accounts would keep
// seeing the startup snapshot `cfg`).
const leaseMaxAgeMs = () => freshCfg().settings.autoStopHours * 3600_000;
const accountPollerDeps = (): PollerDeps => ({
  db, profiles: accountProfiles, fetch,
  now: () => Date.now(),
  settings: () => resolveAccountPool(freshCfg().settings),
  leaseMaxAgeMs: leaseMaxAgeMs(),
});
// Re-entrance guard: docker-backed profile reads can take longer than the 30s tick of
// the timer below — without this safeguard a second run would start over the first.
let accountPollRunning = false;

// The same docker calls as codexAuth and accountProfiles, just a different purpose — hence
// `codexAuth.run` is shared, not copied. GrokPollerDeps is an alias of CodexPollerDeps,
// so one factory serves both usage pollers.
const usagePollerDeps = (): CodexPollerDeps => ({
  db, run: codexAuth.run, fetch, now: () => Date.now(), image: env("DEVD_IMAGE", "devbox:latest"),
});

// Manual "Refresh" from the dashboard. Does not wait for `pollDue` (that is the point — backoff after
// an error is exactly the situation where a person clicks), but runs on the SAME account are merged: each
// poll spins up an ephemeral container over the profile and a double click (or two open
// dashboards) would otherwise produce two concurrent ones overwriting the same row.
const accountRefreshing = new Map<string, Promise<void>>();
const refreshAccount = (id: string): Promise<void> => {
  const running = accountRefreshing.get(id);
  if (running) return running;
  const p = pollAccount(accountPollerDeps(), id).finally(() => accountRefreshing.delete(id));
  accountRefreshing.set(id, p);
  return p;
};

// Shared by ccUpkeep (nightly upgrade restart) and accountSwitch (`dev switch`
// restart) — both need the same docker exec + real waiting, just for a different purpose.
const dockerExec = (container: string, cmd: string[], timeoutMs: number) =>
  runDocker(container, ["exec", container, ...cmd], { timeoutMs });
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// cc upkeep: once a day in the night window. Run state is only in memory — after a devd
// restart it may start once more in the same window, which is a no-op (the version already matches).
let ccUpkeepLastRun: number | null = null;
let ccUpkeepRunning = false;
const ccUpkeepDeps = (): UpkeepDeps => ({
  db,
  exec: dockerExec,
  host: (cmd, timeoutMs) => spawnWithTimeout(cmd, timeoutMs),
  turnInProgress: (id) => agentEvents.turnInProgress(id),
  notify,
  sleep: realSleep,
  repoDir: process.cwd(),
  image: env("DEVD_IMAGE", "devbox:latest"),
});
// One lock for the nightly tick and the manual run from the dashboard: two concurrent runs would
// restart each other's panels and the idle probe would measure someone else's load.
const ccUpkeepRun = async (only?: string[]): Promise<UpkeepResult | null> => {
  if (ccUpkeepRunning) return null;
  ccUpkeepRunning = true;
  // After the run the remembered cc version is false — the cache must go, so the dashboard
  // shows the result of the upgrade and not the state before it.
  try { return await runCcUpkeep(ccUpkeepDeps(), only); }
  finally { ccUpkeepRunning = false; ccStatusCache.invalidate(); }
};

// ccStatus runs `docker run --rm` twice (one of them `npm view` against the registry) and
// `docker exec` 5× on running sessions — 2.16 s. The dashboard asks for it every time
// Sessions is opened. 60 s is a compromise: the cc version does not change within a minute, and after
// a manual upkeep run we invalidate the cache anyway.
const ccStatusCache = memoAsync(() => ccStatus(ccUpkeepDeps()), 60_000);
const launchStatusCaches = {
  codex: memoAsync(() => launchAgentStatus(ccUpkeepDeps(), "codex"), 60_000),
  grok: memoAsync(() => launchAgentStatus(ccUpkeepDeps(), "grok"), 60_000),
  agy: memoAsync(() => launchAgentStatus(ccUpkeepDeps(), "agy"), 60_000),
};
const agentUpkeep = {
  status: async (provider: UpkeepProvider) => {
    if (provider !== "claude") return launchStatusCaches[provider].get();
    const status = await ccStatusCache.get();
    return { provider, latest:status.latest, image:status.image, mode:"nightly" as const, sessions:status.sessions.map((s) => ({id:s.id,project:s.project,repo:s.repo,version:s.version,running:s.panes,restartRequired:s.stalePanes === null ? null : s.stalePanes > 0})) };
  },
  run: async (provider: UpkeepProvider, only?: string[]): Promise<AgentUpkeepResult | null> => {
    if (provider === "claude") {
      const r = await ccUpkeepRun(only);
      return r && {provider,updated:r.updated,restarted:r.restarted,deferred:r.skipped,failed:[],unchanged:[],built:r.built,...(!r.latest ? {error:"Latest version is unavailable."} : {})};
    }
    if (ccUpkeepRunning) return null;
    ccUpkeepRunning = true;
    try { return await updateLaunchAgent(ccUpkeepDeps(),provider,only); }
    finally { ccUpkeepRunning = false; launchStatusCaches[provider].invalidate(); }
  },
};

const accountSwitchDeps = () => ({
  db, exec: dockerExec, sleep: realSleep,
  settings: () => resolveAccountPool(freshCfg().settings),
  now: () => Date.now(),
  inFlight: accountSwitchInFlight,
});

// Live agent (harness) swap: shares `inFlight` with accountSwitch — both operations
// restart the same panels and concurrency on one session would discard each other's
// in-progress turns. proxyEnvFor goes through SessionManager so that the key/model/window
// come from the SAME assembly as the new container's env.
const agentSwitchDeps = (): SwitchAgentDeps => ({
  db, exec: dockerExec, sleep: realSleep,
  now: () => Date.now(),
  inFlight: accountSwitchInFlight,
  proxyEnvFor: (a) => mgr.proxyEnvFor(a),
});

// Hardware tab: Beszel + host probe + borg + Uptime Kuma. Without secrets it is not created
// at all and the API returns 503 — devd must run even on a machine where nobody set up monitoring.
const remoteSsh = () => secrets.remoteSsh ?? secrets.lnrtSsh;
const machines = loadMachines(env("DEVD_HARDWARE", "/etc/devd/hardware.json"));
const buildHardware = () => (secrets.beszel || secrets.uptimeKuma || remoteSsh())
  ? createHardware({
      machines,
      beszel: beszelFrom(secrets.beszel),
      kuma: secrets.uptimeKuma,
      run: async (host, script, timeoutMs) => {
        if (host === "local") {
          const r = await spawnWithTimeout(["bash", "-s"], timeoutMs, script);
          return { code: r.code, stdout: r.stdout, stderr: r.timedOut ? "timeout" : r.stderr };
        }
        const ssh = remoteSsh();
        if (!ssh) throw new Error("remoteSsh is not in secrets.json");
        const r = await spawnWithTimeout(sshArgv(ssh), timeoutMs, script);
        return { code: r.code, stdout: r.stdout, stderr: r.timedOut ? "timeout" : r.stderr };
      },
    })
  : undefined;
let hardware = buildHardware();
if (vaultPath && !vault) console.error(`DEVD_VAULT=${vaultPath} does not exist — devd runs without a vault`);

// Operation broker. Credentials are read from `secrets` only on call, i.e. after the vault is unlocked.
const operationDeps = { coolify: () => secrets.coolify, coolifyInstances: () => coolifyInstancesFromMcp((secrets.mcpServers ?? {}) as Record<string, unknown>) };
const execOperation = createOperationExec(operationDeps);

// Proxy for prod-db. Requires DEVD_DB_PROXY_PORT; without a working proxy the API returns
// a configuration error and never sends the real password into the session.
//
// ⚠️ OPEN: pgConnect targets 127.0.0.1:<hostPort>, which assumes an OPEN forward-only
// SSH tunnel (prodTunnel.withTunnel). Today it is only opened for the duration of one operation
// (prodWrites), so a long-running proxy needs the tunnel held open — see the phase 4 plan.
const dbProxyPort = Number(process.env.DEVD_DB_PROXY_PORT ?? 0);
// The proxy listens ONLY on the docker bridge — it serves containers, not the world. On 0.0.0.0
// ufw would hide it from the outside, but relying on the firewall where the right binding is
// enough is a needless risk (see daemon.json in the phase 5 plan).
const DB_PROXY_BIND = process.env.DEVD_DB_PROXY_BIND ?? "172.17.0.1";
let dbProxyReady = false;
const mysqlProxyPort = Number(process.env.DEVD_MYSQL_PROXY_PORT ?? (dbProxyPort ? dbProxyPort + 1 : 0));
let mysqlProxyReady = false;
const dbTargets = dbProxyPort && prodCatalog ? createDbTargets({ entries: () => prodCatalog.databases }) : undefined;

// Git proxy: the container sends a placeholder, the real token is filled in only by this process from the vault.
// Passed into createApp, not mounted from outside — it must come before the dashboard catch-all.
const gitProxy = createGitProxy({
  vault: {
    isLocked: () => (vault ? vault.isLocked() : false),
    secrets: () => secrets,
  } as Parameters<typeof createGitProxy>[0]["vault"],
  instances: getGiteaInstances,
  placeholders: placeholders.all,
  audit: (e) => logEvent(db, e.session, "git_proxy", { instance: e.instance, path: e.path }),
});

// Is the share listener (:4302) running? Until it starts (and if bind fails) no links are created.
let shareListenerUp = false;
// Network restrictions for shared/tainted containers (shareFirewall.ts, final review I5):
// DEVD_BIND_IP ports, tailnet, cliproxy and db proxy. Linux only (iptables); can be turned off
// with DEVD_SHARE_FIREWALL=0 — then creating shares is not blocked, only this layer is missing.
const restrictedView = new SharedSessions(db, Date.now, containerIdentity);
const shareFirewall = process.platform === "linux" && process.env.DEVD_SHARE_FIREWALL !== "0"
  ? createShareFirewall({
    ips: async () => {
      await containerIdentity.refreshIfStale();
      restrictedView.invalidate();
      return [...restrictedView.current()].flatMap((s) => containerIdentity.ipsFor(s));
    },
    cfg: { bindIp: process.env.DEVD_BIND_IP, blockedPorts: [8317, dbProxyPort, mysqlProxyPort].filter((p) => p > 0) },
  })
  : null;
// Host git (proc.run → safeGit.ts, rereview N3) does not touch repos of restricted sessions at all:
// neither the worktree nor the bare clone (which the session's worktree shares with siblings and is mounted rw).
const sessionGitRoots = (s: SessionRow): string[] =>
  [sessionWorkdir(root, s), ...(s.worktree ? [barePath(root, s.folder, s.project, s.repo)] : [])];
const restrictedGitRoots = (): string[] => [...restrictedView.current()].flatMap((id) => {
  const s = getSession(db, id);
  return !s || s.host === "instabox" ? [] : sessionGitRoots(s);
});
setUntrustedGitRoots(restrictedGitRoots);
const syncShareFirewallSoon = () => {
  if (shareFirewall) void shareFirewall.sync().catch((e) => console.error(`share firewall: ${(e as Error).message}`));
};
const apiDeps: ApiDeps = {
  instabox: ibxSessions && ibxSettings && baseBuilder && ibxClient && ibxStatus ? {
    sessions: ibxSessions, settings: ibxSettings, hostLoad: readHostLoad,
    status: () => ibxStatus.get(),
    rebuildBase: () => { const j = baseBuilder.start(); return j ? { jobId: j.id } : null; },
    baseJob: (id) => baseBuilder.job(id),
    // Only machines that reconcile reports as orphaned (devbox=1 without a session) — never
    // a bare kill(id): a base build or other machines of the account cannot be deleted this way.
    killOrphan: (machineId) => killOrphan(db, ibxClient, machineId, { buildRunning: () => baseBuilder.isRunning() }),
  } : undefined,
  gitProxy,
  dbTargets,
  dbProxyHost: dbProxyPort ? `${DB_PROXY_BIND}:${dbProxyPort}` : undefined,
  execOperation,
  dbProxyReady: () => dbProxyReady,
  mysqlProxyHost: mysqlProxyPort ? `${DB_PROXY_BIND}:${mysqlProxyPort}` : undefined,
  mysqlProxyReady: () => mysqlProxyReady,
  prepareDeployment: (params) => prepareCoolifyDeployment(operationDeps, params),
  dbOnboardingHost: prodCatalog && opAvailable ? createDbOnboardingHost({
    token: needOpToken, catalog: () => prodCatalog, proxyReady: (engine) => engine === "mariadb" ? mysqlProxyReady : dbProxyReady,
    // Upgrade of a legacy entry: its live tunnel was built for the previous server
    // identity; ensure() replaces it once the catalog switches to the new one.
    ownsTunnel: (plan) => prodTunnels.owns(plan.server, plan.entry.hostPort)
      || (!!plan.previousEntry && plan.previousEntry.hostPort === plan.entry.hostPort && prodTunnels.owns(effectiveServer(plan.previousEntry, plan.trustedServer), plan.entry.hostPort)),
    // Direct DB servers (no SSH) bind accounts to the host's public IPv4, not to '%'.
    egressHost: process.env.DEVD_EGRESS_IP,
    adminKeyForServer: (name, server) => resolveDbAdminTarget(db, name, server),
  }) : undefined,
  // The key is read and written AT RUNTIME (not a value captured at startup): the dashboard can
  // swap it and the next session must then get it without a devd restart.
  openrouter: {
    hasKey: () => readKeyFile(openrouterKeyPath) !== null,
    setKey: (key) => writeKeyFile(openrouterKeyPath, key),
  },
  // The same cache as for session creation — so the dashboard shows the same window that
  // the next container gets.
  orCtxLookup: (m) => contextLengthCached(m, DEFAULT_OPENROUTER_URL),
  // The same key sources as the session manager — /api/local-env (dev local on the Mac)
  // hands out the same credentials a container would get.
  upstreamKeys: upstreamKey({ cliproxyKey: () => readKeyFile(cliproxyKeyPath), openrouterKey: () => readKeyFile(openrouterKeyPath) }),
  mgr, db, cfg, root, tree, listener, notify, stats: liveStats, resources, cloneQueue, configRepo, dashboardDir, opToken: secrets.opServiceAccountToken, vault,
  onConfigWritten: () => treeCache.invalidate(),
  unpushed,
  hardware,
  backup: { build: () => buildBackupTar(backupDeps), restore: (t) => restoreBackup(backupDeps, t) },
  agentEvents, liveActivities, gitea, spawnPty: realSpawnPty, scheduler, critic, codexAuth,
  codexUsage: { view: () => buildCodexView(db) },
  codexAccounts,
  codexSessionAccounts: new CodexSessionAccounts({
    db, accounts: codexAccounts, exec: dockerExec, sleep: realSleep,
    now: () => Date.now(), inFlight: accountSwitchInFlight,
    repairAccountMounts: (id) => mgr.repairAccountMounts(id),
  }),
  grokUsage: { view: () => buildGrokView(db) },
  prodCatalog, prodDbAccess, readProdSecret, execProdWrite,
  previewHost: process.env.DEVD_BIND_IP,
  tmuxProbe: createTmuxProbe(),
  tmuxExec: async (container, cmd) => {
    const p = Bun.spawn([...dockerArgv(container), "exec", container, "bash", "-lc", cmd], { stdout: "pipe", stderr: "ignore" });
    const code = await p.exited;
    return { code, stdout: await new Response(p.stdout).text() };
  },
  agentUpkeep,
  ccUpkeep: { status: () => ccStatusCache.get(), run: ccUpkeepRun },
  accounts: {
    profiles: accountProfiles, leaseMaxAgeMs,
    // Same convention as leaseMaxAgeMs above — fresh config on EVERY request,
    // not the startup snapshot `cfg.settings` (review round 4, I5): otherwise a change to
    // thresholdPct from the dashboard would only apply to /api/accounts/lease after a devd restart.
    settings: () => resolveAccountPool(freshCfg().settings),
    switchAccount: (id) => switchAccount(accountSwitchDeps(), id),
    refresh: refreshAccount,
  },
  switchAgent: (id, agent) => switchAgent(agentSwitchDeps(), id, agent),
  sshAgents,
  sshApprovalEnabled: env("DEVD_SSH_APPROVAL", "on") !== "off",
  sshKeyLister,
  // Fresh on every request, like the other getters over freshCfg().
  sshServers: () => freshCfg().sshServers ?? [],
  // Path to the catalog, so a new database can be written into it after a request is approved,
  // and to the claims overlay, where it records WHICH project may use it.
  prodCatalogPath, prodAccessPath,
  // Coolify credentials are taken from the MCP server definitions in the vault — no extra secret
  // that would need separate rotation. Read only on call, i.e. after unlock.
  coolifyInstances: () => coolifyInstancesFromMcp((secrets.mcpServers ?? {}) as Record<string, unknown>),
  // List of SSH keys from 1P — titles only, to check whether the server is ready.
  sshKeyTitles: sshKeyLister ? async () => (await sshKeyLister()).map((k) => k.title) : undefined,
  // getConnInfo needs the real Bun server in `c.env` (Bun.serve below puts it there as the
  // 2nd argument of fetch) — hence injected, not called directly in api.ts (see approvalGate
  // and ApiDeps.remoteAddr there). `.address` is `string | undefined`, exactly the type it wants.
  //
  // try/catch is NOT cosmetic: `getBunServer` (hono/bun) does `"server" in c.env`, which
  // throws TypeError when `c.env` is not an object (no Bun server behind the request), and
  // `getConnInfo` itself throws when `server.requestIP` is missing. Uncaught, this would
  // surface in Hono as an unhandled 500 — `approvalGate` would never reach its
  // `console.warn`, and that is the ONLY documented way for the operator to learn which
  // address to add to `DEVD_APPROVAL_ALLOW` (see docs/mac.md). `undefined`
  // here ends up exactly like an unknown address elsewhere — fail-closed 403 with a log line.
  // The same flag that decides about mounting the host docker.sock (extraMounts above).
  dind: dindEnabled,
  shareAvailable: () => shareListenerUp,
  shareLockdown: {
    containerId: (container) => dockerContainerId(container),
    stopDind: (session) => stopDindSidecar(session),
    ...(shareFirewall ? { syncFirewall: () => shareFirewall.sync(true) } : {}),
  },
  remoteAddr: (c) => {
    try { return getConnInfo(c).remote.address; }
    catch { return undefined; }
  },
  sshApprovalAllowExtra: approvalAllowExtra,
};
if (dbTargets && readProdSecret && prodCatalog && mysqlProxyPort) {
  startMysqlProxy({ port: mysqlProxyPort, hostname: DB_PROXY_BIND, targets: dbTargets,
    vault: vault ?? { isLocked: () => false }, readSecret: readProdSecret,
    ensureTunnel: async target => {
      const server = prodCatalog.servers[target.entry.server];
      if (!server) throw Error("unknown database server");
      await prodTunnels.ensure(effectiveServer(target.entry, server), target.entry.hostPort);
    },
    audit: e => logEvent(db, e.session, "db_proxy", { db: e.db, engine: "mariadb" }),
  }).then(() => { mysqlProxyReady = true; console.log(`MariaDB proxy listening on ${DB_PROXY_BIND}:${mysqlProxyPort}`); })
    .catch(() => console.error("MariaDB proxy could not start"));
}
if (dbTargets && readProdSecret && prodCatalog) {
  // Tunnels are kept alive for the whole lifetime of devd — the proxy holds client connections, so
  // `withTunnel` (a tunnel for the duration of one operation) would not suffice here.
  const tunnels = prodTunnels;
  const pg = createPgConnect();
  startDbProxy({
    port: dbProxyPort, hostname: DB_PROXY_BIND, targets: dbTargets, vault: vault ?? { isLocked: () => false } as never,
    readSecret: readProdSecret,
    connect: async (target, password, onData, onEnd) => {
      const server = prodCatalog.servers[target.entry.server];
      if (!server) throw new Error(`unknown server ${target.entry.server}`);
      await tunnels.ensure(effectiveServer(target.entry, server), target.entry.hostPort);
      return pg(target, password, onData, onEnd);
    },
    audit: (e) => logEvent(db, e.session, "db_proxy", { db: e.db }),
  }).then((p) => { dbProxyReady = true; console.log(`db proxy on port ${p.port}`); })
    .catch((e) => console.error("db proxy failed to start:", (e as Error).message));
}

const app = createApp(apiDeps);
// Restriction of a shared session's container (containerIdentity.ts): container IP → session
// from `docker inspect`, refreshed after every container start / network attach.
containerIdentity.configure({
  snapshot: () => dockerContainerSnapshot(db),
  // The taint of a rebuilt container (new docker id) is cleaned up here permanently.
  onSnapshot: (snap) => { pruneTaints(db, snap.containerIds); setTimeout(syncShareFirewallSoon, 0); },
});
// IPs of restricted containers change with start/rebuild; the chain is kept current even without an event.
if (shareFirewall) { setInterval(syncShareFirewallSoon, 30_000).unref?.(); syncShareFirewallSoon(); }
const stopDockerEvents = watchDockerEvents(firewallOnDockerEvent(() => containerIdentity.markChanged(), shareFirewall ? syncShareFirewallSoon : null));

// Git proxy: the container sends a placeholder, the real token is filled in only by this process from the vault.
// The inner leg runs plain HTTP over the docker bridge, so there is no custom CA here.

// idleTimeout: the default 10 s used to be masked by blocking spawnSync (the event loop stalled,
// so Bun's idle timer never ticked) — since PR #75–#78 long
// operations (clone, backup export/import, upkeep run) are asynchronous and a request over 10 s
// would lose its connection midway (see noIdleTimeout in api.ts). 255 s is the ceiling
// Bun allows for `idleTimeout`; long routes additionally disable the timer themselves
// per request via `server.timeout(req, 0)`.
const httpServer = Bun.serve({ hostname: env("DEVD_HOST", "127.0.0.1"), port: Number(env("DEVD_PORT", "4300")), fetch: app.fetch, websocket, idleTimeout: 255 });
// C1: the InstaBox VM talks to devd only through this port (hooks, OTel, git proxy, health, lease —
// see vmListener.ts); the VM cannot see the main port with the dashboard and approvals. Same host as
// the main listener, port `ibxSettings.vmPort` (DEVD_VM_PORT / config, default 4301).
const vmServer = ibxSettings
  ? Bun.serve({ hostname: env("DEVD_HOST", "127.0.0.1"), port: ibxSettings.vmPort, fetch: vmFetch(app.fetch), idleTimeout: 255 })
  : null;
// Shared terminal: the guest's public entry via a Cloudflare tunnel (DEVD_SHARE_HOST and p0…p9.<DEVD_PREVIEW_DOMAIN>
// → localhost:4302). ALWAYS loopback only (not DEVD_HOST) and a separate app — it shares nothing
// with `app` from api.ts, no gate trusting loopback (cloudflared comes from localhost). See shareListener.ts.
const shareHost = shareHostFromEnv();
// Only the guest page bundle (dashboard `vite build --mode share` → dist/share), not the whole
// dist — otherwise the share host would publicly serve admin dashboard chunks too.
const shareStaticDir = env("DEVD_SHARE_STATIC_DIR", `${dashboardDir}/share`);
const shareApp = createShareApp({
  db, spawnPty: realSpawnPty, staticDir: shareStaticDir, onRevoked: onShareRevoked, shareHost,
  // Preview links only for ports where something actually listens — the same target the preview
  // then proxies to (DEVD_BIND_IP:port_base+N). At most p0…p9.
  listeningPorts: async (s) => {
    const bindIp = process.env.DEVD_BIND_IP;
    if (!bindIp) return [];
    const n = Math.min(cfg.settings.portsPerSession, 10);
    const open = await Promise.all(Array.from({ length: n }, (_, i) => tcpListening(bindIp, s.port_base + i)));
    return open.flatMap((ok, i) => (ok ? [3000 + i] : []));
  },
  exitCopyMode: async (container, name) => { await execInContainer(container, ["tmux", "send-keys", "-t", `=${name}`, "-X", "cancel"]); },
});
// Public preview of a shared session: p<N>.<DEVD_PREVIEW_DOMAIN> → DEVD_BIND_IP:port_base+N (sharePreview.ts).
const sharePreview = createPreview({
  db, bindIp: process.env.DEVD_BIND_IP, portsPerSession: cfg.settings.portsPerSession,
  domain: env("DEVD_PREVIEW_DOMAIN", DEFAULT_PREVIEW_DOMAIN), onRevoked: onShareRevoked,
});
// A taken port 4302 must not bring down all of devd (final review I7) — sharing is just disabled.
const shareServer = startShareServer(() => Bun.serve({ hostname: "127.0.0.1", port: Number(env("DEVD_SHARE_PORT", "4302")), fetch: createShareFetch({ shareApp, shareHost, preview: sharePreview }), websocket, idleTimeout: 255 }));
shareListenerUp = shareServer !== null;
// Docker may still be starting when systemd brings devd up. Restore only rows
// that were running, with bounded retries, without replacing live tmux sessions.
const startupRecovery = startRecovery({
  ids: listSessions(db).filter(s => s.status === "running").map(s => s.id),
  recover: id => mgr.recoverAfterRestart(id),
  failed: (id, error) => console.error(`restart recovery ${id}:`, (error as Error).message),
});
void mgr.recordBranches().catch(e => console.error("writing session branches failed:", e));
startupRecovery.done.then(failed => {
  if (failed.length) logEvent(db, null, "restart-recovery-pending", { sessions: failed });
});
let checkpointingShutdown = false;
const checkpointBeforeShutdown = () => {
  if (checkpointingShutdown) return;
  checkpointingShutdown = true;
  startupRecovery.cancel();
  stopDockerEvents();
  httpServer.stop();
  vmServer?.stop();
  shareServer?.stop();
  // devd is ordered After=docker.service, so on graceful host shutdown these
  // checkpoints run before Docker stops the containers and their DinD daemons.
  const deadline = setTimeout(() => process.exit(0), 15_000);
  deadline.unref();
  void mgr.checkpointRunning().finally(() => process.exit(0));
};
process.once("SIGTERM", checkpointBeforeShutdown);
process.once("SIGINT", checkpointBeforeShutdown);
if (env("DEVD_SSH_APPROVAL", "on") === "off") {
  console.warn("⚠ DEVD_SSH_APPROVAL=off — the SSH key approval gate is DISABLED");
}
// Expired grants: kill the agent (only if it still serves EXACTLY this key —
// see reapExpiredGrants/sshAgent.ts), the socket disappears. This does not end running SSH
// sessions — the key is only used when establishing a connection. The logic itself lives
// in sshApprovals.ts (tested against fake sshAgents); here only the tick + error log.
// `guardedTick` (same pattern as the other intervals below): a tick that is still running
// (slow kill/ssh-agent) does not start a second time — it is skipped.
setInterval(guardedTick("ssh grant cleanup", () =>
  reapExpiredGrants(db, sshAgents, Date.now(), (id, e) => console.error(`cleanup of expired ssh grant ${id} failed:`, e))),
30_000);
setInterval(() => {
  let done: string[] = [];
  try { done = agentEvents.sweep(); liveActivities.request(); } catch (e) { console.error("agent-event sweep failed:", e); }
  // Cleanup after scheduled runs: the "finished work" notification just went out, the session
  // flagged auto_end has served its purpose. Await is not possible here (interval), hence its own
  // catch — an uncaught rejected promise would bring down all of devd.
  if (done.length) {
    endFinishedRuns({ db, end: (id, soloAction, opts) => mgr.end(id, soloAction, opts) }, done)
      .catch((e) => console.error("auto-end failed:", e));
  }
}, 5_000);
// Hardware: the tick itself decides what is currently due (see INTERVALS in hardware.ts),
// so this interval is only a fine sieve, not the refresh cadence.
// `hardware` may only come into existence after the vault is unlocked, so it is read on every tick,
// not once at startup.
const hardwareTick = guardedTick("hardware tick", async () => { await hardware?.tick(); });
hardwareTick();
setInterval(hardwareTick, 30_000);
// Scheduled runs: tick roughly every minute (the guard on last_run_at prevents a double fire).
setInterval(guardedTick("scheduler tick", () => scheduler.tick(new Date())), 30_000);
setInterval(() => {
  sweepIdleSessions(mgr, db, cfg.settings, defaultProbe)
    // Auto-stop used to be silent: the session vanished from the list and there was no way to tell who
    // stopped it. A notification makes it always visible.
    .then((stopped) => {
      for (const id of stopped) {
        const s = listSessions(db).find((x) => x.id === id);
        notify(s ? `${s.project}/${s.repo}` : id, `Session suspended after ${cfg.settings.autoStopHours} h of inactivity`);
      }
    })
    .catch((e) => console.error("watchdog sweep failed:", e));
}, 5 * 60_000);
// Auto-"continue" after API 429 (apiErrorRetry.ts): content scan of tmux panels of running
// sessions; after 5 minutes of a consistently stuck error it sends "continue" into the panel and
// repeats until the provider lets through. Async exec with a timeout — sync would block
// the whole (single-threaded) devd, see the earlier perf incident with the dashboard.
const apiErrorRetry = new ApiErrorRetry();
setInterval(() => {
  sweep429({
    containers: () => listSessions(db).filter((x) => x.status === "running").map((x) => x.container),
    exec: (c, cmd) => execInContainerAsync(c, cmd, 10_000),
    retry: apiErrorRetry,
  }, Date.now())
    .then((sent) => {
      for (const m of sent) console.log(`429 auto-continue → ${m.container} ${m.session} ${m.pane}`);
    })
    .catch((e) => console.error("429 sweep failed:", e));
}, 60_000);
setInterval(() => {
  const u = resolveCcUpkeep(cfg.settings);
  const now = new Date();
  if (!u.enabled || !inWindow(now, u.windowStartHour, u.windowEndHour)) return;
  if (!dueForCheck(ccUpkeepLastRun, now.getTime())) return;
  ccUpkeepLastRun = now.getTime();
  // Codex and Grok otherwise update only when `co`/`gr` starts — a session that
  // runs for days would stay on the old version forever. Sequentially (shares the lock with cc); swapping
  // the symlink does not affect the running process, the new version kicks in on the next start.
  (async () => {
    await ccUpkeepRun().catch((e) => console.error("cc upkeep failed:", e));
    // agy is updated by the image build, not here.
    for (const provider of ["codex", "grok"] as const) {
      const r = await agentUpkeep.run(provider).catch((e) => { console.error(`${provider} upkeep failed:`, e); return null; });
      if (r) console.log(`${provider} upkeep: updated=${r.updated.length} failed=${r.failed.length} deferred=${r.deferred.length}${r.error ? ` error=${r.error}` : ""}`);
    }
  })();
}, 10 * 60_000);
// Account quotas: tick every 30 s, but only what is due is actually measured (pollDue —
// active account ~60 s, idle ~5 min, exhausted until reset). Without accounts it is a no-op.
// Alerts are computed RIGHT after the poll finishes, not in a separate tick — otherwise they would
// look at half-written (currently being overwritten) account_usage rows. Sent messages are
// remembered by key so the same warning is not sent every half minute; the key
// disappears once the condition passes (session ended / quota reset), so the
// same situation is reported again if it happens a second time.
const accountAlertsSent = new Set<string>();
setInterval(() => {
  if (accountPollRunning) return;
  accountPollRunning = true;
  pollAllDue(accountPollerDeps())
    .then(() => {
      // Running sessions only: stop() does not release the lease (only end() does), so a
      // stopped session would otherwise get a message with `dev switch`, which would
      // just answer "isn't running." for it anyway (review round 1, I7).
      const running = new Set(listSessions(db).filter((x) => x.status === "running").map((x) => x.id));
      const poolCfg = resolveAccountPool(freshCfg().settings);
      const views = buildAccountViews(db, Date.now(), leaseMaxAgeMs());
      const alerts = [...switchAlerts(views, poolCfg, running), ...pinAlerts(views, poolCfg)];
      const live = new Set(alerts.map((a) => a.key));
      for (const key of accountAlertsSent) if (!live.has(key)) accountAlertsSent.delete(key);
      for (const a of alerts) {
        if (accountAlertsSent.has(a.key)) continue;
        accountAlertsSent.add(a.key);
        notify(a.title, a.message, alertNotifyExtra(a));
        logEvent(db, a.sessionId, "account_exhausted", { account: a.accountId });
      }
    })
    .catch((e) => console.error("account poll failed:", e))
    .finally(() => { accountPollRunning = false; });
}, 30_000);

// The Codex quota is measured more slowly than Anthropic accounts and without its own setting:
// `idlePollSec` is the only cadence that makes sense here. Codex has no "active" and
// "idle" account, so a second setting of the same thing would just drift earlier or later from
// the first. Re-entrance guard for the same reason as for accounts — docker run can take
// longer than a tick.
//
// `idlePollSec` is read ONCE here at startup, not live like the rest of the pool settings —
// a config change takes effect only after a devd restart. `Math.max(60, …)` is a safeguard
// against a manually entered `0`/`null` in the raw JSON config (Settings has an editor without
// numeric validation): for the account poller such a value is harmless, here it would
// produce an interval with no pause, i.e. `docker run` forever.
//
// The first poll runs IMMEDIATELY, not after the first tick — otherwise there is no row in
// `codex_usage`/`grok_usage` and the card is completely gone for the first `idlePollSec` (5 minutes by
// default) after every devd restart, while the Anthropic cards next to it refresh within 30 s (I4).
// One factory for all singleton usage pollers: single-flight guard, catch/log
// and cadence are policy, not a property of a particular source. `label` is now the full text
// for the error message (not just the agent name) — quotas and harvesters both touch Codex/
// Grok, so "poll Grok quota failed" and "poll Grok usage failed" must be distinguishable.
const usagePollMs = Math.max(60, resolveAccountPool(freshCfg().settings).idlePollSec) * 1000;
const startUsagePoll = (label: string, poll: () => Promise<void>, everyMs = usagePollMs) => {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    poll()
      .catch((e) => console.error(`poll ${label} failed:`, e))
      .finally(() => { running = false; });
  };
  tick();
  setInterval(tick, everyMs);
};
startUsagePoll("Codex quota", () => codexAccounts.poll());
startUsagePoll("Grok quota", () => pollGrok(usagePollerDeps()));
startUsagePoll("Antigravity quota", () => pollAgy(usagePollerDeps()));
// Harvesters run more often than quotas: 60 s keeps Stats close to reality and one
// docker run per minute is cheap.
startUsagePoll("Grok usage", () => harvestGrok(usagePollerDeps()), 60_000);
startUsagePoll("Antigravity usage", () => harvestAgy(usagePollerDeps()), 60_000);
startUsagePoll("Codex usage", () => harvestCodexAccounts(usagePollerDeps()), 60_000);

setInterval(guardedTick("stats collect", async () => {
  // Repos one after another, not Promise.all, so the machine load stays as it is today.
  const untrustedGit = new Set(restrictedGitRoots());
  for (const s of listSessions(db)) {
    if (s.host === "instabox") {
      // A paused machine is not woken up for statistics; without an alias (create still running)
      // docker would go local and write zeros.
      if (s.status !== "running" || !remoteDockerAlias(s.container)) continue;
      // collectGitStats calls run(dir, "git", …) → we run it in the container in the VM.
      const remote: Runner = (cwd, ...cmd) => runDocker(s.container, ["exec", "-w", cwd, s.container, ...cmd], { timeoutMs: timeoutFor("DOCKER_QUERY") });
      await collectSessionGitStat(db, s, "/workspace", (dir) => collectGitStats(dir, remote));
      continue;
    }
    // Shared/tainted session (and a sibling sharing its bare clone): no host git
    // over its repo (rereview N3) — safeGit would reject it anyway; this way, additionally,
    // zeros are not written over the last known stats.
    if (sessionGitRoots(s).some((r) => untrustedGit.has(r))) continue;
    const ws = sessionWorkdir(root, s);
    await collectSessionGitStat(db, s, ws);
  }
  // One TOTAL-usage snapshot per cycle (whole /srv/dev), not one row per workspace —
  // disk_stats is an append-only time series now (see db.ts), so a snapshot per
  // workspace per cycle would both misrepresent "total used" and grow unbounded.
  insertDiskTotal(db, await collectDiskUsage(root));
  pruneDiskStats(db);
  pruneEvents(db);
  pruneCriticReviews(db);
  pruneAccountLeases(db);
  pruneNotifyLog(db);   // 14 days — the notification debug log grows with every hook event
  prunePushAlerts(db);  // 7 days — emergency alerts (see db.ts)
  const used = diskHistoryEnds(db).at(-1)?.bytes ?? 0;
  const now = Date.now();
  if (shouldWarnDisk(used, diskTotal, cfg.settings.diskWarnPercent, lastDiskWarnTs, now)) {
    const pred = predictDisk(diskHistoryEnds(db), diskTotal);
    notify("devbox", diskWarnMessage(used, diskTotal, pred.daysLeft));
    lastDiskWarnTs = now;
  }
}), 2 * 60_000);
if (ibxClient && ibxSsh && ibxSessions && ibxStatus) {
  // The certificate is valid for 24 h, renewal below 2 h — a 10-min cadence has headroom even after an outage.
  const sshRefresh = guardedTick("instabox ssh refresh", () => ibxSsh.refreshAll(runningIbx().map((s) => s.instabox_machine_id!)));
  sshRefresh();
  setInterval(sshRefresh, 10 * 60_000);
  setInterval(guardedTick("instabox creds sync", () => ibxSessions.syncAllCreds()), 2 * 60_000);
  const statusTick = guardedTick("instabox status", async () => { await ibxStatus.refresh(); });
  statusTick();
  setInterval(statusTick, 10 * 60_000);
  setInterval(guardedTick("instabox metrics", refreshIbxMetrics), 30_000);
}
// "Claude finished work" is sent EXCLUSIVELY by AgentEventHub (Stop hook → 20s silence →
// sweep). That is reliable and cannot fire in the middle of work. The former
// telemetry-based "done" inference (working→waiting from metrics) was removed:
// a long tool call generates no metrics = false "done" even though the session keeps running
// (see DEVBOX-3). Here we only periodically clean up the state of ended sessions, so
// sweep() does not send a late "done" after an ended session and the in-memory map does not grow.
// Plus "stuck" detection for important sessions: the agent got a prompt (a turn is running),
// but has been silent for 20 min — no hook AND no metric (token generation) — → most likely stuck,
// send an emergency. Conservative threshold deliberately high: a long legit tool call
// (build/tests) with 20 min of silence is rare, and we only watch sessions marked important
// (see DEVBOX-3 — telemetry is NOT USED for "done", only for this opt-in stuck check).
// Silence is measured by the hub (`silentMs`), same as the "May be stuck" state in the Live Activity — that one
// kicks in already after STALLED_MS; here it stays at a conservative STUCK_MS.
const stuckAlerted = new Set<string>();
setInterval(() => {
  try {
    const now = Date.now();
    const running = new Set<string>();
    for (const s of listSessions(db)) {
      if (s.status !== "running") { stuckAlerted.delete(s.id); continue; }
      running.add(s.id);
      // SSH request expiry is not written anywhere (computed on read) — the tick cleans it up.
      // Live Activity request() is not needed here: the 5s tick liveActivities.tick() recomputes the state
      // and sends the waiting change with priority 10 (fingerprint + needsHighPriority).
      agentEvents.setSshWaiting(s.id, pendingSshLabel(db, s.id, now));
      if (s.important !== 1) { stuckAlerted.delete(s.id); continue; }
      const silent = agentEvents.silentMs(s.id); // null = no hook since restart
      const stuck = agentEvents.turnInProgress(s.id) && silent !== null && silent > STUCK_MS;
      if (stuck && !stuckAlerted.has(s.id)) {
        stuckAlerted.add(s.id);
        // Title via `sessionTitle` (same as done/blocked): with several sessions on one
        // repo "portal/web" is the same thing twice, and with an EMERGENCY notification that rings
        // for a whole hour you cannot tell which one to go unblock. The session nickname
        // is carried by `s.name` — `listSessions` returns the whole row, so it is at hand.
        const sess = { id: s.id, project: s.project, repo: s.repo, name: s.name, agent: s.agent };
        const t = stuckText(sess);
        notify(t.title, t.message, { session: sess, important: true, sound: true });
        logEvent(db, s.id, "agent_stuck", { at: now });
      } else if (!stuck) {
        stuckAlerted.delete(s.id); // condition passed → reset for the next episode
      }
    }
    agentEvents.retainRunning(running);
  } catch (e) { console.error("agent-event cleanup failed:", e); }
}, 15_000);

console.log(`devd listening on ${env("DEVD_HOST", "127.0.0.1")}:${env("DEVD_PORT", "4300")}`);
