// devd/src/safeGit.ts
// Every `git` that devd runs on the HOST (as root) goes through this (rereview N3).
//
// Why: both the workspace and the session's bare clone are bind mounts the container writes into — and since
// terminal sharing, a stranger can write into it too. `.git/config` (and the `config` of the bare clone,
// which the session worktree shares) is therefore untrusted input. Git can run commands
// from it: core.fsmonitor, hooks, diff.external, filter.<x>.clean/smudge/process (via
// .gitattributes), diff.<x>.textconv/command, merge.<x>.driver, credential helper,
// core.sshCommand, remote.<x>.uploadpack, gpg.program… A single stats tick
// (`git diff --numstat`) would be enough for the host to run the terminal guest's script as root — and that
// survives revoking the link, the taint and a container rebuild (the workspace stays).
//
// Three layers:
//  1. Fixed `-c` (the command line takes precedence over the repo) + a safe env: hooks to
//     /dev/null, fsmonitor off, no pager/editor/askpass/prompt, no system
//     config or system attributes, ext:: transport forbidden, no signing and no submodules.
//     diff/log/show additionally with `--no-ext-diff --no-textconv`.
//  2. Keys that cannot be overridden with one fixed value (driver names are chosen by the repo) are
//     read beforehand with `git config --list --show-scope --show-origin` (reading config runs
//     nothing) and each one coming from the repo (scope local/worktree, including includes)
//     is overridden with a harmless value — or with a value from the trusted (global) config
//     when devd itself needs it (core.sshCommand, credential.helper). What cannot be neutralized
//     (core.worktree, core.gitProxy, remote.<x>.vcs/uploadpack/receivepack,
//     url.<x>.insteadOf, hook.*,
//     a key with `=` in its name) means REFUSAL — git is not run.
//  3. The repo of a restricted (shared/tainted) session is NOT READ by host git at all: between reading
//     the config (layer 2) and the git run, the terminal guest could rewrite it (inotify).
//     The roots of such repos (worktree + bare clone) are provided by index.ts via setUntrustedGitRoots.
//
// Residual risk (accepted): for an UNrestricted session, layer 2 can theoretically be bypassed
// by a race only by whoever is running in the container right now — i.e. the agent, which already has
// the same reach today. A local path as a remote (`remote.origin.url=/srv/dev/...`) stays
// allowed (tests and local bare clones use it) — it runs nothing, but pull/push
// would touch a different repo on the host.
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { RunOpts, RunResult } from "./proc";

/** Env for every host git. Overrides the caller's env. */
export const SAFE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
};
/** Variables from the devd environment that would override the config above. */
export const UNSAFE_GIT_ENV: readonly string[] = ["GIT_EXTERNAL_DIFF", "GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_SYSTEM"];

/** Fixed `-c` — layer 1. */
export const SAFE_GIT_CONFIG: readonly string[] = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.attributesFile=/dev/null",
  "core.askPass=",
  "diff.external=",
  "protocol.ext.allow=never",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "log.showSignature=false",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "http.saveCookies=false",
  "gc.auto=0",
  "maintenance.auto=false",
];

/** Subcommands that can produce a patch (and thereby run an external diff / textconv). */
const DIFF_CMDS = new Set(["diff", "log", "show", "whatchanged"]);

type Raw = (cmd: string[], opts: RunOpts) => Promise<RunResult>;

let untrustedRoots: () => string[] = () => [];
/** Repo roots host git must not touch (worktree + bare clone of restricted sessions). */
export function setUntrustedGitRoots(fn: (() => string[]) | null): void {
  untrustedRoots = fn ?? (() => []);
}

export const isGitArgv = (cmd: readonly string[]): boolean => cmd.length > 0 && basename(cmd[0]!) === "git";

/** Index of the subcommand in argv (`git -C x -c a=b diff …` → index of "diff"), -1 = none. */
export function subcommandIndex(cmd: readonly string[]): number {
  for (let i = 1; i < cmd.length; i++) {
    const a = cmd[i]!;
    if (a === "-c" || a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--config-env") { i++; continue; }
    if (a.startsWith("-")) continue;
    return i;
  }
  return -1;
}

const canon = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

type Override = { kind: "set"; value: string } | { kind: "multi" } | { kind: "refuse"; why: string } | null;

/** What to do with a key from the repo (scope local/worktree). `key` is as git prints it (section
 *  and name lowercase, subsection unchanged). */
export function overrideFor(key: string): Override {
  const k = key.toLowerCase();
  if (key.includes("=")) return { kind: "refuse", why: `key ${JSON.stringify(key)} contains "=" and cannot be overridden` };
  if (/^filter\..+\.(clean|smudge|process)$/.test(k)) return { kind: "set", value: "" };
  if (/^filter\..+\.required$/.test(k)) return { kind: "set", value: "false" };
  if (/^diff\..+\.(command|textconv)$/.test(k)) return { kind: "set", value: "" };
  if (/^merge\..+\.driver$/.test(k)) return { kind: "set", value: "false" };
  // uploadpack/receivepack: git takes the FIRST value ("more than one uploadpack given,
  // using the first") — `-c` comes after the repo, so it cannot be overridden.
  if (/^remote\..+\.(uploadpack|receivepack)$/.test(k)) return { kind: "refuse", why: `${key} (remote-side command)` };
  if (k === "core.sshcommand") return { kind: "set", value: "ssh" };
  if (k === "core.alternaterefscommand") return { kind: "set", value: "" };
  if (/^gpg\.(.+\.)?program$/.test(k) || k === "gpg.ssh.defaultkeycommand") return { kind: "set", value: "false" };
  if (/^credential\.(.+\.)?helper$/.test(k)) return { kind: "multi" };
  if (/^remote\..+\.vcs$/.test(k)) return { kind: "refuse", why: `${key} (remote helper)` };
  if (/^url\..+\.(insteadof|pushinsteadof)$/.test(k)) return { kind: "refuse", why: `${key} (remote redirection)` };
  if (k === "core.worktree" || k === "core.gitproxy") return { kind: "refuse", why: key };
  if (k.startsWith("hook.")) return { kind: "refuse", why: `${key} (hook from config)` };
  return null;
}

interface ConfigEntry { scope: string; origin: string; key: string; value: string | null }

/** Output of `git config --list --show-scope --show-origin -z`: scope NUL origin NUL key[LF value] NUL. */
export function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split("\0");
  const res: ConfigEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const kv = parts[i + 2]!;
    const nl = kv.indexOf("\n");
    res.push({ scope: parts[i]!, origin: parts[i + 1]!, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? null : kv.slice(nl + 1) });
  }
  return res;
}

