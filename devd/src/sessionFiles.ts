import type { SessionFiles } from "../../shared/changes";
import { ChangesError, verifiedGit } from "./sessionChanges";

/** Cap of the listing git may print (characters): a repo whose tracked and untracked names exceed it is searched in
 *  the part read (`listingCapped`). */
export const MAX_LISTING = 4 * 1024 * 1024;
/** How long one listing serves the searches of a session (the keystrokes of one @ query). */
export const FILE_LISTING_TTL_MS = 10_000;
/** Most files one answer carries. */
export const MAX_FILE_RESULTS = 50;

/** Every tracked and untracked (not ignored) file of the session repo, repo-relative, through the same verified, pinned
 *  git as the changes routes (sessionChanges.ts openRepo). git lists a symlink as itself and never follows it, so no
 *  name from outside the repo can come back. `capped`: git printed more than `maxBytes`; the cut name is dropped. */
export async function listRepoFiles(ws: string, expected: { gitDir: string; commonDir: string }, o: { maxBytes?: number } = {}): Promise<{ paths: string[]; capped: boolean }> {
  const { gitCapped } = await verifiedGit(ws, expected);
  const r = await gitCapped(o.maxBytes ?? MAX_LISTING, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  const capped = r.stdoutTruncated === true;
  if (!capped && r.code !== 0) {
    console.error(`files ${ws}: git ls-files failed: ${r.stderr.trim()}`);
    throw new ChangesError(500, "git_failed", "listing files failed");
  }
  const names = r.stdout.split("\0");
  // Without a cut the output ends with a NUL (the last element is ""); with one the last element is a partial name.
  names.pop();
  // An unmerged file is listed once per stage.
  return { paths: [...new Set(names)], capped };
}

/** The files matching `q` (case-insensitive): names starting with it, then names containing it, then paths containing
 *  it; shorter paths first within each. An empty `q` lists in path order. A name git could not decode as UTF-8 is left
 *  out: it is not the file's real name, so inserting it would point at nothing. */
export function matchFiles(paths: string[], q: string, limit: number): SessionFiles {
  const needle = q.toLowerCase();
  const ranked: { path: string; rank: number }[] = [];
  for (const path of paths) {
    if (path.includes("\uFFFD")) continue;
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const rank = needle === "" ? 0 : name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (rank >= 0) ranked.push({ path, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || (needle === "" ? 0 : a.path.length - b.path.length) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: ranked.slice(0, limit).map((r) => r.path), ...(ranked.length > limit ? { more: true as const } : {}) };
}
