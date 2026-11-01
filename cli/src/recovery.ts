import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliConfig } from "./config";
import type { SessionInfo } from "./api";
import { recoveryOwnerAlive, type RecoveryOwnerDeps, type RecoveryProcessIdentity } from "./recoveryOwner";

export interface TerminalRecoveryRecord {
  version: 1;
  paneId: string;
  sessionId: string;
  container: string;
  tmuxSession: string;
  devdUrl: string;
  label: string;
  attachedAt: number;
  ownerPid: number;
  ownerIdentity?: RecoveryProcessIdentity;
}

// WARP_SESSION_ID is a legacy per-shell bootstrap number. The terminal UUID is
// persisted by Warp with its pane tree and exported again in the restored shell.
export function warpPaneId(env: Record<string, string | undefined> = process.env): string | undefined {
  const id = env.WARP_TERMINAL_SESSION_UUID;
  return env.TERM_PROGRAM === "WarpTerminal" && id && /^[a-f0-9]{32}$/i.test(id) ? id.toLowerCase() : undefined;
}

export function safeTmuxSession(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function parseRecoveryRecord(value: unknown): TerminalRecoveryRecord | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as TerminalRecoveryRecord;
  if (r.version !== 1 || !/^[a-f0-9]{32}$/.test(r.paneId ?? "")
    || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,255}$/.test(r.sessionId ?? "")
    || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,255}$/.test(r.container ?? "")
    || typeof r.tmuxSession !== "string" || !safeTmuxSession(r.tmuxSession)
    || typeof r.label !== "string" || r.label.length > 1000
    || typeof r.devdUrl !== "string" || !Number.isFinite(r.attachedAt)
    || !Number.isSafeInteger(r.ownerPid) || r.ownerPid < 1) return;
  if (r.ownerIdentity !== undefined && (!r.ownerIdentity
    || typeof r.ownerIdentity.bootId !== "string" || !r.ownerIdentity.bootId || r.ownerIdentity.bootId.length > 128
    || typeof r.ownerIdentity.startedAt !== "string" || !r.ownerIdentity.startedAt || r.ownerIdentity.startedAt.length > 128)) return;
  try {
    const u = new URL(r.devdUrl);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return;
  } catch { return; }
  return r;
}

export function sameRecoveryServer(record: TerminalRecoveryRecord, cfg: CliConfig): boolean {
  return record.devdUrl.replace(/\/+$/, "") === cfg.devdUrl.replace(/\/+$/, "");
}

export function sameRecoveryTarget(a: TerminalRecoveryRecord, b: TerminalRecoveryRecord): boolean {
  return a.devdUrl.replace(/\/+$/, "") === b.devdUrl.replace(/\/+$/, "")
    && a.sessionId === b.sessionId && a.container === b.container && a.tmuxSession === b.tmuxSession;
}

export function ownerAlive(record: TerminalRecoveryRecord, deps?: RecoveryOwnerDeps): boolean {
  return recoveryOwnerAlive(record, deps);
}

export function newestRecoveryRecords(records: TerminalRecoveryRecord[]): TerminalRecoveryRecord[] {
  const newest = [...records].sort((a, b) => b.attachedAt - a.attachedAt || b.paneId.localeCompare(a.paneId));
  return newest.filter((r, i) => !newest.slice(0, i).some((other) => sameRecoveryTarget(r, other)));
}

export function recoveryDirectory(): string {
  return process.env.DEV_RECOVERY_DIR || join(homedir(), ".config", "devbox-cli", "terminals");
}

export function terminalRecoveryStore(dir = recoveryDirectory()) {
  const path = (paneId: string) => {
    if (!/^[a-f0-9]{32}$/.test(paneId)) throw new Error("Invalid Warp pane UUID");
    return join(dir, `${paneId}.json`);
  };
  const read = (paneId: string): TerminalRecoveryRecord | undefined => {
    try {
      const record = parseRecoveryRecord(JSON.parse(readFileSync(path(paneId), "utf8")));
      return record?.paneId === paneId ? record : undefined;
    } catch { return; }
  };
  return {
    read,
    list(): TerminalRecoveryRecord[] {
      try {
        return readdirSync(dir).filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
          .flatMap((f) => { const r = read(f.slice(0, -5)); return r ? [r] : []; })
          .sort((a, b) => a.attachedAt - b.attachedAt);
      } catch { return []; }
    },
    write(record: TerminalRecoveryRecord) {
      if (!parseRecoveryRecord(record)) throw new Error("Invalid terminal recovery record");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // One file per pane: parallel tabs never overwrite one another's entries.
      const target = path(record.paneId);
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(temp, target);
      } finally { rmSync(temp, { force: true }); }
    },
    forget(paneId: string, ownerPid?: number) {
      if (ownerPid !== undefined && read(paneId)?.ownerPid !== ownerPid) return;
      rmSync(path(paneId), { force: true });
    },
  };
}

export function recoveryLaunchConfig(records: TerminalRecoveryRecord[], cwd: string, cliPath: string, bunPath: string): string {
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  // JSON string literals are also YAML strings. Do not interpolate labels or
  // executable paths as unquoted YAML/shell text.
  return ["name: Devbox recovery", "windows:", "  - tabs:", ...records.flatMap((r) => [
    `      - title: ${JSON.stringify(r.label)}`,
    "        layout:",
    `          cwd: ${JSON.stringify(cwd)}`,
    "          commands:",
    `            - exec: ${JSON.stringify([bunPath, cliPath, "resume", "--pane", r.paneId].map(quote).join(" "))}`,
  ]), ""].join("\n");
}

export async function waitForSavedSession(record: TerminalRecoveryRecord, deps: {
  sessions(): Promise<SessionInfo[]>;
  sleep(ms: number): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<SessionInfo> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeoutMs ?? 120_000);
  for (;;) {
    let sessions: SessionInfo[] | undefined;
    try { sessions = await deps.sessions(); } catch { /* server/network may still be starting */ }
    if (sessions) {
      const session = sessions.find((s) => s.id === record.sessionId);
      if (!session || session.container !== record.container) throw new Error("Saved session no longer matches this devbox; its recovery record was kept.");
      if (session.status !== "running") throw new Error("Saved container was stopped. Open it explicitly before running `dev resume`.");
      if (session.tmux?.some((t) => t.name === record.tmuxSession)) return session;
      // Old devd without tmux metadata still gets the exact has-session guard
      // inside SSH. It cannot accidentally create a fresh/default agent.
      if (session.tmux === undefined) return session;
    }
    if (now() >= deadline) throw new Error("Devbox has not restored this terminal yet; run `dev resume` once it is ready.");
    await deps.sleep(3000);
  }
}
