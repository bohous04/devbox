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
// Layer 2 is best-effort, not a security boundary: a repo the agent controls can change between
// probe and run, and git here runs as root. The structural fix is running host git as the agent
// uid (fix/host-git-as-agent-uid). A local path as a remote (`remote.origin.url=/srv/dev/...`) stays
// allowed (tests and local bare clones use it) — it runs nothing, but pull/push
// would touch a different repo on the host.
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
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

/** The container user: owner of every agent-writable repo. */
export const AGENT_UID = 1000;

let agentRoots: () => string[] = () => [];
/** Roots that hold agent-writable repos (devd's workspace root: workspaces, bare clones, session
 *  worktrees). Used to refuse git in devd's own `_`-dirs there (see classifyGitTarget). */
export function setAgentGitRoots(fn: (() => string[]) | null): void {
  agentRoots = fn ?? (() => []);
}

let trustedRoots: () => string[] = () => [];
/** The only repos host git may touch as root: devd's own (config repo, its checkout). When devd is
 *  root, EVERY other git runs as AGENT_UID (layer 4) — the default is the agent, not root, so a
 *  path that only looks like ours (a symlink out of the agent root) cannot get root's git. */
export function setTrustedGitRoots(fn: (() => string[]) | null): void {
  trustedRoots = fn ?? (() => []);
}

let agentIdentity: { name: string; email: string } | null = null;
/** Identity for commits host git makes as the agent uid (pull --rebase rewrites committers,
 *  --autostash commits). It has no global config there; null = none configured, and such a
 *  command fails with git's own "empty ident" error. */
export function setAgentGitIdentity(id: { name: string; email: string } | null): void {
  agentIdentity = id;
}

/** Where a git target (canonical path) sits relative to an agent root: "agent" = a repo or a
 *  `_sessions/<id>` worktree (git runs as AGENT_UID), "own" = devd's other `_`-dirs (inbox, threads,
 *  archives, recovery copies; never git targets, so git there is refused), "outside" = not under it. */
export function classifyGitTarget(target: string, root: string): "agent" | "own" | "outside" {
  if (!within(target, root)) return "outside";
  const top = relative(root, target).split(sep)[0]!;
  return top.startsWith("_") && top !== "_sessions" ? "own" : "agent";
}

/** Environment of git running as the agent uid: nothing from devd's process env (secrets, root's
 *  HOME/gitconfig/gh), no global or system config. Auth comes only from the caller's explicit env. */
