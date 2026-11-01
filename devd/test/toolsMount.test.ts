import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Install-specific MCP servers and helpers live outside the image: devd mounts DEVD_TOOLS_DIR
// read-only into every session, only when the directory exists.
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("sessions get DEVD_TOOLS_DIR read-only at /opt/devbox-tools when it exists", () => {
  expect(index).toContain('env("DEVD_TOOLS_DIR", "/opt/devbox-tools")');
  expect(index).toContain("...(existsSync(toolsDir) ? [`${toolsDir}:/opt/devbox-tools:ro`] : [])");
});
