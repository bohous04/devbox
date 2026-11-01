import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Mapping { from: string; to: string }
export interface ListenerConfig { token: string; host: string; port: number; mappings: Mapping[]; dashboardUrl?: string }
export class ListenerConfigError extends Error {}

const DEFAULT_PATH = join(homedir(), ".config", "devbox-listener", "config.json");
const DEFAULT_MAPPINGS: Mapping[] = [{ from: "/srv/dev", to: "/Volumes/dev" }];

export function loadListenerConfig(
  env: Record<string, string | undefined> = process.env,
  filePath: string = DEFAULT_PATH,
): ListenerConfig {
  let file: Partial<ListenerConfig> = {};
  if (existsSync(filePath)) {
    try { file = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ListenerConfig>; }
    catch { throw new ListenerConfigError(`Corrupt config: ${filePath}`); }
  }
  const token = env.DEVBOX_LISTENER_TOKEN || file.token;
  if (!token) throw new ListenerConfigError("Missing token — set DEVBOX_LISTENER_TOKEN or token in the config (fail closed).");
  const port = Number(env.DEVBOX_LISTENER_PORT || file.port || 7777);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ListenerConfigError(`Invalid port: ${env.DEVBOX_LISTENER_PORT || file.port}`);
  }
  return {
    token,
    host: env.DEVBOX_LISTENER_HOST || file.host || "127.0.0.1",
    port,
    mappings: Array.isArray(file.mappings) ? file.mappings : DEFAULT_MAPPINGS,
    dashboardUrl: env.DEVBOX_DASHBOARD_URL || file.dashboardUrl || undefined,
  };
}
