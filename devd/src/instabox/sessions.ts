import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DevConfig, InstaboxSettings } from "../config";
import { deleteSession, getInstaboxBase, getRepoAgent, getSession, insertSession, listEvents, listSessions, logEvent, setRepoAgent, setSessionInstabox, setSessionInstaboxTsIp, updateSession, type AgentName, type SessionRow } from "../db";
import { removeContainer, runContainer, type RunOpts } from "../docker";
import { dockerArgv, remoteDockerAlias, setRemoteDocker } from "../dockerTarget";
import { addInstaboxIp, isAddressInCidr } from "../network";
import { allocatePortBase } from "../ports";
import { run } from "../proc";
import { nextSessionId, openLockKey, resolveAgent, SessionBusyError, sessionWorktreePath, type InstaboxLifecycle, type SessionManager } from "../sessions";
import type { InstaboxClient } from "./client";
import { credentialFiles, SHARED_CRED_VOLUMES, syncCreds, volumeCredIo, type CredFile, type CredSyncResult } from "./credsSync";
import { IBX_PATHS } from "./runOpts";
import type { InstaboxSsh } from "./ssh";
import { copyVolume, shq, volumesToCopy, type PoolAccountIds } from "./transfer";

export class IbxPreconditionError extends Error {
  constructor(message: string, public readonly status: 400 | 409 | 503) { super(message); this.name = "IbxPreconditionError"; }
}
export type IbxStep = "preflight" | "machine" | "ssh" | "tailscale" | "dirs" | "volumes" | "secrets" | "clone" | "container" | "desktop" | "done";
export interface IbxJob { id: string; sessionId: string; status: "running" | "done" | "error"; step: IbxStep; error?: string; startedAt: number }
export interface IbxOps {
  runContainer(o: RunOpts): Promise<void>;
  removeContainer(name: string): Promise<void>;
  copyVolume(volume: string, image: string, remote: string[]): Promise<void>;
  syncCreds(remote: string[], files: CredFile[], mode: "both" | "push"): Promise<CredSyncResult[]>;
  remoteDocker(remote: string[], args: string[], timeoutMs: number, stdin?: string): Promise<{ code: number; stderr: string }>;
}
export interface InstaboxSessionsDeps {
  db: Database; cfg: DevConfig; root: string; controlRoot: string;
  client: InstaboxClient; ssh: Pick<InstaboxSsh, "ensure" | "forget">; settings: InstaboxSettings;
  tailscaleAuthKey: () => string | null; image: string;
  mgr: Pick<SessionManager, "remoteRunOpts" | "withLock">;
  // The real gitea tokens (credentials/giteaAuthEnv) are DELIBERATELY not here: they must not reach the VM.
  // A Gitea clone goes through the devd git proxy with the session placeholder (see clone()).
  ghConfigDir?: string;
  /** Invalidates the session placeholders (PlaceholderStore.revoke) — rollback of a failed create. */
  revokePlaceholder?: (session: string) => void;
  accountIds: () => PoolAccountIds; notify?: (title: string, message: string) => void;
  ops?: Partial<IbxOps>; now?: () => number;
}

const DESKTOP_TTL_S = 600;
/** devd base URL for InstaBox containers: host from `devdUrl`, VM listener port (C1) —
 *  the VM cannot see the main port 4300 (dashboard, approvals) at all. */
export function vmDevdUrl(s: Pick<InstaboxSettings, "devdUrl" | "vmPort">): string {
  try {
    const u = new URL(s.devdUrl);
    u.port = String(s.vmPort);
    return u.origin;
  } catch { return s.devdUrl.replace(/\/+$/, ""); }
}
const CLONE_TIMEOUT_MS = 60 * 60_000;
// Mount targets the clone needs just like the session container (gh for github.com,
// placeholder for gitea via the git proxy) — sources are taken from the remote RunOpts, not reassembled.
const CLONE_MOUNT_DESTS = new Set(["/home/dev/.config/gh", "/run/devbox-git/gitea-tokens.json"]);
const CRED_HELPER = "/usr/local/bin/git-credential-devbox";
const machineName = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
const machineOf = (s: SessionRow): string => {
  if (!s.instabox_machine_id) throw new Error(`${s.id}: InstaBox machine is missing`);
  return s.instabox_machine_id;
};

