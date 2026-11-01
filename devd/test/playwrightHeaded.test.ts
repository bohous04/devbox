import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSetupFromMacState, buildSyncCommands } from "../src/claudeSetup";
import { run } from "../src/proc";

const IMAGE = join(import.meta.dir, "..", "..", "image");
const WRAPPER = join(IMAGE, "playwright-mcp-devbox");

test("Dockerfile copies playwright-mcp-devbox and makes it executable", () => {
  const df = readFileSync(join(IMAGE, "Dockerfile"), "utf8");
  expect(df).toContain("COPY playwright-mcp-devbox /usr/local/bin/playwright-mcp-devbox");
  expect(df.split("\n").some((l) => l.startsWith("RUN chmod 755") && l.includes("/usr/local/bin/playwright-mcp-devbox"))).toBe(true);
});

async function argsWith(env: Record<string, string>): Promise<string> {
  const bin = mkdtempSync(join(tmpdir(), "pw-bin-"));
  writeFileSync(join(bin, "playwright-mcp"), "#!/bin/sh\necho \"$*\"\n");
  chmodSync(join(bin, "playwright-mcp"), 0o755);
  const r = await run(["sh", WRAPPER, "--browser", "chromium"], { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, unsetEnv: ["DEVBOX_HEADED", "DISPLAY"].filter((k) => !(k in env)), timeoutMs: 5000 });
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

test("wrapper: headless without DEVBOX_HEADED, headed with it and with DISPLAY", async () => {
  expect(await argsWith({})).toBe("--headless --browser chromium");
  expect(await argsWith({ DEVBOX_HEADED: "1" })).toBe("--headless --browser chromium"); // without DISPLAY, prefer headless
  expect(await argsWith({ DEVBOX_HEADED: "1", DISPLAY: ":1" })).toBe("--browser chromium");
});

// Fix round 1: the registered `command`/`args` (sh -c with a fallback) must, on an old image
// without the wrapper in PATH, fall back to `playwright-mcp --headless`, not fail. This runs
// EXACTLY what claude/codex would spawn: ["sh", ...def.args] with the binary name
// simulated by a fake $PATH instead of the real `playwright-mcp-devbox`/`playwright-mcp`.
function registeredPlaywrightCommand(): { command: string; args: string[] } {
  const s = buildSetupFromMacState(undefined, undefined);
  const json = buildSyncCommands(s).find((c) => c[5] === "playwright")?.[6] ?? "";
  return JSON.parse(json) as { command: string; args: string[] };
}

async function runRegisteredCommand(bin: string): Promise<string> {
  const { command, args } = registeredPlaywrightCommand();
  const r = await run([command, ...args], { env: { PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 5000 });
  expect(r.code).toBe(0);
  return r.stdout.trim();
}

test("registered command: wrapper on PATH → calls playwright-mcp-devbox", async () => {
  const bin = mkdtempSync(join(tmpdir(), "pw-reg-"));
  writeFileSync(join(bin, "playwright-mcp-devbox"), "#!/bin/sh\necho \"devbox:$*\"\n");
  chmodSync(join(bin, "playwright-mcp-devbox"), 0o755);
  expect(await runRegisteredCommand(bin)).toBe("devbox:--browser chromium --no-sandbox");
});

test("registered command: wrapper MISSING from PATH (old image) → falls back to playwright-mcp --headless", async () => {
  const bin = mkdtempSync(join(tmpdir(), "pw-reg-"));
  writeFileSync(join(bin, "playwright-mcp"), "#!/bin/sh\necho \"plain:$*\"\n");
  chmodSync(join(bin, "playwright-mcp"), 0o755);
  expect(await runRegisteredCommand(bin)).toBe("plain:--headless --browser chromium --no-sandbox");
});
