import type { SessionInfo } from "./api";
import { parseRecoveryRecord, type TerminalRecoveryRecord } from "./recovery";
import type { CliConfig } from "./config";
import { isDevCliCommand, localRecoveryOwnerDeps, sshAttachTarget, type RecoveryProcessIdentity } from "./recoveryOwner";

export interface SnapshotProcess { pid: number; ppid: number; executable: string }
export interface SnapshotDeps {
  processes(): SnapshotProcess[];
  command(pid: number): string;
  warpEnvironment(pid: number): { TERM_PROGRAM?: string; WARP_TERMINAL_SESSION_UUID?: string };
  ownerIdentity?(pid: number): RecoveryProcessIdentity | undefined;
}

export const localSnapshotDeps: SnapshotDeps = {
  processes: localRecoveryOwnerDeps.processes,
  command: localRecoveryOwnerDeps.command,
  warpEnvironment: localRecoveryOwnerDeps.warpEnvironment,
  ownerIdentity: localRecoveryOwnerDeps.identity,
};

// Migrate only a running dev CLI's direct SSH child with the exact terminal
// command shape emitted by buildExecArgv. Never infer an id from pane titles,
// cwd, recents or command history; an ambiguous process is simply skipped.
export function snapshotWarpConnectionPlan(sessions: SessionInfo[], cfg: CliConfig, deps = localSnapshotDeps,
  now = Date.now()): { records: TerminalRecoveryRecord[]; warpCliProcesses: number; skipped: number } {
  const processes = deps.processes();
  const records: TerminalRecoveryRecord[] = [];
  let warpCliProcesses = 0;
  for (const owner of processes.filter((p) => /(?:^|\/)bun$/.test(p.executable))) {
    const ownerIdentity = deps.ownerIdentity?.(owner.pid);
    const cmd = deps.command(owner.pid);
    if (!isDevCliCommand(cmd)) continue;
    const env = deps.warpEnvironment(owner.pid);
    const paneId = env.WARP_TERMINAL_SESSION_UUID?.toLowerCase();
    if (env.TERM_PROGRAM !== "WarpTerminal" || !paneId || !/^[a-f0-9]{32}$/.test(paneId)) continue;
    warpCliProcesses++;
    const children = processes.filter((p) => p.ppid === owner.pid && /(?:^|\/)ssh$/.test(p.executable));
    if (children.length !== 1) continue;
    const ssh = deps.command(children[0].pid);
    const target = sshAttachTarget(ssh);
    if (!target || ![cfg.sshHost, cfg.sshHostAlt].includes(target.host)) continue;
    const { container, tmuxSession } = target;
    const candidates = sessions.filter((s) => s.container === container && s.status === "running");
    if (candidates.length !== 1) continue;
    const session = candidates[0];
    const afterIdentity = deps.ownerIdentity?.(owner.pid);
    if (ownerIdentity && (!afterIdentity || ownerIdentity.bootId !== afterIdentity.bootId || ownerIdentity.startedAt !== afterIdentity.startedAt)) continue;
    const record = parseRecoveryRecord({ version: 1, paneId, sessionId: session.id, container, tmuxSession,
      devdUrl: cfg.devdUrl, label: `${session.project}/${session.repo}${session.name ? ` · ${session.name}` : ""}`,
      attachedAt: now, ownerPid: owner.pid, ...(ownerIdentity ? { ownerIdentity } : {}) });
    if (record) records.push(record);
  }
  // Nested shells or unexpected duplicate environment inheritance must never
  // choose an arbitrary target for the original Warp pane.
  const unique = records.filter((r) => records.filter((other) => other.paneId === r.paneId).length === 1
    && records.filter((other) => other.container === r.container && other.tmuxSession === r.tmuxSession).length === 1);
  return { records: unique, warpCliProcesses, skipped: warpCliProcesses - unique.length };
}

export function snapshotWarpConnections(sessions: SessionInfo[], cfg: CliConfig, deps = localSnapshotDeps, now = Date.now()) {
  return snapshotWarpConnectionPlan(sessions, cfg, deps, now).records;
}