/** devd startup: tailnet IPs of all known InstaBox sessions back into the approval-gate
 *  ban list (network.ts). Addresses of sessions ended before the restart are not kept — the row is gone. */
export function loadInstaboxIps(db: Database): void {
  for (const s of listSessions(db)) if (s.host === "instabox" && s.instabox_ts_ip) addInstaboxIp(s.instabox_ts_ip);
}

/** The Tailscale auth key must not end up in a job error or in the log (I6). The whole
 *  occurrence is replaced BEFORE the text is truncated — otherwise a cut-off key tail would get through. */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

// Joining the VM to the tailnet + verifying the path to devd. After resume Tailscale keeps running (memory
// is restored), only the tunnel takes a few seconds to re-establish — hence `tailscale up` only when
// it is not running (status != 0, e.g. the ephemeral node vanished meanwhile) and health is retried for up to ~90 s.
// Verified live: a single `curl -m 5` right after resume failed, a few seconds later 200.
export function tailscaleJoinCmd(hostname: string, healthUrl: string): string {
  return `sudo -n tailscale status >/dev/null 2>&1 || sudo -n tailscale up --auth-key="$TS_KEY" --hostname=${shq(hostname)} || exit 2; ` +
    `for i in $(seq 1 30); do curl -sf -m 5 ${shq(healthUrl)} >/dev/null && exit 0; sleep 3; done; ` +
    `echo "devd health unreachable: $(tailscale status 2>&1 | head -3 | tr '\\n' ' ')" >&2; exit 1`;
}

export class InstaboxSessions implements InstaboxLifecycle {
  private jobs = new Map<string, IbxJob>();
  private warned = new Set<string>();
  private ops: IbxOps;

  constructor(private d: InstaboxSessionsDeps) {
    this.ops = {
      runContainer, removeContainer, copyVolume,
      syncCreds: (remote, files, mode) => syncCreds(volumeCredIo(d.image, remote), files, mode),
      remoteDocker: async (remote, args, timeoutMs, stdin) => {
        const r = await run([...remote, ...args], { timeoutMs, stdin });
        return { code: r.timedOut ? 124 : r.code, stderr: r.timedOut ? "timeout" : r.stderr };
      },
      ...d.ops,
    };
  }

  private now() { return this.d.now?.() ?? Date.now(); }
  job(id: string): IbxJob | null { return this.jobs.get(id) ?? null; }
  private credFiles(): CredFile[] { return credentialFiles(this.d.accountIds()); }

  // syncCreds does not throw because of a single file (Task 6): a single file's error comes
  // as `error` in the result. Here it is only logged — sync is best-effort and must not bring down
  // resume/pause or the periodic loop. An exception from the whole call is logged the same way.
  private async syncCredsLogged(s: SessionRow, mode: "both" | "push", files = this.credFiles()): Promise<CredSyncResult[]> {
    try {
      const res = await this.ops.syncCreds(dockerArgv(s.container), files, mode);
      for (const r of res) if (r.error) console.error(`creds sync ${s.id} ${r.file}:`, r.error);
      return res;
    } catch (e) {
      console.error(`creds sync ${s.id} (${mode}):`, (e as Error).message);
      return [];
    }
  }

