import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevConfig } from "../src/config";
import type { SessionRow } from "../src/db";
import { barePath, buildTree, giteaLister, isBareLayout, resolveTarget, sessionWorkdir, workspacePath } from "../src/tree";

const cfg: DevConfig = {
  version: 1,
  settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 },
  folders: {
    acme: { projects: { shop: { sources: [{ provider: "github", org: "shop-org" }] }, metro: {} } },
    games: { repos: [{ name: "esx", provider: "gitea", cloneUrl: "https://git.x.cz/o/esx.git" }] },
  },
};

const fakeGithub = async () => [{ name: "cms", cloneUrl: "https://github.com/shop-org/cms.git", provider: "github" as const, cloned: false }];
const fakeGitea = async () => [];

test("buildTree merges sources + pinned repos and marks cloned", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  mkdirSync(join(root, "games", "esx"), { recursive: true });
  const tree = await buildTree(cfg, root, { github: fakeGithub, gitea: fakeGitea });
  const shop = tree.find((p) => p.project === "shop")!;
  expect(shop.repos.map((r) => r.name)).toEqual(["cms"]);
  const games = tree.find((p) => p.folder === "games")!;
  expect(games.project).toBe("games");
  expect(games.repos[0]).toMatchObject({ name: "esx", cloned: true });
});

test("workspacePath collapses folder-level projects", () => {
  expect(workspacePath("/srv/dev", "acme", "shop", "cms")).toBe("/srv/dev/acme/shop/cms");
  expect(workspacePath("/srv/dev", "games", "games", "esx")).toBe("/srv/dev/games/esx");
});

test("resolveTarget handles project/repo and bare repo queries", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  const tree = await buildTree(cfg, root, { github: fakeGithub, gitea: fakeGitea });
  expect(resolveTarget(tree, "shop/cms")).toHaveLength(1);
  expect(resolveTarget(tree, "cms")).toHaveLength(1);
  expect(resolveTarget(tree, "nope")).toHaveLength(0);
});

test("folder with both projects and folder-level repos yields both entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  const mixed: DevConfig = {
    ...cfg,
    folders: {
      acme: {
        projects: { shop: { sources: [{ provider: "github", org: "shop-org" }] } },
        repos: [{ name: "tools", provider: "github", repo: "o/tools" }],
      },
    },
  };
  const tree = await buildTree(mixed, root, { github: fakeGithub, gitea: fakeGitea });
  expect(tree.map((p) => p.project).sort()).toEqual(["acme", "shop"]);
  const rootEntry = tree.find((p) => p.project === "acme")!;
  expect(rootEntry.repos.map((r) => r.name)).toEqual(["tools"]);
});

test("giteaLister rejects an unknown named instance instead of falling back", async () => {
  const lister = giteaLister(() => [{ name: "a", url: "http://x" }], {});
  await expect(lister({ provider: "gitea", org: "o", instance: "typo" })).rejects.toThrow(/Unknown Gitea instance/);
});

test("giteaLister reads instances fresh from the getter (config change without restart)", async () => {
  let instances: { name: string; url: string }[] = [];
  const lister = giteaLister(() => instances, {});
  await expect(lister({ provider: "gitea", org: "o" })).rejects.toThrow(/No Gitea instance/);
  instances = [{ name: "a", url: "http://x" }]; // "config saved" — the getter returns a new instance
  await expect(lister({ provider: "gitea", org: "o", instance: "typo" })).rejects.toThrow(/Unknown Gitea instance/);
});

const row = (extra: Partial<SessionRow>): SessionRow => ({
  id: "dev-p-app", folder: "acme", project: "p", repo: "app", container: "c",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0,
  important: 0, ...extra,
} as SessionRow);

test("a session with a worktree has its files in its worktree", () => {
  expect(sessionWorkdir("/srv/dev", row({ worktree: "/srv/dev/_sessions/dev-p-app-2" })))
    .toBe("/srv/dev/_sessions/dev-p-app-2");
});

// `worktree === null` = a repo cloned the old way with a shared directory. These sessions
// are not migrated and must behave exactly as today.
test("a session without a worktree falls back to the shared working directory", () => {
  expect(sessionWorkdir("/srv/dev", row({ worktree: null })))
    .toBe(workspacePath("/srv/dev", "acme", "p", "app"));
});

test("buildTree marks a repo with only a bare clone as cloned too", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  mkdirSync(barePath(root, "games", "games", "esx"), { recursive: true }); // bare clone, no workspace
  const tree = await buildTree(cfg, root, { github: fakeGithub, gitea: fakeGitea });
  const games = tree.find((p) => p.folder === "games")!;
  expect(games.repos[0]).toMatchObject({ name: "esx", cloned: true });
});

// I3 from review: "New session" promised its own worktree and branch, but for a repo in the OLD
// layout (shared working directory) a second session gets its own container but the SAME
// files and the same branch. So the label must be derived from the repo's actual layout —
// `bare` is that flag, collected where isBareLayout is already called for `cloned`.
test("buildTree tells the new layout (bare) from the old shared workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  mkdirSync(barePath(root, "games", "games", "esx"), { recursive: true });
  const bare = await buildTree(cfg, root, { github: fakeGithub, gitea: fakeGitea });
  expect(bare.find((p) => p.folder === "games")!.repos[0]).toMatchObject({ cloned: true, bare: true });

  const root2 = mkdtempSync(join(tmpdir(), "devd-root-"));
  mkdirSync(workspacePath(root2, "games", "games", "esx"), { recursive: true });  // old layout
  const old = await buildTree(cfg, root2, { github: fakeGithub, gitea: fakeGitea });
  expect(old.find((p) => p.folder === "games")!.repos[0]).toMatchObject({ cloned: true, bare: false });
});

test("buildTree marks a repo without a workspace and without a bare clone as not cloned", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  const tree = await buildTree(cfg, root, { github: fakeGithub, gitea: fakeGitea });
  const games = tree.find((p) => p.folder === "games")!;
  expect(games.repos[0]).toMatchObject({ name: "esx", cloned: false });
});

test("isBareLayout asks the disk, not the session", () => {
  const root = mkdtempSync(join(tmpdir(), "devd-root-"));
  expect(isBareLayout(root, "acme", "p", "app")).toBe(false);
  mkdirSync(barePath(root, "acme", "p", "app"), { recursive: true });
  expect(isBareLayout(root, "acme", "p", "app")).toBe(true);
});
