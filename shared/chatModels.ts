/** The models a chat session can be switched to, per harness. devd refuses any other model (chatSwitch.ts, 400
 *  `unknown-model`); the dashboard's model menu offers exactly these. ACP agents list the ids their session offers
 *  (live, step 4 Task 3): Grok's from initialize `_meta.modelState` (switching them with `session/set_model` is not
 *  verified live: the probe had no Grok login), Vibe's and Antigravity's model config option values. */
export const CHAT_MODELS = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
  grok: ["grok-4.6", "grok-4.5"],
  vibe: ["mistral-large-4-0", "mistral-medium-3.5"],
  antigravity: ["gemini-4-neon"],
} as const satisfies Record<"claude" | "codex" | "grok" | "vibe" | "antigravity", readonly string[]>;

/** Reported ids that run exactly one of the offered models (not an effort or snapshot of it): the dashboard's model
 *  menu marks that model current. */
export const SAME_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Vibe's session/load reports Medium 3.5 under this id (live, step 4 Task 3).
  "mistral-medium-latest": "mistral-medium-3.5",
};

const efforts = (base: string): Record<string, string> => Object.fromEntries(["low", "medium", "high"].map((l) => [`${base}-${l}`, base]));
/** Model ids a harness reports (thread.native, run.started) that differ from the base model they run: effort
 *  variants (`claude-opus-5-5-high`), dated snapshots and official aliases. devd's window table (chatSwitch.ts
 *  MODEL_WINDOW_ALIASES) and the dashboard's model menu both read the base model from here; an id that is neither
 *  here nor a base model is unknown. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  ...efforts("claude-opus-5-5"), ...efforts("claude-sonnet-5-5"),
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5.5-2026-04-23": "gpt-5.5",
  "gpt-5.4-mini-2026-03-17": "gpt-5.4-mini",
  ...SAME_MODEL_ALIASES,
};
