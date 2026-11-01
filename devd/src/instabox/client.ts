import { Sandbox, type SandboxInfo } from "@insforge/instabox-sdk";

export type IbxState = SandboxInfo["state"];
export interface IbxMachine { id: string; name: string; state: IbxState; metadata: Record<string, string> }
export interface IbxExec { exitCode: number; stdout: string; stderr: string }
export interface IbxSshCreds { host: string; port: number; username: string; certificate: string; knownHostsLine: string; expiresAt: number }
export interface IbxUsage { machines: number; maxMachines: number; storedBytes: number; maxStoredBytes: number }
export interface IbxMetrics { cpuPct: number; memBytes: number }

/** The API key is missing (the `DEVD_INSTABOX_KEY_FILE` file does not exist or is empty). */
export class InstaboxNotConfigured extends Error {
  constructor() { super("InstaBox API key is missing on the VPS (/etc/devd/instabox/api-key)"); this.name = "InstaboxNotConfigured"; }
}

// The only place where devd talks to InstaBox. The rest of the code (and tests via
// FakeInstaboxClient) only knows this interface; the SDK is an implementation detail.
export interface InstaboxClient {
  create(template: string, o: { name: string; metadata: Record<string, string> }): Promise<IbxMachine>;
  list(metadata: Record<string, string>): Promise<IbxMachine[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  kill(id: string): Promise<boolean>;
  run(id: string, cmd: string, o?: { envs?: Record<string, string>; timeoutMs?: number; stdin?: string }): Promise<IbxExec>;
  writeFile(id: string, path: string, data: string): Promise<void>;
  sshCredentials(id: string, publicKey: string, ttlSeconds: number): Promise<IbxSshCreds>;
  desktopStart(id: string, width: number, height: number): Promise<void>;
  desktopLink(id: string, viewOnly: boolean, ttlSeconds: number): Promise<{ url: string; expiresAt: number }>;
  desktopRevoke(id: string): Promise<void>;
  snapshot(id: string, name: string): Promise<{ id: string }>;
  waitSnapshotReady(snapshotId: string, timeoutMs: number): Promise<void>;
  deleteSnapshot(snapshotId: string): Promise<boolean>;
  metrics(id: string): Promise<IbxMetrics | null>;
  usage(): Promise<IbxUsage>;
}

// The key is read on EVERY call (the file can be swapped without restarting devd), hence a function.
// The InstaBox exec API rejects a timeout outside (0, 600 000] ms before even starting
// ("command timeoutMs must be greater than 0 and at most 600 000") — verified live
// during the first base build. Longer work must be split up, not given a longer timeout.
export const MAX_EXEC_TIMEOUT_MS = 600_000;
export function clampExecTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return MAX_EXEC_TIMEOUT_MS;
  return Math.min(Math.floor(ms), MAX_EXEC_TIMEOUT_MS);
}

// Whole bytes — the iOS app decodes `memBytes` from /api/stats/live as Int; fractional
// bytes (the SDK returns `memUsed` as a float) would break decoding.
export function toSessionMetrics(m: { cpuUsedPct?: number; memUsed?: number }): IbxMetrics {
  return { cpuPct: m.cpuUsedPct ?? 0, memBytes: Math.round(m.memUsed ?? 0) };
}

export function createSdkClient(apiKey: () => string | null): InstaboxClient {
  const conn = () => {
    const key = apiKey();
    if (!key) throw new InstaboxNotConfigured();
    return { apiKey: key };
  };
  // resume: false — otherwise the SDK wakes a paused machine on connect. Only resume() wakes it.
  const connect = (id: string) => Sandbox.connect(id, { ...conn(), resume: false });
  const toMachine = (i: SandboxInfo): IbxMachine => ({ id: i.sandboxId, name: i.name, state: i.state, metadata: i.metadata ?? {} });
  return {
    async create(template, o) {
      const s = await Sandbox.create(template, { ...conn(), name: o.name, metadata: o.metadata, autoSuspendMs: 0, vault: false });
      return toMachine(await s.getInfo());
    },
    async list(metadata) { return (await Sandbox.list({ ...conn(), metadata })).map(toMachine); },
    async pause(id) { await (await connect(id)).pause(); },
    async resume(id) { await (await connect(id)).resume(); },
    async kill(id) { return Sandbox.kill(id, conn()); },
    async run(id, cmd, o) {
      // commands.exec never throws on a non-zero exit (unlike commands.run).
      const r = await (await connect(id)).commands.exec(cmd, { envs: o?.envs, timeoutMs: clampExecTimeout(o?.timeoutMs), stdin: o?.stdin });
      return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr || r.error || "" };
    },
    async writeFile(id, path, data) { await (await connect(id)).files.write(path, data); },
    async sshCredentials(id, publicKey, ttlSeconds) {
      const c = await (await connect(id)).sshCredentials(publicKey, { ttlSeconds });
      return { host: c.host, port: c.port, username: c.username, certificate: c.certificate, knownHostsLine: c.knownHostsLine, expiresAt: c.expiresAt.getTime() };
    },
    async desktopStart(id, width, height) { await (await connect(id)).desktop.start({ width, height }); },
    async desktopLink(id, viewOnly, ttlSeconds) {
      const l = await (await connect(id)).desktop.streamUrl({ viewOnly, ttlSeconds });
      return { url: l.url, expiresAt: l.expiresAt.getTime() };
    },
    async desktopRevoke(id) { await (await connect(id)).desktop.revokeStreamUrls(); },
    async snapshot(id, name) { return { id: (await (await connect(id)).createSnapshot({ name })).id }; },
    async waitSnapshotReady(snapshotId, timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const s = await Sandbox.getSnapshot(snapshotId, conn());
        if (s.status === undefined || s.status === "ready") return;
        if (s.status !== "pending") throw new Error(`snapshot ${snapshotId} ended in state ${s.status}`);
        await Bun.sleep(5_000);
      }
      throw new Error(`snapshot ${snapshotId} was not ready within ${Math.round(timeoutMs / 1000)} s`);
    },
    async deleteSnapshot(snapshotId) { return Sandbox.deleteSnapshot(snapshotId, conn()); },
    async metrics(id) {
      const m = (await Sandbox.getMetrics(id, conn())).at(-1);
      return m ? toSessionMetrics(m) : null;
    },
    async usage() {
      const u = await Sandbox.usage(conn());
      return { machines: u.machines, maxMachines: u.limits.maxMachines, storedBytes: u.storedBytes, maxStoredBytes: u.limits.maxStoredGiB * 1024 ** 3 };
    },
  };
}
