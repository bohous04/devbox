import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = join(import.meta.dir, "..", "..", "image", "seed-devd-hooks.sh");
type HookGroup = { hooks: { command: string; timeout?: number }[] };
type SettingsFile = { hooks: Record<string, HookGroup[]> } & Record<string, unknown>;

// The seed only checks that the emitter is executable; it does not call its content. The path must contain
// /opt/devd-hooks/, because that is how the seed recognizes ITS OWN entries.
function fakeHook(dir: string): string {
  const p = join(dir, "devd-hook.sh");
  writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

async function seed(dir: string): Promise<number> {
  const p = Bun.spawn(["bash", SEED], {
    env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir }, stdout: "ignore", stderr: "ignore",
  });
  return await p.exited;
}

const EVENTS = [
  "Notification", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
  "TaskCompleted", "TaskCreated", "TeammateIdle", "UserPromptSubmit",
];

test("empty state → settings.json with lifecycle events including waiting and resuming", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devdhooks-"));
  fakeHook(dir);
  expect(await seed(dir)).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as SettingsFile;
  expect(Object.keys(j.hooks).sort()).toEqual(EVENTS);
  expect(j.hooks.SubagentStart[0].hooks[0].command).toContain("subagent_start");
  expect(j.hooks.SubagentStop[0].hooks[0].command).toContain("subagent_stop");
  expect(j.hooks.TeammateIdle[0].hooks[0].command).toContain("teammate_idle");
  expect(j.hooks.TaskCreated[0].hooks[0].command).toContain("task_created");
  expect(j.hooks.TaskCompleted[0].hooks[0].command).toContain("task_completed");
  rmSync(dir, { recursive: true, force: true });
});

test("only Stop has timeout 300 (devd waits on it for the critic's verdict)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devdhooks-"));
  fakeHook(dir);
  await seed(dir);
  const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as SettingsFile;
  expect(j.hooks.Stop[0].hooks[0].timeout).toBe(300);
  expect(j.hooks.SubagentStop[0].hooks[0].timeout).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("re-run does not duplicate and does not touch foreign hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devdhooks-"));
  fakeHook(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-thing" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/start" }] }],
    },
  }));
  await seed(dir);
  await seed(dir);
  const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as SettingsFile;
  expect(j.hooks.Stop).toHaveLength(2);                       // foreign + one of ours, not two of ours
  expect(j.hooks.Stop[0].hooks[0].command).toBe("/usr/local/bin/my-thing");
  expect(j.hooks.SubagentStart).toHaveLength(1);
  expect(j.hooks.SessionStart[0].hooks[0].command).toBe("/usr/local/bin/start");
  rmSync(dir, { recursive: true, force: true });
});

// Regression test for the data loss from fix round 1: a MARK derived from dirname(HOOK) on the
// $HOME/devd-hook.sh fallback degenerates to "$HOME/" and deletes ANY foreign hook sitting directly
// in $HOME — the reviewer reproduced it on real data. The marker must be the path suffix
// (/devd-hook.sh), not a directory prefix.
test("a foreign hook directly in $HOME survives the seed (the marker is a path suffix, not a directory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devdhooks-"));
  fakeHook(dir);
  const foreignCommand = join(dir, "my-own-hook.sh");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: foreignCommand }] }],
    },
  }));
  await seed(dir);
  const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as SettingsFile;
  expect(j.hooks.Stop).toHaveLength(2);                       // foreign survived + ours added
  const commands = j.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  expect(commands).toContain(foreignCommand);
  rmSync(dir, { recursive: true, force: true });
});

// Backward compatibility: entries written by the OLD script version have a command with a hardcoded
// /opt/devd-hooks/devd-hook.sh (the /devd-hook.sh suffix is the same), so the first run after
// an upgrade must recognize them as its own and replace them, not duplicate them next to the new ones.
test("the old entry shape (/opt/devd-hooks/devd-hook.sh) is replaced after an upgrade, not duplicated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devdhooks-"));
  fakeHook(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [{
          type: "command",
          command: "[ -x /opt/devd-hooks/devd-hook.sh ] && /opt/devd-hooks/devd-hook.sh stop || true",
          timeout: 300,
        }],
      }],
    },
  }));
  await seed(dir);
  const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as SettingsFile;
  expect(j.hooks.Stop).toHaveLength(1);                       // old replaced by new, not added alongside
  expect(j.hooks.Stop[0].hooks[0].command).toContain("devd-hook.sh");
  rmSync(dir, { recursive: true, force: true });
});
