import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// sshHostAlt = a SECOND network path to the same server (ssh alias pointing at the tailnet address).
// The public IP and the tailnet are independent routes: on 2026-07-25 the mac's IPv4 path to the VPS was down for
// ~4 minutes while Tailscale between the same machines kept going over IPv6 → reconnect kept
// dialing the dead public IP in vain. When alt is set, retries alternate between the paths.
export interface CliConfig { devdUrl: string; sshHost?: string; sshHostAlt?: string }

const DEFAULT_PATH = join(homedir(), ".config", "devbox-cli", "config.json");

export function loadCliConfig(
  env: Record<string, string | undefined> = process.env,
  filePath: string = DEFAULT_PATH,
): CliConfig {
  let file: Partial<CliConfig> = {};
  if (existsSync(filePath)) file = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CliConfig>;
  const cfg: CliConfig = { devdUrl: env.DEV_DEVD_URL || file.devdUrl || "http://127.0.0.1:4300" };
  const sshHost = env.DEV_SSH_HOST || file.sshHost;
  if (sshHost) cfg.sshHost = sshHost;
  const sshHostAlt = env.DEV_SSH_HOST_ALT || file.sshHostAlt;
  if (sshHostAlt) cfg.sshHostAlt = sshHostAlt;
  return cfg;
}
