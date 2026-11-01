import { expect, test } from "bun:test";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist", "assets");

// Note: reads the artifacts of the last `bun run --cwd dashboard build`. Without them the
// test is skipped, so `bun test` does not require a build on a clean clone.
test.skipIf(!existsSync(dist))("no JS chunk exceeds 600 kB", () => {
  const big = readdirSync(dist)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ f, kb: Math.round(statSync(join(dist, f)).size / 1024) }))
    .filter((x) => x.kb > 600);
  expect(big).toEqual([]);
});

test.skipIf(!existsSync(dist))("charts and the terminal are in their own chunks, not the main one", () => {
  const names = readdirSync(dist).filter((f) => f.endsWith(".js"));
  expect(names.some((f) => f.startsWith("charts-"))).toBe(true);
  expect(names.some((f) => f.startsWith("terminal-"))).toBe(true);
});
