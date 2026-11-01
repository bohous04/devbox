import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SEED = join(import.meta.dir, "..", "..", "image", "seed-warp-hooks.sh");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(settings: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "claude-warp-"));
  homes.push(home);
  const config = join(home, ".claude");
  const settingsPath = join(config, "settings.json");
  mkdirSync(config);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  const hook = join(home, "warp-hook.sh");
  writeFileSync(hook, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(hook, 0o755);

  return {
    home, config, hook, settingsPath,
    async seed() {
      const process = Bun.spawn(["bash", SEED], {
        env: { ...Bun.env, HOME: home, CLAUDE_CONFIG_DIR: config, WARP_HOOK: hook },
        stdout: "pipe", stderr: "pipe",
      });
      const error = await new Response(process.stderr).text();
      expect(await process.exited).toBe(0);
      expect(error).toBe("");
      return JSON.parse(readFileSync(settingsPath, "utf8"));
    },
  };
}

test("Claude seed registers waiting and recovery events with the isolated emitter", async () => {
  const f = fixture();
  const settings = await f.seed();
  const actions = {
    SessionStart: "session_start",
    UserPromptSubmit: "prompt_submit",
    PermissionRequest: "permission_request",
    PreToolUse: "pre_tool_use",
    PostToolUse: "tool_complete",
    PostToolUseFailure: "tool_complete",
    Stop: "stop",
    StopFailure: "stop_failure",
    Notification: "notification",
  };
  expect(Object.keys(settings.hooks).sort()).toEqual(Object.keys(actions).sort());
  for (const [event, action] of Object.entries(actions)) {
    const command = settings.hooks[event][0].hooks[0].command;
    expect(command).toContain(`${f.hook} ${action} || true`);
    expect(command).toContain("# devd-warp-hook");
  }
  expect(settings.hooks.SessionStart[0].matcher).toBe("startup|resume");
  expect(settings.hooks.Notification[0].matcher).toBe("idle_prompt");
});

test("Claude seed removes only its stale command from a group shared with foreign hooks", async () => {
  const foreign = { type: "command", command: "node /home/dev/notify.js", timeout: 8 };
  const native = { type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/scripts/warp-hook.sh" stop' };
  const mixed = {
    matcher: "custom-matcher",
    hooks: [
      foreign,
      { type: "command", command: "/opt/warp-hooks/warp-hook.sh stop" },
      native,
    ],
  };
  const untouched = [{ hooks: [{ type: "command", command: "echo compacted" }] }];
  const f = fixture({ hooks: { Stop: [mixed], PreCompact: untouched }, theme: "dark" });
  const settings = await f.seed();

  expect(settings.hooks.Stop).toHaveLength(2);
  expect(settings.hooks.Stop[0]).toEqual({ matcher: mixed.matcher, hooks: [foreign, native] });
  expect(settings.hooks.Stop[1].hooks[0].command).toContain(`${f.hook} stop`);
  expect(settings.hooks.PreCompact).toEqual(untouched);
  expect(settings.theme).toBe("dark");
});

test("Claude seed stays byte-identical on rerun with a custom emitter and foreign hooks", async () => {
  const f = fixture({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] } });
  await f.seed();
  const first = readFileSync(f.settingsPath, "utf8");
  await f.seed();
  expect(readFileSync(f.settingsPath, "utf8")).toBe(first);
});

test("Claude seed preserves native Warp plugin configuration and enabledPlugins settings", async () => {
  const enabledPlugins = { "warp@claude-code-warp": true, "another@marketplace": false };
  const f = fixture({ enabledPlugins });
  const nativeHooksPath = join(f.config, "plugins", "cache", "claude-code-warp", "warp", "1.0.0", "hooks", "hooks.json");
  const nativeConfig = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/scripts/warp-hook.sh" stop' }] }],
    },
  }, null, 2) + "\n";
  mkdirSync(dirname(nativeHooksPath), { recursive: true });
  writeFileSync(nativeHooksPath, nativeConfig);

  const settings = await f.seed();
  expect(settings.enabledPlugins).toEqual(enabledPlugins);
  expect(readFileSync(nativeHooksPath, "utf8")).toBe(nativeConfig);
});
