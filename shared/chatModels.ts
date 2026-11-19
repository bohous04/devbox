/** The models a chat session can be switched to, per harness. devd refuses any other model (chatSwitch.ts, 400
 *  `unknown-model`); the dashboard's model menu offers exactly these. ACP agents list the ids their session offers
 *  (live, step 4 Task 3): Grok's `session/set_model` ids, Vibe's and Antigravity's model config option values. */
export const CHAT_MODELS = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
  grok: ["grok-4.6", "grok-4.5"],
  vibe: ["mistral-large-4-0", "mistral-medium-3.5"],
  antigravity: ["gemini-4-neon"],
} as const satisfies Record<"claude" | "codex" | "grok" | "vibe" | "antigravity", readonly string[]>;
