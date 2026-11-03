import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tools/privacy-check.py against a throwaway repository and an invented deny-list.
const SCRIPT = join(import.meta.dir, "privacy-check.py");
const DENYLIST = ["# test list", "secretclient", "10\\.9\\.8\\.", "!github\\.com/secretclient/public-repo"].join("\n");

function repo(files: Record<string, string | Uint8Array>, author = "Pat <pat@example.com>") {
  const dir = mkdtempSync(join(tmpdir(), "privacy-check-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Base", "-c", "user.email=base@example.com", "commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git("add", "-A");
  const [name, email] = author.replace(">", "").split(" <");
  git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", "change");
  return { dir, range: `${base}..HEAD` };
}

function check(dir: string, range: string, denylist = DENYLIST) {
  const r = Bun.spawnSync(["python3", SCRIPT, range], { cwd: dir, env: { ...process.env, DENYLIST: denylist }, stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test("a clean tree and clean commits pass", () => {
  const { dir, range } = repo({ "README.md": "hello\n" });
  expect(check(dir, range).code).toBe(0);
});

test("a deny-listed term in a file fails with file:line, but the output never repeats the term", () => {
  const { dir, range } = repo({ "docs/a.md": "line one\nwe deployed for SecretClient today\n" });
  const r = check(dir, range);
  expect(r.code).toBe(1);
  expect(r.out).toContain("docs/a.md:2: matches pattern #1");
  expect(r.out.toLowerCase()).not.toContain("secretclient");
});

test("an allowed occurrence passes, but only that occurrence on the line", () => {
  expect(check(...Object.values(repo({ "a.md": "see https://github.com/secretclient/public-repo\n" })) as [string, string]).code).toBe(0);
  const r = check(...Object.values(repo({ "a.md": "https://github.com/secretclient/public-repo and secretclient\n" })) as [string, string]);
  expect(r.code).toBe(1);
});

test("paths, binary strings and commit authors are checked too", () => {
  expect(check(...Object.values(repo({ "secretclient/notes.txt": "x\n" })) as [string, string]).out).toContain("path matches pattern #1");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, ...new TextEncoder().encode("host 10.9.8.7 inside"), 0]);
  expect(check(...Object.values(repo({ "shot.png": png })) as [string, string]).out).toContain("shot.png: binary content matches pattern #2");
  const r = check(...Object.values(repo({ "a.md": "x\n" }, "Someone <someone@secretclient.example>")) as [string, string]);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/commit [0-9a-f]{12}: author matches pattern #1/);
});

test("without a deny-list (fork pull request) the check is skipped, not failed", () => {
  const { dir, range } = repo({ "a.md": "secretclient\n" });
  const r = check(dir, range, "");
  expect(r.code).toBe(0);
  expect(r.out).toContain("skipped");
});

test("a rewritten push fetches its missing before-SHA and still scans the new commit's metadata", () => {
  const { dir } = repo({ "README.md": "hello\n" }, "Prior <prior@secretclient.example>");
  const run = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const old = run(dir, "rev-parse", "HEAD");
  const parent = run(dir, "rev-parse", "HEAD^");
  const tree = run(dir, "rev-parse", "HEAD^{tree}");
  const clean = run(dir, "-c", "user.name=Clean", "-c", "user.email=clean@example.com", "commit-tree", tree, "-p", parent, "-m", "clean metadata");
  const root = mkdtempSync(join(tmpdir(), "privacy-force-push-"));
  const origin = join(root, "origin.git");
  run(dir, "clone", "--bare", "-q", dir, origin);
  // GitHub permits fetching an existing commit by SHA even after its ref was rewritten.
  run(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  run(origin, "update-ref", "refs/heads/main", clean, old);
  const checkout = join(root, "checkout");
  run(root, "clone", "--no-local", "-q", origin, checkout);
  expect(Bun.spawnSync(["git", "cat-file", "-e", old], { cwd: checkout, stderr: "ignore" }).exitCode).not.toBe(0);
  expect(check(checkout, `${old}..${clean}`).code).toBe(0);
  expect(run(checkout, "cat-file", "-t", old)).toBe("commit");

  run(checkout, "-c", "user.name=New", "-c", "user.email=new@secretclient.example", "commit", "--allow-empty", "-q", "-m", "new metadata");
  const rejected = check(checkout, `${old}..HEAD`);
  expect(rejected.code).toBe(1);
  expect(rejected.out).toMatch(/author matches pattern #1/);
  expect(rejected.out.toLowerCase()).not.toContain("secretclient");
});

test("an unavailable before-SHA fails closed instead of skipping commit checks", () => {
  const { dir } = repo({ "README.md": "hello\n" });
  expect(check(dir, `${"a".repeat(40)}..HEAD`).code).not.toBe(0);
});

test("only a GitHub-verified owner noreply merge can normalize its public display name", () => {
  const code = `
import copy, os, runpy, sys
m = runpy.run_path(sys.argv[1])
normalize = m['public_merge_author']
scope = normalize.__globals__
os.environ['GITHUB_REPOSITORY'] = 'maintainer/project'
sha, parents = 'a' * 40, 'b' * 40 + ' ' + 'c' * 40
author = 'SecretClient <123+maintainer@users.noreply.github.com>'
committer = 'GitHub <noreply@github.com>'
fixture = {'sha': sha, 'author': {'login': 'maintainer'}, 'committer': {'login': 'web-flow'},
 'commit': {'author': {'name': 'SecretClient', 'email': '123+maintainer@users.noreply.github.com'},
 'verification': {'verified': True, 'reason': 'valid'}}, 'parents': [{'sha': p} for p in parents.split()]}
scope['github_commit'] = lambda *args: fixture
expected = 'maintainer <123+maintainer@users.noreply.github.com>'
assert normalize(sha, author, committer, parents) == expected
deny, allow = m['load_patterns']('SecretClient')
assert m['offending'](expected, deny, allow) is None
deny, allow = m['load_patterns']('users\\\\.noreply')
assert m['offending'](expected, deny, allow) == 1 # Email is never exempted.
assert normalize(sha, author, committer, 'b' * 40) == author
assert normalize(sha, author, 'Local <local@example.com>', parents) == author
private = 'SecretClient <maintainer@example.com>'
assert normalize(sha, private, committer, parents) == private
for field in ['signature', 'sha', 'parents', 'identity', 'webflow']:
 data = copy.deepcopy(fixture)
 if field == 'signature': data['commit']['verification']['verified'] = False
 if field == 'sha': data['sha'] = 'd' * 40
 if field == 'parents': data['parents'].reverse()
 if field == 'identity': data['commit']['author']['name'] = 'Someone else'
 if field == 'webflow': data['committer']['login'] = 'maintainer'
 scope['github_commit'] = lambda *args: data
 assert normalize(sha, author, committer, parents) == author
def unavailable(*args): raise OSError('offline')
scope['github_commit'] = unavailable
assert normalize(sha, author, committer, parents) == author
`;
  const r = Bun.spawnSync(["python3", "-c", code, SCRIPT], { stderr: "pipe" });
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});
