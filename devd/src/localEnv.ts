// Env maps for `dev local` — running a proxy profile (claude-gpt/grok/openrouter)
// directly on the Mac. TS mirror of the proxy branch of agent-launch.sh: there the env is assembled for
// the container, here devd hands it out ready-made via GET /api/local-env and the local CLI just
// passes it to the `claude` process. Cliproxy is not reachable from the tailnet (it binds only to
// 127.0.0.1 + docker bridge — its key covers three paid subscriptions), so
// cliproxy profiles point at the devd passthrough /api/cliproxy (see api.ts).
import { AGENT_IDS, AGENTS, type AgentName, type Upstream } from "./agents";
import type { Settings } from "./config";
import { DEFAULT_OPENROUTER_URL } from "./sessions";

export interface LocalEnvProfile {
  profile: AgentName;
  label: string;
  ready: boolean;
  /** Why the profile cannot be offered (missing key/model). Only when ready:false. */
  reason?: string;
  env?: Record<string, string>;
  /** Names the CLI must REMOVE from the inherited environment (see agent-launch:
   *  an inherited ANTHROPIC_API_KEY would silently override the bearer token in cc). */
  unset?: string[];
}

export async function localEnvProfiles(
  settings: Settings,
  key: (u: Upstream) => string | null,
  ctx: (agent: AgentName) => Promise<number | null>,
  cliproxyBase: string,
): Promise<LocalEnvProfile[]> {
  const rows: LocalEnvProfile[] = [];
  for (const id of AGENT_IDS) {
    const spec = AGENTS[id];
    if (!spec.modelKey || !spec.upstream) continue;
    const model = settings.proxyModels?.[spec.modelKey] ?? "";
    let apiKey: string | null = null;
    try { apiKey = key(spec.upstream); } catch { apiKey = null; }
    if (!apiKey) { rows.push({ profile: id, label: spec.label, ready: false, reason: "missing upstream key" }); continue; }
    if (!model) { rows.push({ profile: id, label: spec.label, ready: false, reason: "no model set" }); continue; }
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: spec.upstream === "openrouter" ? DEFAULT_OPENROUTER_URL : cliproxyBase,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "3",
      // Grok forces tool search: xAI rejects requests with more than 350 tools,
      // deferred loading is verified live — the full reasoning is at the same condition
      // in image/agent-launch.sh (both places change TOGETHER).
      ENABLE_TOOL_SEARCH: id === "claude-grok" ? "true" : "false",
    };
    const window = await ctx(id);
    if (window !== null) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
    // Effort is a property of GPT models, it is not forced on Grok — same as in agent-launch.
    if (id === "claude-gpt") env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1";
    if (spec.upstream === "openrouter") {
      // A subagent may ask for "Sonnet"/"Opus"/"Haiku" by name — without remapping
      // all slots it would request a model that does not exist on OpenRouter (404), or silently
      // escape to the paid Anthropic API.
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      rows.push({ profile: id, label: spec.label, ready: true, env, unset: ["ANTHROPIC_API_KEY"] });
      continue;
    }
    rows.push({ profile: id, label: spec.label, ready: true, env });
  }
  return rows;
}
