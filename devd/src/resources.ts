// Who holds RAM and CPU on the devbox: a per-session breakdown for the Hardware page.
// Session = its container + its dind container (dind-<container>). Everything else
// is summed into the rows "other containers", "Codex app-server" and "rest of host", so that
// the total matches the machine's used RAM.

import { dindName } from "./dind";
import type { DockerStat } from "./stats";

export interface ResourceSession {
  id: string; container: string; project: string; repo: string;
  status: "running" | "stopped"; name?: string | null;
}

export interface ResourceRow {
  id: string; label: string; project: string;
  cpuPct: number; memBytes: number;
  /** Part of memBytes held by the session's dind container. */
  dindMemBytes: number;
}

export interface HostMem { totalBytes: number; usedBytes: number }

export interface Resources {
  sessions: ResourceRow[];
  otherContainers: { count: number; cpuPct: number; memBytes: number };
  /** Memory of the codex-remote-control.service cgroup; null = service not running / unreadable. */
  codexMemBytes: number | null;
  /** Used host RAM not explained by any of the rows above (devd, dockerd, sshd, cache…). */
  hostOtherBytes: number;
  host: HostMem;
}

export function resourceBreakdown(
  sessions: ResourceSession[], stats: DockerStat[], host: HostMem, codexMemBytes: number | null,
): Resources {
  const byName = new Map(stats.map((s) => [s.container, s]));
  const claimed = new Set<string>();
  const rows: ResourceRow[] = [];
  for (const s of sessions) {
    if (s.status !== "running") continue;
    const main = byName.get(s.container);
    const dind = byName.get(dindName(s.container));
    claimed.add(s.container); claimed.add(dindName(s.container));
    rows.push({
      // Without a nickname, several slots of the same repo would have the same label — append the slot number.
      id: s.id, label: s.name || slotLabel(s.repo, s.container), project: s.project,
      cpuPct: (main?.cpuPct ?? 0) + (dind?.cpuPct ?? 0),
      memBytes: (main?.memBytes ?? 0) + (dind?.memBytes ?? 0),
      dindMemBytes: dind?.memBytes ?? 0,
    });
  }
  const other = stats.filter((s) => !claimed.has(s.container));
  const otherContainers = {
    count: other.length,
    cpuPct: other.reduce((a, s) => a + s.cpuPct, 0),
    memBytes: other.reduce((a, s) => a + s.memBytes, 0),
  };
  const explained = rows.reduce((a, r) => a + r.memBytes, 0) + otherContainers.memBytes + (codexMemBytes ?? 0);
  return {
    sessions: rows, otherContainers, codexMemBytes,
    hostOtherBytes: Math.max(0, host.usedBytes - explained),
    host,
  };
}

/** /proc/meminfo → used RAM as MemTotal − MemAvailable (same as `free`). */
export function parseMeminfo(text: string): HostMem {
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  const total = kb("MemTotal");
  return { totalBytes: total, usedBytes: Math.max(0, total - kb("MemAvailable")) };
}

function slotLabel(repo: string, container: string): string {
  const slot = container.match(/-\d+$/)?.[0] ?? "";
  return slot && !repo.endsWith(slot) ? repo + slot : repo;
}
