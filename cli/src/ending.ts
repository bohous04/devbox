import { execFileSync } from "node:child_process";
import type { SessionInfo } from "./api";

// Compatibility with devd versions predating the live `ending` flag. Read only
// active prepare-end names; never start/stop an operation to discover its state.
export function endingFromHost(sshHost: string): Set<string> {
  try {
    const command = `ps -eo args= | awk '$1 ~ /python/ && $2 == "/usr/local/bin/devbox-storage" && $3 == "prepare-end" {print $4}'`;
    const output = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "--", sshHost, command],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(output.split(/\s+/).filter(id => /^dev-[A-Za-z0-9_.-]+$/.test(id)));
  } catch { return new Set(); }
}

export function markEnding(rows: SessionInfo[], active: Set<string>): SessionInfo[] {
  return rows.map(row => row.ending !== undefined ? row : { ...row, ending: active.has(row.id) });
}