  private async tailscale(m: string, sessionId: string): Promise<void> {
    const key = this.d.tailscaleAuthKey();
    if (!key) throw new Error("Tailscale auth key is missing on the VPS (/etc/devd/instabox/tailscale-auth-key)");
    // Idempotent: run again after resume. Checking /api/health on the devd VM listener
    // also tests the ACL (tag:devbox-instabox may only reach VPS:vmPort).
    let r;
    try {
      r = await this.d.client.run(m,
        tailscaleJoinCmd(`ibx-${m.replace(/_/g, "-")}`, `${vmDevdUrl(this.d.settings)}/api/health`),
        { envs: { TS_KEY: key }, timeoutMs: 150_000 });
    } catch (e) {
      throw new Error(scrubSecret((e as Error).message, key));
    }
    if (r.exitCode !== 0) {
      throw new Error(`The machine did not reach devd over Tailscale (check the auth key and ACL tag:devbox-instabox → VPS:${this.d.settings.vmPort}): ${scrubSecret((r.stderr || r.stdout).trim(), key).slice(0, 300)}`);
    }
    // C1: the machine's tailnet IP is recorded BEFORE the session container runs in the VM —
    // the devd approval gates then let nothing through from it. Without an IP the guarantee cannot hold → create/resume fails.
    const ipR = await this.d.client.run(m, "tailscale ip -4", { timeoutMs: 30_000 });
    const ip = ipR.stdout.trim().split(/\s+/)[0] ?? "";
    if (ipR.exitCode !== 0 || !isAddressInCidr(ip, "100.64.0.0/10")) {
      throw new Error(`Could not read the machine's tailnet IPv4 (tailscale ip -4): ${(ipR.stderr || ipR.stdout).trim().slice(0, 200)}`);
    }
    addInstaboxIp(ip);
    setSessionInstaboxTsIp(this.d.db, sessionId, ip);
  }

  async startCreate(t: { folder: string; project: string; repo: string; cloneUrl: string; agent?: AgentName }): Promise<IbxJob> {
    const base = getInstaboxBase(this.d.db);
    if (!base) throw new IbxPreconditionError("InstaBox base snapshot is not built yet — run Rebuild base", 503);
    if (!this.d.tailscaleAuthKey()) throw new IbxPreconditionError("Tailscale auth key is missing on the VPS", 503);
    // The limit applies to the WHOLE account (spike: the account also has another machine) → usage().machines.
    const usage = await this.d.client.usage();
    if (usage.machines >= usage.maxMachines) {
      throw new IbxPreconditionError(`InstaBox is full (${usage.machines}/${usage.maxMachines} machines on the account) — stop or delete a machine`, 409);
    }
    const agent = resolveAgent(t.agent, getRepoAgent(this.d.db, t.folder, t.project, t.repo));
    if (t.agent) setRepoAgent(this.d.db, t.folder, t.project, t.repo, t.agent, this.now());
    return this.d.mgr.withLock([openLockKey(t)], "instabox-create", async () => {
      // R3: always a NEW session; leftover = a worktree remained after an ended VPS session.
      const id = nextSessionId(this.d.db, t.project, t.repo, (x) => existsSync(sessionWorktreePath(this.d.root, x)));
      const port_base = allocatePortBase(this.d.db, this.d.cfg.settings);
      insertSession(this.d.db, {
        id, folder: t.folder, project: t.project, repo: t.repo, container: id, port_base,
        status: "running", solo: 0, created_at: this.now(), last_active_at: this.now(), important: 0, agent, host: "instabox",
      });
      logEvent(this.d.db, id, "instabox_create_start", { snapshot: base.snapshot_id });
      const job: IbxJob = { id: crypto.randomUUID(), sessionId: id, status: "running", step: "preflight", startedAt: this.now() };
      this.jobs.set(job.id, job);
      // withLock takes the [id] key SYNCHRONOUSLY (locked() adds keys before the first await),
      // so there is no window for stop/end between releasing the repo lock and starting the job.
      void this.d.mgr.withLock([id], "instabox-create", () => this.runCreate(job, { ...t, agent }, id, port_base, base.snapshot_id))
        .catch((e) => {
          console.error(`instabox create ${id}:`, e);
          // The [id] lock was not taken (or the rollback itself failed): the job must not hang in "running"
          // and the inserted row must not remain as a phantom without a machine.
          if (job.status !== "running") return;
          job.status = "error";
          job.error = (e as Error).message;
          deleteSession(this.d.db, id);
        });
      return job;
    });
  }

