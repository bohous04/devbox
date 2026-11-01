import { expect, test } from "bun:test";
import { alreadyConfigured, isSecretBearingCommand } from "../src/claudeSetup";

// Verbatim messages, measured on live CLIs (claude 2.1.237, grok 1.0.5, codex).
// All three return a NONZERO code, so without this detection a second sync run
// reported 21 "failures" and exited nonzero.
test('detects already-configured for all three CLIs', () => {
  expect(alreadyConfigured("MCP server testsrv already exists in user config")).toBe(true);
  expect(alreadyConfigured("Error: Marketplace source already configured: https://github.com/x/y.git")).toBe(true);
  expect(alreadyConfigured("plugin already installed")).toBe(true);
});

// This is the dangerous side: if the pattern matched too much, it would turn a broken
// sync into a silent success — worse than today's noise, because nobody would look for anything.
test('a real failure does NOT pass as already-configured', () => {
  expect(alreadyConfigured("error: unrecognized subcommand 'add'")).toBe(false);
  expect(alreadyConfigured("Error: connection refused")).toBe(false);
  expect(alreadyConfigured("permission denied")).toBe(false);
  expect(alreadyConfigured("could not resolve host github.com")).toBe(false);
  expect(alreadyConfigured("")).toBe(false);
  // "exists" without "already" is common in other errors — it must not be enough.
  expect(alreadyConfigured("path exists but is not a directory")).toBe(false);
});

// Blanket redaction of `add-json` was costly: when sync failed, the log had only
// "<redacted>" and the cause could only be found by running the command by hand.
test("add-json is redacted by CONTENT, not by subcommand name", () => {
  const plain = ["claude", "mcp", "add-json", "--scope", "user", "playwright",
    '{"command":"playwright-mcp","args":["--headless"]}'];
  expect(isSecretBearingCommand(plain)).toBe(false);

  const withHeaders = ["claude", "mcp", "add-json", "--scope", "user", "api",
    '{"type":"http","url":"https://x","headers":{"Authorization":"Bearer t"}}'];
  expect(isSecretBearingCommand(withHeaders)).toBe(true);

  const withEnv = ["claude", "mcp", "add-json", "--scope", "user", "docs",
    '{"command":"node","env":{"INFRA_DOCS_TOKEN":"t"}}'];
  expect(isSecretBearingCommand(withEnv)).toBe(true);
});

// Other paths to secrets must not be loosened by the narrowing.
test("flag paths and bash -lc are still redacted unchanged", () => {
  expect(isSecretBearingCommand(["grok", "mcp", "add", "x", "-H", "Authorization: Bearer t"])).toBe(true);
  expect(isSecretBearingCommand(["codex", "mcp", "add", "x", "--env", "K=v", "--", "node"])).toBe(true);
  expect(isSecretBearingCommand(["bash", "-lc", "printf '…' >> config.toml"])).toBe(true);
  expect(isSecretBearingCommand(["claude", "plugin", "marketplace", "add", "org/repo"])).toBe(false);
});
