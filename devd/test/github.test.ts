import { expect, test } from "bun:test";
import { GithubError, listOwners, listRepos, validOwner, type Runner } from "../src/github";

/** Runner stub keyed by the joined command; records invocations. */
function stub(map: Record<string, { code: number; stdout: string; stderr?: string; timedOut?: boolean }>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (_cwd, ...cmd) => {
    calls.push(cmd);
    const hit = map[cmd.join(" ")];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
    return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? "", timedOut: hit.timedOut };
  };
  return { run, calls };
}

const OWNERS_USER = "gh api user --jq {login,name,avatar_url}";
const OWNERS_ORGS = "gh api user/orgs --paginate --jq .[]|{login,avatar_url}";

test("validOwner whitelists logins", () => {
  expect(validOwner("acme")).toBe(true);
  expect(validOwner("me-org_1.x")).toBe(true);
  expect(validOwner("")).toBe(false);
  expect(validOwner("a b")).toBe(false);
  expect(validOwner("a;rm -rf /")).toBe(false);
  expect(validOwner("../etc")).toBe(false);
});

test("listOwners returns the user first, then orgs", async () => {
  const { run } = stub({
    [OWNERS_USER]: { code: 0, stdout: '{"login":"alice","name":"Alice","avatar_url":"https://a/u.png"}\n' },
    [OWNERS_ORGS]: {
      code: 0,
      stdout: '{"login":"acme","avatar_url":"https://a/o1.png"}\n{"login":"pricing","avatar_url":null}\n',
    },
  });
  const owners = await listOwners(run);
  expect(owners).toEqual([
    { login: "alice", kind: "user", name: "Alice", avatarUrl: "https://a/u.png" },
    { login: "acme", kind: "org", avatarUrl: "https://a/o1.png" },
    { login: "pricing", kind: "org" },
  ]);
});

test("listOwners with no orgs returns just the user", async () => {
  const { run } = stub({
    [OWNERS_USER]: { code: 0, stdout: '{"login":"alice","name":null,"avatar_url":null}' },
    [OWNERS_ORGS]: { code: 0, stdout: "" },
  });
  expect(await listOwners(run)).toEqual([{ login: "alice", kind: "user" }]);
});

test("listOwners surfaces gh auth failure as GithubError", async () => {
  const { run } = stub({
    [OWNERS_USER]: { code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login\n" },
  });
  await expect(listOwners(run)).rejects.toThrow(GithubError);
  await expect(listOwners(run)).rejects.toThrow("gh auth login");
});

test("listOwners surfaces a gh timeout as a distinct GithubError", async () => {
  const { run } = stub({
    [OWNERS_USER]: { code: 1, stdout: "", stderr: "", timedOut: true },
  });
  await expect(listOwners(run)).rejects.toThrow(GithubError);
  await expect(listOwners(run)).rejects.toThrow(/timed out/);
});

test("listRepos rejects a hostile owner before shelling out", async () => {
  const { run, calls } = stub({});
  await expect(listRepos("owner; rm -rf /", run)).rejects.toThrow("invalid owner");
  expect(calls).toHaveLength(0);
});

test("listRepos parses and normalizes gh output", async () => {
  const fields = "name,nameWithOwner,url,visibility,description,isPrivate,isArchived,updatedAt";
  const rows = [
    { name: "cms", nameWithOwner: "acme/cms", url: "https://github.com/acme/cms", visibility: "PRIVATE", description: "web cms", isPrivate: true, isArchived: false, updatedAt: "2026-07-01T10:00:00Z" },
    { name: "old", nameWithOwner: "acme/old", url: "https://github.com/acme/old", visibility: "PUBLIC", description: null, isPrivate: false, isArchived: true, updatedAt: "2024-01-01T10:00:00Z" },
  ];
  const { run } = stub({
    [`gh repo list acme --limit 300 --json ${fields}`]: { code: 0, stdout: JSON.stringify(rows) },
  });
  const out = await listRepos("acme", run);
  expect(out).toEqual([
    { name: "cms", nameWithOwner: "acme/cms", url: "https://github.com/acme/cms", visibility: "private", description: "web cms", isPrivate: true, isArchived: false, updatedAt: "2026-07-01T10:00:00Z" },
    { name: "old", nameWithOwner: "acme/old", url: "https://github.com/acme/old", visibility: "public", description: "", isPrivate: false, isArchived: true, updatedAt: "2024-01-01T10:00:00Z" },
  ]);
});

test("listRepos non-zero exit → GithubError with stderr detail", async () => {
  const fields = "name,nameWithOwner,url,visibility,description,isPrivate,isArchived,updatedAt";
  const { run } = stub({
    [`gh repo list ghost --limit 300 --json ${fields}`]: { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a User\n" },
  });
  await expect(listRepos("ghost", run)).rejects.toThrow("Could not resolve");
});
