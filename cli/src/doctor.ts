import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh } from "./sh";
import type { ApiClient } from "./api";
import type { CliConfig } from "./config";

export interface Check { name: string; ok: boolean; hint?: string }

type Runner = (...cmd: string[]) => { code: number };
const defaultRun: Runner = (...cmd) => sh(process.cwd(), ...cmd);

/** Check that the mac sends metrics to devd. A pure function over the settings.json content
 *  so it can be tested without disk. Without this check the failure is silent — metrics
 *  stop arriving and nothing shows it. */
export function checkMacOtel(settings: unknown, devdUrl: string): Check {
  const name = "mac OTel metrics";
  const env = (settings as { env?: Record<string, string> } | null | undefined)?.env;
  if (!env) return { name, ok: false, hint: `missing "env" block in ~/.claude/settings.json — see docs/mac-stats.md` };
  if (env.OTEL_METRICS_EXPORTER !== "otlp" || env.CLAUDE_CODE_ENABLE_TELEMETRY !== "1") {
    return { name, ok: false, hint: "telemetry is not enabled — see docs/mac-stats.md" };
  }
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT !== devdUrl) {
    return { name, ok: false, hint: `OTEL_EXPORTER_OTLP_ENDPOINT is "${env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "—"}", should be ${devdUrl} — see docs/mac-stats.md` };
  }
  if (!/(^|,)devbox\.host=mac(,|$)/.test(env.OTEL_RESOURCE_ATTRIBUTES ?? "")) {
    return { name, ok: false, hint: "OTEL_RESOURCE_ATTRIBUTES is missing devbox.host=mac — see docs/mac-stats.md" };
  }
  return { name, ok: true };
}

function readClaudeSettings(): unknown {
  const p = join(homedir(), ".claude", "settings.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export async function runDoctor(cfg: CliConfig, api: ApiClient, run: Runner = defaultRun): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const h = await api.health();
    checks.push({ name: `devd (${cfg.devdUrl}) v${h.version}`, ok: h.ok });
  } catch (e) {
    checks.push({ name: `devd (${cfg.devdUrl})`, ok: false, hint: (e as Error).message });
  }
  if (cfg.sshHost) {
    checks.push({
      name: `ssh ${cfg.sshHost}`,
      ok: run("ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", cfg.sshHost, "true").code === 0,
      hint: "check Tailscale and `ssh " + cfg.sshHost + "` manually",
    });
    // The backup path is tested separately: when one route fails (public IP × tailnet),
    // the output shows right away that the server is alive and reconnect has a way through.
    if (cfg.sshHostAlt) {
      checks.push({
        name: `ssh ${cfg.sshHostAlt} (backup path)`,
        ok: run("ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", cfg.sshHostAlt, "true").code === 0,
        hint: "backup path is down — check Tailscale (`tailscale status`)",
      });
    }
    checks.push({ name: "tailscale", ok: run("tailscale", "status").code === 0, hint: "start the Tailscale app" });
    checks.push(checkMacOtel(readClaudeSettings(), cfg.devdUrl));
  } else {
    checks.push({ name: "docker (local mode)", ok: run("docker", "info").code === 0, hint: "start Docker Desktop" });
  }
  return checks.map((c) => (c.ok ? { name: c.name, ok: true } : c));
}
