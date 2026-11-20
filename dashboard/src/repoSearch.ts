import type { TreeProject } from "./api";
import { repoChoices, type RepoChoice } from "./newSession";

/** One option of the New session repo picker: the tree's folder/project/repo cascade flattened. */
export const pickKey = (folder: string, project: string, repo: string) => JSON.stringify([folder, project, repo]);

export interface RepoOption { key: string; folder: string; project: string; repo: RepoChoice }
/** `label`: empty when the section heading already names the group. */
export interface RepoGroup { label: string; items: RepoOption[] }
export interface RepoSection { heading: string | null; groups: RepoGroup[] }

const groupLabel = (p: { folder: string; project: string }) => (p.project === p.folder ? p.folder : `${p.folder} / ${p.project}`);
export const searchTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** The picker's list for a query. Every term must match. A match in the repo's name or its own project comes first;
 *  a repo found only through its folder's name follows under "In folder …", so a word like "web" does not bury the
 *  repos named after it among every repo of a folder that happens to contain it. */
export function repoSearch(tree: TreeProject[], query: string): RepoSection[] {
  const terms = searchTerms(query);
  const projects = tree.slice().sort((a, b) => a.folder.localeCompare(b.folder) || a.project.localeCompare(b.project));
  const first: RepoGroup[] = [];
  const byFolder = new Map<string, RepoGroup[]>();
  for (const p of projects) {
    const direct: RepoOption[] = [];
    const viaFolder: RepoOption[] = [];
    for (const repo of repoChoices(tree, p.folder, p.project)) {
      const option = { key: pickKey(p.folder, p.project, repo.value), folder: p.folder, project: p.project, repo };
      const own = `${repo.value} ${p.project === p.folder ? "" : p.project}`.toLowerCase();
      const all = `${p.folder} ${p.project} ${repo.value}`.toLowerCase();
      if (terms.every((t) => own.includes(t))) direct.push(option);
      else if (terms.every((t) => all.includes(t))) viaFolder.push(option);
    }
    if (direct.length > 0) first.push({ label: groupLabel(p), items: direct });
    // Under its folder's heading a group names only its project; a flat folder's own project needs no line.
    if (viaFolder.length > 0) byFolder.set(p.folder, [...(byFolder.get(p.folder) ?? []), { label: p.project === p.folder ? "" : p.project, items: viaFolder }]);
  }
  const sections: RepoSection[] = first.length > 0 ? [{ heading: null, groups: first }] : [];
  for (const [folder, groups] of byFolder) sections.push({ heading: `In folder “${folder}”`, groups });
  return sections;
}

/** `text` split into the parts that match one of `terms` (case-insensitive) and the rest, for highlighting. */
export function highlight(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const hit = new Array<boolean>(text.length).fill(false);
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1 && t !== ""; i = lower.indexOf(t, i + 1)) hit.fill(true, i, i + t.length);
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === hit[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: hit[i]! });
  }
  return parts;
}
