import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = join(import.meta.dir, "..", "..", "image", "seed-grok-hooks.sh");

// MIND the path: grok NEVER reads `~/.grok/hooks.json` and stays silent about it even under --debug.
// Reality (measured in Task 7 on grok 1.0.5): it scans the DIRECTORY `~/.grok/hooks/`.
const HOOKS = (home: string) => join(home, ".grok", "hooks", "devd.json");
const WARP = (home: string) => join(home, ".grok", "hooks", "warp.json");

// A fake emitter (same convention as codexHooksSeed.test.ts): the seed only checks that it
// is executable, it does not call the content. `/bin/true` is NOT portable — it does not exist on macOS (only
// /usr/bin/true), so `bun run ci` on the mac fails with it outside anything this test
// actually verifies. An own executable file is portable across mac/Linux CI.
function fakeExec(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}
const fakeHook = (dir: string) => fakeExec(dir, "devd-hook.sh");

async function seed(home: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["bash", SEED], {
    env: {
      ...process.env, HOME: home, GROK_HOME: join(home, ".grok"),
      DEVD_HOOK: fakeHook(home), WARP_HOOK: fakeExec(home, "warp-hook.sh"), ...env,
    },
    stdout: "ignore", stderr: "ignore",
  });
  await p.exited;
  return await Bun.file(HOOKS(home)).text();
}

// The same run, but with stderr and the exit code read — for the path where no file
// gets created.
async function seedRaw(home: string, grokHome: string): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(["bash", SEED], {
    env: { ...process.env, HOME: home, GROK_HOME: grokHome, DEVD_HOOK: fakeHook(home) },
    stdout: "ignore", stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  return { code: (await p.exited) ?? 1, err };
}

test("a repeated seed gives a byte-identical result (idempotence)", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  const first = JSON.parse(await seed(home));
  const second = JSON.parse(await seed(home));
  expect(second).toEqual(first);
});

test("events are NESTED under the hooks key — grok silently drops the flat shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  const cfg = JSON.parse(await seed(home));
  expect(cfg.hooks).toBeDefined();
  expect(cfg.hooks.Stop).toBeDefined();
  expect(cfg.Stop).toBeUndefined();   // a top-level event = silent death of the hooks
});

// An unwritable grok-home is a REAL state, not theory: until the image created
// /home/dev/.grok, docker made a root:root directory for the new volume and uid 1000 was not
// allowed in. The seed ran into it, `mkdir … || exit 0` swallowed it and the Grok session silently ran
// without devd hooks. It must not be fatal (the session must come up), but it must not be
// invisible either.
// Warp status: a second own file warp.json in the same directory (grok scans the whole
// directory, so the files do not clash). It calls warp-hook.sh in --tty mode — Grok has no
// measured terminalSequence contract, the hook writes OSC 777 to the pane's tty itself.
test("warp.json writes the Grok identity and the whole verified lifecycle via warp-hook --tty", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  await seed(home);
  const cfg = JSON.parse(await Bun.file(WARP(home)).text());
  expect(cfg.hooks).toBeDefined();
  expect(cfg.Stop).toBeUndefined();     // flat shape = silent death of the hooks
  const cmd = (ev: string) => cfg.hooks[ev][0].hooks[0].command as string;
  const events = {
    SessionStart: "session_start",
    UserPromptSubmit: "prompt_submit",
    PermissionRequest: "permission_request",
    PreToolUse: "pre_tool_use",
    PostToolUse: "tool_complete",
    PostToolUseFailure: "tool_complete",
    Stop: "stop",
    StopFailure: "stop_failure",
    StopCancelled: "stop",
    SessionEnd: "stop",
  };
  expect(Object.keys(cfg.hooks).sort()).toEqual([...Object.keys(events), "Notification"].sort());
  for (const [event, action] of Object.entries(events)) {
    expect(cmd(event)).toContain("DEVD_WARP_AGENT=grok ");
    expect(cmd(event)).toContain(`--tty ${action}`);
    // guard: on an older image without /opt/warp-hooks the hook must not fail
    expect(cmd(event)).toContain("[ -x ");
    expect(cmd(event)).toContain("|| true");
  }
  expect(cfg.hooks.Notification.map((entry: { matcher: string }) => entry.matcher)).toEqual([
    "idle_prompt", "permission_prompt|elicitation_dialog",
  ]);
  for (const [index, action] of ["idle_prompt", "permission_request"].entries()) {
    expect(cfg.hooks.Notification[index].hooks[0].command).toContain("DEVD_WARP_AGENT=grok ");
    expect(cfg.hooks.Notification[index].hooks[0].command).toContain(`--tty ${action}`);
  }
});

test("the Grok hook overrides the inherited Claude identity and passes the event and stdin to the emitter", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  await seed(home);
  const cfg = JSON.parse(await Bun.file(WARP(home)).text());
  writeFileSync(join(home, "warp-hook.sh"), [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$DEVD_WARP_AGENT" "$1" "$2"',
    "cat",
    "",
  ].join("\n"));
  const payload = JSON.stringify({ sessionId: "grok-session", toolName: "ask_user" });
  for (const event of ["SessionStart", "PreToolUse", "PostToolUseFailure", "StopFailure"]) {
    const command = cfg.hooks[event][0].hooks[0].command as string;
    const process = Bun.spawn(["bash", "-c", command], {
      env: { ...Bun.env, DEVD_WARP_AGENT: "claude" },
      stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(process.stdout).text();
    expect(await process.exited).toBe(0);
    const action = command.match(/--tty (\w+)/)![1];
    expect(out).toBe(`grok\n--tty\n${action}\n${payload}`);
  }
});

test("warp.json is idempotent (two runs → byte-identical file)", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  await seed(home);
  const first = await Bun.file(WARP(home)).text();
  await seed(home);
  const second = await Bun.file(WARP(home)).text();
  expect(second).toBe(first);
});

test("missing warp emitter → warp.json is not created, devd.json is (old image)", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  const devd = await seed(home, { WARP_HOOK: join(home, "missing.sh") });
  expect(JSON.parse(devd).hooks.Stop).toBeDefined();
  expect(await Bun.file(WARP(home)).exists()).toBe(false);
});

test("unwritable grok-home: does not break the start, but says so loudly", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-"));
  const locked = join(home, "locked");
  writeFileSync(locked, "not a directory"); // deterministic even when CI runs as root
  {
    const r = await seedRaw(home, join(locked, ".grok"));
    expect(r.code).toBe(0);              // the session start must not be stopped
    expect(r.err).toContain("seed-grok-hooks");
    expect(r.err).toContain("WITHOUT devd hooks");
  }
});
