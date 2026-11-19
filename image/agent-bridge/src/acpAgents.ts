import type { Capabilities } from "./events.ts";

export type AcpAgentId = "grok" | "vibe" | "antigravity" | "opencode";

/** One ACP agent: how to start it and its quirks. Per-agent differences live here, never in branches on the id. */
export interface AcpAgentSpec {
  id: AcpAgentId | (string & {});
  argv: string[];
  /** Added to the agent's environment. */
  env?: Record<string, string>;
  /** clientInfo.name sent in `initialize`; devbox's own when omitted. */
  clientName?: string;
  /** JSON-RPC error codes of `session/prompt` that mean the agent is rate-limited. */
  rateLimitCodes?: number[];
  /** Session modes devbox keeps the agent in; a session reporting another mode is switched to `allowed[0]`. */
  modes?: { allowed: string[] };
  /** Applied over the capabilities the agent reports. */
  overrides?: Partial<Capabilities>;
}

// Quirks from the T3 Code reference (commit eebb6bcc), checked live in step 4 Task 3 (see each entry).
export const ACP_AGENTS: Record<AcpAgentId, AcpAgentSpec> = {
  // Full access: Grok approves its own tool calls. grok 1.0.13 (live): ACP v1, session/resume, no image prompts, models
  // in initialize `_meta.modelState`. Not offered in chat yet: no login in grok-home to record a turn with.
  grok: { id: "grok", argv: ["grok", "agent", "--always-approve", "stdio"] },
  // -31001 is Mistral Vibe's rate-limit code, outside ACP. mistral-vibe 3.1.3 (live): ACP v1, session/load only, image
  // prompts, model as a config option; sessions open in "accept-edits", devbox runs them in "auto-approve".
  vibe: { id: "vibe", argv: ["vibe-acp"], rateLimitCodes: [-31001], modes: { allowed: ["auto-approve"] } },
  // Releases before 1.5.1 offer non-Gemini models only to allowlisted editors such as Zed (1.5.9, live, lists the same
  // models under either name). In "default" it asks before acting and devbox allows every request. 1.5.9 (live): ACP
  // v1 shape with protocolVersion 1, session/resume, image prompts, model as a config option. Not offered in chat yet:
  // the account behind antigravity-home must be verified with Google first (403 "Verify your account to continue").
  // Before devd sets `acpLive` for it, the adapter must detect that state: agy answers it as an ordinary `end_turn`
  // message ("⚠ Verification Required"), so today such a turn would read as a completed run, not a failure.
  antigravity: { id: "antigravity", argv: ["agy", "acp"], clientName: "zed", modes: { allowed: ["default"] } },
  // Through ACP, not OpenCode's native HTTP server.
  opencode: { id: "opencode", argv: ["opencode", "acp"] },
};

export function isAcpAgent(v: unknown): v is AcpAgentId {
  return typeof v === "string" && Object.hasOwn(ACP_AGENTS, v);
}