  private async runCreate(job: IbxJob, t: { project: string; repo: string; cloneUrl: string; agent: AgentName }, id: string, portBase: number, snapshot: string): Promise<void> {
    let machineId: string | null = null;
    const step = (s: IbxStep) => { job.step = s; };
    try {
      step("machine");
      machineId = (await this.d.client.create(snapshot, { name: machineName(id), metadata: { devbox: "1", session: id } })).id;
      setSessionInstabox(this.d.db, id, machineId);
      step("ssh");
      setRemoteDocker(id, await this.d.ssh.ensure(machineId));
      const remote = dockerArgv(id);
      step("tailscale");
      await this.tailscale(machineId, id);
      step("dirs");
      await this.prepareDirs(machineId, id);
      step("volumes");
      for (const v of volumesToCopy(this.d.accountIds())) await this.ops.copyVolume(v, this.d.image, remote);
      step("secrets");
      const opts = await this.d.mgr.remoteRunOpts(id, portBase, t.project, t.repo, t.agent, vmDevdUrl(this.d.settings));
      await this.writeSecrets(machineId, id);
      step("clone");
      await this.clone(remote, id, t.cloneUrl, opts);
      step("container");
      await this.ops.runContainer(opts);
      step("desktop");
      await this.d.client.desktopStart(machineId, this.d.settings.desktopWidth, this.d.settings.desktopHeight);
      step("done");
      job.status = "done";
      logEvent(this.d.db, id, "open-instabox", { machine: machineId });
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      await this.rollback(id, machineId ? [machineId] : [], { step: job.step, error: job.error });
    }
  }

  private async rollback(id: string, machines: string[], failed: { step: string; error?: string }): Promise<void> {
    // kill deletes the machine along with the container and disks — nothing else in the VM needs cleanup.
    for (const m of machines) {
      await this.d.client.kill(m).catch((k) => { console.error(`instabox rollback ${id}: kill ${m} failed:`, (k as Error).message); return false; });
      this.d.ssh.forget(m);
    }
    setRemoteDocker(id, null);
    // The placeholder was issued by remoteRunOpts; the git proxy only checks that the placeholder exists, not the session.
    try { this.d.revokePlaceholder?.(id); } catch (r) { console.error(`instabox rollback ${id}: revoking placeholders failed:`, (r as Error).message); }
    // The local control dir with the gitea token placeholder was written by remoteRunOpts — pointless without a session.
    rmSync(join(this.d.controlRoot, id), { recursive: true, force: true });
    deleteSession(this.d.db, id);
    logEvent(this.d.db, id, "instabox_create_failed", failed);
  }

  /** devd startup: an InstaBox session whose create was interrupted by a restart (the last create event
   *  is `instabox_create_start`, without `open-instabox` / `instabox_create_failed`) is cleaned up
   *  the same way as a rollback. Without a machine id in the DB (crash between create and writing the id) the machine
   *  is looked up by the metadata `devbox=1, session=<id>` — never without the devbox=1 filter. */
  async sweepInterruptedCreates(): Promise<string[]> {
    const creating = new Set([...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.sessionId));
    const swept: string[] = [];
    for (const s of listSessions(this.d.db).filter((x) => x.host === "instabox" && !creating.has(x.id))) {
      const last = listEvents(this.d.db, { session: s.id, types: ["instabox_create_start", "open-instabox", "instabox_create_failed"], limit: 1 })[0];
      if (last?.type !== "instabox_create_start") continue;
      let machines: string[];
      try {
        machines = s.instabox_machine_id ? [s.instabox_machine_id] : (await this.d.client.list({ devbox: "1", session: s.id })).map((m) => m.id);
      } catch (e) {
        // Without the API we do not know which machine to delete — we keep the row, it is retried on the next start.
        console.error(`instabox sweep ${s.id}: listing machines failed:`, (e as Error).message);
        continue;
      }
      console.error(`instabox sweep ${s.id}: create interrupted by a devd restart → cleanup`);
      await this.rollback(s.id, machines, { step: "interrupted", error: "devd restarted during create" });
      swept.push(s.id);
    }
    return swept;
  }

