import { expect, test } from "bun:test";
import type { TreeProject } from "./api";
import { highlight, repoSearch } from "./repoSearch";

const repo = (name: string) => ({ name, cloneUrl: `https://git.example/${name}.git`, provider: "github", cloned: false });
const TREE: TreeProject[] = [
  { folder: "websites", project: "websites", repos: [repo("acme-bistro"), repo("harbor-web")] },
  { folder: "work", project: "lumen", repos: [repo("orchard"), repo("lumen-api")] },
  { folder: "work", project: "webshop", repos: [repo("cart")] },
];
const names = (s: ReturnType<typeof repoSearch>[number]) => s.groups.flatMap((g) => g.items.map((i) => i.repo.value));

test("no query: every repo (and claudeSolo) by folder/project, one section without a heading", () => {
  const r = repoSearch(TREE, "");
  expect(r.length).toBe(1);
  expect(r[0]!.heading).toBeNull();
  expect(r[0]!.groups.map((g) => g.label)).toEqual(["websites", "work / lumen", "work / webshop"]);
  expect(names(r[0]!)).toEqual(["acme-bistro", "harbor-web", "claudeSolo", "lumen-api", "orchard", "claudeSolo", "cart", "claudeSolo"]);
});

test("repo and project names match first; a folder-only match is a second section under its folder", () => {
  const r = repoSearch(TREE, "web");
  expect(r[0]!.heading).toBeNull();
  // harbor-web by name, cart by its project "webshop"; acme-bistro only by the folder "websites".
  expect(names(r[0]!)).toEqual(["harbor-web", "cart", "claudeSolo"]);
  expect(r[1]!.heading).toBe("In folder “websites”");
  expect(names(r[1]!)).toEqual(["acme-bistro", "claudeSolo"]);
  expect(r[1]!.groups[0]!.label).toBe("");
});

test("every term must match; case does not matter; nothing → empty", () => {
  expect(names(repoSearch(TREE, "LUMEN api")[0]!)).toEqual(["lumen-api"]);
  expect(repoSearch(TREE, "zzz")).toEqual([]);
});

test("highlight marks every term occurrence, case-insensitively", () => {
  expect(highlight("Harbor-Web", ["web"])).toEqual([{ text: "Harbor-", hit: false }, { text: "Web", hit: true }]);
  expect(highlight("lumen-api", ["api", "lu"])).toEqual([{ text: "lu", hit: true }, { text: "men-", hit: false }, { text: "api", hit: true }]);
  expect(highlight("abc", [])).toEqual([{ text: "abc", hit: false }]);
});
