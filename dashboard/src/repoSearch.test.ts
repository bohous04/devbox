import { expect, test } from "bun:test";
import type { TreeProject } from "./api";
import { highlight, openIndex, pickKey, repoSearch, searchTerms } from "./repoSearch";

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

test("search and highlight fold case and diacritics, also where folding changes the length", () => {
  const tree: TreeProject[] = [{ folder: "acme", project: "acme", repos: [repo("Café-api"), repo("İstanbul")] }];
  expect(names(repoSearch(tree, "cafe")[0]!)).toEqual(["Café-api"]);
  expect(names(repoSearch(tree, "CAFÉ")[0]!)).toEqual(["Café-api"]);
  expect(names(repoSearch(tree, "istan")[0]!)).toEqual(["İstanbul"]);
  expect(highlight("Café-api", searchTerms("cafe"))).toEqual([{ text: "Café", hit: true }, { text: "-api", hit: false }]);
  // "İ" lower-cases to two units; the rest of the name must still line up.
  expect(highlight("İstanbul", searchTerms("bul"))).toEqual([{ text: "İstan", hit: false }, { text: "bul", hit: true }]);
  expect(highlight("İstanbul", searchTerms("is"))).toEqual([{ text: "İs", hit: true }, { text: "tanbul", hit: false }]);
  // A decomposed "é" (e + combining accent) stays one highlighted piece.
  expect(highlight("café bar", ["cafe"])).toEqual([{ text: "café", hit: true }, { text: " bar", hit: false }]);
});

test("openIndex: the picked repo's row in the unfiltered list, whatever the last query was", () => {
  const all = repoSearch(TREE, "").flatMap((s) => s.groups.flatMap((g) => g.items));
  const key = pickKey("work", "webshop", "cart");
  expect(all[openIndex(TREE, key)]!.key).toBe(key);
  // The filtered list puts it elsewhere: an index from there would pick another repo after the query is cleared.
  expect(repoSearch(TREE, "web").flatMap((s) => s.groups.flatMap((g) => g.items)).findIndex((o) => o.key === key)).not.toBe(openIndex(TREE, key));
  expect(openIndex(TREE, "")).toBe(0);
});
