import { expect, test } from "bun:test";
import type { Upstream } from "../src/agents";
import { DEFAULT_CONFIG, type Settings } from "../src/config";
import { localEnvProfiles } from "../src/localEnv";

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_CONFIG.settings, ...over });
const full = settings({ proxyModels: { gpt: "gpt-5.6-sol", grok: "grok-4.5", openrouter: "stealth/ox-alpha" } });
const keys = (u: Upstream) => (u === "openrouter" ? "or-key" : "cp-key");
const ctx = async () => 1_000_000;
const BASE = "http://100.100.100.100:4300/api/cliproxy";

test("cliproxy profile points at the devd passthrough and carries the key, model and window", async () => {
  const rows = await localEnvProfiles(full, keys, ctx, BASE);
  const gpt = rows.find((r) => r.profile === "claude-gpt")!;
  expect(gpt.ready).toBe(true);
  expect(gpt.env).toMatchObject({
    ANTHROPIC_BASE_URL: BASE,
    ANTHROPIC_AUTH_TOKEN: "cp-key",
    ANTHROPIC_MODEL: "gpt-5.6-sol",
    CLAUDE_CODE_SUBAGENT_MODEL: "gpt-5.6-sol",
    CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "3",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
  });
  // Effort is a property of GPT models — it is not forced on Grok (same as in agent-launch).
  const grok = rows.find((r) => r.profile === "claude-grok")!;
  expect(grok.env!.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined();
  expect(grok.env!.ANTHROPIC_MODEL).toBe("grok-4.5");
  // Grok forces tool search (xAI cap of 350 tools) — the full reasoning is at the same
  // condition in image/agent-launch.sh; this is just a mirror for `dev local`.
  expect(grok.env!.ENABLE_TOOL_SEARCH).toBe("true");
});

test("openrouter profile goes direct, remaps all slots + drops ANTHROPIC_API_KEY", async () => {
  const rows = await localEnvProfiles(full, keys, ctx, BASE);
  const or = rows.find((r) => r.profile === "claude-openrouter")!;
  expect(or.ready).toBe(true);
  expect(or.env).toMatchObject({
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: "or-key",
    ANTHROPIC_MODEL: "stealth/ox-alpha",
    ANTHROPIC_SMALL_FAST_MODEL: "stealth/ox-alpha",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "stealth/ox-alpha",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "stealth/ox-alpha",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "stealth/ox-alpha",
  });
  expect(or.unset).toContain("ANTHROPIC_API_KEY");
});

test("missing key or model → ready:false with a reason and NO env", async () => {
  const noKey = await localEnvProfiles(full, () => null, ctx, BASE);
  expect(noKey.find((r) => r.profile === "claude-gpt")).toMatchObject({ ready: false });
  expect(noKey.find((r) => r.profile === "claude-gpt")!.env).toBeUndefined();
  expect(noKey.find((r) => r.profile === "claude-gpt")!.reason).toContain("key");
  const noModel = await localEnvProfiles(settings(), keys, ctx, BASE);
  expect(noModel.find((r) => r.profile === "claude-openrouter")).toMatchObject({ ready: false });
  expect(noModel.find((r) => r.profile === "claude-openrouter")!.reason).toContain("model");
});

test("an unknown window simply omits the key", async () => {
  const rows = await localEnvProfiles(full, keys, async () => null, BASE);
  expect(rows.find((r) => r.profile === "claude-gpt")!.env!.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
});
