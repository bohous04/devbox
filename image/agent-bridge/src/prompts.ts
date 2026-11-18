export const APPENDED_SYSTEM_PROMPT = `You run inside a devbox session. If you want to end your turn while you are still waiting for a background command or for CI to finish, call the devbox_wait tool first (reason, kind "command" or "ci", optional timeoutMinutes, default 60, max 240). That tells devbox you are still working, so the user is not notified that you are done. When you stop waiting (the work finished, or you gave up on it), call devbox_wait_done. Do not call devbox_wait when you are not waiting for anything. Older conversation history that is not in your context is available through the devbox_thread_read tool.`;

/** Codex starts stdio MCP servers with a filtered environment, so the devd variables the devbox MCP server needs
 *  are forwarded explicitly. A variable that is not set is left out (the tool then reports it as missing). */
const MCP_ENV_NAMES = ["DEVD_URL", "DEVD_SESSION_ID", "DEVD_AGENT_SOCK"] as const;
const presentMcpEnv = (): string[] => MCP_ENV_NAMES.filter((n) => process.env[n]);

export function claudeMcpServers(): Record<string, unknown> {
  const env = Object.fromEntries(presentMcpEnv().map((n) => [n, process.env[n]!]));
  return { devbox: { type: "stdio", command: "agent-bridge", args: ["mcp"], env } };
}

export function codexMcpArgs(): string[] {
  return [
    "-c", 'mcp_servers.devbox.command="agent-bridge"',
    "-c", 'mcp_servers.devbox.args=["mcp"]',
    "-c", `mcp_servers.devbox.env_vars=${JSON.stringify(presentMcpEnv())}`,
  ];
}
