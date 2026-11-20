import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentChownArgv, agentRepoDirs, ownAgentRepos, ownershipHints, untraversableForAgent } from "../src/agentRepos";

/** harbor/api.git (bare, flat), harbor/shop/web (workspace), _sessions/dev-web (worktree),
 *  plus things that must NOT be touched: _inbox/x with a .git, a symlinked "repo", a non-repo dir. */
function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentrepos-")));
  mkdirSync(join(root, "harbor", "api.git", "objects"), { recursive: true });
  writeFileSync(join(root, "harbor", "api.git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "harbor", "shop", "web", ".git"), { recursive: true });
  writeFileSync(join(root, "harbor", "shop", "web", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "harbor", "shop", "web", "a.txt"), "1\n");
  mkdirSync(join(root, "_sessions", "dev-web"), { recursive: true });
  writeFileSync(join(root, "_sessions", "dev-web", ".git"), "gitdir: x\n");
  mkdirSync(join(root, "_sessions", "not-a-worktree"), { recursive: true });
  mkdirSync(join(root, "_inbox", "x", ".git"), { recursive: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agentrepos-out-")));
  mkdirSync(join(outside, ".git"));
  symlinkSync(outside, join(root, "harbor", "linked"));
  // A symlinked folder: its repos live elsewhere and must not be found through it.
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "agentrepos-else-")));
  mkdirSync(join(elsewhere, "app", ".git"), { recursive: true });
  symlinkSync(elsewhere, join(root, "linkedfolder"));
  return root;
}

test("agentRepoDirs: exactly the bare clones, workspaces and session worktrees; no _-dirs besides _sessions, no symlinks", () => {
  const root = layout();
  expect(agentRepoDirs(root)).toEqual([
    join(root, "_sessions", "dev-web"),
    join(root, "harbor", "api.git"),
    join(root, "harbor", "shop", "web"),
  ]);
});

test("ownAgentRepos dry run: counts entries not owned by the agent uid per repo, without following links, changes nothing", async () => {
  const root = layout();
  symlinkSync("/etc", join(root, "harbor", "shop", "web", "etc-link"));
  const calls: string[][] = [];
  const report = await ownAgentRepos(root, { apply: false, agentUid: -2, chown: async (argv) => { calls.push(argv); } });
  expect(calls).toEqual([]);
  const web = report.find((r) => r.path.endsWith("/web"))!;
  // web, .git, .git/HEAD, a.txt, etc-link (the link itself, not /etc's contents)
  expect(web.foreign).toBe(5);
  expect(report.find((r) => r.path.endsWith("api.git"))!.foreign).toBe(3);
});

test("ownAgentRepos --apply: chown -h -R -P per repo dir that has foreign entries, nothing else", async () => {
  const root = layout();
  const calls: string[][] = [];
  await ownAgentRepos(root, { apply: true, agentUid: -2, chown: async (argv) => { calls.push(argv); } });
  expect(calls).toEqual([
    ["chown", "-h", "-R", "-P", "1000:1000", "--", join(root, "_sessions", "dev-web")],
    ["chown", "-h", "-R", "-P", "1000:1000", "--", join(root, "harbor", "api.git")],
    ["chown", "-h", "-R", "-P", "1000:1000", "--", join(root, "harbor", "shop", "web")],
  ]);
  const none: string[][] = [];
  await ownAgentRepos(root, { apply: true, agentUid: process.getuid!(), chown: async (argv) => { none.push(argv); } });
  expect(none).toEqual([]);
});

test("ownershipHints: cheap startup check names repos whose top or key git files are not the agent uid's", () => {
  const root = layout();
  expect(ownershipHints(root, process.getuid!())).toEqual([]);
  expect(ownershipHints(root, -2)).toEqual(agentRepoDirs(root));
});

test("untraversableForAgent names the root or a parent the agent uid cannot enter", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agentrepos-trav-")));
  const root = join(base, "srv");
  mkdirSync(root);
  chmodSync(base, 0o755);
  // Another uid/gid than the owner: only the "other" bits count.
  expect(untraversableForAgent(root, -2, -2).filter((p) => p.startsWith(base))).toEqual([]);
  chmodSync(base, 0o750);
  try { expect(untraversableForAgent(root, -2, -2)).toContain(base); }
  finally { chmodSync(base, 0o755); }
});

test("agentChownArgv: chown -h -R -P (no link followed, links changed themselves), never find -exec", () => {
  expect(agentChownArgv("/srv/dev/harbor/api.git")).toEqual(["chown", "-h", "-R", "-P", "1000:1000", "--", "/srv/dev/harbor/api.git"]);
});

const asRootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
test.skipIf(!asRootOnLinux)("as root on Linux: agentChownArgv over a tree with a symlinked subdir pointing outside leaves the target root's (needs root; skipped otherwise)", async () => {
  const { run } = await import("../src/proc");
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "agentchown-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agentchown-out-")));
  writeFileSync(join(outside, "secret"), "x");
  mkdirSync(join(tree, "objects"));
  writeFileSync(join(tree, "objects", "pack"), "p");
  symlinkSync(outside, join(tree, "objects", "linked"));
  symlinkSync(join(outside, "secret"), join(tree, "FETCH_HEAD"));
  const r = await run(agentChownArgv(tree), { cwd: "/", timeoutMs: 30_000 });
  expect(r.code).toBe(0);
  for (const p of [tree, join(tree, "objects", "pack")]) expect(statSync(p).uid).toBe(1000);
  expect(lstatSync(join(tree, "objects", "linked")).uid).toBe(1000);
  expect(lstatSync(join(tree, "FETCH_HEAD")).uid).toBe(1000);
  expect(statSync(outside).uid).toBe(0);
  expect(statSync(join(outside, "secret")).uid).toBe(0);
});
