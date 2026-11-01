import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTurnDiff } from "../src/criticDiff";
import { pullWithRebase, sh as devdSh, worktreeChanges } from "../src/git";
import { run } from "../src/proc";
import { overrideFor, parseConfigList, repoOverrides, setUntrustedGitRoots, subcommandIndex } from "../src/safeGit";
import { collectGitStats } from "../src/stats";
import { pushBranch, unpushedInRepo } from "../src/unpushed";
import { sh } from "./helpers/sh";

afterEach(() => setUntrustedGitRoots(null));

/** A repo with a commit in which the terminal host planted everything git can use to run
 *  a command: fsmonitor, diff.external, filter/diff drivers via .gitattributes, hooks,
 *  merge driver, gpg.program + log.showSignature, pager, credential helper. Every "attack" writes a line
 *  to MARK; `cat` in the filter just passes data through so git does not fail before it runs it. */
function poisonedRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "devd-safegit-")));
  const mark = join(base, "MARK");
  const hit = join(base, "hit.sh");
  writeFileSync(hit, `#!/bin/sh\necho "hit $0 $*" >> ${mark}\nexit 0\n`);
  const filt = join(base, "filter.sh");
  writeFileSync(filt, `#!/bin/sh\necho "filter $*" >> ${mark}\ncat\n`);
  chmodSync(hit, 0o755); chmodSync(filt, 0o755);

  const origin = join(base, "origin.git");
  sh(base, "git", "init", "-q", "--bare", origin);
  const ws = join(base, "ws");
  sh(base, "git", "clone", "-q", origin, ws);
  const g = (...a: string[]) => sh(ws, "git", ...a);
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(ws, "a.txt"), "one\n");
  g("add", "."); g("commit", "-qm", "init"); g("push", "-q", "origin", "HEAD");
  // Upstream gets a commit so pull --rebase has something to do (and would run hooks/drivers).
  const other = join(base, "other");
  sh(base, "git", "clone", "-q", origin, other);
  sh(other, "git", "config", "user.email", "t@t"); sh(other, "git", "config", "user.name", "t");
  writeFileSync(join(other, "b.txt"), "remote\n");
  sh(other, "git", "add", "."); sh(other, "git", "commit", "-qm", "remote"); sh(other, "git", "push", "-q", "origin", "HEAD");

  // Only now the poisoning (git above must not have triggered it yet).
  g("config", "core.fsmonitor", hit);
  g("config", "diff.external", hit);
  g("config", "filter.ev.clean", filt);
  g("config", "filter.ev.smudge", filt);
  g("config", "filter.ev.process", hit);
  g("config", "filter.ev.required", "true");
  g("config", "diff.ev.textconv", hit);
  g("config", "diff.ev.command", hit);
  g("config", "merge.ev.driver", hit);
  g("config", "gpg.program", hit);
  g("config", "log.showSignature", "true");
  g("config", "core.pager", hit);
  g("config", "credential.helper", `!${hit} cred`);
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  for (const h of ["pre-rebase", "post-checkout", "post-rewrite", "post-merge", "pre-push", "reference-transaction", "pre-auto-gc"]) {
    writeFileSync(join(ws, ".git", "hooks", h), `#!/bin/sh\necho "hook ${h}" >> ${mark}\n`);
    chmodSync(join(ws, ".git", "hooks", h), 0o755);
  }
  writeFileSync(join(ws, ".gitattributes"), "* filter=ev diff=ev merge=ev\n");
  writeFileSync(join(ws, "a.txt"), "one\ntwo\n");
  const marks = () => (existsSync(mark) ? readFileSync(mark, "utf8") : "");
  return { base, ws, origin, mark, marks, hit };
}

test("N3: devd git calls on a poisoned repo run nothing (fsmonitor, diff.external, filters, hooks, drivers)", async () => {
  const r = poisonedRepo();
  // Check that the trap works: plain git triggers it.
  sh(r.ws, "git", "diff", "--numstat");
  expect(r.marks()).not.toBe("");
  rmSync(r.mark, { force: true });

  const stats = await collectGitStats(r.ws);
  expect(stats.added).toBeGreaterThanOrEqual(1);
  await devdSh(r.ws, "git", "-c", `safe.directory=${r.ws}`, "log", "-p", "-3");
  await devdSh(r.ws, "git", "-c", `safe.directory=${r.ws}`, "show", "HEAD");
  expect(await worktreeChanges(r.ws)).not.toBeNull();
  await collectTurnDiff(r.ws, null);
  await unpushedInRepo(r.ws);
  // Commit so rebase has something to replay and push something to send.
  sh(r.ws, "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "filter.ev.clean=", "-c", "filter.ev.process=", "-c", "filter.ev.required=false", "commit", "-qam", "local");
  rmSync(r.mark, { force: true });
  const pulled = await pullWithRebase(r.ws);
  expect(pulled).toEqual({ status: "clean" });
  await pushBranch(r.ws, (sh(r.ws, "git", "branch", "--show-current").stdout.trim() || "master"), {});
  expect(r.marks()).toBe("");
});

test("N3: a plain repo works unchanged (stats, pull --rebase, push)", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "devd-safegit-ok-")));
  const origin = join(base, "o.git");
  sh(base, "git", "init", "-q", "--bare", origin);
  const ws = join(base, "ws");
  sh(base, "git", "clone", "-q", origin, ws);
  sh(ws, "git", "config", "user.email", "t@t"); sh(ws, "git", "config", "user.name", "t");
  writeFileSync(join(ws, "a"), "1\n"); sh(ws, "git", "add", "."); sh(ws, "git", "commit", "-qm", "x");
  const branch = sh(ws, "git", "branch", "--show-current").stdout.trim();
  expect(await pushBranch(ws, branch, {})).toEqual({ ok: true });
  writeFileSync(join(ws, "a"), "1\n2\n");
  expect(await collectGitStats(ws)).toMatchObject({ commits: 1, added: 1, removed: 0 });
  expect((await pullWithRebase(ws)).status).toBe("clean");
});

