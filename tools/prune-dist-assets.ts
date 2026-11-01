/** Cleanup of old dashboard chunks after a build.
 *
 *  `vite build` used to wipe the whole output directory, so every deploy broke
 *  chunks for ALL open tabs: a page the user had not yet clicked in that tab
 *  is only fetched at the moment of the click, and by then its file was gone.
 *  The devbox deploys several times an hour, so this was not an exception
 *  but almost the rule.
 *
 *  The output is therefore not wiped (`emptyOutDir: false`) and older builds stay
 *  around for a while. Hashed names encode the content, so two builds cannot clash.
 *  This script removes whatever is older than the retention window. */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How long after a deploy a tab that has not reloaded since keeps working.
 *  Three days cover even a laptop closed over the weekend; the longer tail is caught
 *  by `ErrorBoundary` in the dashboard (missing chunk = one automatic reload). */
export const ASSET_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export interface AssetEntry { name: string; mtimeMs: number }

/** Which files are to be removed. The build that just finished (newest mtime)
 *  is always excluded — without this safeguard a skewed machine clock or
 *  zero retention would delete the dashboard that was just deployed. */
export function staleAssets(entries: AssetEntry[], now: number, retentionMs = ASSET_RETENTION_MS): string[] {
  if (entries.length === 0) return [];
  const newest = Math.max(...entries.map((e) => e.mtimeMs));
  return entries.filter((e) => e.mtimeMs !== newest && now - e.mtimeMs > retentionMs).map((e) => e.name);
}

/** Cleans `<dist>/assets` and returns the names of the deleted files. */
export function pruneAssets(distDir: string, now = Date.now(), retentionMs = ASSET_RETENTION_MS): string[] {
  const dir = join(distDir, "assets");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const entries = names.flatMap((name) => {
    const st = statSync(join(dir, name), { throwIfNoEntry: false });
    return st?.isFile() ? [{ name, mtimeMs: st.mtimeMs }] : [];
  });
  const stale = staleAssets(entries, now, retentionMs);
  for (const name of stale) rmSync(join(dir, name), { force: true });
  return stale;
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(import.meta.dir, "..", "dashboard", "dist");
  const removed = pruneAssets(dist);
  console.log(removed.length ? `dist/assets cleanup: removed ${removed.length} old files` : "dist/assets cleanup: nothing old");
}
