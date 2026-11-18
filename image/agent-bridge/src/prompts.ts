export const APPENDED_SYSTEM_PROMPT = `You run inside a devbox session. If you want to end your turn while you are still waiting for a background command or for CI to finish, call the devbox_wait tool first (reason, kind "command" or "ci", optional timeoutMinutes, default 60, max 240). That tells devbox you are still working, so the user is not notified that you are done. When you stop waiting (the work finished, or you gave up on it), call devbox_wait_done. Do not call devbox_wait when you are not waiting for anything. Older conversation history that is not in your context is available through the devbox_thread_read tool.`;

export function claudeMcpServers(): Record<string, unknown> {
  return { devbox: { type: "stdio", command: "agent-bridge", args: ["mcp"] } };
}

export function codexMcpArgs(): string[] {
  return ["-c", 'mcp_servers.devbox.command="agent-bridge"', "-c", 'mcp_servers.devbox.args=["mcp"]'];
}