const AGENT_GIT_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
export const asAgent = (cmd: string[]): string[] =>
  ["setpriv", `--reuid=${AGENT_UID}`, `--regid=${AGENT_UID}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", ...cmd];
const identityEnv = (): Record<string, string> => agentIdentity ? {
  GIT_AUTHOR_NAME: agentIdentity.name, GIT_AUTHOR_EMAIL: agentIdentity.email,
  GIT_COMMITTER_NAME: agentIdentity.name, GIT_COMMITTER_EMAIL: agentIdentity.email,
} : {};

/** Repo-scoped keys that redirect or weaken the transport (proxy, TLS checks, resolve, extra
 *  headers that would carry devd's auth elsewhere). Refused for network commands only. */
const NET_KEY = /^(http\.(.+\.)?(proxy|proxyauthmethod|proxysslcert|proxysslkey|proxysslcainfo|sslverify|sslcainfo|sslcapath|sslcert|sslkey|sslbackend|pinnedpubkey|curloptresolve|extraheader|cookiefile|followredirects)|remote\..+\.proxy)$/;
const NET_CMDS = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

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
/** `uid` = devd's own uid (injectable for tests). */
export async function hardenGit(cmd: string[], opts: RunOpts, raw: Raw, uid: number = process.getuid?.() ?? -1): Promise<{ cmd: string[]; opts: RunOpts } | { result: RunResult }> {
  const sub = subcommandIndex(cmd);
  const globals = cmd.slice(1, sub < 0 ? cmd.length : sub);
  const rest = sub < 0 ? [] : cmd.slice(sub);
  // Directory git will run in: cwd + an optional -C.
  let dir = resolve(opts.cwd ?? process.cwd());
  for (let i = 0; i < globals.length; i++) if (globals[i] === "-C" && globals[i + 1] !== undefined) dir = resolve(dir, globals[++i]!);
  const roots = untrustedRoots().filter(Boolean).map(canon);
  const target = canon(dir);
  if (roots.some((r) => within(target, r))) return { result: refused("repo belongs to a restricted (shared/tainted) session") };

  // Layer 4: when devd is root, git runs as the agent uid unless EVERY target (cwd/-C, --git-dir,
  // --work-tree) is in a trusted root — whatever a repo manages to run despite layers 1-3 then runs
  // with the agent's own rights, not root's.
  const targets = [target];
  for (let i = 0; i < globals.length; i++) {
    const a = globals[i]!;
    if ((a === "--git-dir" || a === "--work-tree") && globals[i + 1] !== undefined) targets.push(canon(resolve(dir, globals[++i]!)));
    else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) targets.push(canon(resolve(dir, a.slice(a.indexOf("=") + 1))));
  }
  // Classification under an agent root: repos (`<folder>/<project>/…`) and session worktrees
  // (`_sessions/<id>`) are agent-writable git targets. devd's other `_`-dirs (inbox, threads,
  // archives, recovery copies) are never git targets, so git there is refused rather than run.
  const agent = agentRoots().filter(Boolean).map(canon);
  const classes = targets.flatMap((t) => agent.map((r) => classifyGitTarget(t, r)));
  if (classes.includes("own")) return { result: refused("target is devd's own directory, not a repo") };
  const trusted = trustedRoots().filter(Boolean).map(canon);
  const dropToAgent = uid === 0 && !targets.every((t) => trusted.some((r) => within(t, r)));
  const env = dropToAgent ? { ...identityEnv(), ...(opts.env ?? {}), ...AGENT_GIT_ENV, ...SAFE_GIT_ENV } : { ...(opts.env ?? {}), ...SAFE_GIT_ENV };
  const unsetEnv = [...(opts.unsetEnv ?? []), ...UNSAFE_GIT_ENV];
  const envOpts = dropToAgent ? { env, unsetEnv, inheritEnv: false as const } : { env, unsetEnv };
  const wrap = dropToAgent ? asAgent : (c: string[]) => c;

  // Layer 2: the repo config up front. The probe itself is git, but `config --list` runs nothing.
  const probe = await raw(wrap(["git", ...SAFE_GIT_CONFIG.flatMap((c) => ["-c", c]), ...globals, "config", "--list", "--show-scope", "--show-origin", "-z"]),
    { cwd: opts.cwd, ...envOpts, timeoutMs: Math.min(opts.timeoutMs, 30_000) });
  if (probe.timedOut) return { result: refused("reading git config timed out") };
  if (probe.code !== 0) return { result: { ...probe, stderr: probe.stderr || refused("git config failed").stderr } };
  const entries = parseConfigList(probe.stdout);
  for (const e of entries) {
    if (!REPO_SCOPES.has(e.scope) || !e.origin.startsWith("file:")) continue;
    const f = e.origin.slice(5);
    const file = canon(isAbsolute(f) ? f : resolve(dir, f));
    if (roots.some((r) => within(file, r))) return { result: refused("repo config lives in a restricted (shared/tainted) session") };
  }
  if (rest.length && NET_CMDS.has(rest[0]!)) {
    const net = entries.find((e) => REPO_SCOPES.has(e.scope) && NET_KEY.test(e.key.toLowerCase()));
    if (net) return { result: refused(`repo config sets ${net.key} for a network command`) };
  }
  const dyn = repoOverrides(entries);
  if ("refuse" in dyn) return { result: refused(`config repa nastavuje ${dyn.refuse}`) };

  const fixed = SAFE_GIT_CONFIG.flatMap((c) => ["-c", c]);
  const tail = rest.length && DIFF_CMDS.has(rest[0]!) ? [rest[0]!, "--no-ext-diff", "--no-textconv", ...rest.slice(1)] : rest;
  // Order: fixed and dynamic overrides BEFORE the caller's global options (safe.directory,
  // credential.helper for InstaBox…), so the caller can deliberately override e.g. the helper.
  return { cmd: wrap([cmd[0]!, ...fixed, ...dyn.args, ...globals, ...tail]), opts: { ...opts, ...envOpts } };
}
