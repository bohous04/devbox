import type { TreeProject } from "./api";
import { repoChoices, type RepoChoice } from "./newSession";

/** One option of the New session repo picker: the tree's folder/project/repo cascade flattened. */
export const pickKey = (folder: string, project: string, repo: string) => JSON.stringify([folder, project, repo]);

export interface RepoOption { key: string; folder: string; project: string; repo: RepoChoice }
/** `label`: empty when the section heading already names the group. */
export interface RepoGroup { label: string; items: RepoOption[] }
export interface RepoSection { heading: string | null; groups: RepoGroup[] }

const groupLabel = (p: { folder: string; project: string }) => (p.project === p.folder ? p.folder : `${p.folder} / ${p.project}`);
/** Text as the search compares it: lower case without diacritics ("Café" and "cafe" match, "İ" matches "i"). */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
export const searchTerms = (query: string) => fold(query).split(/\s+/).filter(Boolean);

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
      const own = fold(`${repo.value} ${p.project === p.folder ? "" : p.project}`);
      const all = fold(`${p.folder} ${p.project} ${repo.value}`);
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

/** Where the picker's highlight starts when it opens: the picked repo's row in the unfiltered list (the query is
 *  cleared on open), else the first row. */
export function openIndex(tree: TreeProject[], value: string): number {
  const all = repoSearch(tree, "").flatMap((s) => s.groups.flatMap((g) => g.items));
  return Math.max(all.findIndex((o) => o.key === value), 0);
}

/** `text` split into the parts that match one of `terms` (folded, see searchTerms) and the rest, for highlighting.
 *  Folding can change the length ("İ" → "i", "é" → "e"), so each folded unit remembers the original character it came
 *  from and a hit marks whole original characters. */
export function highlight(text: string, terms: string[]): { text: string; hit: boolean }[] {
  let folded = "";
  const from: [number, number][] = []; // per folded unit: the original character's [start, end)
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) from.push([i, i + ch.length]);
    folded += f;
    i += ch.length;
  }
  const hit = new Array<boolean>(text.length).fill(false);
  for (const t of terms) {
    for (let j = folded.indexOf(t); j !== -1 && t !== ""; j = folded.indexOf(t, j + 1)) {
      for (let k = j; k < j + t.length; k++) hit.fill(true, from[k]![0], from[k]![1]);
    }
  }
  // A combining mark folds to nothing: it goes with the character before it, so a hit never splits it off.
  for (let i = 1; i < text.length; i++) if (fold(text[i]!) === "" && /\p{M}/u.test(text[i]!)) hit[i] = hit[i - 1]!;
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === hit[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: hit[i]! });
  }
  return parts;
}
