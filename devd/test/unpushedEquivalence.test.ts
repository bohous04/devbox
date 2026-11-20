// The one-pass unpushedInRepo must report exactly what the per-branch implementation it replaced
// did. `reference` below is that implementation verbatim (one rev-list per branch, one log per
// branch), kept here as the oracle.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, timeoutFor, type RunResult } from "../src/proc";
import { unpushedInRepo, type UnpushedBranch } from "../src/unpushed";
import { sh } from "./helpers/sh";

async function git(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["git", "-C", dir, "-c", `safe.directory=${dir}`, ...args], { timeoutMs: timeoutFor("LOCAL") });
}
async function reference(dir: string, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 30;
  const total = await git(dir, "rev-list", "--count", "--branches", "--not", "--remotes");
  if (total.code !== 0) return { noRemote: false, count: 0, branches: [], error: (total.stderr || total.stdout).trim() || `git failed (${total.code})` };
  if ((parseInt(total.stdout.trim(), 10) || 0) === 0) return { noRemote: false, count: 0, branches: [] };
  const remotes = await git(dir, "remote");
  const noRemote = remotes.code === 0 && remotes.stdout.trim() === "";
  const refs = await git(dir, "for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%09%(refname)%09%(upstream:short)", "refs/heads");
  if (refs.code !== 0) return { noRemote, count: 0, branches: [], error: refs.stderr.trim() };
  const heads = refs.stdout.split("\n").filter(Boolean).map((l) => {
    const [head, ref, upstream] = l.split("\t");
    return { head: head === "*", ref, branch: ref.replace(/^refs\/heads\//, ""), upstream: upstream || null, hashes: [] as string[] };
  });
  for (const h of heads) {
    const list = await git(dir, "rev-list", h.ref, "--not", "--remotes", "--");
    if (list.code === 0) h.hashes = list.stdout.split("\n").filter(Boolean);
  }
  heads.sort((a, b) => a.hashes.length - b.hashes.length || Number(b.head) - Number(a.head));
  const seen = new Set<string>();
  const branches: UnpushedBranch[] = [];
  for (const h of heads) {
    const fresh = h.hashes.filter((x) => !seen.has(x));
    if (!fresh.length) continue;
    for (const x of fresh) seen.add(x);
    const shown = fresh.slice(0, limit);
    const details = await git(dir, "log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%ct%x1f%an", ...shown);
    const commits = details.code === 0 ? details.stdout.split("\n").filter(Boolean).map((l) => {
      const [hash, subject, ct, author] = l.split("\x1f");
      return { hash, subject, at: (parseInt(ct, 10) || 0) * 1000, author };
    }) : shown.map((hash) => ({ hash, subject: "", at: 0, author: "" }));
    branches.push({ branch: h.branch, upstream: h.upstream, count: fresh.length, commits, truncated: fresh.length > shown.length });
  }
  return { noRemote, count: seen.size, branches };
}

/** A repo whose commits get explicit dates: `tick` seconds apart, or all in one second (`tie`). */
function repo(o: { remote: boolean; tie?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), "unpushed-eq-"));
  const work = join(base, "work");
  let t = 1_700_000_000;
  const env = () => { if (!o.tie) t += 60; return { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` }; };
  const g = (...a: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=Tess", "-c", "user.email=t@example.com", ...a], { cwd: work, env: env(), stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
  };
  let n = 0;
  const commit = (msg: string) => { writeFileSync(join(work, `f${n++}.txt`), msg); g("add", "."); g("commit", "-qm", msg); };
  if (o.remote) {
    sh(base, "git", "init", "-q", "--bare", "-b", "main", join(base, "origin.git"));
    sh(base, "git", "clone", "-q", join(base, "origin.git"), work);
  } else sh(base, "git", "init", "-q", "-b", "main", work);
  return { work, g, commit, base };
}

/** Several branches over one unpushed main, shared commits, a branch merged into another, a merge
 *  commit, a fully pushed branch, a tag named like a branch, a branch at the same tip as another. */
function rich(o: { remote: boolean; tie?: boolean }) {
  const r = repo(o);
  r.commit("base");
  if (o.remote) r.g("push", "-q", "-u", "origin", "main");
  r.commit("main 1"); r.commit("main 2");                       // unpushed on main
  r.g("checkout", "-qb", "feat"); r.commit("feat 1"); r.commit("feat 2"); r.commit("feat 3");
  r.g("checkout", "-qb", "sub"); r.commit("sub 1");
  r.g("checkout", "-q", "feat"); r.commit("feat 4");
  r.g("merge", "-q", "--no-ff", "-m", "merge sub", "sub");        // sub merged into feat
  r.g("branch", "same-as-feat");
  r.g("checkout", "-q", "main"); r.g("checkout", "-qb", "side"); r.commit("side 1");
  r.g("tag", "side");                                             // tag colliding with a branch name
  r.commit("side 2");
  if (o.remote) {
    r.g("checkout", "-q", "main"); r.g("checkout", "-qb", "pushed"); r.commit("pushed 1"); r.g("push", "-q", "origin", "pushed");
  }
  r.g("checkout", "-q", "feat");
  for (let i = 0; i < 5; i++) r.commit(`feat long ${i}`);
  return r;
}

for (const remote of [true, false]) {
  for (const tie of [false, true]) {
    for (const limit of [30, 2]) {
      test(`one-pass unpushedInRepo equals the per-branch reference (remote=${remote}, same-second commits=${tie}, limit=${limit})`, async () => {
        const r = rich({ remote, tie });
        expect(await unpushedInRepo(r.work, { limit })).toEqual(await reference(r.work, { limit }));
      });
    }
  }
}

test("one-pass equals the reference on a bare clone and on a clean repo", async () => {
  const r = rich({ remote: true });
  const bare = join(r.base, "mirror.git");
  sh(r.base, "git", "clone", "-q", "--bare", r.work, bare);
  sh(bare, "git", "remote", "add", "up", join(r.base, "origin.git"));
  sh(bare, "git", "fetch", "-q", "up");
  expect(await unpushedInRepo(bare)).toEqual(await reference(bare));
  const clean = repo({ remote: true });
  clean.commit("base"); clean.g("push", "-q", "-u", "origin", "main");
  expect(await unpushedInRepo(clean.work)).toEqual(await reference(clean.work));
});

test("many branches: the one-pass scan runs a fixed number of git calls, not one per branch", async () => {
  const r = rich({ remote: true });
  for (let i = 0; i < 40; i++) { r.g("checkout", "-q", "-b", `wip-${i}`, "main"); r.commit(`wip ${i}`); }
  const expected = await reference(r.work);
  // A git on PATH that logs each call's subcommand args, then runs the real one.
  const bin = mkdtempSync(join(tmpdir(), "unpushed-gitlog-"));
  const log = join(bin, "calls");
  const real = sh("/", "which", "git").stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try { expect(await unpushedInRepo(r.work)).toEqual(expected); }
  finally { process.env.PATH = path; }
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => / (rev-list|log) /.test(l) && !/ config --list /.test(l));
  expect(calls.length).toBeLessThanOrEqual(2);
}, 30_000);