  // /data is owned by root (spike point 5) → sudo -n; contents then uid 1000 (= dev in the container and user in the VM).
  private async prepareDirs(m: string, id: string): Promise<void> {
    const dirs = [IBX_PATHS.ws(id), IBX_PATHS.ctl(id), IBX_PATHS.projects(id), `${IBX_PATHS.secrets}/gh`].map(shq).join(" ");
    const r = await this.d.client.run(m, `sudo -n mkdir -p ${dirs} && sudo -n chown -R 1000:1000 ${shq(IBX_PATHS.root)} && sudo -n chmod 700 ${shq(IBX_PATHS.secrets)}`);
    if (r.exitCode !== 0) throw new Error(`Preparing ${IBX_PATHS.root} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }

  private async writeSecrets(m: string, id: string): Promise<void> {
    for (const f of ["config.yml", "hosts.yml"]) {
      const p = this.d.ghConfigDir ? join(this.d.ghConfigDir, f) : null;
      if (p && existsSync(p)) await this.d.client.writeFile(m, `${IBX_PATHS.secrets}/gh/${f}`, readFileSync(p, "utf8"));
    }
    // Git token placeholder: remoteRunOpts just wrote it into the local control dir keyed by
    // the devdUrl host. Real tokens do not go to the VM (toRemoteRunOpts drops such a mount).
    const tokens = join(this.d.controlRoot, id, "gitea-tokens.json");
    if (existsSync(tokens)) await this.d.client.writeFile(m, `${IBX_PATHS.ctl(id)}/gitea-tokens.json`, readFileSync(tokens, "utf8"));
  }

  // The clone runs in the devbox image with the SAME git credentials as the session container (see
  // image/entrypoint.sh): the devbox credential helper (github.com via gh, others from
  // the placeholder in gitea-tokens.json) and gitea via `insteadOf` to the devd git proxy. The real
  // gitea token thus never reaches the VM, not even briefly — the proxy adds it only on the VPS.
  // `git -c` instead of `git config --global`: nothing is written, argv carries no secret.
  private async clone(remote: string[], id: string, cloneUrl: string, opts: RunOpts): Promise<void> {
    const mounts = (opts.extraMounts ?? []).filter((m) => CLONE_MOUNT_DESTS.has(m.split(":")[1] ?? ""));
    const base = (opts.env?.DEVD_URL ?? vmDevdUrl(this.d.settings)).replace(/\/+$/, "");
    const insteadOf = (opts.env?.DEVD_GIT_INSTEADOF ?? "").split(",").flatMap((pair) => {
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), url = pair.slice(i + 1);
      return i > 0 && url ? ["-c", `url.${base}/git/${name}/.insteadOf=${url.replace(/\/+$/, "")}/`] : [];
    });
    const r = await this.ops.remoteDocker(remote, ["run", "--rm", "-u", "1000",
      "-v", `${IBX_PATHS.ws(id)}:/workspace`, ...mounts.flatMap((m) => ["-v", m]),
      this.d.image, "git", "-c", `credential.helper=${CRED_HELPER}`, ...insteadOf, "clone", "--", cloneUrl, "/workspace"], CLONE_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.trim().slice(0, 300)}`);
  }

  async resume(s: SessionRow): Promise<void> {
    const m = machineOf(s);
    await this.d.client.resume(m);
    try {
      setRemoteDocker(s.container, await this.d.ssh.ensure(m));
      await this.tailscale(m, s.id);
    } catch (e) {
      // I3: the machine is already running (autoSuspend 0), but the session stays "stopped" — without a pause it would
      // run and bill forever, with nobody knowing about it. Best-effort; the resume error wins.
      setRemoteDocker(s.container, null);
      await this.d.client.pause(m).catch((p) => console.error(`instabox resume ${s.id}: pausing machine ${m} again failed:`, (p as Error).message));
      throw e;
    }
    // Current file list: an account added in the meantime gets pushed right away (Review Focus 5).
    await this.syncCredsLogged(s, "push");
    updateSession(this.d.db, s.id, { status: "running", last_active_at: this.now() });
    logEvent(this.d.db, s.id, "instabox_resume", { machine: m });
  }

