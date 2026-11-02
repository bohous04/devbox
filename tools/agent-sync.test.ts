import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent-sync works without a Claude catalog and still syncs MCP; invalid JSON is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-default-"));
  try {
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n', { mode: 0o755 });
    const secrets = join(dir, "secrets.json");
    writeFileSync(secrets, JSON.stringify({ mcpServers: { sample: { command: "sample-mcp" } } }));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: join(dir, "calls"),
      DEVD_CONFIG_DIR: dir, DEVD_SECRETS: secrets, DEVD_AGENT_SECRETS: join(dir, "missing-bridge"),
      DEVD_MCP_LOCAL: join(dir, "missing-local"), DEVD_GH_CONFIG_DIR: join(dir, "missing-gh") };
    const run = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "agent-sync.ts")], { env });
    const ok = run();
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("No claude-setup.json defined");
    expect(Bun.file(join(dir, "calls")).size).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toContain("sample-mcp");
    writeFileSync(join(dir, "claude-setup.json"), "{broken");
    expect(run().exitCode).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
