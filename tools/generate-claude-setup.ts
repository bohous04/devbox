#!/usr/bin/env bun
// Generates claude-setup.json (→ vps-dev-config repo) and claude-mcp-secrets.json
// (→ merge into /etc/devd/secrets.json on the VPS; NEVER commit) from this Mac's state.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSetupFromMacState } from "../devd/src/claudeSetup";
import { saveJson } from "../devd/src/config";

const claudeDir = process.env.CLAUDE_DIR ?? join(homedir(), ".claude");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as unknown;
const readIf = (p: string) => (existsSync(p) ? read(p) : undefined);

const setup = buildSetupFromMacState(
  readIf(join(claudeDir, "plugins", "known_marketplaces.json")),
  readIf(join(claudeDir, "plugins", "installed_plugins.json")),
);
const setupOut = process.argv[2] ?? "claude-setup.json";
saveJson(setupOut, setup);
console.log(`wrote ${setupOut}: ${setup.marketplaces.length} marketplaces, ${setup.plugins.length} plugins`);

const claudeJson = process.env.CLAUDE_JSON ?? join(homedir(), ".claude.json");
if (existsSync(claudeJson)) {
  const mcp = ((read(claudeJson) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  delete mcp["claude-in-chrome"]; // mac-only: needs local Chrome, never provision on the VPS
  const mcpOut = process.argv[3] ?? "claude-mcp-secrets.json";
  saveJson(mcpOut, { mcpServers: mcp });
  chmodSync(mcpOut, 0o600);
  console.log(`wrote ${mcpOut}: ${Object.keys(mcp).length} MCP servers — contains tokens, NEVER commit; merge into /etc/devd/secrets.json`);
}
