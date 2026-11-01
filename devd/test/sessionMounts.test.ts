import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The bridge reads its registration from /opt/mac-mcp; without this mount the `xcode` MCP in the session
// does not start and the error only shows up in the agent, not in tests.
test("sessions mount /etc/devd/mac-mcp read-only at /opt/mac-mcp", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(src).toContain("/etc/devd/mac-mcp:/opt/mac-mcp:ro");
});
