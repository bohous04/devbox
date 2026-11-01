import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ibxAlias } from "../dockerTarget";
import { run } from "../proc";
import type { IbxSshCreds, InstaboxClient } from "./client";

export interface SshPaths { dir: string; configFile: string }
export const DEFAULT_SSH_PATHS: SshPaths = { dir: "/var/lib/devd/instabox", configFile: "/etc/ssh/ssh_config.d/devd-instabox.conf" };
const CERT_TTL_S = 86_400;
const REFRESH_BEFORE_MS = 2 * 3600_000;

export function needsRefresh(expiresAt: number | undefined, now: number): boolean {
  return expiresAt === undefined || expiresAt - now < REFRESH_BEFORE_MS;
}

// ControlMaster: `docker -H ssh://` opens a new ssh connection for EVERY command (inspect,
// exec, probe…). Without multiplexing, the watchdog and tmux probe would pay the handshake through
// the InstaBox gateway every time.
export function hostBlock(alias: string, c: Pick<IbxSshCreds, "host" | "port" | "username">, dir: string): string {
  return `Host ${alias}\n  HostName ${c.host}\n  Port ${c.port}\n  User ${c.username}\n` +
    `  IdentityFile ${dir}/id_ed25519\n  CertificateFile ${dir}/${c.username}-cert.pub\n` +
    `  UserKnownHostsFile ${dir}/known_hosts\n  StrictHostKeyChecking yes\n` +
    `  ControlMaster auto\n  ControlPath ${dir}/cm-%C\n  ControlPersist 10m\n` +
    `  ServerAliveInterval 15\n  ConnectTimeout 15\n`;
}

// Ubuntu includes /etc/ssh/ssh_config.d/*.conf by itself, so the alias also works for
// `ssh vps docker -H ssh://ibx-…` from the Mac (CLI attach).
export function includeFile(dir: string): string {
  return `# managed by devd (instabox/ssh.ts) — manual changes will be overwritten\nInclude ${dir}/hosts/*.conf\n`;
}

export class InstaboxSsh {
  constructor(private client: InstaboxClient, private paths: SshPaths = DEFAULT_SSH_PATHS, private now: () => number = Date.now) {}

  private get dir() { return this.paths.dir; }
  private hostFile(m: string) { return join(this.dir, "hosts", `${m}.conf`); }
  private certFile(m: string) { return join(this.dir, `${m}-cert.pub`); }
  private metaFile(m: string) { return join(this.dir, `${m}.json`); }

  private async pubKey(): Promise<string> {
    const key = join(this.dir, "id_ed25519");
    if (!existsSync(key)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const r = await run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "devd-instabox", "-f", key, "-q"], { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr.trim()}`);
    }
    return readFileSync(`${key}.pub`, "utf8").trim();
  }

  private expiresAt(m: string): number | undefined {
    try { const v = (JSON.parse(readFileSync(this.metaFile(m), "utf8")) as { expiresAt?: unknown }).expiresAt; return typeof v === "number" ? v : undefined; }
    catch { return undefined; }
  }

  private addKnownHost(line: string): void {
    const path = join(this.dir, "known_hosts");
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    if (!lines.includes(line)) writeFileSync(path, [...lines, line].join("\n") + "\n", { mode: 0o600 });
  }

  /** Ensures a valid certificate and host block; returns the ssh alias. `force` = renew right away
   *  (the gateway rejected the certificate, see runDocker). */
  async ensure(machineId: string, force = false): Promise<string> {
    const alias = ibxAlias(machineId);
    if (!force && existsSync(this.hostFile(machineId)) && !needsRefresh(this.expiresAt(machineId), this.now())) return alias;
    const c = await this.client.sshCredentials(machineId, await this.pubKey(), CERT_TTL_S);
    mkdirSync(join(this.dir, "hosts"), { recursive: true, mode: 0o700 });
    writeFileSync(this.certFile(machineId), c.certificate.trim() + "\n", { mode: 0o600 });
    chmodSync(this.certFile(machineId), 0o600);
    writeFileSync(this.hostFile(machineId), hostBlock(alias, c, this.dir), { mode: 0o600 });
    this.addKnownHost(c.knownHostsLine);
    writeFileSync(this.metaFile(machineId), JSON.stringify({ expiresAt: c.expiresAt }), { mode: 0o600 });
    writeFileSync(this.paths.configFile, includeFile(this.dir), { mode: 0o644 });
    return alias;
  }

  forget(machineId: string): void {
    for (const f of [this.hostFile(machineId), this.certFile(machineId), this.metaFile(machineId)]) rmSync(f, { force: true });
  }

  async refreshAll(machineIds: string[]): Promise<void> {
    for (const m of machineIds) {
      try { await this.ensure(m); } catch (e) { console.error(`instabox ssh refresh ${m} failed:`, (e as Error).message); }
    }
  }
}
