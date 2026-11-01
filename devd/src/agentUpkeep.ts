import { listSessions } from "./db";
import { isNewer, parseProcTree, PS_TREE_CMD, type UpkeepDeps } from "./ccUpkeep";
import type { AgentUpkeepResult, AgentUpkeepStatus, UpkeepProvider } from "../../shared/agentUpkeep";

type LaunchProvider = Exclude<UpkeepProvider, "claude">;
export function parseAgentVersion(raw: string): string | null {
  return raw.trim().match(/^(?:(?:codex-cli|grok)\s+)?(\d+\.\d+\.\d+)(?=\s|$)/)?.[1] ?? null;
}
export function isRuntimeProcess(comm: string, provider: LaunchProvider): boolean {
  if (provider === "codex") return comm === "codex";
  if (provider === "agy") return comm === "agy";
  return /^(?:grok|grok-native|grok-pager|grok-\d[\w.-]*|xai-grok-pager)$/.test(comm);
}
const good = (r: Awaited<ReturnType<UpkeepDeps["exec"]>>) => r.code === 0 && !r.timedOut;
const AGY_MANIFEST = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const LATEST_CMD: Record<LaunchProvider, string[]> = {
  codex: ["npm", "view", "@openai/codex@latest", "version", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=8000"],
  grok: ["curl", "-fsSL", "--connect-timeout", "3", "--max-time", "8", "https://x.ai/cli/stable"],
  // The same manifest the installer in image/Dockerfile takes the version from.
  agy: ["sh", "-c", `a=$(uname -m); case $a in x86_64) a=amd64;; aarch64) a=arm64;; esac; curl -fsSL --connect-timeout 3 --max-time 8 ${AGY_MANIFEST}/linux_$a.json | jq -r .version`],
};
async function latestVersion(d: UpkeepDeps, provider: LaunchProvider): Promise<string | null> {
  try {
    const cmd = LATEST_CMD[provider];
    const r = await d.host(["docker", "run", "--rm", d.image, ...cmd], 20_000);
    return good(r) ? parseAgentVersion(r.stdout) : null;
  } catch { return null; }
}
export async function launchAgentStatus(d: UpkeepDeps, provider: LaunchProvider): Promise<AgentUpkeepStatus> {
  const rows = listSessions(d.db).filter((s) => s.status === "running");
  const [latest, image, sessions] = await Promise.all([
    latestVersion(d, provider),
    (async () => { try { const r = await d.host(["docker", "run", "--rm", d.image, provider, "--version"], 15_000); return good(r) ? parseAgentVersion(r.stdout) : null; } catch { return null; } })(),
    Promise.all(rows.map(async (s) => {
      const base = { id:s.id, project:s.project, repo:s.repo };
      try {
        const [version, ps, age] = await Promise.all([
          d.exec(s.container,[provider,"--version"],15_000),
          d.exec(s.container,PS_TREE_CMD,15_000),
          // The existing updater swaps this symlink atomically; it retains old bundles.
          d.exec(s.container,["sh","-c",`stamp=$(stat -c %Y /usr/local/bin/${provider}) || exit 1; echo $(( $(date +%s) - stamp ))`],15_000),
        ]);
        const parsed = good(ps) && ps.stdout.trim() ? parseProcTree(ps.stdout) : [];
        const tree = parsed.length ? parsed : null;
        const processes = tree?.filter((p) => isRuntimeProcess(p.comm, provider));
        const seconds = good(age) && /^\d+$/.test(age.stdout.trim()) ? Number(age.stdout.trim()) : null;
        return { ...base, version:good(version) ? parseAgentVersion(version.stdout) : null, running:processes?.length ?? null, restartRequired:processes && seconds !== null ? processes.some((p) => p.etimes > seconds) : null };
      } catch { return {...base,version:null,running:null,restartRequired:null}; }
    })),
  ]);
  return {provider,latest,image,mode:"on-launch",sessions};
}

/** Reuses the bounded, staged updater already used by co/gr launchers. No auth,
 * account, tmux, resume, image-build or running-process mutations are introduced. */
export async function updateLaunchAgent(d: UpkeepDeps, provider: LaunchProvider, only?: string[]): Promise<AgentUpkeepResult> {
  const result: AgentUpkeepResult = {provider,updated:[],restarted:[],deferred:[],failed:[],unchanged:[],built:false};
  // agy is root-owned in /opt/agy (phase 1a): an update = a new image build, not an intervention in
  // running containers. The upkeep shows the state (version, restart), it will not change anything.
  if (provider === "agy") return {...result, error: "Antigravity is updated by rebuilding the devbox image; running sessions were not changed."};
  const latest = await latestVersion(d, provider);
  if (!latest) return {...result,error:"Latest stable version is unavailable; nothing was changed."};
  for (const s of listSessions(d.db).filter((s) => s.status === "running" && (!only || only.includes(s.id)))) {
    try {
      const before = await d.exec(s.container,[provider,"--version"],15_000);
      const installed = good(before) ? parseAgentVersion(before.stdout) : null;
      if (!installed) { result.failed.push(s.id); continue; }
      if (!isNewer(latest,installed)) { result.unchanged.push(s.id); continue; }
      if (d.turnInProgress(s.id)) { result.deferred.push(s.id); continue; }
      const update = await d.exec(s.container,["/usr/local/bin/agent-auto-update",provider],50_000);
      if (!good(update)) { result.failed.push(s.id); continue; }
      const after = await d.exec(s.container,[provider,"--version"],15_000);
      const version = good(after) ? parseAgentVersion(after.stdout) : null;
      if (!version) result.failed.push(s.id);
      else if (isNewer(version,installed)) result.updated.push(s.id);
      // Helper intentionally retains its per-container lock and one-hour cooldown.
      else result.deferred.push(s.id);
    } catch { result.failed.push(s.id); }
  }
  return result;
}
