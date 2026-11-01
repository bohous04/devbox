#!/usr/bin/env bun
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultClipreadBin, defaultNotifierBin } from "./src/actions";

export function renderPlist(template: string, bunPath: string, repoRoot: string): string {
  return template.replaceAll("__BUN__", bunPath).replaceAll("__REPO__", repoRoot);
}

// Build + authorize the custom-icon notifier app. Non-fatal: if swiftc is missing
// or the build fails, the listener still notifies via its osascript fallback.
// macOS 26 auto-grants notification permission only when the binary is exec'd
// DIRECTLY (this spawn), never via `open`/LaunchServices — so this is exactly right.
export function installNotifier(repoRoot: string): void {
  try {
    const icon = join(repoRoot, "listener", "devbox-icon.png");
    const build = Bun.spawnSync(["bash", join(repoRoot, "listener", "notifier", "build.sh"), icon],
      { stdout: "inherit", stderr: "inherit" });
    if (build.exitCode !== 0) {
      console.log("Could not build the notifier app (Xcode CLT missing?) — notifications will go through osascript.");
      return;
    }
    const bin = defaultNotifierBin();
    if (Bun.spawnSync([bin, "--status"]).exitCode !== 0) {
      Bun.spawnSync([bin, "--hello"], { stdout: "inherit", stderr: "inherit" });
    }
    console.log("Notifier app: installed and authorized (notifications with the devbox icon).");
  } catch {
    console.log("Notifier app step skipped — notifications will go through osascript.");
  }
}

// Builds the native clipread helper (fast clipboard reads). Non-fatal: without swiftc /
// Xcode CLT the listener reads the clipboard via osascript (works, just slower).
export function installClipread(repoRoot: string): void {
  try {
    const bin = defaultClipreadBin();
    mkdirSync(dirname(bin), { recursive: true });
    const r = Bun.spawnSync(["swiftc", "-O", join(repoRoot, "listener", "clipread.swift"), "-o", bin],
      { stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) {
      console.log("Could not build the clipread helper (Xcode CLT missing?) — the clipboard will go through osascript (slower).");
      return;
    }
    console.log("clipread helper: built (fast native clipboard reads).");
  } catch {
    console.log("clipread step skipped — clipboard through osascript.");
  }
}

// Copies SendToDevbox.workflow into ~/Library/Services (Finder Quick Action:
// "Send to devbox" puts the selected files on the clipboard, the session-aware ⌘V then
// stages them into the container). Non-fatal: a missing/uncopyable bundle must not
// bring down the rest of the installation — enabling it in System Settings → Extensions is
// a manual user step anyway.
export function installQuickAction(home: string, installDir: string): void {
  try {
    const dst = join(home, "Library", "Services", "SendToDevbox.workflow");
    mkdirSync(join(home, "Library", "Services"), { recursive: true });
    cpSync(join(installDir, "SendToDevbox.workflow"), dst, { recursive: true });
    console.log("Finder Quick Action „Send to devbox“: installed (enable it in System Settings → Extensions → Finder).");
  } catch {
    console.log("Finder Quick Action step skipped — you can still fill the clipboard by hand (Finder ⌘C).");
  }
}

if (import.meta.main) {
  const bunPath = Bun.which("bun");
  if (!bunPath) { console.error("bun is not in PATH"); process.exit(1); }
  const repoRoot = resolve(import.meta.dir, "..");
  const laDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(laDir, { recursive: true });
  const names = ["cz.devbox.listener.plist", "cz.devbox.smbmount.plist"];
  for (const name of names) {
    const tpl = readFileSync(join(import.meta.dir, "install", name), "utf8");
    writeFileSync(join(laDir, name), renderPlist(tpl, bunPath, repoRoot));
    console.log(`Written: ${join(laDir, name)}`);
  }
  installNotifier(repoRoot);
  installClipread(repoRoot);
  installQuickAction(homedir(), join(repoRoot, "listener", "install"));
  for (const name of names) {
    const dest = join(laDir, name);
    console.log("Load:      launchctl unload " + dest + " 2>/dev/null; launchctl load " + dest);
  }
  console.log("Don't forget: ~/.config/devbox-listener/config.json with the token (see listener/README.md)");
  console.log("Don't forget: the SMB password in the Keychain (see docs/mac.md, section 4)");
}
