import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeProject } from "../../devd/src/tree";
import { fileLastAttached, fileRecents, flattenTree, matchSessions, resolveQuery, sortByRecent } from "../src/resolve";

const tree: TreeProject[] = [
  { folder: "acme", project: "shop", repos: [
    { name: "cms", cloneUrl: "https://x/cms.git", provider: "github", cloned: true },
    { name: "web", cloneUrl: "https://x/web.git", provider: "github", cloned: false },
  ]},
  { folder: "acme", project: "metro", repos: [
    { name: "cms", cloneUrl: "https://y/cms.git", provider: "github", cloned: false },
  ]},
];

test("flatten and resolve project/repo and bare repo", () => {
  const t = flattenTree(tree);
  expect(t).toHaveLength(3);
  expect(resolveQuery(t, "shop/cms")).toHaveLength(1);
  expect(resolveQuery(t, "shop/cms")[0]).toMatchObject({ folder: "acme", project: "shop", repo: "cms" });
  expect(resolveQuery(t, "cms")).toHaveLength(2);
  expect(resolveQuery(t, "nope")).toHaveLength(0);
});

test("recents store touch/load caps and dedupes; sortByRecent pins recents first", () => {
  const p = join(mkdtempSync(join(tmpdir(), "rec-")), "sub", "recents.json");
  const store = fileRecents(p);
  expect(store.load()).toEqual([]);
  const t = flattenTree(tree);
  store.touch(t[2]); // metro/cms
  store.touch(t[0]); // shop/cms
  store.touch(t[2]); // metro/cms again → moves to front, no dup
  const rec = store.load();
  expect(rec).toHaveLength(2);
  expect(rec[0]).toMatchObject({ project: "metro", repo: "cms" });
  const sorted = sortByRecent(t, rec);
  expect(sorted[0]).toMatchObject({ project: "metro", repo: "cms" });
  expect(sorted[1]).toMatchObject({ project: "shop", repo: "cms" });
});

test("corrupt recents file fails closed to empty and recovers on touch", () => {
  const p = join(mkdtempSync(join(tmpdir(), "rec-")), "recents.json");
  writeFileSync(p, "{ not json");
  const store = fileRecents(p);
  expect(store.load()).toEqual([]);
  store.touch({ folder: "a", project: "p", repo: "r", cloned: false });
  expect(store.load()).toHaveLength(1);
});

test("fileLastAttached: touch writes the id with a time, load returns the newest first", () => {
  const path = join(mkdtempSync(join(tmpdir(), "la-")), "attached.json");
  const store = fileLastAttached(path);
  expect(store.load()).toEqual([]);
  store.touch("dev-a", 100);
  store.touch("dev-b", 200);
  const rows = store.load();
  expect(rows[0].id).toBe("dev-b");
  expect(rows[0].ts).toBe(200);
  expect(rows[1].id).toBe("dev-a");
});

test("fileLastAttached: touching the same id again moves it up without a duplicate", () => {
  const path = join(mkdtempSync(join(tmpdir(), "la-")), "attached.json");
  const store = fileLastAttached(path);
  store.touch("dev-a", 100);
  store.touch("dev-b", 200);
  store.touch("dev-a", 300);
  const rows = store.load();
  expect(rows.map((r) => r.id)).toEqual(["dev-a", "dev-b"]);
  expect(rows[0].ts).toBe(300);
});

test("fileLastAttached: corrupt JSON → empty (does not crash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "la-"));
  const path = join(dir, "attached.json");
  writeFileSync(path, "{ broken");
  expect(fileLastAttached(path).load()).toEqual([]);
});

// I2 from the review: a `project/repo` query used to be unambiguous, now it is not — a second
// session of the same repo exists. `find()` silently took the FIRST (the oldest per listSessions),
// so `dev end portal/web` could delete the files of a session the user did not mean (since C1
// `end()` is destructive), and `dev important` did not even say which flag it toggled.
const sess = (id: string, project: string, repo: string) => ({ id, project, repo });

test("matchSessions: an exact id wins and is always unambiguous", () => {
  const all = [sess("dev-p-web", "p", "web"), sess("dev-p-web-2", "p", "web")];
  // A notification click runs `dev attach <id>` — it must not start asking anything.
  expect(matchSessions(all, "dev-p-web-2").map((s) => s.id)).toEqual(["dev-p-web-2"]);
  expect(matchSessions(all, "dev-p-web").map((s) => s.id)).toEqual(["dev-p-web"]);
});

test("matchSessions: project/repo returns ALL matches, not the first", () => {
  const all = [sess("dev-p-web", "p", "web"), sess("dev-p-api", "p", "api"), sess("dev-p-web-2", "p", "web")];
  expect(matchSessions(all, "p/web").map((s) => s.id)).toEqual(["dev-p-web", "dev-p-web-2"]);
  expect(matchSessions(all, "p/api").map((s) => s.id)).toEqual(["dev-p-api"]);
  expect(matchSessions(all, "p/nowhere")).toEqual([]);
});
