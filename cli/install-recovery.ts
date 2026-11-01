#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export function installWarpRecovery(home: string, repoRoot: string, bunPath: string): string[] {
  const cli = join(repoRoot, "cli", "src", "main.ts");
  const hookSource = readFileSync(join(repoRoot, "infra", "devbox-warp-resume.zsh"), "utf8");
  if (!existsSync(cli)) throw new Error("CLI source is missing");
  const hook = join(home, ".config", "devbox-cli", "warp-resume.zsh");
  const zshrc = join(home, ".zshrc");
  const previousZshrc = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
  const changed: string[] = [];
  const stamp = `${Date.now()}-${process.pid}`;
  const backup = (path: string) => {
    try { lstatSync(path); } catch { return; }
    const saved = `${path}.before-warp-recovery-${stamp}`;
    renameSync(path, saved);
    changed.push(`Backup: ${saved}`);
  };
  const content = `DEVBOX_RECOVERY_BUN=${quote(bunPath)}\nDEVBOX_RECOVERY_CLI=${quote(cli)}\n${hookSource}`;
  mkdirSync(dirname(hook), { recursive: true });
  if (!existsSync(hook) || readFileSync(hook, "utf8") !== content) {
    backup(hook);
    writeFileSync(hook, content, { mode: 0o600 });
    changed.push(`Shell hook: ${hook}`);
  }
  // Both paths have existed on this Mac; PATH must not select an older checkout.
  for (const bin of [join(home, ".bun", "bin", "dev"), join(home, ".local", "bin", "dev")]) {
    mkdirSync(dirname(bin), { recursive: true });
    try { if (readlinkSync(bin) === cli) continue; } catch {}
    backup(bin);
    symlinkSync(cli, bin);
    changed.push(`CLI: ${bin} -> ${cli}`);
  }
  const sourceLine = `source ${quote(hook)} # devbox-warp-recovery`;
  const lines = previousZshrc.split("\n");
  const updated = lines.some((l) => l.endsWith("# devbox-warp-recovery"))
    ? lines.map((l) => l.endsWith("# devbox-warp-recovery") ? sourceLine : l).join("\n")
    : `${previousZshrc}${previousZshrc.endsWith("\n") || !previousZshrc ? "" : "\n"}\n${sourceLine}\n`;
  if (updated !== previousZshrc) {
    // Keep the rc file's inode/permissions (and existing symlink) intact.
    if (existsSync(zshrc)) writeFileSync(`${zshrc}.before-warp-recovery-${stamp}`, previousZshrc, { mode: 0o600 });
    writeFileSync(zshrc, updated, { mode: 0o600 });
    changed.push(`Startup: ${zshrc}`);
  }
  return changed;
}

if (import.meta.main) {
  if (process.platform !== "darwin") throw new Error("Warp recovery installation requires macOS");
  for (const line of installWarpRecovery(homedir(), resolve(import.meta.dir, ".."), process.execPath)) console.log(line);
  console.log("Installed for new/restored shells. Before updating Warp: dev recover --snapshot");
}
