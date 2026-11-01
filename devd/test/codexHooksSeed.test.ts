import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = join(import.meta.dir, "..", "..", "image", "seed-codex-hooks.sh");

type HookGroup = { matcher?: string; hooks: { type?: string; command: string; timeout?: number }[] };
type HooksFile = { description?: string; hooks: Record<string, HookGroup[]> } & Record<string, unknown>;

// Fake emitter: the seed only checks that it is executable, it does not call its content.
function fakeHook(dir: string): string {
  const p = join(dir, "devd-hook.sh");
  writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

async function seed(env: Record<string, string>): Promise<number> {
  const p = Bun.spawn(["bash", SEED], { env: { ...process.env, WARP_HOOK: join(env.CODEX_HOME, "no-warp-emitter"), ...env }, stdout: "ignore", stderr: "ignore" });
  return await p.exited;
}

test("empty state → hooks.json with events under .hooks, pointing to devd-hook.sh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const hook = fakeHook(dir);
  expect(await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook })).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  expect(Object.keys(j.hooks).sort()).toEqual(["Interrupt", "PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]);
  expect(j.description).toBeTruthy();   // we set our own description because there was none
  expect(j.hooks.Stop[0].hooks[0].command).toContain("stop");
  expect(j.hooks.Stop[0].hooks[0].timeout).toBe(300);   // devd waits on Stop for the critic's verdict
  expect(j.hooks.UserPromptSubmit[0].hooks[0].command).toContain("user_prompt_submit");
  expect(j.hooks.PermissionRequest[0].hooks[0].command).toContain("permission_request");
  rmSync(dir, { recursive: true, force: true });
});

test("re-run does not duplicate and keeps foreign hooks inside .hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const hook = fakeHook(dir);
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-thing" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/start" }] }],
    },
  }));
  await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook });
  await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook });
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  const stopCmds = j.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  expect(stopCmds.filter((c) => c.includes("devd-hook.sh")).length).toBe(1);   // only one of ours
  expect(stopCmds.some((c) => c.includes("my-thing"))).toBe(true);             // the foreign one stayed
  expect(j.hooks.SessionStart[0].hooks[0].command).toContain("start");         // untouched (foreign event)
  rmSync(dir, { recursive: true, force: true });
});

test("two consecutive runs produce a byte-identical file (idempotence)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const hook = fakeHook(dir);
  await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook });
  const first = readFileSync(join(dir, "hooks.json"), "utf8");
  await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook });
  const second = readFileSync(join(dir, "hooks.json"), "utf8");
  expect(second).toBe(first);
  rmSync(dir, { recursive: true, force: true });
});

test("migration from the old (broken) top-level shape — no old keys remain after the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const hook = fakeHook(dir);
  // Old shape: events directly at top level (which Codex refused to parse).
  // Plus a foreign hook inside Stop that must survive the migration.
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({
    Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/foreign-stop" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/devd-hooks/devd-hook.sh user_prompt_submit" }] }],
    PermissionRequest: [{ hooks: [{ type: "command", command: "/opt/devd-hooks/devd-hook.sh permission_request" }] }],
  }));
  expect(await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook })).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  // no stale top-level keys
  expect(j.Stop).toBeUndefined();
  expect(j.UserPromptSubmit).toBeUndefined();
  expect(j.PermissionRequest).toBeUndefined();
  // correctly moved under .hooks, the foreign hook in the Stop array kept
  expect(Object.keys(j.hooks).sort()).toEqual(["Interrupt", "PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]);
  const stopCmds = j.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  expect(stopCmds.some((c) => c.includes("foreign-stop"))).toBe(true);
  expect(stopCmds.filter((c) => c.includes("devd-hook.sh")).length).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("foreign top-level keys (description and any other) are kept, our description is not forced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const hook = fakeHook(dir);
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({
    description: "foreign description, do not touch",
    myCustomKey: "keep-me",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-thing" }] }],
    },
  }));
  expect(await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: hook })).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  expect(j.description).toBe("foreign description, do not touch");
  expect(j.myCustomKey).toBe("keep-me");
  rmSync(dir, { recursive: true, force: true });
});

const warpEvents: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "prompt_submit",
  PermissionRequest: "permission_request",
  PostToolUse: "tool_complete",
  PreToolUse: "pre_tool_use",
  Stop: "stop",
  Interrupt: "stop",
  SessionEnd: "stop",
};

