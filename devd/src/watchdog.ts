import type { Database } from "bun:sqlite";
import { AGENT_RUNTIMES } from "./agents";
import type { Settings } from "./config";
import { listSessions, type SessionRow } from "./db";
import { execInContainer } from "./docker";
import type { SessionManager } from "./sessions";

export type ActivityProbe = (s: SessionRow) => Promise<boolean>;

// Process names that mean "work is happening in the session" — derived from the profile table,
// so adding another runtime cannot be forgotten by the watchdog. If a runtime were missing here,
// the watchdog would consider a session with a working agent idle and put it to sleep.
const AGENT_PROCS = AGENT_RUNTIMES;

// Two lines: the number of attached tmux clients and the number of live agent processes.
// `|| true` keeps the exit code at zero — grep without a match returns 1.
export const PROBE_CMD =
  `tmux list-clients 2>/dev/null | wc -l; ps -eo comm= | grep -cE '^(${AGENT_PROCS.join("|")})$' || true`;

// A session is alive when someone is sitting at it OR an agent is running in it. Previously, instead of the agent,
// `ps -eo %cpu > 3` was tested — but that is the average load over the whole lifetime of the process,
// so even a working Claude has ~1 % there and the condition never fired. The only thing that then
// kept the session alive was an attached terminal: a sleeping mac / closed Warp tab = a detached
// client and the watchdog killed the container after `autoStopHours` along with the running agent.
export function probeActive(stdout: string): boolean {
  const [clients, agents] = stdout.trim().split("\n");
  const n = (s: string | undefined) => Number.parseInt(s ?? "", 10) || 0;
  return n(clients) > 0 || n(agents) > 0;
}

export const defaultProbe: ActivityProbe = async (s) => {
  const r = await execInContainer(s.container, ["sh", "-c", PROBE_CMD]);
  return probeActive(r.stdout);
};

export async function sweepIdleSessions(
  mgr: SessionManager, db: Database, settings: Settings, probe: ActivityProbe, now = Date.now()
): Promise<string[]> {
  const stopped: string[] = [];
  for (const s of listSessions(db).filter((x) => x.status === "running")) {
    let active = false;
    try { active = await probe(s); } catch { /* container unreachable → treat as inactive */ }
    // `active` (an attached tmux client / running claude) is only a VETO against auto-stop —
    // it keeps a live session alive. It is NOT written into `last_active_at`: that is "last
    // actually used" (open/restart/sent prompt) and drives the UI "active X ago".
    // It used to be bumped here → a forgotten attach reset the time to "now" every 5 min.
    if (!active && now - s.last_active_at > settings.autoStopHours * 3600_000) {
      try {
        await mgr.stop(s.id, "idle");
        stopped.push(s.id);
      } catch (e) {
        console.error(`watchdog: failed to stop ${s.id}:`, e);
      }
    }
  }
  return stopped;
}
