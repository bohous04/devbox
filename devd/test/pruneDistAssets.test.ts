import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_RETENTION_MS, pruneAssets, staleAssets } from "../../tools/prune-dist-assets";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_787_300_000_000;
const e = (name: string, ageDays: number) => ({ name, mtimeMs: NOW - ageDays * DAY });

// Deploy used to delete the whole output directory, so EVERY deploy pulled the chunks out from under
// all open tabs. So chunks from previous builds are left in place —
// the name carries the content hash, so there is nothing for them to clash with.
test("chunks from the last few days stay — an open tab still finds them", () => {
  const keep = [e("index-NEW.js", 0), e("Stats-VCEREJSI.js", 1), e("Log-PREDVCEREM.js", 2)];
  expect(staleAssets(keep, NOW)).toEqual([]);
});

test("chunks older than the retention window are removed", () => {
  const list = [e("index-NEW.js", 0), e("Stats-ANCIENT.js", 9), e("Log-OLD.js", 4)];
  expect(staleAssets(list, NOW).sort()).toEqual(["Log-OLD.js", "Stats-ANCIENT.js"]);
});

// A safeguard in case the machine's clock drifts from reality or someone
// sets zero retention: the build that just finished MUST NOT be deleted —
// otherwise the cleanup would take the dashboard down completely.
test("the newest build is never deleted, not even with zero retention", () => {
  const list = [e("index-NEW.js", 0), e("vendor-NEW.js", 0), e("Stats-OLD.js", 5)];
  expect(staleAssets(list, NOW, 0)).toEqual(["Stats-OLD.js"]);
});

test("an empty directory deletes nothing and does not crash", () => {
  expect(staleAssets([], NOW)).toEqual([]);
});

test("the default window is several days, not minutes", () => {
  expect(ASSET_RETENTION_MS).toBeGreaterThanOrEqual(2 * DAY);
});

test("pruneAssets deletes only the old files on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-prune-"));
  const assets = join(dir, "assets");
  mkdirSync(assets);
  for (const [name, ageDays] of [["index-NEW.js", 0], ["Stats-OLD.js", 9]] as const) {
    const p = join(assets, name);
    writeFileSync(p, "x");
    const t = new Date(Date.now() - ageDays * DAY);
    utimesSync(p, t, t);
  }
  const removed = pruneAssets(dir);
  expect(removed).toEqual(["Stats-OLD.js"]);
  expect(readdirSync(assets)).toEqual(["index-NEW.js"]);
});

test("pruneAssets without an assets directory just returns nothing", () => {
  expect(pruneAssets(mkdtempSync(join(tmpdir(), "devd-prune-empty-")))).toEqual([]);
});