// Codex writes OSC 777 to the tty itself; besides that devd has its own three events.
function fakeWarp(dir: string): string {
  const p = join(dir, "warp-hook.sh");
  writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

test("Warp registers Codex's whole lifecycle and keeps devd lifecycle hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const env = { CODEX_HOME: dir, HOME: dir, DEVD_HOOK: fakeHook(dir), WARP_HOOK: fakeWarp(dir) };
  expect(await seed(env)).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  const cmds = (ev: string) => j.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
  expect(Object.keys(j.hooks).sort()).toEqual(Object.keys(warpEvents).sort());
  for (const [event, action] of Object.entries(warpEvents)) {
    const warp = cmds(event).filter((c) => c.includes("warp-hook.sh"));
    expect(warp).toHaveLength(1);
    expect(warp[0]).toContain(`--tty ${action}`);
    expect(warp[0]).toContain("&& DEVD_WARP_AGENT=codex ");
    expect(warp[0]).toContain("[ -x ");
    expect(warp[0]).toContain("|| true");
    const devd = cmds(event).filter((c) => c.includes("devd-hook.sh"));
    expect(devd).toHaveLength(["Stop", "UserPromptSubmit", "PermissionRequest", "PreToolUse", "PostToolUse", "Interrupt", "SessionEnd"].includes(event) ? 1 : 0);
    for (const command of devd) expect(command).not.toContain("DEVD_WARP_AGENT");
  }
  expect(j.hooks.Stop.find((group) => group.hooks.some((hook) => hook.command.includes("devd-hook.sh")))?.hooks[0].timeout).toBe(300);
  rmSync(dir, { recursive: true, force: true });
});

test("migration replaces old Warp hooks in all events and keeps foreign commands even in a shared group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const env = { CODEX_HOME: dir, HOME: dir, DEVD_HOOK: fakeHook(dir), WARP_HOOK: fakeWarp(dir) };
  const foreignGroup = (event: string) => ({ matcher: "keep-matcher", hooks: [
    { type: "command", command: `/usr/local/bin/foreign-${event}` },
    { type: "command", command: `/old/warp-hook.sh --tty old-${event}` },
  ] });
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({
    hooks: Object.fromEntries(Object.keys(warpEvents).map((event) => [event, [foreignGroup(event)]])),
    Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/legacy-stop" }] }],
  }));
  expect(await seed(env)).toBe(0);
  const first = readFileSync(join(dir, "hooks.json"), "utf8");
  const j = JSON.parse(first) as HooksFile;
  expect(j.Stop).toBeUndefined();
  for (const event of Object.keys(warpEvents)) {
    const commands = j.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toContain(`/usr/local/bin/foreign-${event}`);
    expect(j.hooks[event][0]).toEqual({ matcher: "keep-matcher", hooks: [
      { type: "command", command: `/usr/local/bin/foreign-${event}` },
    ] });
    expect(commands.filter((command) => command.includes("warp-hook.sh"))).toHaveLength(1);
    expect(commands.some((command) => command.includes("/old/"))).toBe(false);
  }
  expect(j.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command))).toContain("/usr/local/bin/legacy-stop");
  expect(await seed(env)).toBe(0);
  expect(readFileSync(join(dir, "hooks.json"), "utf8")).toBe(first);
  rmSync(dir, { recursive: true, force: true });
});

test("without a Warp emitter its old hooks are cleaned up across the lifecycle, foreign and devd ones stay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const env = { CODEX_HOME: dir, HOME: dir, DEVD_HOOK: fakeHook(dir), WARP_HOOK: join(dir, "missing.sh") };
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({
    hooks: Object.fromEntries(Object.keys(warpEvents).map((event) => [event, [{ hooks: [
      { type: "command", command: `/old/warp-hook.sh --tty ${event}` },
      { type: "command", command: `/usr/local/bin/foreign-${event}` },
    ] }]])),
  }));
  expect(await seed(env)).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  for (const event of Object.keys(warpEvents)) {
    const commands = j.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toContain(`/usr/local/bin/foreign-${event}`);
    expect(commands.some((command) => command.includes("warp-hook.sh"))).toBe(false);
  }
  expect(j.hooks.Stop.some((group) => group.hooks.some((hook) => hook.command.includes("devd-hook.sh")))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("re-run with a warp emitter does not duplicate warp entries (byte idempotence)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const env = { CODEX_HOME: dir, HOME: dir, DEVD_HOOK: fakeHook(dir), WARP_HOOK: fakeWarp(dir) };
  await seed(env);
  const first = readFileSync(join(dir, "hooks.json"), "utf8");
  await seed(env);
  const second = readFileSync(join(dir, "hooks.json"), "utf8");
  expect(second).toBe(first);
  rmSync(dir, { recursive: true, force: true });
});

test("without a warp emitter warp entries are not seeded, devd ones are (old image)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  const env = { CODEX_HOME: dir, HOME: dir, DEVD_HOOK: fakeHook(dir), WARP_HOOK: join(dir, "neexistuje.sh") };
  expect(await seed(env)).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as HooksFile;
  const stopCmds = j.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  expect(stopCmds.some((c) => c.includes("devd-hook.sh"))).toBe(true);
  expect(stopCmds.some((c) => c.includes("--tty"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("missing emitter → no-op, exit 0 (an old image must not break startup)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhooks-"));
  expect(await seed({ CODEX_HOME: dir, HOME: dir, DEVD_HOOK: join(dir, "neexistuje.sh") })).toBe(0);
  expect(() => readFileSync(join(dir, "hooks.json"), "utf8")).toThrow();
  rmSync(dir, { recursive: true, force: true });
});
