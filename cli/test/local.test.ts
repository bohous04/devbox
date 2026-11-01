import { expect, test } from "bun:test";
import { childEnv, detectHarnesses, harnessArgv, launchOptions, LOCAL_HARNESSES, profileLaunch, scratchDirName, uniqueDirName, type LocalEnvProfile } from "../src/local";

test("catalog covers the known local harnesses in UI order", () => {
  expect(LOCAL_HARNESSES.map((h) => h.command)).toEqual(["claude", "codex", "agy", "grok"]);
});

test("detectHarnesses offers only commands found in PATH, in catalog order", () => {
  const found = detectHarnesses((cmd) => (cmd === "codex" || cmd === "claude" ? `/bin/${cmd}` : null));
  expect(found.map((h) => h.command)).toEqual(["claude", "codex"]);
});

test("detectHarnesses with nothing installed returns empty list", () => {
  expect(detectHarnesses(() => null)).toEqual([]);
});

test("harnessArgv launches with devbox-style flags", () => {
  const by = (cmd: string) => LOCAL_HARNESSES.find((h) => h.command === cmd)!;
  expect(harnessArgv(by("claude"))).toEqual(["claude", "--dangerously-skip-permissions"]);
  expect(harnessArgv(by("codex"))).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"]);
  expect(harnessArgv(by("agy"))).toEqual(["agy", "--dangerously-skip-permissions"]);
  // --always-approve verified on grok 1.0.5 (see image/gr), not guessed.
  expect(harnessArgv(by("grok"))).toEqual(["grok", "--always-approve"]);
});

test("scratchDirName formats the local timestamp with zero padding", () => {
  expect(scratchDirName(new Date(2026, 7, 22, 14, 35))).toBe("scratch-20260822-1435");
  expect(scratchDirName(new Date(2026, 0, 3, 4, 5))).toBe("scratch-20260103-0405");
});

test("uniqueDirName keeps a free name and suffixes -2, -3 on collision", () => {
  expect(uniqueDirName("scratch-x", () => false)).toBe("scratch-x");
  const taken = new Set(["scratch-x", "scratch-x-2"]);
  expect(uniqueDirName("scratch-x", (n) => taken.has(n))).toBe("scratch-x-3");
});

// ── Proxy profily z devboxu ──────────────────────────────────────────────────
const profile = (over: Partial<LocalEnvProfile> = {}): LocalEnvProfile => ({
  profile: "claude-gpt", label: "Claude Code + GPT", ready: true,
  env: { ANTHROPIC_BASE_URL: "http://h:4300/api/cliproxy", ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_MODEL: "gpt-5.6-sol" },
  ...over,
});

test("launchOptions: local harnesses first, then only ready profiles from the devbox", () => {
  const found = detectHarnesses((c) => (c === "claude" || c === "agy" ? `/bin/${c}` : null));
  const opts = launchOptions(found, [profile(), profile({ profile: "claude-grok", label: "Claude Code + Grok", ready: false, reason: "no model set", env: undefined })]);
  expect(opts.map((o) => o.label)).toEqual(["Claude Code", "Antigravity (yolo)", "Claude Code + GPT"]);
  expect(opts[2]!.hint).toBe("via devbox");
});

test("launchOptions: profiles are not offered without a local claude", () => {
  const found = detectHarnesses((c) => (c === "agy" ? "/bin/agy" : null));
  expect(launchOptions(found, [profile()]).map((o) => o.label)).toEqual(["Antigravity (yolo)"]);
});

// CLAUDE_POOL_DIR pointing to a nonexistent directory: the pool wrapper then never calls lease —
// a proxy profile has no use for an Anthropic account from the pool (see ~/.claude-pool/bin/claude).
test("profileLaunch: claude in yolo mode, env from the API + pool disabled", () => {
  const spec = profileLaunch(profile({ unset: ["ANTHROPIC_API_KEY"] }));
  expect(spec.argv).toEqual(["claude", "--dangerously-skip-permissions"]);
  expect(spec.env).toMatchObject({ ANTHROPIC_MODEL: "gpt-5.6-sol", CLAUDE_POOL_DIR: "/nonexistent" });
  expect(spec.unset).toEqual(["ANTHROPIC_API_KEY"]);
});

test("childEnv: unset is removed from the inherited environment, env overrides the rest", () => {
  const base = { PATH: "/bin", ANTHROPIC_API_KEY: "stale", HOME: "/Users/x" };
  const out = childEnv({ argv: ["claude"], env: { ANTHROPIC_MODEL: "m" }, unset: ["ANTHROPIC_API_KEY"] }, base);
  expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  expect(out).toMatchObject({ PATH: "/bin", HOME: "/Users/x", ANTHROPIC_MODEL: "m" });
});
