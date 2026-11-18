// The environment of a proxy profile (Claude Code against a third-party upstream), translated from the DEVD_*
// inputs devd assembles in `proxyEnv` (devd/src/sessions.ts). A mirror of the proxy branch of
// image/agent-launch.sh, guarded by devd/test/chatSwitch.test.ts against `agent-launch.sh --print-env`.
// Used by the chat bridge at launch (serve.ts) and by devd for a live switch (chatSwitch.ts), so both paths
// produce the same env.

export const PROXY_PROFILES = ["claude-gpt", "claude-grok", "claude-gemini", "claude-openrouter"] as const;
export type ProxyProfile = (typeof PROXY_PROFILES)[number];

export function isProxyProfile(v: unknown): v is ProxyProfile {
  return typeof v === "string" && (PROXY_PROFILES as readonly string[]).includes(v);
}

/** Every key `proxyProfileEnv` can emit. A harness that is not opened on a proxy profile must not inherit any of
 *  them (nor ANTHROPIC_API_KEY, see `INHERITED_STRIP`). */
export const PROXY_PROFILE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "ENABLE_TOOL_SEARCH", "DEVBOX_PROXY_PROFILE",
] as const;

/** Removed from the launch env before any harness env is overlaid: the profile keys (a switch away from a proxy
 *  profile must not keep its upstream) and ANTHROPIC_API_KEY, which Claude Code prefers over both the bearer token
 *  of a proxy profile and the subscription login (agent-launch.sh unsets it for OpenRouter for the same reason). */
export const INHERITED_STRIP: readonly string[] = [...PROXY_PROFILE_ENV_KEYS, "ANTHROPIC_API_KEY"];

/** Throws when the key or the model is missing: agent-launch.sh refuses to start the profile then, because Claude Code
 *  would only fail on its first request with a 401. The upstream URL is required too: devd always sends it. */
export function proxyProfileEnv(profile: ProxyProfile, inputs: Record<string, string | undefined>): Record<string, string> {
  // UPSTREAM_* are the canonical names; CLIPROXY_* the old ones devd still sends alongside (agent-launch.sh reads both).
  const url = inputs.DEVD_UPSTREAM_URL || inputs.DEVD_CLIPROXY_URL;
  const key = inputs.DEVD_UPSTREAM_KEY || inputs.DEVD_CLIPROXY_KEY;
  const model = inputs.DEVD_AGENT_MODEL;
  if (!key) throw new Error(`profile ${profile} has no upstream key`);
  if (!model) throw new Error(`profile ${profile} has no model set`);
  if (!url) throw new Error(`profile ${profile} has no upstream URL`);
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "3",
    // xAI rejects more than 350 tools; the reasoning is at the same condition in agent-launch.sh.
    ENABLE_TOOL_SEARCH: profile === "claude-grok" ? "true" : "false",
    DEVBOX_PROXY_PROFILE: "1",
  };
  if (inputs.DEVD_AGENT_CTX) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = inputs.DEVD_AGENT_CTX;
  if (profile === "claude-openrouter") {
    for (const k of ["ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
      env[k] = model;
    }
  }
  if (profile === "claude-gpt") env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1";
  return env;
}
