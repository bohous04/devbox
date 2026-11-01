import { readFileSync } from "node:fs";
import { loadCliConfig, type CliConfig } from "./config";
import type { TerminalRecoveryRecord } from "./recovery";

export interface RecoveryProcess { pid: number; ppid: number; executable: string }
export interface RecoveryProcessIdentity { bootId: string; startedAt: string }
export interface RecoveryOwnerDeps {
  identity(pid: number): RecoveryProcessIdentity | undefined;
  command(pid: number): string;
  warpEnvironment(pid: number): { TERM_PROGRAM?: string; WARP_TERMINAL_SESSION_UUID?: string };
  processes(): RecoveryProcess[];
  config(): CliConfig;
}

const output = (args: string[]) => Bun.spawnSync(args, {
  stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" },
}).stdout.toString().trim();

let bootId: string | undefined;
export function currentBootId(): string | undefined {
  if (bootId) return bootId;
  if (process.platform === "darwin") {
    const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(output(["/usr/sbin/sysctl", "-n", "kern.boottime"]));
    if (match) bootId = `darwin:${match[1]}:${match[2]}`;
  } else {
    try { bootId = `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}`; } catch {}
  }
  return bootId;
}

export function readProcessIdentity(pid: number): RecoveryProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  const boot = currentBootId();
  const startedAt = output(["ps", "-p", String(pid), "-o", "lstart="]);
  return boot && startedAt ? { bootId: boot, startedAt } : undefined;
}

export function isDevCliCommand(command: string): boolean {
  return /^(?:\S*\/)?bun\s+(?:\S*\/)?(?:dev|main\.ts)(?:\s|$)/.test(command);
}

export function sshAttachTarget(command: string): { host: string; container: string; tmuxSession: string } | undefined {
  const prefix = /^(?:\S*\/)?ssh\s+(.*?)\s+docker(?: -H ssh:\/\/[A-Za-z0-9_.-]+)? exec -it /.exec(command)?.[1];
  const host = prefix?.trim().split(/\s+/).at(-1);
  const container = /(?:^|\s)docker(?: -H ssh:\/\/[A-Za-z0-9_.-]+)? exec -it ([A-Za-z0-9_][A-Za-z0-9._-]*) bash -lc /.exec(command)?.[1];
  const tmuxSession = /(?:^|[;\s'"])tmux attach (?:-d )?-t =?([A-Za-z0-9_][A-Za-z0-9_-]*)['"]?\s*$/.exec(command)?.[1];
  return host && container && tmuxSession ? { host, container, tmuxSession } : undefined;
}

export const localRecoveryOwnerDeps: RecoveryOwnerDeps = {
  identity: readProcessIdentity,
  command: (pid) => output(["ps", "-p", String(pid), "-o", "command="]),
  warpEnvironment(pid) {
    // macOS ps cannot select individual environment variables. Keep output in
    // memory, return only the two nonsecret keys; never log or persist the rest.
    const raw = output(["ps", "eww", "-p", String(pid), "-o", "command="]);
    const env: Record<string, string> = {};
    for (const [, key, value] of raw.matchAll(/(?:^|\s)(TERM_PROGRAM|WARP_TERMINAL_SESSION_UUID)=([^\s]*)/g)) env[key] = value;
    return env;
  },
  processes: () => output(["ps", "-eo", "pid,ppid,comm"]).split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], executable: m[3] }] : [];
  }),
  config: loadCliConfig,
};

export function recoveryOwnerAlive(record: TerminalRecoveryRecord, deps = localRecoveryOwnerDeps): boolean {
  try {
    const observed = deps.identity(record.ownerPid);
    if (record.ownerIdentity) {
      // PID alone is reusable, including immediately after reboot. Require the
      // same boot and process start recorded by attach or the migration scan.
      if (!observed || observed.bootId !== record.ownerIdentity.bootId
        || observed.startedAt !== record.ownerIdentity.startedAt) return false;
    }
    if (!isDevCliCommand(deps.command(record.ownerPid))) return false;
    const env = deps.warpEnvironment(record.ownerPid);
    if (env.TERM_PROGRAM !== "WarpTerminal" || env.WARP_TERMINAL_SESSION_UUID?.toLowerCase() !== record.paneId) return false;
    if (record.ownerIdentity) return true;
    // Legacy records remain usable: verify the actual live SSH attach target.
    // No child while reconnecting is not proof of an owner; a new snapshot can
    // upgrade this old record once that connection is established again.
    const cfg = deps.config();
    if (cfg.devdUrl.replace(/\/+$/, "") !== record.devdUrl.replace(/\/+$/, "")) return false;
    const children = deps.processes().filter((p) => p.ppid === record.ownerPid && /(?:^|\/)ssh$/.test(p.executable));
    if (children.length !== 1) return false;
    const target = sshAttachTarget(deps.command(children[0].pid));
    return !!target && [cfg.sshHost, cfg.sshHostAlt].includes(target.host)
      && target.container === record.container && target.tmuxSession === record.tmuxSession;
  } catch { return false; }
}
