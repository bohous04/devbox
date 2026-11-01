// devd/test/noSpawnSync.test.ts
// Ratchet: every phase of the plan shortens the allowlist, after PR 4 it is empty. A text test —
// it runs nothing, it only reads the sources. Comments are stripped so that a mention of
// "Bun.spawnSync" in a comment (api.ts, cache.ts) does not count.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
// The allowlist has been empty since PR #77 — devd/src no longer calls Bun.spawnSync anywhere. It stays
// only as a ratchet: if spawnSync came back into some file, the test below would
// catch it. The second test guards the opposite direction — that files which no longer
// have spawnSync do not return to the allowlist (otherwise the ratchet would allow more than needed).
const ALLOW = new Set<string>();

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return n.endsWith(".ts") ? [p] : [];
  });
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("devd/src: Bun.spawnSync only in the allowlist (ratchet)", () => {
  const offenders: string[] = [];
  for (const f of tsFiles(SRC)) {
    const rel = relative(SRC, f);
    if (ALLOW.has(rel)) continue;
    if (/Bun\.spawnSync\s*\(/.test(stripComments(readFileSync(f, "utf8")))) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});

test("allowlist contains no files that no longer have spawnSync (the ratchet should shrink)", () => {
  const stale = [...ALLOW].filter((rel) => !/Bun\.spawnSync\s*\(/.test(stripComments(readFileSync(join(SRC, rel), "utf8"))));
  expect(stale).toEqual([]);
});
