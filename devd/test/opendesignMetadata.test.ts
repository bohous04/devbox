import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexSyncCommands, buildSetupFromMacState, buildSyncCommands, codexMcpCommands, codexMetadataCommand, describeCommand, isSecretBearingCommand } from "../src/claudeSetup";

test("stdio Codex metadata survives provisioning separately from explicit env, without altering other config", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-mcp-metadata-"));
  try {
    const name = "open-design";
    const cmds = codexMcpCommands(name, {
      command: "/home/dev/.codex/integrations/open-design/mcp",
      env: { STATIC: "dummy-secret" },
      env_vars: ["DEVD_SESSION_ID", "PATH"], startup_timeout_sec: 90,
      tool_timeout_sec: 600.5, enabled: false,
    })!;
    expect(cmds[1]).toContain("STATIC=dummy-secret");
    expect(cmds[1]).not.toContain("DEVD_SESSION_ID");
    expect(cmds).toHaveLength(3);
    expect(isSecretBearingCommand(cmds[2])).toBe(true);
    expect(describeCommand(cmds[2])).not.toContain("dummy-secret");
    const initial = 'model = "preserved"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.open-design]\ncommand = "bridge"\nargs = []\n\n[mcp_servers.open-design.env]\nSTATIC = "dummy-secret"\n';
    writeFileSync(join(dir, "config.toml"), initial, { mode: 0o600 });
    const result = Bun.spawnSync(cmds[2], { env: { ...process.env, CODEX_HOME: dir } });
    expect(result.exitCode).toBe(0);
    expect(statSync(join(dir, "config.toml")).mode & 0o777).toBe(0o600);
    const config = Bun.TOML.parse(readFileSync(join(dir, "config.toml"), "utf8")) as any;
    expect(config.model).toBe("preserved");
    expect(config.mcp_servers.other).toEqual({ command: "other" });
    expect(config.mcp_servers[name]).toEqual({
      command: "bridge", args: [], env: { STATIC: "dummy-secret" },
      env_vars: ["DEVD_SESSION_ID", "PATH"], startup_timeout_sec: 90,
      tool_timeout_sec: 600.5, enabled: false,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("metadata command handles quoted server names and repeated updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-mcp-quoted-"));
  try {
    const name = "odd.name'$(false)";
    const configPath = join(dir, "config.toml");
    const command = codexMcpCommands(name, { command: "bridge", env_vars: [], enabled: true })![2];
    writeFileSync(configPath, `[mcp_servers.${JSON.stringify(name)}]\ncommand = "bridge"`);
    expect(Bun.spawnSync(command, { env: { ...process.env, CODEX_HOME: dir } }).exitCode).toBe(0);
    const updated = readFileSync(configPath, "utf8");
    const parsed = Bun.TOML.parse(updated) as any;
    expect(parsed.mcp_servers[name]).toEqual({ command: "bridge", env_vars: [], enabled: true });
    expect(Bun.spawnSync(command, { env: { ...process.env, CODEX_HOME: dir } }).exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(updated);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared metadata command updates Grok defaults while preserving excluded env_vars and other tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-mcp-metadata-"));
  try {
    const source = 'model = "preserved"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.open-design]\ncommand = "bridge"\nargs = [\n  "--label",\n  "enabled = true",\n]\nenabled = true\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n\n[mcp_servers.open-design.env]\nSTATIC = "dummy-secret"\nenabled = "keep-subtable-value"\n';
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, source, { mode: 0o600 });
    const command = codexMetadataCommand("open-design", ["startup_timeout_sec = 150", "tool_timeout_sec = 600", "enabled = false"], "grok");
    const result = Bun.spawnSync(command, { env: { ...process.env, GROK_HOME: dir, CODEX_HOME: join(dir, "wrong-home") } });
    expect(result.exitCode).toBe(0);
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as any;
    expect(config.model).toBe("preserved");
    expect(config.mcp_servers.other).toEqual({ command: "other" });
    expect(config.mcp_servers["open-design"]).toEqual({
      command: "bridge", args: ["--label", "enabled = true"],
      startup_timeout_sec: 150, tool_timeout_sec: 600, enabled: false,
      env: { STATIC: "dummy-secret", enabled: "keep-subtable-value" },
    });
    expect(config.mcp_servers["open-design"].env_vars).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("metadata replacement consumes complete multiline env_vars assignments", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-mcp-multiline-"));
  try {
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, '[mcp_servers.open-design]\ncommand = "bridge"\nenv_vars = [\n  "OLD",\n  "PATH",\n]\n# Keep this comment\n[mcp_servers.open-design.env]\nSTATIC = "preserved"\n');
    const command = codexMcpCommands("open-design", { command: "bridge", env_vars: ["DEVD_SESSION_ID"] })![2];
    expect(Bun.spawnSync(command, { env: { ...process.env, CODEX_HOME: dir } }).exitCode).toBe(0);
    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain("# Keep this comment");
    const config = Bun.TOML.parse(updated) as any;
    expect(config.mcp_servers["open-design"]).toEqual({ command: "bridge", env_vars: ["DEVD_SESSION_ID"], env: { STATIC: "preserved" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid Codex metadata rejects the definition before any remove/add commands", () => {
  for (const metadata of [
    { env_vars: "PATH" }, { env_vars: ["VALID", 1] }, { env_vars: ["SECRET=value"] },
    { env_vars: ["BAD\nNAME"] }, { startup_timeout_sec: 0 }, { startup_timeout_sec: "90" },
    { tool_timeout_sec: -1 }, { tool_timeout_sec: Infinity }, { enabled: "false" }, { enabled: null },
  ]) expect(codexMcpCommands("open-design", { command: "bridge", ...metadata })).toBeNull();
  const { cmds, skipped } = buildCodexSyncCommands({ marketplaces: [], plugins: [] }, {
    "open-design": { command: "bridge", env_vars: ["BAD=VALUE"] },
  });
  expect(skipped).toContain("open-design");
  expect(cmds.some(c => c.includes("open-design"))).toBe(false);
});

test("Claude registration strips Codex-only metadata and preserves explicit env without mutating the definition", () => {
  const def = {
    command: "bridge", args: [], env: { STATIC: "dummy-secret" },
    env_vars: ["DEVD_SESSION_ID"], startup_timeout_sec: 90, tool_timeout_sec: 600, enabled: true,
  };
  const cmd = buildSyncCommands({ marketplaces: [], plugins: [] }, { "open-design": def })
    .find(c => c[5] === "open-design")!;
  expect(JSON.parse(cmd[6])).toEqual({ command: "bridge", args: [], env: { STATIC: "dummy-secret" } });
  expect(def.env_vars).toEqual(["DEVD_SESSION_ID"]);
});