const REPO_SCOPES = new Set(["local", "worktree"]);

/** Dynamic `-c` overrides for keys from the repo (layer 2), or the reason for refusal. */
export function repoOverrides(entries: ConfigEntry[]): { args: string[] } | { refuse: string } {
  const trusted = new Map<string, string[]>();
  for (const e of entries) {
    if (REPO_SCOPES.has(e.scope)) continue;
    const k = e.key.toLowerCase();
    trusted.set(k, [...(trusted.get(k) ?? []), e.value ?? ""]);
  }
  const done = new Set<string>();
  const args: string[] = [];
  for (const e of entries) {
    if (!REPO_SCOPES.has(e.scope)) continue;
    const o = overrideFor(e.key);
    if (!o) continue;
    if (o.kind === "refuse") return { refuse: o.why };
    if (done.has(e.key)) continue;
    done.add(e.key);
    const t = trusted.get(e.key.toLowerCase());
    if (o.kind === "multi") {
      // An empty value clears the helper list; then only those from the trusted config are added back.
      args.push("-c", `${e.key}=`);
      for (const v of t ?? []) if (v) args.push("-c", `${e.key}=${v}`);
    } else {
      args.push("-c", `${e.key}=${t?.length ? t[t.length - 1] : o.value}`);
    }
  }
  return { args };
}

const refused = (why: string): RunResult => ({ code: 128, stdout: "", stderr: `devd: host git refused — ${why}`, timedOut: false });

/** Secures one host git command. Returns the adjusted argv/opts, or a refusal result. */
export async function hardenGit(cmd: string[], opts: RunOpts, raw: Raw): Promise<{ cmd: string[]; opts: RunOpts } | { result: RunResult }> {
  const sub = subcommandIndex(cmd);
  const globals = cmd.slice(1, sub < 0 ? cmd.length : sub);
  const rest = sub < 0 ? [] : cmd.slice(sub);
  // Directory git will run in: cwd + an optional -C.
  let dir = resolve(opts.cwd ?? process.cwd());
  for (let i = 0; i < globals.length; i++) if (globals[i] === "-C" && globals[i + 1] !== undefined) dir = resolve(dir, globals[++i]!);
  const env = { ...(opts.env ?? {}), ...SAFE_GIT_ENV };
  const unsetEnv = [...(opts.unsetEnv ?? []), ...UNSAFE_GIT_ENV];

  const roots = untrustedRoots().filter(Boolean).map(canon);
  const target = canon(dir);
  if (roots.some((r) => within(target, r))) return { result: refused("repo belongs to a restricted (shared/tainted) session") };

  // Layer 2: the repo config up front. The probe itself is git, but `config --list` runs nothing.
  const probe = await raw(["git", ...SAFE_GIT_CONFIG.flatMap((c) => ["-c", c]), ...globals, "config", "--list", "--show-scope", "--show-origin", "-z"],
    { cwd: opts.cwd, env, unsetEnv, timeoutMs: Math.min(opts.timeoutMs, 30_000) });
  if (probe.timedOut) return { result: refused("reading git config timed out") };
  if (probe.code !== 0) return { result: { ...probe, stderr: probe.stderr || refused("git config failed").stderr } };
  const entries = parseConfigList(probe.stdout);
  for (const e of entries) {
    if (!REPO_SCOPES.has(e.scope) || !e.origin.startsWith("file:")) continue;
    const f = e.origin.slice(5);
    const file = canon(isAbsolute(f) ? f : resolve(dir, f));
    if (roots.some((r) => within(file, r))) return { result: refused("repo config lives in a restricted (shared/tainted) session") };
  }
  const dyn = repoOverrides(entries);
  if ("refuse" in dyn) return { result: refused(`config repa nastavuje ${dyn.refuse}`) };

  const fixed = SAFE_GIT_CONFIG.flatMap((c) => ["-c", c]);
  const tail = rest.length && DIFF_CMDS.has(rest[0]!) ? [rest[0]!, "--no-ext-diff", "--no-textconv", ...rest.slice(1)] : rest;
  // Order: fixed and dynamic overrides BEFORE the caller's global options (safe.directory,
  // credential.helper for InstaBox…), so the caller can deliberately override e.g. the helper.
  return { cmd: [cmd[0]!, ...fixed, ...dyn.args, ...globals, ...tail], opts: { ...opts, env, unsetEnv } };
}
