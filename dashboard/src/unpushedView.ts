// Pure logic of the Work in progress page (unpushed commits). JSX stays in pages/
// (same pattern as sshApprovalsView / accountsView).

import type { UnpushedBranch, UnpushedRepo } from "./api";

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/* ------------------------------ expansion ------------------------------ */

/** The page holds one set of expanded nodes (folders, repos and branches) — keys have a
 *  per-level prefix, so a folder "web" does not collide with a repo or branch "web". */
export const folderKey = (folder: string): string => `folder:${folder}`;
export const repoKey = (path: string): string => `repo:${path}`;
/** A branch is unique only within a repo (almost every one has main). */
export const branchKey = (path: string, branch: string): string => `branch:${path}#${branch}`;

/** New set with the key toggled — the input is not mutated (React state). */
export function toggled(open: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(open);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/** `project/repo`; for a flat repo (project === folder) just `repo` — the folder is already
 *  in the card header and "apps/web" under "apps/" would say the same thing twice. */
export function repoTitle(r: UnpushedRepo): string {
  return r.project === r.folder ? r.repo : `${r.project}/${r.repo}`;
}

/** Tags that change the meaning of the count: a bare clone (session branches, no working
 *  directory) and a repo without a remote (unpushed = everything, nowhere to push). */
export function repoFlags(r: UnpushedRepo): string[] {
  const out: string[] = [];
  if (r.bare) out.push("bare");
  if (r.noRemote) out.push("no remote");
  return out;
}

export function branchLabel(b: UnpushedBranch): string {
  return b.upstream ? `${b.branch} → ${b.upstream}` : `${b.branch} · no upstream`;
}

/** Push makes sense only where there is a remote and git works in the repo. */
export function canPush(r: UnpushedRepo): boolean {
  return !r.noRemote && !r.error;
}

/** PRs are supported only by GitHub and a configured Gitea (see devd `parseRemote`). */
export function canCreatePr(r: UnpushedRepo): boolean {
  return canPush(r) && (r.remote?.provider === "github" || r.remote?.provider === "gitea");
}

/** Default PR title: a single commit → its subject, otherwise the branch name (the user
 *  rewrites it in the field). */
export function prTitle(b: UnpushedBranch): string {
  return b.count === 1 && b.commits[0]?.subject ? b.commits[0].subject : b.branch;
}

/** PR body: commit bullets from the oldest (the report has them from the newest), a truncated
 *  list says so instead of silently omitting. */
export function prBody(b: UnpushedBranch): string {
  const lines = [...b.commits].reverse().map((c) => `- ${c.subject}`);
  const hidden = b.count - b.commits.length;
  return hidden > 0 ? `${lines.join("\n")}\n\n…and ${hidden} more ${hidden === 1 ? "commit" : "commits"}` : lines.join("\n");
}

/** "4 commits", for a truncated list also how many are visible. `shown` is passed only when
 *  the list is shorter than `count`. */
export function commitsLabel(count: number, shown?: number): string {
  const base = `${count} ${count === 1 ? "commit" : "commits"}`;
  return shown !== undefined && shown < count ? `${base} · showing ${shown}` : base;
}
