import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = join(import.meta.dir, "..", "..", "image");

async function printAgent(env: Record<string, string>, args: string[] = []): Promise<string> {
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), ...args, "--print-agent"], {
    env: { ...process.env, DEVD_AGENT: "", ...env },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

test("agent-launch: argument beats env, env beats the default claude", async () => {
  expect(await printAgent({})).toBe("claude");
  expect(await printAgent({ DEVD_AGENT: "codex" })).toBe("codex");
  expect(await printAgent({ DEVD_AGENT: "codex" }, ["claude"])).toBe("claude");
  expect(await printAgent({}, ["codex"])).toBe("codex");
  expect(await printAgent({}, ["grok"])).toBe("grok");
  expect(await printAgent({}, ["claude-gpt"])).toBe("claude-gpt");
  expect(await printAgent({}, ["claude-grok"])).toBe("claude-grok");
  expect(await printAgent({}, ["claude-gemini"])).toBe("claude-gemini");
  expect(await printAgent({}, ["claude-openrouter"])).toBe("claude-openrouter");
  expect(await printAgent({}, ["antigravity"])).toBe("antigravity");
  expect(await printAgent({ DEVD_AGENT: "antigravity" })).toBe("antigravity");
});

test("agent-launch: an unknown profile falls back to claude (the session always comes up)", async () => {
  expect(await printAgent({ DEVD_AGENT: "gpt" })).toBe("claude");
  expect(await printAgent({}, ["nonsense"])).toBe("claude");
});

// The fallback must be audible: "I picked codex and claude came up" is, from outside, indistinguishable
// from a bug in devd until someone names it.
test("agent-launch: an unknown profile says so instead of switching silently", async () => {
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "nonsense", "--print-agent"], {
    env: { ...process.env, DEVD_AGENT: "" }, stdout: "ignore", stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  await p.exited;
  expect(err).toContain("nonsense");
  expect(err).toContain("claude");
});

test("gr runs grok with approvals disabled", async () => {
  const gr = await Bun.file(join(IMAGE, "gr")).text();
  expect(gr).toContain("exec grok");
  expect(gr).toContain("--always-approve");
  expect(gr).toContain('"$@"');
});

/** One LOGICAL Dockerfile instruction (lines joined by a trailing `\`), found by
 *  substring. The check must look at the whole RUN, not at one line — the bug this
 *  test guards against was exactly in what happened one line over. Comments are
 *  dropped so the test does not hit text that runs nothing. */
function dockerInstruction(df: string, needle: string): string {
  const joined = df.replace(/\\\n\s*/g, " ");
  const line = joined.split("\n").filter((l) => !l.trimStart().startsWith("#")).find((l) => l.includes(needle));
  if (!line) throw new Error(`Dockerfile: no instruction containing "${needle}"`);
  return line;
}

// This test used to assert only "the Dockerfile contains the string x.ai/cli/install.sh" — and was
// green over an install the `dev` user (uid 1000) could not see at all: RUN runs as
// root, the installer drops into `$HOME/.grok`, so the binary ended up under /root (mode 0700)
// and `grok` in the session reported "command not found". A green test over a broken thing is worse
// than none, so this verifies what was failing.
test("Dockerfile installs grok outside /root, verifies it as non-root and copies gr with permissions", async () => {
  const df = await Bun.file(join(IMAGE, "Dockerfile")).text();
  const run = dockerInstruction(df, "x.ai/cli/install.sh");

  // 1) The install MUST NOT end up under /root — uid 1000 cannot see there.
  const home = run.match(/\bHOME=(\S+)/)?.[1];
  expect(home).toBeDefined();
  expect(home!.startsWith("/root")).toBe(false);
  expect(run).not.toContain("/root");

  // 2) Verification MUST run as non-root. `&& grok --version` as root returned zero
  //    even for an install unavailable to the user — that is exactly how the defect got in.
  expect(run).toMatch(/\bsu\b.*\bnobody\b/);
  const bareRootCheck = run.split("&&").some((part) => /^\s*grok\s+--version/.test(part));
  expect(bareRootCheck).toBe(false);
  expect(run).toContain("grok --version");

  // 3) The installer also creates an `agent` alias — too generic a name for every session's PATH.
  expect(run).toContain("rm -f /usr/local/bin/agent");

  expect(df).toContain("COPY gr /usr/local/bin/gr");
  const chmodLines = df.split("\n").filter((l) => l.startsWith("RUN chmod 755"));
  expect(chmodLines.some((l) => l.includes("/usr/local/bin/gr"))).toBe(true);
});

// `grok-home` is mounted at /home/dev/.grok (index.ts). When the directory does not exist in the image,
// docker creates it for a new volume as root:root 0755 and uid 1000 cannot write
// to it — the hook seed, `auth.json` from the device-auth login and `.xai_api_key` silently drop out.
// That is exactly why `.codex` is on that list too.
test("Dockerfile creates /home/dev/.grok as dev — otherwise grok-home mounts as root:root", async () => {
  const df = await Bun.file(join(IMAGE, "Dockerfile")).text();
  const run = dockerInstruction(df, "install -d -o dev -g dev");
  expect(run).toContain("/home/dev/.grok ");
});

test("co runs codex with approvals, sandbox and hook trust disabled", async () => {
  const co = await Bun.file(join(IMAGE, "co")).text();
  expect(co).toContain("exec codex");
  expect(co).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(co).toContain("--dangerously-bypass-hook-trust");
  expect(co).toContain('"$@"');
});

test("claude-launch is just a shim for agent-launch claude", async () => {
  const shim = await Bun.file(join(IMAGE, "claude-launch.sh")).text();
  expect(shim).toContain("exec /usr/local/bin/agent-launch claude");
});

test("Dockerfile copies co and agent-launch, the entrypoint starts agent-launch", async () => {
  const df = await Bun.file(join(IMAGE, "Dockerfile")).text();
  expect(df).toContain("COPY agent-launch.sh /usr/local/bin/agent-launch");
  expect(df).toContain("COPY co /usr/local/bin/co");
  // both launchers must get permissions — each in its own chmod line (they are in different layers)
  const chmodLines = df.split("\n").filter((l) => l.startsWith("RUN chmod 755"));
  expect(chmodLines.some((l) => l.includes("/usr/local/bin/agent-launch"))).toBe(true);
  expect(chmodLines.some((l) => l.includes("/usr/local/bin/co"))).toBe(true);
  const ep = await Bun.file(join(IMAGE, "entrypoint.sh")).text();
  expect(ep).toContain("tmux new-session -d -s main -c /workspace /usr/local/bin/agent-launch");
});

async function printEnv(env: Record<string, string>, args: string[]): Promise<string> {
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), ...args, "--print-env"], {
    env: { ...process.env, DEVD_AGENT: "", ...env }, stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

// A live agent switch (agentSwitch.ts) clears profile exports from the pane's shell
// according to PROFILE_ENV. An export added here but not there would silently survive
// a profile switch and send the new profile to the wrong upstream/model. --print-env is a complete
// inventory of exports, so it keeps both lists together. ANTHROPIC_API_KEY and XAI_API_KEY
// are left out on purpose: the first is handled by agent-launch itself (openrouter unset), the second belongs
// to the grok runtime, not the proxy branch.
import { PROFILE_ENV } from "../src/agentSwitch";

test("every export from --print-env is in PROFILE_ENV (cleanup on agent switch)", async () => {
  const known: readonly string[] = PROFILE_ENV;
  const inputs = { DEVD_CLIPROXY_KEY: "k1", DEVD_UPSTREAM_KEY: "k1", DEVD_AGENT_MODEL: "m", DEVD_AGENT_CTX: "123" };
  for (const profile of ["claude-gpt", "claude-grok", "claude-gemini", "claude-openrouter"]) {
    const names = (await printEnv(inputs, [profile])).trim().split("\n").filter(Boolean)
      .map((l) => l.split("=")[0]!)
      .filter((n) => n !== "ANTHROPIC_API_KEY" && n !== "XAI_API_KEY");
    for (const n of names) expect(known).toContain(n);
  }
});

test("a proxy profile sets base URL, token and model; GPT also effort", async () => {
  const e = await printEnv(
    { DEVD_CLIPROXY_KEY: "k1", DEVD_CLIPROXY_URL: "http://h:8317", DEVD_AGENT_MODEL: "gpt-5.6-sol" },
    ["claude-gpt"]);
  expect(e).toContain("ANTHROPIC_BASE_URL=http://h:8317");
  // The token is NEVER printed by --print-env in readable form, see the test below.
  expect(e).toContain("ANTHROPIC_AUTH_TOKEN=<set>");
  expect(e).toContain("ANTHROPIC_MODEL=gpt-5.6-sol");
  expect(e).toContain("CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol");
  expect(e).toContain("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1");
  expect(e).toContain("DEVBOX_PROXY_PROFILE=1");
});

// cc assumes a 200k window for an unrecognized model (stealth/ox-alpha…) and keeps compacting.
// devd sends the real window as an inert DEVD_AGENT_CTX; only this proxy branch translates it
// to CLAUDE_CODE_MAX_CONTEXT_TOKENS — so the container env carries no active name that would
// leak into another profile launched alongside (`dev -n --claude` in the same container).
test("a proxy profile translates DEVD_AGENT_CTX to CLAUDE_CODE_MAX_CONTEXT_TOKENS", async () => {
  const e = await printEnv(
    { DEVD_UPSTREAM_KEY: "or-key", DEVD_AGENT_MODEL: "stealth/ox-alpha", DEVD_AGENT_CTX: "1048576" },
    ["claude-openrouter"]);
  expect(e).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576");
});

test("without DEVD_AGENT_CTX CLAUDE_CODE_MAX_CONTEXT_TOKENS is not set (cc default)", async () => {
  const e = await printEnv(
    { DEVD_UPSTREAM_KEY: "or-key", DEVD_AGENT_MODEL: "stealth/ox-alpha" },
    ["claude-openrouter"]);
  expect(e).not.toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
});

// Subagents can ask for "Sonnet"/"Opus"/"Haiku" by name — without remapping all
// slots a session under OpenRouter would ask for a model that is not there (404), or
// silently escape to the paid Anthropic API. SMALL_FAST is already remapped; the DEFAULT_* slots
// are the same risk.
test("the openrouter profile also remaps the DEFAULT_SONNET/OPUS/HAIKU slots", async () => {
  const e = await printEnv(
    { DEVD_UPSTREAM_KEY: "or-key", DEVD_AGENT_MODEL: "stealth/ox-alpha" },
    ["claude-openrouter"]);
  expect(e).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=stealth/ox-alpha");
  expect(e).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=stealth/ox-alpha");
  expect(e).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=stealth/ox-alpha");
});

// --print-env exists only for this test suite, but the script ships in the production
// image — the value of a key to three paid subscriptions has no business on stdout there.
test("--print-env prints only that ANTHROPIC_AUTH_TOKEN is set, never its value", async () => {
  const e = await printEnv(
    { DEVD_CLIPROXY_KEY: "secret-key-for-three-subscriptions", DEVD_AGENT_MODEL: "gpt-5.6-sol" },
    ["claude-gpt"]);
  expect(e).toContain("ANTHROPIC_AUTH_TOKEN=<set>");
  expect(e).not.toContain("secret-key-for-three-subscriptions");
});

test("the grok profile via proxy has no GPT-specific effort", async () => {
  const e = await printEnv(
    { DEVD_CLIPROXY_KEY: "k1", DEVD_AGENT_MODEL: "grok-4.5" }, ["claude-grok"]);
  expect(e).toContain("ANTHROPIC_MODEL=grok-4.5");
  expect(e).not.toContain("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT");
});

// Grok forces tool search (xAI cap of 350 tools), the other proxy profiles keep it
// off — the full reasoning is at that condition in image/agent-launch.sh.
test("claude-grok forces tool search (xAI cap of 350 tools), the other proxy profiles do not", async () => {
  const grok = await printEnv({ DEVD_CLIPROXY_KEY: "k1", DEVD_AGENT_MODEL: "grok-4.6" }, ["claude-grok"]);
  expect(grok).toContain("ENABLE_TOOL_SEARCH=true");
  const gpt = await printEnv({ DEVD_CLIPROXY_KEY: "k1", DEVD_AGENT_MODEL: "gpt-5.6-sol" }, ["claude-gpt"]);
  expect(gpt).toContain("ENABLE_TOOL_SEARCH=false");
  const or = await printEnv({ DEVD_UPSTREAM_KEY: "or-key", DEVD_AGENT_MODEL: "stealth/ox-alpha" }, ["claude-openrouter"]);
  expect(or).toContain("ENABLE_TOOL_SEARCH=false");
  const gemini = await printEnv({ DEVD_CLIPROXY_KEY: "k1", DEVD_AGENT_MODEL: "gemini-3-pro" }, ["claude-gemini"]);
  expect(gemini).toContain("ENABLE_TOOL_SEARCH=false");
});

// The Gemini profile behaves like GPT/OpenRouter: cliproxy upstream, no GPT effort,
// no forced tool search. A mirror of the tests above for claude-grok/claude-openrouter.
test("claude-gemini: cliproxy upstream, no GPT effort", async () => {
  const e = await printEnv({ DEVD_CLIPROXY_KEY: "k1", DEVD_AGENT_MODEL: "gemini-3-pro" }, ["claude-gemini"]);
  expect(e).toContain("ANTHROPIC_MODEL=gemini-3-pro");
  expect(e).not.toContain("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT");
});

test("native claude gets NOT A SINGLE proxy variable", async () => {
  const e = await printEnv({ DEVD_CLIPROXY_KEY: "k1" }, ["claude"]);
  expect(e).not.toContain("ANTHROPIC_BASE_URL");
  expect(e).not.toContain("ANTHROPIC_AUTH_TOKEN");
});

// Review round 1, Finding 1: the dashboard reported grok.loggedIn by the presence of
// ~/.grok/.xai_api_key in the volume, but nothing ever exported it as XAI_API_KEY —
// the badge lied. This block is the missing second half (see agentAuth.ts grokApiKey).
function tmpHomeWithGrokKey(key: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "agent-launch-home-"));
  if (key !== null) {
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", ".xai_api_key"), key);
  }
  return home;
}