test("N3: host git does not run at all on a restricted session's repo (setUntrustedGitRoots) — not even via a worktree sharing the bare clone", async () => {
  const r = poisonedRepo();
  setUntrustedGitRoots(() => [r.ws]);
  const res = await run(["git", "-C", r.ws, "-c", `safe.directory=${r.ws}`, "status"], { timeoutMs: 10_000 });
  expect(res.code).toBe(128);
  expect(res.stderr).toContain("restricted");
  expect(await collectGitStats(r.ws)).toEqual({ commits: 0, added: 0, removed: 0, unpushed: 0 });

  // Worktree OUTSIDE the restricted root, but the config (bare / common dir) inside it → also refused.
  const wt = join(r.base, "wt");
  sh(r.ws, "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "filter.ev.smudge=", "-c", "filter.ev.process=", "-c", "filter.ev.required=false", "worktree", "add", "-q", wt);
  const viaWt = await run(["git", "-C", wt, "-c", `safe.directory=*`, "log", "--oneline"], { timeoutMs: 10_000 });
  expect(viaWt.code).toBe(128);
  expect(viaWt.stderr).toContain("restricted");
  setUntrustedGitRoots(null);
  expect((await run(["git", "-C", wt, "-c", `safe.directory=*`, "log", "--oneline"], { timeoutMs: 10_000 })).code).toBe(0);
  expect(r.marks()).toBe("");
});

test("N3: what cannot be neutralised (core.worktree, url.insteadOf, remote.vcs/uploadpack/receivepack, hook.*) → refusal", async () => {
  for (const [k, v] of [["core.worktree", "/etc"], ["url./srv/x.insteadOf", "https://github.com/"], ["remote.origin.vcs", "ext"], ["hook.x.command", "id"],
    ["remote.origin.uploadpack", "sh -c id"], ["remote.origin.receivepack", "sh -c id"]] as const) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "devd-safegit-ref-")));
    sh(base, "git", "init", "-q");
    sh(base, "git", "config", k, v);
    const res = await run(["git", "-c", `safe.directory=${base}`, "status"], { cwd: base, timeoutMs: 10_000 });
    expect(res.code).toBe(128);
    expect(res.stderr).toContain("host git refused");
  }
});

test("N3: host git argv carries fixed -c, env and --no-ext-diff/--no-textconv for diff/log/show", async () => {
  const seen: { cmd: string[]; env?: Record<string, string> }[] = [];
  const { hardenGit } = await import("../src/safeGit");
  const raw = async (cmd: string[], o: { env?: Record<string, string> }) => {
    seen.push({ cmd, env: o.env });
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const h = await hardenGit(["git", "-C", "/tmp", "-c", "safe.directory=/tmp", "diff", "--numstat"], { timeoutMs: 1000 }, raw);
  expect("cmd" in h).toBe(true);
  if (!("cmd" in h)) return;
  const a = h.cmd.join(" ");
  for (const c of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "core.attributesFile=/dev/null", "protocol.ext.allow=never"]) expect(a).toContain(`-c ${c}`);
  expect(a.endsWith("-C /tmp -c safe.directory=/tmp diff --no-ext-diff --no-textconv --numstat")).toBe(true);
  expect(h.opts.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  expect(h.opts.unsetEnv).toContain("GIT_EXTERNAL_DIFF");
  // Probe = git config --list on the same repo.
  expect(seen[0]!.cmd.slice(-5)).toEqual(["config", "--list", "--show-scope", "--show-origin", "-z"]);
  // Pull without --no-ext-diff (it does not support it), but with hooks to /dev/null.
  const p = await hardenGit(["git", "pull", "--rebase"], { cwd: "/tmp", timeoutMs: 1000 }, raw);
  if (!("cmd" in p)) throw new Error("refused");
  expect(p.cmd.slice(-2)).toEqual(["pull", "--rebase"]);
  expect(p.cmd.join(" ")).toContain("-c core.hooksPath=/dev/null");
});

test("safeGit: parseConfigList, subcommandIndex and overriding keys from the repo", () => {
  const out = "global\0file:/root/.gitconfig\0core.sshcommand\nssh -i /root/.ssh/devd\0global\0file:/root/.gitconfig\0credential.helper\nstore\0"
    + "local\0file:.git/config\0core.sshcommand\nsh -c evil\0local\0file:.git/config\0credential.helper\n!evil\0"
    + "local\0file:.git/config\0filter.Ev.clean\nevil\0local\0file:.git/config\0core.bare\0";
  const e = parseConfigList(out);
  expect(e).toHaveLength(6);
  expect(e[5]).toEqual({ scope: "local", origin: "file:.git/config", key: "core.bare", value: null });
  const o = repoOverrides(e);
  expect(o).toEqual({ args: [
    "-c", "core.sshcommand=ssh -i /root/.ssh/devd", // the trusted value from the global config stays
    "-c", "credential.helper=", "-c", "credential.helper=store",
    "-c", "filter.Ev.clean=",
  ] });
  expect(overrideFor("core.sshcommand")).toEqual({ kind: "set", value: "ssh" });
  expect(overrideFor("x.a=b.k")?.kind).toBe("refuse");
  expect(overrideFor("user.name")).toBeNull();
  expect(subcommandIndex(["git", "-C", "/x", "-c", "a=b", "--no-pager", "log", "-p"])).toBe(6);
  expect(subcommandIndex(["git", "--version"])).toBe(-1);
});
