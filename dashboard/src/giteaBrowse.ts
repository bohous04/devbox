/** Pure logic of the RepoBrowser Gitea tab — no React, testable (same pattern as configEdit.ts). */
import type { GiteaRepo } from "./api";

export interface GiteaOwner { login: string; repoCount: number }

/** Unique owners derived from search results; sorted by repo count desc, then alphabetically. */
export function deriveOwners(repos: GiteaRepo[]): GiteaOwner[] {
  const counts = new Map<string, number>();
  for (const r of repos) if (r.owner) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  return [...counts.entries()]
    .map(([login, repoCount]) => ({ login, repoCount }))
    .sort((a, b) => b.repoCount - a.repoCount || a.login.localeCompare(b.login));
}

/** Filter by the selected owner (null = all) and full text (name/fullName/description). */
export function filterGiteaRepos(repos: GiteaRepo[], owner: string | null, q: string): GiteaRepo[] {
  const needle = q.trim().toLowerCase();
  return repos.filter((r) =>
    (owner === null || r.owner === owner) &&
    (!needle ||
      r.name.toLowerCase().includes(needle) ||
      r.fullName.toLowerCase().includes(needle) ||
      r.description.toLowerCase().includes(needle)));
}