test("the grok profile does not overwrite an XAI_API_KEY that already came from outside (e.g. docker -e)", async () => {
  const home = tmpHomeWithGrokKey("from-file");
  const e = await printEnv({ HOME: home, XAI_API_KEY: "from-env" }, ["grok"]);
  expect(e).toContain("XAI_API_KEY=from-env");
  expect(e).not.toContain("from-file");
});

test("the grok profile without a stored key exports nothing", async () => {
  const home = tmpHomeWithGrokKey(null);
  expect(await printEnv({ HOME: home }, ["grok"])).not.toContain("XAI_API_KEY");
});

test("profiles other than grok do not read XAI_API_KEY from the volume, even when it is there", async () => {
  const home = tmpHomeWithGrokKey("xai-secret-abc");
  expect(await printEnv({ HOME: home }, ["claude"])).not.toContain("XAI_API_KEY");
  expect(await printEnv({ HOME: home, DEVD_CLIPROXY_KEY: "k1", DEVD_AGENT_MODEL: "grok-4.5" }, ["claude-grok"]))
    .not.toContain("XAI_API_KEY");
  expect(await printEnv({ HOME: home }, ["codex"])).not.toContain("XAI_API_KEY");
});

// A live agent switch (devd/src/agentSwitch.ts) runs `agent-launch <profile>
// --resume <id>` — arguments AFTER the profile must make it all the way to the binary, otherwise
// the conversation would silently not continue after a profile switch. A fake binary in PATH prints
// its argv (the same trick as fakeClaudeBin in the `cc` test below).
function fakeBin(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-launch-bin-"));
  writeFileSync(join(dir, name), `#!/bin/sh\necho "${name}-argv: $@"\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

test("agent-launch passes arguments after the profile to the binary (--resume for an agent switch)", async () => {
  const bin = fakeBin("cc");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "claude", "--resume", "abc-123"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVD_AGENT: "" },
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(out).toContain("cc-argv: --resume abc-123");
});

test("agent-launch without extra arguments runs the bare binary (current behaviour)", async () => {
  const bin = fakeBin("co");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "codex"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVD_AGENT: "" },
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(out).toContain("co-argv:");
  expect(out).not.toContain("co-argv: -");
});

test("after the agent exits it restores the terminal from mouse and alt screen before starting zsh", async () => {
  const bin = fakeBin("co");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "codex"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVD_AGENT: "" },
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const reset = out.indexOf("\x1b[?1003l");
  expect(reset).toBeGreaterThan(out.indexOf("co-argv:"));
  for (const mode of ["1000", "1002", "1003", "1006", "1049"]) expect(out).toContain(`\x1b[?${mode}l`);
});

// stdin "ignore": the guard path does `exec zsh` — with an empty stdin zsh immediately gets
// EOF and exits (verified by hand), so the test does not hang on an interactive shell.
async function launch(env: Record<string, string>, args: string[]): Promise<{ out: string; err: string }> {
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), ...args], {
    env: { ...process.env, DEVD_AGENT: "", ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  return { out, err };
}

test("missing key: the message points to the host and does NOT send you to the vault", async () => {
  const { out, err } = await launch({ DEVD_AGENT_MODEL: "gpt-5.6-sol" }, ["claude-gpt"]);
  expect(err).toContain("/etc/devd/cliproxy/api-key");
  expect(err).toContain("setup.sh");
  // Regression: the key is NOT in the vault and never should be (see readCliproxyKey in config.ts).
  // A message that sends people there makes them unlock something unrelated to the cause.
  expect(err).not.toContain("vault");
  expect(err).not.toContain("cliproxy.apiKey");
  expect(out).not.toContain("ANTHROPIC_BASE_URL");
  expect(out).not.toContain("ANTHROPIC_AUTH_TOKEN");
});

test("missing model: the message points to the config, not the vault, the session comes up without proxy variables", async () => {
  const { out, err } = await launch({ DEVD_CLIPROXY_KEY: "k1" }, ["claude-gpt"]);
  expect(err).toContain("model");
  expect(err).not.toContain("vault");
  expect(out).not.toContain("ANTHROPIC_BASE_URL");
  expect(out).not.toContain("ANTHROPIC_AUTH_TOKEN");
});

// A fake `claude` in PATH — verifies the real argv `cc` launches the agent with,
// instead of just grepping the script text (that would not catch an inverted condition).
function fakeClaudeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-fake-claude-"));
  writeFileSync(join(dir, "claude"), '#!/bin/sh\necho "$@"\n');
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

async function runCc(env: Record<string, string>): Promise<string> {
  const bin = fakeClaudeBin();
  const p = Bun.spawn(["bash", join(IMAGE, "cc")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVD_SESSION_ID: "", DEVBOX_PROXY_PROFILE: "", ...env },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

test("cc registers Remote Control only outside a proxy profile", async () => {
  const native = await runCc({ DEVD_SESSION_ID: "sess1" });
  expect(native).toContain("--remote-control sess1");
  const proxy = await runCc({ DEVD_SESSION_ID: "sess1", DEVBOX_PROXY_PROFILE: "1" });
  expect(proxy).not.toContain("--remote-control");
});

// OpenRouter goes direct, not via CLIProxyAPI — that is why the variables are named UPSTREAM.
test("the openrouter profile gets base URL, token and model, without GPT effort", async () => {
  const e = await printEnv(
    { DEVD_UPSTREAM_KEY: "or-key", DEVD_UPSTREAM_URL: "https://openrouter.ai/api",
      DEVD_AGENT_MODEL: "stealth/ox-alpha" }, ["claude-openrouter"]);
  expect(e).toContain("ANTHROPIC_BASE_URL=https://openrouter.ai/api");
  expect(e).toContain("ANTHROPIC_AUTH_TOKEN=<set>");
  expect(e).toContain("ANTHROPIC_MODEL=stealth/ox-alpha");
  expect(e).toContain("CLAUDE_CODE_SUBAGENT_MODEL=stealth/ox-alpha");
  expect(e).toContain("DEVBOX_PROXY_PROFILE=1");
  expect(e).not.toContain("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT");
});

// Claude Code reaches for a small model for background tasks. Without reconfiguring it would
// ask for it by a Haiku-family name this upstream does not know — either a 404 on every
// background operation, or (if OpenRouter maps it to the real Anthropic one)
// paid tokens on a profile that is otherwise free. Neither has any way to surface.
test("the openrouter profile also redirects the small background model", async () => {
  const e = await printEnv(
    { DEVD_UPSTREAM_KEY: "or-key", DEVD_AGENT_MODEL: "stealth/ox-alpha" }, ["claude-openrouter"]);
  expect(e).toContain("ANTHROPIC_SMALL_FAST_MODEL=stealth/ox-alpha");
});

// cc prefers x-api-key over the bearer token. An inherited ANTHROPIC_API_KEY (from the image,
// from docker -e, left over from a native profile) would therefore silently override our key and OpenRouter
// would answer 401 — for a key we never meant to send.
test("the openrouter profile drops an inherited ANTHROPIC_API_KEY", async () => {
  const inherited = { ANTHROPIC_API_KEY: "leftover-from-native-profile" };
  // First proof that this test CAN fail: the native profile leaves the variable alone
  // and --print-env shows it. Without this half `not.toContain` would hold trivially,
  // because ANTHROPIC_API_KEY used to not make it into the output at all.
  expect(await printEnv(inherited, ["claude"])).toContain("ANTHROPIC_API_KEY=<set>");

  const e = await printEnv(
    { ...inherited, DEVD_UPSTREAM_KEY: "or-key", DEVD_AGENT_MODEL: "stealth/ox-alpha" },
    ["claude-openrouter"]);
  expect(e).not.toContain("ANTHROPIC_API_KEY");
  expect(e).not.toContain("leftover-from-native-profile");
});

// The opposite direction from devd: a new image may run against an older devd that still
// sends only the old names. The profile must not report a missing key because of that.
test("the old DEVD_CLIPROXY_* names still work (new image, older devd)", async () => {
  const e = await printEnv(
    { DEVD_CLIPROXY_KEY: "k1", DEVD_CLIPROXY_URL: "http://h:8317",
      DEVD_AGENT_MODEL: "gpt-5.6-sol" }, ["claude-gpt"]);
  expect(e).toContain("ANTHROPIC_BASE_URL=http://h:8317");
  expect(e).toContain("ANTHROPIC_AUTH_TOKEN=<set>");
});

test("a missing key for openrouter points to the dashboard, not to setup.sh", async () => {
  const { out, err } = await launch({ DEVD_AGENT_MODEL: "stealth/ox-alpha" }, ["claude-openrouter"]);
  expect(err).toContain("dashboard");
  // Different profile, different cause, different fix: neither the proxy path nor its installer
  // has anything to do with a missing OpenRouter key.
  expect(err).not.toContain("setup.sh");
  expect(err).not.toContain("CLIProxyAPI");
  expect(err).not.toContain("vault");
  expect(out).not.toContain("ANTHROPIC_BASE_URL");
});

// The missing-model message sent the OpenRouter profile "to the devd config" too, but
// for it the model is set in the dashboard. A wrong address is worse than none: you
// open the config, SEE the model there (the card saved it there) and have nowhere to go next.
test("a missing model for openrouter points to the dashboard, not to the config", async () => {
  const { out, err } = await launch({ DEVD_UPSTREAM_KEY: "or-key" }, ["claude-openrouter"]);
  expect(err).toContain("dashboard");
  expect(err).not.toContain("settings.proxyModels");
  expect(out).not.toContain("ANTHROPIC_BASE_URL");
});

// Cliproxy profiles have no model in the dashboard — theirs still belongs in the config.
test("a missing model for a cliproxy profile still points to the config", async () => {
  const { err } = await launch({ DEVD_UPSTREAM_KEY: "k1" }, ["claude-gpt"]);
  expect(err).toContain("settings.proxyModels");
});

// claude-gemini is a cliproxy profile too (not OpenRouter) — without a model it must end
// with the same message pointing to the devd config, not the dashboard.
test("a missing model for claude-gemini still points to the config", async () => {
  const { err } = await launch({ DEVD_UPSTREAM_KEY: "k1" }, ["claude-gemini"]);
  expect(err).toContain("settings.proxyModels");
});

// Finding A (review phase 1a): agy does not document starting a turn with a positional argument —
// the help describes only `-i, --prompt-interactive`. The antigravity profile therefore must
// send the prompt via `-i`, the other profiles (positional) stay unchanged.
// PROMPT_FILE is fixed at /run/devd/prompt; DEVD_PROMPT_FILE is a test escape hatch.
function fakePromptLaunch(binName: string): { dir: string; promptFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-launch-prompt-"));
  writeFileSync(join(dir, binName), `#!/bin/sh\necho "${binName}-argv: $@"\n`);
  chmodSync(join(dir, binName), 0o755);
  const promptFile = join(dir, "prompt");
  writeFileSync(promptFile, "do X");
  return { dir, promptFile };
}

// agy onboarding (colors, data collection consent, trust) only shows up on the first
// real run — an automatically typed prompt would race through its menu and agree to
// data collection (checked by default). agy-hook.sh SessionStart creates the marker only AFTER
// onboarding (see agyHook.test.ts); while it is missing, agent-launch does not pass the prompt.
function agyHomeWithMarker(dir: string): string {
  const agyHome = join(dir, "agy-home");
  mkdirSync(agyHome, { recursive: true });
  writeFileSync(join(agyHome, ".devbox-onboarded"), "");
  return agyHome;
}

test("the antigravity profile with the onboarding marker sends the prompt via -i, not positionally", async () => {
  const { dir, promptFile } = fakePromptLaunch("ag");
  const agyHome = agyHomeWithMarker(dir);
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "antigravity"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: promptFile, AGY_HOME: agyHome },
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(out).toContain("ag-argv: -i do X");
});

// after the agent exits agent-launch restores the terminal from mouse/alt screen (printf before zsh);
// the exact comparison of the stub argv ignores those sequences.
const stripTermReset = (s: string) => s.replace(/\x1b\[\?(?:1000|1002|1003|1006|1049)l/g, "");

test("the antigravity profile without finished onboarding does not pass the prompt, only shows it on stderr", async () => {
  const { dir, promptFile } = fakePromptLaunch("ag");
  // AGY_HOME points to an empty temp directory — there is no marker there.
  const agyHome = join(dir, "agy-home-empty");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "antigravity"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: promptFile, AGY_HOME: agyHome },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  // The `ag` stub gets argv without `-i` and without a prompt (a bare launch).
  expect(stripTermReset(out).trim()).toBe("ag-argv:");
  expect(out).not.toContain("-i");
  expect(out).not.toContain("do X");
  expect(err).toContain("do X");
  expect(err).toContain("Antigravity");
});

// Finding (review phase 2): the stderr message disappears the moment agy comes up
// full screen over it (TUI) — so a scheduled run silently loses the task, without a trace.
// Fix: the task is additionally saved to a file next to AGY_HOME, the message points to it, and
// only with a non-interactive (ignore) stdin there is no wait for Enter — so tests (without a tty)
// stay non-blocking, while an attached user sees the message before the TUI overwrites it.
test("antigravity without onboarding saves the task to .devbox-pending-prompt (0600, exact content)", async () => {
  const { dir, promptFile } = fakePromptLaunch("ag");
  const agyHome = join(dir, "agy-home-empty");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "antigravity"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: promptFile, AGY_HOME: agyHome },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  const pendingFile = join(agyHome, ".devbox-pending-prompt");
  expect(existsSync(pendingFile)).toBe(true);
  expect(readFileSync(pendingFile, "utf8")).toBe("do X");
  expect((statSync(pendingFile).mode & 0o777)).toBe(0o600);
  expect(err).toContain(pendingFile);
  // The `ag` stub still starts without -i and without a prompt (a non-interactive stdin does not wait for Enter).
  expect(stripTermReset(out).trim()).toBe("ag-argv:");
});

