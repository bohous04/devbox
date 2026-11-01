import type { IbxExec, IbxMachine, IbxMetrics, IbxSshCreds, IbxUsage, InstaboxClient } from "../../src/instabox/client";

export class FakeInstaboxClient implements InstaboxClient {
  machines = new Map<string, IbxMachine>();
  calls: string[] = [];
  /** Method name → error its next call throws (one-shot). */
  failNext = new Map<string, Error>();
  /** Command prefix → `run` result (first match wins), otherwise exit 0. */
  runResults: [string, IbxExec][] = [];
  /** `${machine}:${path}` → content written via writeFile. */
  files = new Map<string, string>();
  maxMachines = 5;
  /** Machines outside the devbox (spike: the account also has a foreign `vps02`) — counted in usage().machines. */
  foreignMachines = 0;
  links = 0;
  private seq = 0;
  private hit(name: string, arg = "") {
    this.calls.push(arg ? `${name} ${arg}` : name);
    const e = this.failNext.get(name);
    if (e) { this.failNext.delete(name); throw e; }
  }
  async create(template: string, o: { name: string; metadata: Record<string, string> }) {
    this.hit("create", template);
    const m: IbxMachine = { id: `m_${++this.seq}`, name: o.name, state: "running", metadata: o.metadata };
    this.machines.set(m.id, m);
    return m;
  }
  async list(metadata: Record<string, string>) {
    this.hit("list");
    return [...this.machines.values()].filter((m) => Object.entries(metadata).every(([k, v]) => m.metadata[k] === v));
  }
  async pause(id: string) { this.hit("pause", id); this.machines.get(id)!.state = "suspended"; }
  async resume(id: string) { this.hit("resume", id); this.machines.get(id)!.state = "running"; }
  async kill(id: string) { this.hit("kill", id); return this.machines.delete(id); }
  async run(id: string, cmd: string): Promise<IbxExec> {
    this.hit("run", `${id} ${cmd}`);
    const hit = this.runResults.find(([p]) => cmd.startsWith(p))?.[1];
    if (hit) return hit;
    // The machine's tailnet IP (C1): deterministic 100.100.0.<machine number>.
    if (cmd === "tailscale ip -4") return { exitCode: 0, stdout: `100.100.0.${id.replace(/\D/g, "") || "0"}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async writeFile(id: string, path: string, data: string) { this.hit("writeFile", `${id} ${path}`); this.files.set(`${id}:${path}`, data); }
  async sshCredentials(id: string): Promise<IbxSshCreds> {
    this.hit("sshCredentials", id);
    return { host: "api.instabox.sh", port: 2222, username: id, certificate: `ssh-ed25519-cert-v01@openssh.com AAAA ${id}`, knownHostsLine: "@cert-authority [api.instabox.sh]:2222 ssh-ed25519 CA", expiresAt: Date.now() + 86_400_000 };
  }
  async desktopStart(id: string) { this.hit("desktopStart", id); }
  async desktopLink(id: string, viewOnly: boolean, ttl: number) {
    this.hit("desktopLink", `${id} ${viewOnly}`);
    this.links++;
    return { url: `https://dashboard.instabox.sh/stream/${id}/${this.links}`, expiresAt: Date.now() + ttl * 1000 };
  }
  async desktopRevoke(id: string) { this.hit("desktopRevoke", id); }
  async snapshot(id: string, name: string) { this.hit("snapshot", `${id} ${name}`); return { id: `sn_${name}` }; }
  async waitSnapshotReady(id: string) { this.hit("waitSnapshotReady", id); }
  async deleteSnapshot(id: string) { this.hit("deleteSnapshot", id); return true; }
  async metrics(id: string): Promise<IbxMetrics | null> { this.hit("metrics", id); return { cpuPct: 12, memBytes: 1_000_000 }; }
  async usage(): Promise<IbxUsage> {
    this.hit("usage");
    return { machines: this.machines.size + this.foreignMachines, maxMachines: this.maxMachines, storedBytes: 0, maxStoredBytes: 200 * 1024 ** 3 };
  }
}
