import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeMcpServers, readMcpServers } from "../src/config";

const tmp = () => join(mkdtempSync(join(tmpdir(), "mcp-")), "agent-secrets.json");

test("writes MCP servers and reads them back", () => {
  const path = tmp();
  materializeMcpServers(path, { serena: { command: "uvx", args: ["serena"] } });
  expect(readMcpServers(path)).toEqual({ serena: { command: "uvx", args: ["serena"] } });
});

// The file carries tokens for MCP servers (HTTP headers), so it must not be readable by
// everyone on the host — same requirement as the gitea tokens next to it.
test("the file is created with mode 0600, not with the default umask", () => {
  const path = tmp();
  materializeMcpServers(path, { api: { url: "https://x", headers: { Authorization: "Bearer t" } } });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

// A missing file is a normal state (nobody has unlocked devd's vault yet), not an error —
// agent-sync then simply has nothing to propagate and must not crash because of it.
test("a missing or corrupted file returns empty, not an exception", () => {
  expect(readMcpServers(join(tmpdir(), "mcp-nonexistent", "x.json"))).toEqual({});
  const broken = tmp();
  writeFileSync(broken, "{this is not JSON");
  expect(readMcpServers(broken)).toEqual({});
});

// Regression against how the gitea tokens broke: overwriting an existing file with an empty
// map (devd started with a locked vault) would rob agent-sync of servers it
// already had. An empty write must therefore be ignored, not performed.
test("an empty map does NOT OVERWRITE an existing file", () => {
  const path = tmp();
  materializeMcpServers(path, { serena: { command: "uvx" } });
  materializeMcpServers(path, {});
  expect(readMcpServers(path)).toEqual({ serena: { command: "uvx" } });
  // On disk too, not just via our own reader — agent-sync reads the file as well.
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toHaveProperty("serena");
});