test("antigravity without onboarding overwrites an old pending prompt with the new one (not append)", async () => {
  const { dir, promptFile } = fakePromptLaunch("ag");
  const agyHome = join(dir, "agy-home-empty");
  mkdirSync(agyHome, { recursive: true });
  const pendingFile = join(agyHome, ".devbox-pending-prompt");
  writeFileSync(pendingFile, "old task");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "antigravity"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: promptFile, AGY_HOME: agyHome },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  await p.exited;
  expect(readFileSync(pendingFile, "utf8")).toBe("do X");
});

test("the claude profile still sends the prompt positionally (current behaviour unchanged)", async () => {
  const { dir, promptFile } = fakePromptLaunch("cc");
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "claude"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: promptFile },
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(out).toContain("cc-argv: do X");
  expect(out).not.toContain("-i");
});

test("cc, co and gr use yolo even on recovery after a restart (DEVD_RECOVERY_LAUNCH)", async () => {
  // The container itself is the sandbox; a recovered conversation without yolo would hang on sandbox/approvals.
  for (const [name, flag] of [["cc", "--dangerously-skip-permissions"], ["co", "--dangerously-bypass-approvals-and-sandbox"], ["gr", "--always-approve"]]) {
    const src = await Bun.file(join(IMAGE, name)).text();
    expect(src).not.toContain("DEVD_RECOVERY_LAUNCH");
    expect(src).toContain(flag);
  }
});
