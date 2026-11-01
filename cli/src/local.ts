// `dev local` — run a harness directly on the mac in the current folder, without SSH/tmux.
// The catalog of local binaries is separate from devd agents.ts: that one is about profiles
// in the container, this one about binaries installed on the host. Proxy profiles from the devbox
// (claude-gpt/grok/openrouter) are added to them: devd provides their env via
// GET /api/local-env — ready-made maps including keys (the tailnet is the trust boundary,
// same as for leased accounts and backup).
import { confirm, isCancel, log } from "@clack/prompts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LocalEnvProfile } from "./api";
export type { LocalEnvProfile } from "./api";
import { runInteractive } from "./attach";
import { cancelled, requireTty, selectVal, type Deps } from "./main";

export interface LocalHarness {
  /** Binary in PATH — also the value in the picker. */
  command: string;
  /** Label for the picker. In English — the dev CLI UI is in English since 2026-07-26. */
  label: string;
  /** Flags "as on the devbox" (yolo). The mac has no container sandbox — a deliberate choice. */
  flags: string[];
}

/** Order is the order in the picker. */
export const LOCAL_HARNESSES: LocalHarness[] = [
  { command: "claude", label: "Claude Code", flags: ["--dangerously-skip-permissions"] },
  { command: "codex", label: "Codex (yolo)", flags: ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"] },
  // Gemini CLI does not work with a personal Google account (UNSUPPORTED_CLIENT, evidence
  // the Antigravity research notes, Question 5) — the successor is Antigravity CLI.
  { command: "agy", label: "Antigravity (yolo)", flags: ["--dangerously-skip-permissions"] },
  // --always-approve verified on grok 1.0.5 (see image/gr), not guessed.
  { command: "grok", label: "Grok Build (yolo)", flags: ["--always-approve"] },
];

/** Only harnesses actually present in PATH, in catalog order. `which` injected for tests. */
export function detectHarnesses(which: (cmd: string) => string | null): LocalHarness[] {
  return LOCAL_HARNESSES.filter((h) => which(h.command) !== null);
}

export function harnessArgv(h: LocalHarness): string[] {
  return [h.command, ...h.flags];
}

/** What finally runs: argv + extra env + names removed from the inherited environment. */
export interface LaunchSpec { argv: string[]; env?: Record<string, string>; unset?: string[] }

/** Running a proxy profile locally: `claude` with env from devd. CLAUDE_POOL_DIR pointing to
 *  a non-existent directory disables the pool wrapper (~/.claude-pool/bin/claude) — a proxy
 *  profile has no Anthropic account from the pool to use, a lease would just be burned. */
export function profileLaunch(p: LocalEnvProfile): LaunchSpec {
  return {
    argv: ["claude", "--dangerously-skip-permissions"],
    env: { ...(p.env ?? {}), CLAUDE_POOL_DIR: "/nonexistent" },
    unset: p.unset,
  };
}

/** Picker: local binaries first, then ready proxy profiles from the devbox. Profiles run
 *  via `claude`, so without it in PATH they are not offered at all. */
export function launchOptions(found: LocalHarness[], profiles: LocalEnvProfile[]): { value: LaunchSpec; label: string; hint?: string }[] {
  const local = found.map((h) => ({ value: { argv: harnessArgv(h) }, label: h.label, hint: h.command }));
  if (!found.some((h) => h.command === "claude")) return local;
  const remote = profiles.filter((p) => p.ready)
    .map((p) => ({ value: profileLaunch(p), label: p.label, hint: "via devbox" }));
  return [...local, ...remote];
}

/** Child environment: inherited minus `unset`, overridden by the map from the API. */
export function childEnv(spec: LaunchSpec, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...base };
  for (const k of spec.unset ?? []) delete out[k];
  return { ...out, ...(spec.env ?? {}) };
}

/** Auto name of the working subfolder from local time: scratch-YYYYMMDD-HHmm. */
export function scratchDirName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `scratch-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** First free name: unchanged, otherwise -2, -3, … (`exists` injected for tests). */
export function uniqueDirName(name: string, exists: (name: string) => boolean): string {
  if (!exists(name)) return name;
  let n = 2;
  while (exists(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

// Interactive flow: harness picker → confirm new folder → run with inherited
// stdio. The harness exit code propagates out — when it ends, `dev local` ends too.
// An unreachable devd (off the tailnet) just narrows the offer to local binaries.
export async function runLocal(deps: Deps): Promise<number> {
  if (!requireTty()) return 1;
  const found = detectHarnesses((cmd) => Bun.which(cmd));
  const options = launchOptions(found, await deps.api.localEnvProfiles());
  if (options.length === 0) {
    console.error(`Error: no supported harness found in PATH (${LOCAL_HARNESSES.map((h) => h.command).join(", ")}).`);
    return 1;
  }
  const spec = await selectVal<LaunchSpec>("Harness?", options);
  if (spec === undefined) return cancelled();
  const makeDir = await confirm({ message: "Create a new working folder?" });
  if (isCancel(makeDir)) return cancelled();
  let cwd = process.cwd();
  if (makeDir) {
    const name = uniqueDirName(scratchDirName(new Date()), (n) => existsSync(join(cwd, n)));
    cwd = join(cwd, name);
    mkdirSync(cwd);
    log.info(`Working folder: ${name}`);
  }
  return await runInteractive(spec.argv, cwd, (spec.env || spec.unset) ? childEnv(spec, process.env) : undefined);
}
