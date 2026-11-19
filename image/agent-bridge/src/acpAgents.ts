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

// Quirks from the T3 Code reference (commit eebb6bcc); Task 3 verifies each agent live.
export const ACP_AGENTS: Record<AcpAgentId, AcpAgentSpec> = {
  // Full access: Grok approves its own tool calls.
  grok: { id: "grok", argv: ["grok", "agent", "--always-approve", "stdio"] },
  // -31001 is Mistral Vibe's rate-limit code, outside ACP.
  vibe: { id: "vibe", argv: ["vibe-acp"], rateLimitCodes: [-31001] },
  // Releases before 1.5.1 offer non-Gemini models only to allowlisted editors such as Zed. The agy CLI rejects the
  // "yolo" and "auto_edit" modes; in "default" it asks before acting and devbox allows every request.
  antigravity: { id: "antigravity", argv: ["agy", "acp"], clientName: "zed", modes: { allowed: ["default"] } },
  // Through ACP, not OpenCode's native HTTP server.
  opencode: { id: "opencode", argv: ["opencode", "acp"] },
};

export function isAcpAgent(v: unknown): v is AcpAgentId {
  return typeof v === "string" && Object.hasOwn(ACP_AGENTS, v);
}
