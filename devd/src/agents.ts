// Profile = what is offered to the user as an "agent". It is not just a binary: two profiles
// launch Claude Code, but with a foreign model via CLIProxyAPI.
//
// THIS IS THE SINGLE SOURCE OF TRUTH. Nowhere else in the repo may a comparison
// against a specific value (`agent === "codex"`) appear — ask about a PROPERTY. Previously
// `=== "codex"` was used to mean "does not run on an Anthropic account", which after proxy
// profiles were added would silently lie and claude-grok would take a lease from a pool it does not use.
export type AgentRuntime = "claude" | "codex" | "grok" | "agy";

/** Where to go for a foreign model. This is NOT the same as `modelKey`: that says WHICH model,
 *  this says WHERE to go for it — a different base URL, a different key, a different reason it does not run.
 *  `cliproxy` holds OAuth to subscriptions (paid from them, not from API credit),
 *  `openrouter` is an API key and goes direct, without an intermediary on the host. */
export type Upstream = "cliproxy" | "openrouter";

export interface AgentSpec {
  /** Which binary is launched (see RUNTIME_BIN). Also the process name in `ps`. */
  runtime: AgentRuntime;
  /** Label for the picker and the dashboard. In English — the devbox UI is English since 2026-07-26. */
  label: string;
  /** Short name for notifications ("Claude finished"). Deliberately a different field from
   *  `label`: notifications have their established text and tests on it. */
  short: string;
  /** Runs with approvals disabled (the container itself is the sandbox). Only for the picker label. */
  yolo: boolean;
  /** Runs on an Anthropic OAuth account → account pool, --remote-control, `dev switch`. */
  anthropicAccount: boolean;
  /** Key into settings.proxyModels. Presence means "runs via the proxy". */
  modelKey?: string;
  /** Where the model comes from. Required exactly where `modelKey` is (guarded by agents.test.ts).
   *  Without it the URL and key would be hard-wired from CLIProxyAPI and the OpenRouter profile would
   *  get a key OpenRouter does not know — i.e. a 401 only inside cc. */
  upstream?: Upstream;
}

const AGENTS_TABLE = {
  claude:        { runtime: "claude", label: "Claude Code",        short: "Claude",      yolo: true, anthropicAccount: true },
  "claude-gpt":  { runtime: "claude", label: "Claude Code + GPT",  short: "Claude+GPT",  yolo: true, anthropicAccount: false, modelKey: "gpt", upstream: "cliproxy" },
  "claude-grok": { runtime: "claude", label: "Claude Code + Grok", short: "Claude+Grok", yolo: true, anthropicAccount: false, modelKey: "grok", upstream: "cliproxy" },
  "claude-gemini": { runtime: "claude", label: "Claude Code + Gemini", short: "Claude+Gemini", yolo: true, anthropicAccount: false, modelKey: "gemini", upstream: "cliproxy" },
  "claude-openrouter": { runtime: "claude", label: "Claude Code + OpenRouter", short: "Claude+OR", yolo: true, anthropicAccount: false, modelKey: "openrouter", upstream: "openrouter" },
  codex:         { runtime: "codex",  label: "Codex",              short: "Codex",       yolo: true, anthropicAccount: false },
  grok:          { runtime: "grok",   label: "Grok Build",         short: "Grok",        yolo: true, anthropicAccount: false },
  antigravity:   { runtime: "agy",    label: "Antigravity",        short: "Antigravity", yolo: true, anthropicAccount: false },
} as const satisfies Record<string, AgentSpec>;

export type AgentName = keyof typeof AGENTS_TABLE;

// Widened to Record<AgentName, AgentSpec> (not typeof AGENTS_TABLE): the generic access
// AGENTS[a] with a: AgentName would otherwise be typed as a union of five exact literals,
// where `modelKey` does not exist at all on three of them (not just `undefined`) — TS would then
// reject AGENTS[a].modelKey everywhere a specific key is not accessed directly.
export const AGENTS: Record<AgentName, AgentSpec> = AGENTS_TABLE;

/** The order is the UI order: default first, then proxy variants, then standalone CLIs. */
export const AGENT_IDS = Object.keys(AGENTS) as AgentName[];

export const RUNTIME_BIN: Record<AgentRuntime, string> = { claude: "cc", codex: "co", grok: "gr", agy: "ag" };

/** Names of agent processes in `ps` (= runtime). The single derivation for the watchdog
 *  (AGENT_PROCS) and the agent swap — two local copies would drift when a runtime is added. */
export const AGENT_RUNTIMES = [...new Set(Object.values(AGENTS).map((a) => a.runtime))].sort() as AgentRuntime[];

/** Runtimes that can exit with the `/exit` slash command (the others are terminated by kill). */
export const SLASH_EXIT_RUNTIMES: ReadonlySet<AgentRuntime> = new Set(["claude"]);

/** A conversation survives a profile swap only within THE SAME runtime, and only when that
 *  runtime supports `--resume <id>`. The single source of truth for devd (the actual behaviour of
 *  agentSwitch) and the CLI (the warning "the conversation will not carry over") — two independent
 *  rules would drift invisibly: the user would simply lose a conversation
 *  the text promised to keep. */
const RESUMABLE_RUNTIMES: ReadonlySet<AgentRuntime> = new Set(["claude"]);
export function conversationCarries(from: AgentRuntime, to: AgentRuntime): boolean {
  return from === to && RESUMABLE_RUNTIMES.has(to);
}

export function isAgentName(v: unknown): v is AgentName {
  return typeof v === "string" && Object.hasOwn(AGENTS, v);
}

/** Normalizing text to a profile: an unknown value (an old DB row, a foreign tmux option)
 *  = claude — the same decision as specFor/agent-launch.sh, just at the NAME level.
 *  Exists so that `isAgentName(x) ? x : "claude"` is not written across callers. */
export function agentNameFor(v: string | null | undefined): AgentName {
  return isAgentName(v) ? v : "claude";
}

/** Profile for a value that IS just text. `agent` is a plain column in the DB and also comes
 *  from the API, so the `AgentName` type is a promise, not a guarantee: `AGENTS[s.agent ?? "claude"]`
 *  returns `undefined` for an unknown value and reading `.anthropicAccount` on it crashes the
 *  request (500 in devd, a blank page in the dashboard). Yet the original `=== "codex"`
 *  this replaced was total and just returned false — so the refactor
 *  added a crash where there was none before.
 *
 *  The fallback to `claude` is the same choice agent-launch.sh makes: an unknown profile
 *  never crashes a session. Also accepts null/undefined, so callers do not repeat
 *  `?? "claude"` — which was incidentally falsely reassuring on its own, because it did not
 *  catch an unknown STRING. */
export function specFor(agent: string | null | undefined): AgentSpec {
  return isAgentName(agent) ? AGENTS[agent] : AGENTS.claude;
}

export function usesProxy(a: AgentName): boolean {
  return specFor(a).modelKey !== undefined;
}

/** Why the agent must not run on an InstaBox (null = it may). Proxy profiles run via
 *  CLIProxyAPI/an upstream key on the VPS (unreachable from the VM, keys must not go into the VM); Antigravity
 *  depends on VPS-only login and the harvester (M10). Applies to create and to a live swap (I4). */
export function instaboxAgentBlock(a: AgentName): string | null {
  if (usesProxy(a)) return `Agent ${a} is not supported on InstaBox (proxy agents run only on the VPS)`;
  if (a === "antigravity") return `Agent ${a} is not supported on InstaBox (Antigravity runs only on the VPS)`;
  return null;
}
