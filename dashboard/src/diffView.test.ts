import { expect, test } from "bun:test";
import { escapeInvisible, limiter, parseUnifiedDiff } from "./diffView";

test("parseUnifiedDiff: skips the file header, numbers both sides, keeps hunk context and the no-newline note", () => {
  const diff = [
    "diff --git a/src/queue.ts b/src/queue.ts",
    "index 1111111..2222222 100644",
    "--- a/src/queue.ts",
    "+++ b/src/queue.ts",
    "@@ -3,3 +3,4 @@ export function push() {",
    " keep",
    "-old",
    "--- a removed line that looks like a header",
    "+new",
    "+++ an added line that looks like a header",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  expect(parseUnifiedDiff(diff)).toEqual([
    { kind: "hunk", text: "@@ -3,3 +3,4 @@ export function push() {", old: null, new: null },
    { kind: "ctx", text: "keep", old: 3, new: 3 },
    { kind: "del", text: "old", old: 4, new: null },
    { kind: "del", text: "-- a removed line that looks like a header", old: 5, new: null },
    { kind: "add", text: "new", old: null, new: 4 },
    { kind: "add", text: "++ an added line that looks like a header", old: null, new: 5 },
    { kind: "note", text: "\\ No newline at end of file", old: null, new: null },
  ]);
});

test("parseUnifiedDiff: a new file from /dev/null and an empty diff", () => {
  expect(parseUnifiedDiff("--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n").map((l) => [l.kind, l.new])).toEqual([["hunk", null], ["add", 1], ["add", 2]]);
  expect(parseUnifiedDiff("")).toEqual([]);
});

test("limiter: never more than n at once, all finish, a failure frees its slot", async () => {
  const run = limiter(2);
  let active = 0, peak = 0;
  const task = (fail: boolean) => async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (fail) throw new Error("x");
    return 1;
  };
  const results = await Promise.allSettled([task(true), task(false), task(false), task(false), task(false)].map((t) => run(t)));
  expect(peak).toBe(2);
  expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
});

test("escapeInvisible: combining marks, bidi and zero-width controls become escapes; text and tabs stay", () => {
  const show = (s: string) => escapeInvisible(s).map((p) => (p.escaped ? `[${p.text}]` : p.text)).join("");
  expect(show("/[̀-ͯ]/g")).toBe("/[[\\u0300]-[\\u036f]]/g");
  expect(show("if (isAdmin) {‮ } ⁦// check⁩")).toBe("if (isAdmin) {[\\u202e] } [\\u2066]// check[\\u2069]");
  expect(show("a​b﻿\x07")).toBe("a[\\u200b]b[\\ufeff][\\u0007]");
  expect(show("\tconst žluťoučký = 1; // 🙂")).toBe("\tconst žluťoučký = 1; // 🙂");
  expect(escapeInvisible("")).toEqual([]);
});
