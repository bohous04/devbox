// Host git (devd, root) over agent-controlled repos must not run code the repo configures:
// hooks (core.hooksPath and .git/hooks), core.fsmonitor, filter drivers via .gitattributes.
// This pins down what safeGit.ts (layer 1 fixed -c, layer 2 overrides from the config probe)
// already guarantees for the commands devd runs on a session's workspace.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { addWorktree, fetchBare, pullWithRebase, removeWorktree } from "../src/git";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): void {
  const r = sh(cwd, "git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** Arms `repoGitDir` (a .git dir or a bare clone) with every code-running knob; each writes `marker`. */
function arm(repoGitDir: string, worktree: string | null, marker: string): void {
  const script = join(tmp("repocode-bin-"), "evil.sh");
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\ncat\n`);
  chmodSync(script, 0o755);
  const hooks = join(repoGitDir, "evil-hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["post-checkout", "post-merge", "post-rewrite", "pre-rebase", "reference-transaction", "pre-auto-gc", "post-index-change"]) {
    for (const dir of [hooks, join(repoGitDir, "hooks")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, h), `#!/bin/sh\n${JSON.stringify(script)} ${h}\n`);
      chmodSync(join(dir, h), 0o755);
    }
  }
  const cfg = (k: string, v: string) => git(repoGitDir, "--git-dir", repoGitDir, "config", k, v);
  cfg("core.hooksPath", hooks);
  cfg("core.fsmonitor", script);
  cfg("filter.evil.clean", script);
  cfg("filter.evil.smudge", script);
  cfg("filter.evil.required", "true");
  cfg("diff.evil.textconv", script);
  cfg("core.sshCommand", script);
  if (worktree) writeFileSync(join(worktree, ".gitattributes"), "* filter=evil diff=evil\n");
}

function origin(): { root: string; url: string } {
  const root = tmp("repocode-");
  git(root, "init", "-q", "--bare", "harbor.git");
  const seed = join(root, "seed");
  git(root, "clone", "-q", join(root, "harbor.git"), seed);
  writeFileSync(join(seed, "a.txt"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { root, url: join(root, "harbor.git") };
}

test("pull --rebase --autostash on an armed workspace runs none of the repo's hooks, fsmonitor or filters", async () => {
  const { root, url } = origin();
  const ws = join(root, "work");
  git(root, "clone", "-q", url, ws);
  // Something to pull and something to autostash.
  const seed = join(root, "seed");
  writeFileSync(join(seed, "b.txt"), "2\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "more");
  git(seed, "push", "-q", "origin", "HEAD:main");
  writeFileSync(join(ws, "a.txt"), "local\n");
  const marker = join(tmp("repocode-marker-"), "ran");
  arm(join(ws, ".git"), ws, marker);
  const r = await pullWithRebase(ws);
  expect(existsSync(marker)).toBe(false);
  expect(r.status).toBe("clean");
  // Control: the same repo under plain (unhardened) git does run the planted code.
  sh(ws, "git", "status");
  expect(existsSync(marker)).toBe(true);
});

test("fetch, worktree add and worktree remove on an armed bare clone run none of its hooks, fsmonitor or filters", async () => {
  const { root, url } = origin();
  const bare = join(root, "bare.git");
  git(root, "clone", "-q", "--bare", url, bare);
  git(bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const marker = join(tmp("repocode-marker-"), "ran");
  arm(bare, null, marker);
  git(bare, "--git-dir", bare, "config", "--unset", "core.sshCommand"); // a local url never uses ssh
  await fetchBare(bare);
  const wt = join(root, "harbor-1");
  await addWorktree(bare, wt, "session/harbor-1", "main");
  writeFileSync(join(wt, ".gitattributes"), "* filter=evil diff=evil\n");
  await removeWorktree(bare, wt);
  expect(existsSync(marker)).toBe(false);
  // Control: plain git in the same bare clone does run the planted hooks.
  sh(root, "git", "-C", bare, "worktree", "add", "-q", join(root, "harbor-2"), "main");
  expect(existsSync(marker)).toBe(true);
});
