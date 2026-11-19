/** The models a chat session can be switched to, per harness. devd refuses any other model (chatSwitch.ts, 400
 *  `unknown-model`); the dashboard's model menu offers exactly these. */
export const CHAT_MODELS = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
} as const satisfies Record<"claude" | "codex", readonly string[]>;
