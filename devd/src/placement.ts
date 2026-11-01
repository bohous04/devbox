import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import type { InstaboxSettings } from "./config";
import { parseMeminfo } from "./resources";

export interface HostLoad { memUsedPct: number; load1: number; cores: number }

// parseMeminfo computes from MemAvailable (not MemFree): page cache would otherwise make every
// VPS a "full" server. Reads only /proc, no subprocess — may be called on every request.
export function readHostLoad(): HostLoad {
  let memUsedPct = 0;
  try {
    const m = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    if (m.totalBytes > 0) memUsedPct = (100 * m.usedBytes) / m.totalBytes;
  } catch { /* mac/dev: leave 0 */ }
  return { memUsedPct, load1: loadavg()[0] ?? 0, cores: cpus().length || 1 };
}

export function suggestPlacement(l: HostLoad, s: InstaboxSettings): { suggest: "vps" | "instabox"; reason: string | null } {
  if (l.memUsedPct > s.suggestRamPct) return { suggest: "instabox", reason: `RAM ${Math.round(l.memUsedPct)} %` };
  if (l.load1 > s.suggestLoadPerCore * l.cores) return { suggest: "instabox", reason: `load ${l.load1.toFixed(1)} on ${l.cores} cores` };
  return { suggest: "vps", reason: null };
}
