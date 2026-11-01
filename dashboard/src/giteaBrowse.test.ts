import { describe, expect, test } from "bun:test";
import type { GiteaRepo } from "./api";
import { deriveOwners, filterGiteaRepos } from "./giteaBrowse";

const repo = (name: string, owner: string, desc = ""): GiteaRepo => ({
  name, fullName: `${owner}/${name}`, owner, description: desc,
  isPrivate: true, isArchived: false, updatedAt: "2026-07-01T10:00:00Z",
  cloneUrl: `http://g/${owner}/${name}.git`,
});

describe("deriveOwners", () => {
  test("unique owners with counts, sorted by count ↓ then alphabetically", () => {
    const repos = [repo("a", "bob"), repo("b", "bob"), repo("c", "alice"), repo("d", "alfa")];
    expect(deriveOwners(repos)).toEqual([
      { login: "bob", repoCount: 2 },
      { login: "alfa", repoCount: 1 },
      { login: "alice", repoCount: 1 },
    ]);
  });
  test("empty owner is skipped", () => {
    expect(deriveOwners([{ ...repo("x", "y"), owner: "" }])).toEqual([]);
  });
});

describe("filterGiteaRepos", () => {
  const repos = [repo("rp_main", "bob", "main server"), repo("web", "alice")];
  test("owner=null + empty query returns everything", () => {
    expect(filterGiteaRepos(repos, null, "")).toEqual(repos);
  });
  test("filters by owner", () => {
    expect(filterGiteaRepos(repos, "alice", "").map((r) => r.name)).toEqual(["web"]);
  });
  test("full-text search across name, fullName and description, case-insensitive", () => {
    expect(filterGiteaRepos(repos, null, "MAIN").map((r) => r.name)).toEqual(["rp_main"]);
    expect(filterGiteaRepos(repos, null, "bob/").map((r) => r.name)).toEqual(["rp_main"]);
  });
  test("owner + query combine", () => {
    expect(filterGiteaRepos(repos, "bob", "web")).toEqual([]);
  });
});
