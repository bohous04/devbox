import { expect, test } from "bun:test";
import type { UnpushedBranch, UnpushedReport, UnpushedRepo } from "./api";
import { branchKey, branchLabel, canCreatePr, canPush, commitsLabel, folderKey, prBody, prTitle, repoFlags, repoKey, repoTitle, shortHash, toggled, withoutPushed } from "./unpushedView";

const repo = (over: Partial<UnpushedRepo> = {}): UnpushedRepo => ({
  folder: "acme", project: "portal", repo: "web", path: "/srv/dev/acme/portal/web", bare: false, noRemote: false,
  count: 1, branches: [], ...over,
});
const branch = (over: Partial<UnpushedBranch> = {}): UnpushedBranch => ({
  branch: "main", upstream: "origin/main", count: 1, commits: [], truncated: false, ...over,
});

test("shortHash shortens to 7 characters and leaves an empty hash empty", () => {
  expect(shortHash("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  expect(shortHash("")).toBe("");
});

test("repoTitle: a repo in a project is project/repo, a flat repo (project === folder) just repo", () => {
  expect(repoTitle(repo())).toBe("portal/web");
  expect(repoTitle(repo({ folder: "apps", project: "apps", repo: "web" }))).toBe("web");
});

test("repoFlags: a bare clone and a repo without a remote get a tag, a plain repo none", () => {
  expect(repoFlags(repo())).toEqual([]);
  expect(repoFlags(repo({ bare: true }))).toEqual(["bare"]);
  expect(repoFlags(repo({ noRemote: true }))).toEqual(["no remote"]);
  expect(repoFlags(repo({ bare: true, noRemote: true }))).toEqual(["bare", "no remote"]);
});

test("branchLabel shows the upstream, or says it is missing", () => {
  expect(branchLabel(branch())).toBe("main → origin/main");
  expect(branchLabel(branch({ branch: "session/web-2", upstream: null }))).toBe("session/web-2 · no upstream");
});

test("canPush: only a repo with a remote and working git", () => {
  expect(canPush(repo())).toBe(true);
  expect(canPush(repo({ noRemote: true }))).toBe(false);
  expect(canPush(repo({ error: "not a git repository" }))).toBe(false);
});

test("canCreatePr: GitHub/Gitea remote only", () => {
  const gh = { provider: "github" as const, url: "https://github.com/o/n.git", host: "github.com", owner: "o", name: "n" };
  expect(canCreatePr(repo({ remote: gh }))).toBe(true);
  expect(canCreatePr(repo({ remote: { ...gh, provider: "gitea" } }))).toBe(true);
  expect(canCreatePr(repo({ remote: { ...gh, provider: "other" } }))).toBe(false);
  expect(canCreatePr(repo({ remote: null }))).toBe(false);
  expect(canCreatePr(repo())).toBe(false);
  expect(canCreatePr(repo({ remote: gh, error: "broken" }))).toBe(false);
});

test("prTitle: one commit = its subject, more commits = the branch name", () => {
  const one = branch({ count: 1, commits: [{ hash: "a".repeat(40), subject: "feat: x", at: 0, author: "t" }] });
  expect(prTitle(one)).toBe("feat: x");
  const many = branch({ branch: "session/web-2", count: 2, commits: [
    { hash: "a".repeat(40), subject: "second", at: 0, author: "t" },
    { hash: "b".repeat(40), subject: "first", at: 0, author: "t" },
  ] });
  expect(prTitle(many)).toBe("session/web-2");
});

test("prBody: bullets from the oldest commit, a truncated listing says so", () => {
  const b = branch({ count: 2, commits: [
    { hash: "a".repeat(40), subject: "second", at: 0, author: "t" },
    { hash: "b".repeat(40), subject: "first", at: 0, author: "t" },
  ] });
  expect(prBody(b)).toBe("- first\n- second");
  expect(prBody(branch({ count: 40, truncated: true, commits: [{ hash: "a".repeat(40), subject: "x", at: 0, author: "t" }] })))
    .toBe("- x\n\n…and 39 more commits");
});

test("commitsLabel pluralizes and for a truncated listing says how many are shown", () => {
  expect(commitsLabel(1)).toBe("1 commit");
  expect(commitsLabel(4)).toBe("4 commits");
  expect(commitsLabel(41, 30)).toBe("41 commits · showing 30");
  expect(commitsLabel(4, 30)).toBe("4 commits");
});

test("toggled: adds a missing key, removes a present one and does not modify the input set", () => {
  const empty = new Set<string>();
  const on = toggled(empty, "a");
  expect([...on]).toEqual(["a"]);
  expect(empty.size).toBe(0);
  const off = toggled(on, "a");
  expect(off.size).toBe(0);
  expect([...on]).toEqual(["a"]);
});

test("expansion keys: folder, repo and branch do not mix up, even with the same name", () => {
  const keys = [folderKey("web"), repoKey("web"), branchKey("web", "web")];
  expect(new Set(keys).size).toBe(3);
  // the same branch in two repos = two different keys
  expect(branchKey("/srv/dev/web/web", "main")).not.toBe(branchKey("/srv/dev/web/other", "main"));
});

test("withoutPushed hides a pushed branch until the report is newer than the push, and fixes the counts", () => {
  const a = branch({ branch: "a", count: 2 });
  const b = branch({ branch: "b", count: 3 });
  const report: UnpushedReport = { at: 1000, total: 6, scanned: 4, folders: [
    { folder: "acme", count: 6, repos: [repo({ count: 5, branches: [a, b] }), repo({ path: "/srv/dev/acme/x", count: 1, branches: [branch({ branch: "a" })] })] },
  ] };
  const pushedA = [{ path: "/srv/dev/acme/portal/web", branch: "a", at: 2000 }];
  const v = withoutPushed(report, pushedA);
  expect(v.total).toBe(4);
  expect(v.folders[0]!.count).toBe(4);
  expect(v.folders[0]!.repos[0]!.count).toBe(3);
  expect(v.folders[0]!.repos[0]!.branches.map((x) => x.branch)).toEqual(["b"]);
  expect(v.folders[0]!.repos[1]!.branches.map((x) => x.branch)).toEqual(["a"]);   // same name, other repo
  // A repo and a folder left with nothing disappear.
  const all = withoutPushed(report, [...pushedA, { path: "/srv/dev/acme/portal/web", branch: "b", at: 2000 }, { path: "/srv/dev/acme/x", branch: "a", at: 2000 }]);
  expect(all).toMatchObject({ total: 0, folders: [] });
  // A report scanned after the push is shown as is.
  expect(withoutPushed({ ...report, at: 2500 }, pushedA)).toEqual({ ...report, at: 2500 });
});