  async pause(s: SessionRow, reason: "manual" | "idle" = "manual"): Promise<void> {
    const m = machineOf(s);
    if (s.status === "running") await this.syncCredsLogged(s, "both");
    await this.d.client.desktopRevoke(m).catch(() => {});
    // I2: alias gone BEFORE the pause — a docker call that would otherwise finish after the pause
    // (creds sync, probe) would wake the machine again via the SSH gateway. Restored if the pause fails.
    const alias = remoteDockerAlias(s.container);
    setRemoteDocker(s.container, null);
    try { await this.d.client.pause(m); }
    catch (e) { setRemoteDocker(s.container, alias); throw e; }
    updateSession(this.d.db, s.id, { status: "stopped" });
    logEvent(this.d.db, s.id, "stop", reason === "idle" ? { host: "instabox", reason: "idle-timeout" } : { host: "instabox" });
  }

  async end(s: SessionRow): Promise<void> {
    const m = s.instabox_machine_id;
    if (m) {
      await this.d.client.desktopRevoke(m).catch(() => {});
      await this.d.client.kill(m); // false = the machine no longer existed → fine
      this.d.ssh.forget(m);
    }
    setRemoteDocker(s.container, null);
  }

  async syncAllCreds(): Promise<void> {
    const files = this.credFiles();
    // A session whose create is still running has no finished volumes or alias — sync would only interfere.
    const creating = new Set([...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.sessionId));
    for (const listed of listSessions(this.d.db).filter((x) => x.host === "instabox" && x.status === "running" && !creating.has(x.id))) {
      // I2: under the session lock — pause/end/resume never overlap with a sync run. Lock taken =
      // an operation on the session is running right now → this round skips it (next one in 2 min).
      let synced: { s: SessionRow; res: CredSyncResult[] } | null;
      try {
        synced = await this.d.mgr.withLock([listed.id], "instabox-creds-sync", async () => {
          const s = getSession(this.d.db, listed.id);
          if (s?.host !== "instabox" || s.status !== "running") return null;
          const alias = remoteDockerAlias(s.container);
          if (!alias) return null;
          const res: CredSyncResult[] = [];
          for (const f of files) {
            // The alias vanished (pause/end outside the lock, rollback) → not even the next file: SSH would wake the machine.
            if (remoteDockerAlias(s.container) !== alias) break;
            res.push(...await this.syncCredsLogged(s, "both", [f]));
          }
          return { s, res };
        });
      } catch (e) {
        if (e instanceof SessionBusyError) continue;
        throw e;
      }
      if (!synced) continue;
      const { s, res } = synced;
      const moved = res.filter((r) => r.action !== "none");
      if (moved.length) logEvent(this.d.db, s.id, "instabox_creds_sync", moved.map((r) => ({ file: r.file, action: r.action })));
      // Neither side has a valid login: sync has nothing to propagate, the user must log in again.
      for (const r of res) {
        // A file that could not be read also has local/remote null — but that does not
        // mean logged out, just a transfer error (logged in syncCredsLogged).
        if (r.error) continue;
        const key = `${s.id}:${r.file}`;
        const dead = SHARED_CRED_VOLUMES.has(r.volume) && r.local === null && r.remote === null;
        if (dead && !this.warned.has(key)) { this.warned.add(key); this.d.notify?.(`${s.project}/${s.repo}`, `InstaBox: ${r.file} is not logged in on either side — log in again`); }
        if (!dead) this.warned.delete(key);
      }
    }
  }

  /** `refresh` = periodic renewal of the reconnect link (M7): old links are NOT invalidated,
   *  otherwise a renewal in control mode would disconnect the desktop that is currently open. Only an
   *  explicit takeover of control invalidates them. */
  async desktopLink(s: SessionRow, control: boolean, refresh = false): Promise<{ url: string; expiresAt: number }> {
    const m = machineOf(s);
    if (control && !refresh) await this.d.client.desktopRevoke(m); // a new link with control invalidates the old ones
    return this.d.client.desktopLink(m, !control, DESKTOP_TTL_S);
  }

  async desktopRevoke(s: SessionRow): Promise<void> { await this.d.client.desktopRevoke(machineOf(s)); }
}
